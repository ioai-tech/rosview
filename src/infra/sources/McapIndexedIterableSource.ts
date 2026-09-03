import { McapIndexedReader } from "@mcap/core";
import type {
  Initialization,
  MessageEvent,
  PlayerProblem,
  RosDatatypes,
  Time,
  TopicInfo,
  TopicStats,
} from '@/core/types/ros';
import type { GetAdjacentMessageArgs, IIterableSource } from "./IIterableSource";
import type { MessageIteratorArgs, GetBackfillMessagesArgs } from '@/infra/workers/types';
import { parseChannel } from "./parseChannel";
import type { ParsedChannel } from "./parseChannel";
import { fromNano, toNano } from '@/shared/utils/time';
import { workerPerf } from '@/infra/workers/workerPerf';

/** One record from `McapIndexedReader#readMessages` iterators. */
interface McapReadMessage {
  channelId: number;
  logTime: bigint;
  publishTime: bigint;
  data: Uint8Array;
}

export class McapIndexedIterableSource implements IIterableSource {
  private _reader: McapIndexedReader;
  private _channelsById: Map<number, ParsedChannel> = new Map();
  private _start?: Time;
  private _end?: Time;

  constructor(reader: McapIndexedReader) {
    this._reader = reader;
  }

  initialize(): Promise<Initialization> {
    let startTime: bigint | undefined;
    let endTime: bigint | undefined;
    for (const chunk of this._reader.chunkIndexes) {
      if (startTime === undefined || chunk.messageStartTime < startTime) {
        startTime = chunk.messageStartTime;
      }
      if (endTime === undefined || chunk.messageEndTime > endTime) {
        endTime = chunk.messageEndTime;
      }
    }

    const topics: TopicInfo[] = [];
    const datatypes: RosDatatypes = {};
    const publishersByTopic: Record<string, string[]> = {};
    const topicStats: Record<string, TopicStats> = {};
    const problems: PlayerProblem[] = [];
    const statistics = this._reader.statistics;
    const topicMessageCounts = new Map<string, number>();
    const topicFirstNs = new Map<string, bigint>();
    const topicLastNs = new Map<string, bigint>();

    for (const [channelId, count] of statistics?.channelMessageCounts ?? []) {
      const channel = this._reader.channelsById.get(channelId);
      if (!channel) continue;
      topicMessageCounts.set(channel.topic, (topicMessageCounts.get(channel.topic) ?? 0) + Number(count));
    }

    for (const chunk of this._reader.chunkIndexes) {
      for (const channelId of chunk.messageIndexOffsets.keys()) {
        const channel = this._reader.channelsById.get(channelId);
        if (!channel) continue;
        const first = topicFirstNs.get(channel.topic);
        const last = topicLastNs.get(channel.topic);
        if (first == null || chunk.messageStartTime < first) {
          topicFirstNs.set(channel.topic, chunk.messageStartTime);
        }
        if (last == null || chunk.messageEndTime > last) {
          topicLastNs.set(channel.topic, chunk.messageEndTime);
        }
      }
    }

    const registerTopic = (channel: {
      topic: string;
      schemaId: number;
      metadata: Map<string, string>;
    }) => {
      const schemaName =
        channel.schemaId === 0
          ? "unknown"
          : this._reader.schemasById.get(channel.schemaId)?.name ?? "unknown";
      topics.push({
        name: channel.topic,
        type: schemaName,
      });

      if (!publishersByTopic[channel.topic]) {
        publishersByTopic[channel.topic] = [];
      }
      const publisher = channel.metadata.get("publisher") ?? "unknown";
      if (!publishersByTopic[channel.topic].includes(publisher)) {
        publishersByTopic[channel.topic].push(publisher);
      }

      const messageCount = topicMessageCounts.get(channel.topic) ?? 0;
      const firstNs = topicFirstNs.get(channel.topic);
      const lastNs = topicLastNs.get(channel.topic);
      const durationSec =
        firstNs != null && lastNs != null && lastNs > firstNs ? Number(lastNs - firstNs) / 1e9 : undefined;
      const frequency =
        durationSec != null && durationSec > 0 && messageCount > 1 ? (messageCount - 1) / durationSec : 0;

      topicStats[channel.topic] = {
        messageCount,
        frequency: frequency > 0 ? frequency : 0,
        durationSec,
      };
    };

    for (const channel of this._reader.channelsById.values()) {
      const schema = channel.schemaId !== 0 ? this._reader.schemasById.get(channel.schemaId) : undefined;

      try {
        const parsedChannel = parseChannel({
          messageEncoding: channel.messageEncoding,
          schema: schema ? {
            name: schema.name,
            encoding: schema.encoding,
            data: schema.data
          } : undefined
        });

        this._channelsById.set(channel.id, parsedChannel);

        for (const [name, definition] of parsedChannel.datatypes) {
          datatypes[name] = definition;
        }

        registerTopic(channel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to parse channel ${channel.id}:`, err);
        problems.push({
          severity: "warn",
          message: `Channel ${channel.id} (${channel.topic}): ${msg}`,
        });
        this._channelsById.set(channel.id, {
          datatypes: new Map(),
          deserialize: (data) => ({
            _rosviewDecodeFailed: true,
            message: msg,
            byteLength: data.byteLength,
          }),
        });
        registerTopic(channel);
      }
    }

    this._start = fromNano(startTime ?? 0n);
    this._end = fromNano(endTime ?? 0n);

    console.debug("McapIndexedIterableSource: initialized", {
      topicCount: topics.length,
      startTime: this._start,
      endTime: this._end
    });

    return Promise.resolve({
      topics,
      datatypes,
      start: this._start,
      end: this._end,
      publishersByTopic,
      topicStats,
      problems,
      randomAccessByTopic: true,
    });
  }

  async *messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent> {
    const startTime = toNano(args.startTime);
    const endTime = args.endTime ? toNano(args.endTime) : (this._end ? toNano(this._end) : undefined);

    const iterator = this._reader.readMessages({
      startTime,
      endTime,
      topics: args.topics,
    })[Symbol.asyncIterator]();

    for (;;) {
      const result = await workerPerf.timeAsync("mcap.readMessages.next", () => iterator.next());
      if (result.done) break;
      const message = result.value as McapReadMessage;
      const channel = this._reader.channelsById.get(message.channelId);
      if (!channel) continue;

      const parsedChannel = this._channelsById.get(message.channelId);
      if (!parsedChannel) continue;

      const deserializeStart = performance.now();
      const deserialized = parsedChannel.deserialize(message.data);
      const deserializeMs = performance.now() - deserializeStart;
      workerPerf.record("mcap.deserialize", deserializeMs, message.data.byteLength);
      workerPerf.recordTopic("mcap.deserialize.topic", channel.topic, deserializeMs, message.data.byteLength);

      const event: MessageEvent = {
        topic: channel.topic,
        receiveTime: fromNano(message.logTime),
        publishTime: fromNano(message.publishTime),
        message: deserialized,
        schemaName: channel.schemaId !== 0 ? this._reader.schemasById.get(channel.schemaId)?.name ?? "" : "",
      };
      yield event;
    }
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    const time = toNano(args.time);
    const messages: MessageEvent[] = [];

    for (const topic of args.topics) {
      // First try: look backwards from current time for the most recent message.
      const backIterator = this._reader.readMessages({
        endTime: time,
        topics: [topic],
        reverse: true,
      });
      let raw = await workerPerf.timeAsync("mcap.backfill.readNext", () => backIterator.next());

      // If no message exists at or before this time (e.g. seeking near the start),
      // fall forward to find the first available message for this topic.
      if (raw.done && this._end != null) {
        const fwdIterator = this._reader.readMessages({
          startTime: time,
          topics: [topic],
        });
        raw = await workerPerf.timeAsync("mcap.backfill.readNext", () => fwdIterator.next());
      }

      if (!raw.done) {
        const message = raw.value as McapReadMessage;
        const channel = this._reader.channelsById.get(message.channelId);
        const parsedChannel = this._channelsById.get(message.channelId);

        if (channel && parsedChannel) {
          messages.push({
            topic: channel.topic,
            receiveTime: fromNano(message.logTime),
            publishTime: fromNano(message.publishTime),
            message: workerPerf.time(
              "mcap.backfill.deserialize",
              () => parsedChannel.deserialize(message.data),
              message.data.byteLength,
            ),
            schemaName: channel.schemaId !== 0 ? this._reader.schemasById.get(channel.schemaId)?.name ?? "" : "",
          });
        }
      }
    }

    return messages;
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    const { time, topics, direction } = args;
    if (topics.length === 0) return null;
    const t = toNano(time);
    const iterator =
      direction === "next"
        ? this._reader.readMessages({
            startTime: t + 1n,
            topics,
            reverse: false,
          })
        : this._reader.readMessages({
            endTime: t > 0n ? t - 1n : 0n,
            topics,
            reverse: true,
          });
    const raw = await workerPerf.timeAsync("mcap.adjacent.readNext", () => iterator.next());
    if (raw.done) return null;
    const message = raw.value as McapReadMessage;
    const channel = this._reader.channelsById.get(message.channelId);
    const parsedChannel = this._channelsById.get(message.channelId);
    if (!channel || !parsedChannel) return null;
    return {
      topic: channel.topic,
      receiveTime: fromNano(message.logTime),
      publishTime: fromNano(message.publishTime),
      message: workerPerf.time(
        "mcap.adjacent.deserialize",
        () => parsedChannel.deserialize(message.data),
        message.data.byteLength,
      ),
      schemaName: channel.schemaId !== 0 ? this._reader.schemasById.get(channel.schemaId)?.name ?? "" : "",
    };
  }

}
