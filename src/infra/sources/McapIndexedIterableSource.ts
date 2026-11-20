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
import type {
  BackfillTopicCallback,
  BackfillTopicError,
  MessageIteratorArgs,
  GetBackfillMessagesArgs,
  ReadBoundariesArgs,
} from '@/infra/workers/types';
import { parseChannel } from "./parseChannel";
import type { ParsedChannel } from "./parseChannel";
import { fromNano, toNano } from '@/shared/utils/time';
import { workerPerf } from '@/infra/workers/workerPerf';

/**
 * How many backfill topics are read at once. Each holds at most one decompressed chunk (a few MB,
 * up to tens of MB for a map), so the worker's memory stays bounded however many topics a layout
 * subscribes to, while a slow topic does not block the others.
 */
const BACKFILL_CONCURRENCY = 4;

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

  /**
   * The latest message of each topic at `time`. Topics are read at most
   * `BACKFILL_CONCURRENCY` at a time, in the order given (callers put the frame they wait for
   * first), so a topic whose message is in a large or distant chunk does not hold back the next
   * ones, while the worker holds only a few decompressed chunks at once. With `onTopic`, each
   * topic is handed over as soon as it is read, and no further topic is started once it returns
   * false.
   */
  async getBackfillMessages(args: GetBackfillMessagesArgs, onTopic?: BackfillTopicCallback): Promise<MessageEvent[]> {
    const time = toNano(args.time);
    const found: (MessageEvent | undefined)[] = [];
    let next = 0;
    let stopped = false;
    const lane = async (): Promise<void> => {
      while (!stopped && next < args.topics.length) {
        const index = next++;
        const topic = args.topics[index];
        if (!onTopic) {
          found[index] = await this._latestMessageAt(topic, time);
          continue;
        }
        // One topic that cannot be read (a stalled range, a corrupt chunk) is handed over as failed;
        // the rest of the frame is still read and shown.
        let event: MessageEvent | undefined;
        let error: BackfillTopicError | undefined;
        try {
          event = await this._latestMessageAt(topic, time);
        } catch (err) {
          error = {
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : String(err),
          };
        }
        if (stopped) return;
        if (!(await onTopic(topic, event ? [event] : [], error))) stopped = true;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, args.topics.length) }, lane));
    } finally {
      // However the call ends (also when a lane throws), no lane starts another topic.
      stopped = true;
    }
    return found.filter((event): event is MessageEvent => event != undefined);
  }

  private async _latestMessageAt(topic: string, time: bigint): Promise<MessageEvent | undefined> {
    // First try: look backwards from current time for the most recent message.
    const backIterator = this._reader.readMessages({
      endTime: time,
      topics: [topic],
      reverse: true,
    });
    let raw = await workerPerf.timeAsync("mcap.backfill.readNext", () => backIterator.next());
    void backIterator.return?.(undefined);

    // If no message exists at or before this time (e.g. seeking near the start),
    // fall forward to find the first available message for this topic.
    if (raw.done && this._end != null) {
      const fwdIterator = this._reader.readMessages({
        startTime: time,
        topics: [topic],
      });
      raw = await workerPerf.timeAsync("mcap.backfill.readNext", () => fwdIterator.next());
      void fwdIterator.return?.(undefined);
    }
    if (raw.done) return undefined;

    const message = raw.value as McapReadMessage;
    const channel = this._reader.channelsById.get(message.channelId);
    const parsedChannel = this._channelsById.get(message.channelId);
    if (!channel || !parsedChannel) return undefined;
    return {
      topic: channel.topic,
      receiveTime: fromNano(message.logTime),
      publishTime: fromNano(message.publishTime),
      message: workerPerf.time(
        "mcap.backfill.deserialize",
        () => parsedChannel.deserialize(message.data),
        message.data.byteLength,
      ),
      schemaName: channel.schemaId !== 0 ? this._reader.schemasById.get(channel.schemaId)?.name ?? "" : "",
    };
  }

  getReadBoundaries({ start, end, topics }: ReadBoundariesArgs): Promise<Time[] | undefined> {
    const startNs = toNano(start);
    const endNs = toNano(end);
    if (endNs < startNs || topics.length === 0) return Promise.resolve(undefined);
    const wanted = new Set(topics);
    const channelIds = new Set<number>();
    for (const [id, channel] of this._reader.channelsById) if (wanted.has(channel.topic)) channelIds.add(id);
    const spans: Array<[bigint, bigint]> = [];
    for (const chunk of this._reader.chunkIndexes) {
      if (chunk.messageEndTime < startNs || chunk.messageStartTime > endNs) continue;
      if (![...chunk.messageIndexOffsets.keys()].some((id) => channelIds.has(id))) continue;
      spans.push([chunk.messageStartTime, chunk.messageEndTime]);
    }
    spans.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // A boundary is a chunk start that no earlier chunk passes: overlapping chunks stay one piece.
    // A chunk that starts where the previous one ends (several messages at one time, split by
    // size) is cut there; the previous chunk is then decoded again for that time only.
    const boundaries: Time[] = [start];
    let reach = -1n;
    for (const [s, e] of spans) {
      if (s >= reach && s > startNs && (boundaries.length === 1 || s > toNano(boundaries[boundaries.length - 1]))) {
        boundaries.push(fromNano(s));
      }
      if (e > reach) reach = e;
    }
    return Promise.resolve(boundaries);
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
