import { ROS2_TO_DEFINITIONS, Rosbag2 } from '@foxglove/rosbag2';
import { SqliteSqljsDb } from './SqliteSqljsDb';
import { stringify } from "@foxglove/rosmsg";
import type { Initialization, MessageEvent, RosDatatypes, Time, TopicInfo, TopicStats } from '@/core/types/ros';
import type { GetAdjacentMessageArgs, IIterableSource } from "./IIterableSource";
import type { MessageIteratorArgs, GetBackfillMessagesArgs } from '@/infra/workers/types';
import { basicDatatypes } from '@/shared/utils/basicDatatypes';
import type { MessageDefinition } from "@foxglove/message-definition";
import { addMs, addNano, toNano } from '@/shared/utils/time';

function dataTypeToFullName(dataType: string): string {
  const parts = dataType.split("/");
  if (parts.length === 2) {
    return `${parts[0]}/msg/${parts[1]}`;
  }
  return dataType;
}

type RosDb3SourceParams =
  | { type: "files"; files: File[] }
  | { type: "data"; datas: Uint8Array[] };

/** One row from `Rosbag2#readMessages` (library typings are loose). */
interface Rosbag2ReadRow {
  topic: { name: string; type: string };
  timestamp: Time;
  data: Uint8Array;
  value?: unknown;
}

function toMessageEvent(msg: Rosbag2ReadRow): MessageEvent {
  const data = msg.data;
  const value = msg.value;
  return {
    topic: msg.topic.name,
    receiveTime: msg.timestamp,
    publishTime: msg.timestamp,
    message: value !== undefined ? value : data,
    schemaName: msg.topic.type,
    sizeInBytes: data.byteLength,
  };
}

function mergeTopicTimeRange(
  existing: [Time, Time] | undefined,
  next: [Time, Time],
): [Time, Time] {
  if (!existing) return next;
  const [minA, maxA] = existing;
  const [minB, maxB] = next;
  return [
    toNano(minB) < toNano(minA) ? minB : minA,
    toNano(maxB) > toNano(maxA) ? maxB : maxA,
  ];
}

function computeTopicMetrics(
  messageCount: number,
  start?: Time,
  end?: Time,
): { durationSec?: number; frequency: number } {
  const durationSec =
    start && end && toNano(end) > toNano(start)
      ? Number(toNano(end) - toNano(start)) / 1e9
      : undefined;
  const frequency =
    durationSec != null && durationSec > 0 && messageCount > 1 ? (messageCount - 1) / durationSec : 0;
  return { durationSec, frequency: frequency > 0 ? frequency : 0 };
}

export class RosDb3IterableSource implements IIterableSource {
  private _params: RosDb3SourceParams;
  private _sqlWasmBinary?: ArrayBuffer;
  private _bag?: Rosbag2;
  private _start: Time = { sec: 0, nsec: 0 };
  private _end: Time = { sec: 0, nsec: 0 };

  constructor(params: RosDb3SourceParams, options?: { sqlWasmBinary?: ArrayBuffer }) {
    this._params = params;
    this._sqlWasmBinary = options?.sqlWasmBinary;
  }

  async initialize(): Promise<Initialization> {
    await SqliteSqljsDb.initialize({
      ...(this._sqlWasmBinary ? { wasmBinary: this._sqlWasmBinary } : {}),
    });

    const dbs =
      this._params.type === "files"
        ? this._params.files.map((file) => new SqliteSqljsDb(file))
        : this._params.datas.map((data) => new SqliteSqljsDb(data));
    const bag = new Rosbag2(dbs, { timeType: "sec,nsec" });
    await bag.open();
    this._bag = bag;

    const [start, end] = await this._bag.timeRange();
    const topicDefs = await this._bag.readTopics();
    const messageCounts = await this._bag.messageCounts();

    const timeRangeByTopic = new Map<string, [Time, Time]>();
    for (const db of dbs) {
      const ranges = await db.topicTimeRanges();
      for (const [topicName, range] of ranges) {
        timeRangeByTopic.set(topicName, mergeTopicTimeRange(timeRangeByTopic.get(topicName), range));
      }
    }

    const topics: TopicInfo[] = [];
    const topicStats: Record<string, TopicStats> = {};
    const datatypes: RosDatatypes = {};

    // Copy definitions from ROS2_TO_DEFINITIONS and basicDatatypes to plain object
    for (const [key, val] of ROS2_TO_DEFINITIONS) {
      datatypes[key] = val;
    }
    for (const [key, val] of basicDatatypes) {
      datatypes[key] = val;
    }

    for (const topicDef of topicDefs) {
      const numMessages = messageCounts.get(topicDef.name) ?? 0;
      const [topicStart, topicEnd] = timeRangeByTopic.get(topicDef.name) ?? [];
      const { durationSec, frequency } = computeTopicMetrics(numMessages, topicStart, topicEnd);

      const topic: TopicInfo = {
        name: topicDef.name,
        type: topicDef.type,
        messageCount: numMessages,
        durationSec,
        frequency: frequency > 0 ? frequency : undefined,
      };
      topics.push(topic);
      topicStats[topicDef.name] = {
        messageCount: numMessages,
        durationSec,
        frequency,
      };

      const parsedMsgdef = ROS2_TO_DEFINITIONS.get(topicDef.type);
      if (parsedMsgdef) {
        const typesToProcess = [parsedMsgdef];
        const typesForMessage: MessageDefinition[] = [];
        const seenTypes = new Set<string>();
        while (typesToProcess.length > 0) {
          const rosType = typesToProcess.shift()!;
          typesForMessage.push(rosType);
          for (const def of rosType.definitions) {
            const fullTypeName = dataTypeToFullName(def.type);
            if (def.isComplex === true && !seenTypes.has(fullTypeName)) {
              const newComplexType = ROS2_TO_DEFINITIONS.get(fullTypeName);
              if (newComplexType) {
                typesToProcess.push(newComplexType);
                seenTypes.add(fullTypeName);
              }
            }
          }
        }
        const messageDefinition = stringify(typesForMessage);
        console.log(`Generated definition for ${topicDef.type} with length ${messageDefinition.length}`);
      }
    }

    this._start = start;
    this._end = end;

    return {
      topics,
      datatypes,
      start,
      end,
      publishersByTopic: {},
      topicStats,
      problems: [],
      randomAccessByTopic: true,
    };
  }

  async *messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent> {
    if (!this._bag) throw new Error("Not initialized");

    const iterator = this._bag.readMessages({
      startTime: args.startTime,
      endTime: args.endTime ?? this._end,
      topics: args.topics,
    }) as AsyncIterableIterator<Rosbag2ReadRow>;

    for await (const msg of iterator) {
      yield toMessageEvent(msg);
    }
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (!this._bag) throw new Error("Not initialized");

    const messages: MessageEvent[] = [];
    for (const topic of args.topics) {
      let lastBeforeOrAt: MessageEvent | undefined;
      const beforeIterator = this._bag.readMessages({
        startTime: this._start,
        endTime: args.time,
        topics: [topic],
      }) as AsyncIterableIterator<Rosbag2ReadRow>;
      for await (const msg of beforeIterator) {
        lastBeforeOrAt = toMessageEvent(msg);
      }
      if (lastBeforeOrAt) {
        messages.push(lastBeforeOrAt);
        continue;
      }

      const afterIterator = this._bag.readMessages({
        startTime: args.time,
        endTime: this._end,
        topics: [topic],
      }) as AsyncIterableIterator<Rosbag2ReadRow>;
      const result = await afterIterator.next();
      if (!result.done && result.value) {
        messages.push(toMessageEvent(result.value));
      }
    }
    return messages;
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._bag) throw new Error("Not initialized");
    const { time, topics, direction } = args;
    if (topics.length === 0) return null;

    const mapMsg = (msg: Rosbag2ReadRow): MessageEvent => toMessageEvent(msg);

    const tNs = toNano(time);

    if (direction === "next") {
      const iterator = this._bag.readMessages({
        startTime: addMs(time, 0.000001),
        endTime: this._end,
        topics,
      }) as AsyncIterableIterator<Rosbag2ReadRow>;
      for await (const msg of iterator) {
        if (toNano(msg.timestamp) <= tNs) continue;
        return mapMsg(msg);
      }
      return null;
    }

    const windowStart = addMs(time, -2000);
    const endExclusive = addNano(time, -1n);
    let last: MessageEvent | null = null;
    const iterator = this._bag.readMessages({
      startTime: windowStart,
      endTime: endExclusive,
      topics,
    }) as AsyncIterableIterator<Rosbag2ReadRow>;
    for await (const msg of iterator) {
      if (toNano(msg.timestamp) < tNs) {
        last = mapMsg(msg);
      }
    }
    if (last) return last;

    const fallback = this._bag.readMessages({
      startTime: this._start,
      endTime: endExclusive,
      topics,
    }) as AsyncIterableIterator<Rosbag2ReadRow>;
    for await (const msg of fallback) {
      if (toNano(msg.timestamp) < tNs) {
        last = mapMsg(msg);
      }
    }
    return last;
  }
}
