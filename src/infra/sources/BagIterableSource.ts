import { Bag, type Filelike } from "@foxglove/rosbag";
import { BlobReader } from "@foxglove/rosbag/web";
import { parse as parseMessageDefinition } from "@foxglove/rosmsg";
import { MessageReader } from "@foxglove/rosmsg-serialization";
import type {
  Initialization,
  MessageEvent,
  RosDatatypes,
  Time,
  TopicInfo,
  TopicStats,
} from '@/core/types/ros';
import type { GetAdjacentMessageArgs, IIterableSource } from "./IIterableSource";
import type { MessageIteratorArgs, GetBackfillMessagesArgs } from '@/infra/workers/types';
import { loadDecompressHandlers } from "./decompressHandlers";
import { addMs, toNano } from '@/shared/utils/time';

/**
 * Remote byte reader shape accepted by @foxglove/rosbag `Bag` (non-`BlobReader` paths).
 * Must structurally match the library's own `Filelike` (`size(): number`, synchronous) —
 * previously this was hand-rolled with an async/bigint `size()`, which the compiler could
 * not catch because callers cast past it (see the removed `as ConstructorParameters<...>`
 * below). Deriving from `Filelike` directly means any future mismatch is a type error again.
 */
type RemoteBagReadable = Filelike;

type BagSource = { type: "file"; file: Blob } | { type: "remote"; readable: RemoteBagReadable };

/** One message record yielded by `Bag#messageIterator` (library surface is untyped). */
interface BagIteratorMessage {
  connectionId: number;
  topic: string;
  timestamp: Time;
  data: Uint8Array;
}

function asTime(value: unknown): Time {
  if (
    value &&
    typeof value === "object" &&
    "sec" in value &&
    "nsec" in value &&
    typeof (value as { sec: unknown }).sec === "number" &&
    typeof (value as { nsec: unknown }).nsec === "number"
  ) {
    return { sec: (value as Time).sec, nsec: (value as Time).nsec };
  }
  return { sec: 0, nsec: 0 };
}

export class BagIterableSource implements IIterableSource {
  private _source: BagSource;
  private _wasmBinary: ArrayBuffer;
  private _bag?: Bag;
  private _datatypesByConnectionId = new Map<number, string>();
  private _readersByConnectionId = new Map<number, MessageReader>();

  constructor(source: BagSource, options: { wasmBinary: ArrayBuffer }) {
    this._source = source;
    this._wasmBinary = options.wasmBinary;
  }

  async initialize(): Promise<Initialization> {
    const decompressHandlers = await loadDecompressHandlers({ wasmBinary: this._wasmBinary });

    const fileLike: Filelike =
      this._source.type === "remote" ? this._source.readable : new BlobReader(this._source.file);

    // `BlobReader` and `RemoteBagReadable` both satisfy `Filelike` structurally now, so this
    // no longer needs an `as`-cast to bypass the type checker.
    this._bag = new Bag(fileLike, {
      parse: false,
      decompress: {
        // RosView currently supports lz4-compressed ROS1 bag chunks.
        // bz2-compressed chunks are intentionally not handled in the browser pipeline.
        lz4: (buffer: Uint8Array, size: number) => {
          return decompressHandlers.lz4(buffer, BigInt(size));
        },
      },
    });

    await this._bag.open();

    const datatypes: RosDatatypes = {};
    const topics: TopicInfo[] = [];
    const publishersByTopic: Record<string, string[]> = {};
    const topicStats: Record<string, TopicStats> = {};
    const countsByTopic = new Map<string, number>();
    const startByTopic = new Map<string, Time>();
    const endByTopic = new Map<string, Time>();

    for (const chunkInfo of this._bag.chunkInfos) {
      for (const { conn, count } of chunkInfo.connections) {
        const connection = this._bag.connections.get(conn);
        if (!connection) continue;
        countsByTopic.set(connection.topic, (countsByTopic.get(connection.topic) ?? 0) + count);

        const chunkStart = asTime(chunkInfo.startTime);
        const chunkEnd = asTime(chunkInfo.endTime);
        const start = startByTopic.get(connection.topic);
        if (!start || toNano(chunkStart) < toNano(start)) {
          startByTopic.set(connection.topic, chunkStart);
        }
        const end = endByTopic.get(connection.topic);
        if (!end || toNano(chunkEnd) > toNano(end)) {
          endByTopic.set(connection.topic, chunkEnd);
        }
      }
    }

    for (const [id, connection] of this._bag.connections) {
      const schemaName = connection.type;
      if (!schemaName) continue;

      if (!publishersByTopic[connection.topic]) {
        publishersByTopic[connection.topic] = [];
      }
      const publisherId = connection.callerid ?? String(connection.conn);
      if (!publishersByTopic[connection.topic].includes(publisherId)) {
        publishersByTopic[connection.topic].push(publisherId);
      }

      const existingTopic = topics.find(t => t.name === connection.topic);
      if (!existingTopic) {
        const messageCount = countsByTopic.get(connection.topic) ?? 0;
        const start = startByTopic.get(connection.topic);
        const end = endByTopic.get(connection.topic);
        const durationSec =
          start && end && toNano(end) > toNano(start)
            ? Number(toNano(end) - toNano(start)) / 1e9
            : undefined;
        const frequency =
          durationSec != null && durationSec > 0 && messageCount > 1 ? (messageCount - 1) / durationSec : 0;
        topics.push({
          name: connection.topic,
          type: schemaName,
          messageCount,
          durationSec,
          frequency: frequency > 0 ? frequency : undefined,
        });
        topicStats[connection.topic] = {
          messageCount,
          durationSec,
          frequency: frequency > 0 ? frequency : 0,
        };
      }

      const parsedDefinitions = parseMessageDefinition(connection.messageDefinition);
      this._readersByConnectionId.set(id, new MessageReader(parsedDefinitions));
      for (const definition of parsedDefinitions) {
        if (!definition.name) {
          datatypes[schemaName] = definition;
        } else {
          datatypes[definition.name] = definition;
        }
      }

      this._datatypesByConnectionId.set(id, schemaName);
    }

    return {
      topics,
      datatypes,
      start: this._bag.startTime ?? { sec: 0, nsec: 0 },
      end: this._bag.endTime ?? { sec: 0, nsec: 0 },
      publishersByTopic,
      topicStats,
      problems: [],
      randomAccessByTopic: false,
    };
  }

  async *messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent> {
    if (!this._bag) throw new Error("Not initialized");

    const iterator = this._bag.messageIterator({
      topics: args.topics,
      start: args.startTime,
      reverse: false,
    }) as AsyncIterableIterator<BagIteratorMessage>;

    for await (const bagMsgEvent of iterator) {
      if (args.endTime && (bagMsgEvent.timestamp.sec > args.endTime.sec || (bagMsgEvent.timestamp.sec === args.endTime.sec && bagMsgEvent.timestamp.nsec > args.endTime.nsec))) {
        return;
      }

      const schemaName = this._datatypesByConnectionId.get(bagMsgEvent.connectionId);
      if (!schemaName) continue;

      const reader = this._readersByConnectionId.get(bagMsgEvent.connectionId);
      let deserialized: unknown = bagMsgEvent.data;
      if (reader) {
        try {
          deserialized = reader.readMessage(bagMsgEvent.data);
        } catch (e) {
          console.warn(`BagIterableSource: deserialize failed for ${bagMsgEvent.topic}`, e);
        }
      }

      const event: MessageEvent = {
        topic: bagMsgEvent.topic,
        receiveTime: bagMsgEvent.timestamp,
        publishTime: bagMsgEvent.timestamp,
        message: deserialized,
        schemaName,
        sizeInBytes: bagMsgEvent.data.byteLength,
      };
      yield event;
    }
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (!this._bag) throw new Error("Not initialized");
    const messages: MessageEvent[] = [];

    for (const topic of args.topics) {
      const iterator = this._bag.messageIterator({
        topics: [topic],
        start: args.time,
        reverse: true,
      }) as AsyncIterableIterator<BagIteratorMessage>;

      const result = await iterator.next();
      if (!result.done && result.value) {
        const bagMsgEvent = result.value;
        const schemaName = this._datatypesByConnectionId.get(bagMsgEvent.connectionId);
        if (schemaName) {
          const reader = this._readersByConnectionId.get(bagMsgEvent.connectionId);
          let deserialized: unknown = bagMsgEvent.data;
          if (reader) {
            try {
              deserialized = reader.readMessage(bagMsgEvent.data);
            } catch {
              /* keep raw */
            }
          }
          messages.push({
            topic: bagMsgEvent.topic,
            receiveTime: bagMsgEvent.timestamp,
            publishTime: bagMsgEvent.timestamp,
            message: deserialized,
            schemaName,
            sizeInBytes: bagMsgEvent.data.byteLength,
          });
        }
      }
    }

    return messages;
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._bag) throw new Error("Not initialized");
    const { time, topics, direction } = args;
    if (topics.length === 0) return null;

    const startTime = direction === "next" ? addMs(time, 0.000001) : time;
    const iterator = this._bag.messageIterator({
      topics,
      start: startTime,
      reverse: direction === "prev",
    }) as AsyncIterableIterator<BagIteratorMessage>;

    const tNs = toNano(time);
    for await (const bagMsgEvent of iterator) {
      const msgNs = toNano(bagMsgEvent.timestamp);
      if (direction === "next" && msgNs <= tNs) {
        continue;
      }
      if (direction === "prev" && msgNs >= tNs) {
        continue;
      }
      const schemaName = this._datatypesByConnectionId.get(bagMsgEvent.connectionId);
      if (!schemaName) continue;
      const reader = this._readersByConnectionId.get(bagMsgEvent.connectionId);
      let deserialized: unknown = bagMsgEvent.data;
      if (reader) {
        try {
          deserialized = reader.readMessage(bagMsgEvent.data);
        } catch {
          /* keep raw */
        }
      }
      return {
        topic: bagMsgEvent.topic,
        receiveTime: bagMsgEvent.timestamp,
        publishTime: bagMsgEvent.timestamp,
        message: deserialized,
        schemaName,
        sizeInBytes: bagMsgEvent.data.byteLength,
      };
    }
    return null;
  }
}
