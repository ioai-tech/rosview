import type { IReadable, McapTypes } from "@mcap/core";
import type {
  Initialization,
  MessageEvent,
  PlayerProblem,
  RosDatatypes,
  TopicInfo,
  TopicStats,
} from '@/core/types/ros';
import type { GetAdjacentMessageArgs, IIterableSource } from "./IIterableSource";
import type { MessageIteratorArgs, GetBackfillMessagesArgs } from '@/infra/workers/types';
import { parseChannel } from "./parseChannel";
import type { ParsedChannel } from "./parseChannel";
import { fromNano, toNano } from '@/shared/utils/time';

/**
 * Reads MCAP files that have no summary section / chunk index (e.g. recorders
 * that stream records and never write a summary, or a recording that was cut
 * short). `McapIndexedReader` refuses these, so we scan the data section once
 * and build an in-memory message index (offsets only, no payloads), then serve
 * random-access reads from it.
 */

const MCAP_MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];

const OP_HEADER = 0x01;
const OP_FOOTER = 0x02;
const OP_SCHEMA = 0x03;
const OP_CHANNEL = 0x04;
const OP_MESSAGE = 0x05;
const OP_CHUNK = 0x06;
const OP_DATA_END = 0x0f;

/** channelId u16 + sequence u32 + logTime u64 + publishTime u64 */
const MESSAGE_PREFIX_BYTES = 22;
const RECORD_PREFIX_BYTES = 9;
const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
const CHUNK_CACHE_SIZE = 4;

interface ScannedSchema {
  id: number;
  name: string;
  encoding: string;
  data: Uint8Array;
}

interface ScannedChannel {
  id: number;
  schemaId: number;
  topic: string;
  messageEncoding: string;
  metadata: Map<string, string>;
}

interface ScannedChunk {
  /** File offset of the (compressed) records blob. */
  recordsOffset: number;
  recordsLength: number;
  compression: string;
  uncompressedSize: bigint;
}

interface IndexedMessage {
  channelId: number;
  logTime: bigint;
  publishTime: bigint;
  /** File offset of the payload, or offset inside the decompressed chunk when `chunk >= 0`. */
  offset: number;
  length: number;
  chunk: number;
}

export interface McapScanProgress {
  scannedBytes: number;
  totalBytes: number;
}

export interface McapUnindexedScanOptions {
  decompressHandlers?: McapTypes.DecompressHandlers;
  onProgress?: (progress: McapScanProgress) => void;
}

class BinaryCursor {
  private _bytes: Uint8Array;
  private _view: DataView;
  private _textDecoder = new TextDecoder();
  offset = 0;

  constructor(bytes: Uint8Array) {
    this._bytes = bytes;
    this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(): number {
    const v = this._view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this._view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this._view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  bytes(length: number): Uint8Array {
    const v = this._bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return v;
  }

  string(): string {
    return this._textDecoder.decode(this.bytes(this.u32()));
  }

  stringMap(): Map<string, string> {
    const end = this.u32() + this.offset;
    const map = new Map<string, string>();
    while (this.offset < end) {
      map.set(this.string(), this.string());
    }
    return map;
  }
}

/** Sequential read-ahead window over an `IReadable` for the one-pass scan. */
class WindowedReader {
  private _readable: IReadable;
  private _size: number;
  private _buf: Uint8Array = new Uint8Array(0);
  private _bufStart = 0;

  constructor(readable: IReadable, size: number) {
    this._readable = readable;
    this._size = size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset >= this._bufStart && offset + length <= this._bufStart + this._buf.byteLength) {
      return this._buf.subarray(offset - this._bufStart, offset - this._bufStart + length);
    }
    if (length > SCAN_WINDOW_BYTES) {
      return await this._readable.read(BigInt(offset), BigInt(length));
    }
    const windowLength = Math.min(this._size - offset, SCAN_WINDOW_BYTES);
    this._buf = await this._readable.read(BigInt(offset), BigInt(windowLength));
    this._bufStart = offset;
    return this._buf.subarray(0, length);
  }
}

function compareLogTime(a: IndexedMessage, b: IndexedMessage): number {
  return a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0;
}

/** First index whose logTime >= t (or > t when `strict`). */
function lowerBound(messages: IndexedMessage[], t: bigint, strict = false): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = messages[mid].logTime;
    if (v < t || (strict && v === t)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class McapUnindexedIterableSource implements IIterableSource {
  private _readable: IReadable;
  private _options: McapUnindexedScanOptions;
  private _schemas = new Map<number, ScannedSchema>();
  private _channels = new Map<number, ScannedChannel>();
  private _chunks: ScannedChunk[] = [];
  private _messages: IndexedMessage[] = [];
  private _messagesByTopic = new Map<string, IndexedMessage[]>();
  private _parsedChannels = new Map<number, ParsedChannel>();
  private _chunkCache = new Map<number, Uint8Array>();
  private _problems: PlayerProblem[] = [];
  private _endNs = 0n;

  constructor(readable: IReadable, options: McapUnindexedScanOptions = {}) {
    this._readable = readable;
    this._options = options;
  }

  async initialize(): Promise<Initialization> {
    await this._scan();

    this._messages.sort(compareLogTime);
    for (const message of this._messages) {
      const topic = this._channels.get(message.channelId)?.topic;
      if (topic == undefined) continue;
      let list = this._messagesByTopic.get(topic);
      if (!list) {
        list = [];
        this._messagesByTopic.set(topic, list);
      }
      list.push(message);
    }

    const topics: TopicInfo[] = [];
    const datatypes: RosDatatypes = {};
    const publishersByTopic: Record<string, string[]> = {};
    const topicStats: Record<string, TopicStats> = {};
    const registeredTopics = new Set<string>();

    for (const channel of this._channels.values()) {
      const schema = channel.schemaId !== 0 ? this._schemas.get(channel.schemaId) : undefined;
      try {
        const parsedChannel = parseChannel({ messageEncoding: channel.messageEncoding, schema });
        this._parsedChannels.set(channel.id, parsedChannel);
        for (const [name, definition] of parsedChannel.datatypes) {
          datatypes[name] = definition;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to parse channel ${channel.id}:`, err);
        this._problems.push({ severity: "warn", message: `Channel ${channel.id} (${channel.topic}): ${msg}` });
        this._parsedChannels.set(channel.id, {
          datatypes: new Map(),
          deserialize: (data) => ({ _rosviewDecodeFailed: true, message: msg, byteLength: data.byteLength }),
        });
      }

      const publisher = channel.metadata.get("publisher") ?? "unknown";
      const publishers = (publishersByTopic[channel.topic] ??= []);
      if (!publishers.includes(publisher)) publishers.push(publisher);

      if (registeredTopics.has(channel.topic)) continue;
      registeredTopics.add(channel.topic);
      topics.push({ name: channel.topic, type: schema?.name ?? "unknown" });

      const list = this._messagesByTopic.get(channel.topic) ?? [];
      const firstNs = list[0]?.logTime;
      const lastNs = list[list.length - 1]?.logTime;
      const durationSec =
        firstNs != null && lastNs != null && lastNs > firstNs ? Number(lastNs - firstNs) / 1e9 : undefined;
      const frequency = durationSec != null && list.length > 1 ? (list.length - 1) / durationSec : 0;
      topicStats[channel.topic] = { messageCount: list.length, frequency, durationSec };
    }

    const startNs = this._messages[0]?.logTime ?? 0n;
    this._endNs = this._messages[this._messages.length - 1]?.logTime ?? 0n;

    console.debug("McapUnindexedIterableSource: initialized", {
      topicCount: topics.length,
      messageCount: this._messages.length,
    });

    return {
      topics,
      datatypes,
      start: fromNano(startNs),
      end: fromNano(this._endNs),
      publishersByTopic,
      topicStats,
      problems: this._problems,
      randomAccessByTopic: true,
    };
  }

  async *messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent> {
    const startNs = toNano(args.startTime);
    const endNs = args.endTime ? toNano(args.endTime) : this._endNs;
    const topics = new Set(args.topics);
    for (let i = lowerBound(this._messages, startNs); i < this._messages.length; i++) {
      const message = this._messages[i];
      if (message.logTime > endNs) break;
      const channel = this._channels.get(message.channelId);
      if (!channel || !topics.has(channel.topic)) continue;
      const event = await this._toEvent(message);
      if (event) yield event;
    }
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    const t = toNano(args.time);
    const events: MessageEvent[] = [];
    for (const topic of args.topics) {
      const list = this._messagesByTopic.get(topic);
      if (!list || list.length === 0) continue;
      // Latest message at or before `t`; fall forward to the first one when seeking before it.
      const index = Math.max(0, lowerBound(list, t, true) - 1);
      const event = await this._toEvent(list[index]);
      if (event) events.push(event);
    }
    return events;
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    const t = toNano(args.time);
    let best: IndexedMessage | undefined;
    for (const topic of args.topics) {
      const list = this._messagesByTopic.get(topic);
      if (!list) continue;
      if (args.direction === "next") {
        const candidate = list[lowerBound(list, t, true)];
        if (candidate && (!best || candidate.logTime < best.logTime)) best = candidate;
      } else {
        const candidate = list[lowerBound(list, t) - 1];
        if (candidate && (!best || candidate.logTime > best.logTime)) best = candidate;
      }
    }
    return best ? ((await this._toEvent(best)) ?? null) : null;
  }

  private async _toEvent(message: IndexedMessage): Promise<MessageEvent | undefined> {
    const channel = this._channels.get(message.channelId);
    const parsedChannel = this._parsedChannels.get(message.channelId);
    if (!channel || !parsedChannel) return undefined;
    const data = await this._readPayload(message);
    return {
      topic: channel.topic,
      receiveTime: fromNano(message.logTime),
      publishTime: fromNano(message.publishTime),
      message: parsedChannel.deserialize(data),
      schemaName: this._schemas.get(channel.schemaId)?.name ?? "",
    };
  }

  private async _readPayload(message: IndexedMessage): Promise<Uint8Array> {
    if (message.chunk < 0) {
      return await this._readable.read(BigInt(message.offset), BigInt(message.length));
    }
    const records = await this._loadChunk(message.chunk);
    return records.subarray(message.offset, message.offset + message.length);
  }

  private async _loadChunk(index: number): Promise<Uint8Array> {
    const cached = this._chunkCache.get(index);
    if (cached) {
      // Refresh LRU position.
      this._chunkCache.delete(index);
      this._chunkCache.set(index, cached);
      return cached;
    }
    const chunk = this._chunks[index];
    const compressed = await this._readable.read(BigInt(chunk.recordsOffset), BigInt(chunk.recordsLength));
    const records = this._decompress(chunk, compressed);
    this._chunkCache.set(index, records);
    if (this._chunkCache.size > CHUNK_CACHE_SIZE) {
      this._chunkCache.delete(this._chunkCache.keys().next().value!);
    }
    return records;
  }

  private _decompress(chunk: ScannedChunk, compressed: Uint8Array): Uint8Array {
    if (chunk.compression === "") return compressed;
    const handler = this._options.decompressHandlers?.[chunk.compression];
    if (!handler) {
      throw new Error(`Unsupported MCAP chunk compression "${chunk.compression}"`);
    }
    return handler(compressed, chunk.uncompressedSize);
  }

  private async _scan(): Promise<void> {
    const size = Number(await this._readable.size());
    const reader = new WindowedReader(this._readable, size);
    const magic = await reader.read(0, Math.min(size, MCAP_MAGIC.length));
    if (magic.length < MCAP_MAGIC.length || MCAP_MAGIC.some((b, i) => magic[i] !== b)) {
      throw new Error("Not a valid MCAP file (missing magic)");
    }

    const onProgress = this._options.onProgress;
    let lastReported = 0;
    let offset = MCAP_MAGIC.length;
    while (offset + RECORD_PREFIX_BYTES <= size) {
      const prefix = new BinaryCursor(await reader.read(offset, RECORD_PREFIX_BYTES));
      const opcode = prefix.bytes(1)[0];
      const length = Number(prefix.u64());
      const bodyOffset = offset + RECORD_PREFIX_BYTES;
      if (opcode === OP_FOOTER || opcode === OP_DATA_END) break;
      if (bodyOffset + length > size) {
        this._problems.push({
          severity: "warn",
          message: `MCAP file is truncated at byte ${offset}; showing messages recorded before that point.`,
        });
        break;
      }

      switch (opcode) {
        case OP_MESSAGE: {
          const cursor = new BinaryCursor(await reader.read(bodyOffset, MESSAGE_PREFIX_BYTES));
          this._indexMessage(cursor, bodyOffset + MESSAGE_PREFIX_BYTES, length - MESSAGE_PREFIX_BYTES, -1);
          break;
        }
        case OP_CHUNK:
          this._scanChunk(await reader.read(bodyOffset, length), bodyOffset);
          break;
        case OP_HEADER:
        case OP_SCHEMA:
        case OP_CHANNEL:
          this._parseDefinitionRecord(opcode, new BinaryCursor(await reader.read(bodyOffset, length)));
          break;
        default:
          break;
      }

      offset = bodyOffset + length;
      if (onProgress && offset - lastReported >= SCAN_WINDOW_BYTES) {
        lastReported = offset;
        onProgress({ scannedBytes: offset, totalBytes: size });
      }
    }
    onProgress?.({ scannedBytes: size, totalBytes: size });
  }

  private _indexMessage(cursor: BinaryCursor, offset: number, length: number, chunk: number): void {
    const channelId = cursor.u16();
    cursor.u32(); // sequence
    const logTime = cursor.u64();
    const publishTime = cursor.u64();
    this._messages.push({ channelId, logTime, publishTime, offset, length, chunk });
  }

  private _parseDefinitionRecord(opcode: number, cursor: BinaryCursor): void {
    if (opcode === OP_SCHEMA) {
      const id = cursor.u16();
      const name = cursor.string();
      const encoding = cursor.string();
      // Copy: the scan window buffer is reused.
      const data = cursor.bytes(cursor.u32()).slice();
      this._schemas.set(id, { id, name, encoding, data });
    } else if (opcode === OP_CHANNEL) {
      const id = cursor.u16();
      const schemaId = cursor.u16();
      const topic = cursor.string();
      const messageEncoding = cursor.string();
      const metadata = cursor.stringMap();
      this._channels.set(id, { id, schemaId, topic, messageEncoding, metadata });
    }
  }

  private _scanChunk(body: Uint8Array, bodyOffset: number): void {
    const cursor = new BinaryCursor(body);
    cursor.u64(); // message start time
    cursor.u64(); // message end time
    const uncompressedSize = cursor.u64();
    cursor.u32(); // uncompressed crc
    const compression = cursor.string();
    const recordsLength = Number(cursor.u64());
    const chunk: ScannedChunk = {
      recordsOffset: bodyOffset + cursor.offset,
      recordsLength,
      compression,
      uncompressedSize,
    };
    const chunkIndex = this._chunks.length;
    this._chunks.push(chunk);

    const records = this._decompress(chunk, cursor.bytes(recordsLength));
    const inner = new BinaryCursor(records);
    while (inner.offset + RECORD_PREFIX_BYTES <= records.byteLength) {
      const opcode = inner.bytes(1)[0];
      const length = Number(inner.u64());
      const start = inner.offset;
      if (opcode === OP_MESSAGE) {
        this._indexMessage(inner, start + MESSAGE_PREFIX_BYTES, length - MESSAGE_PREFIX_BYTES, chunkIndex);
      } else if (opcode === OP_SCHEMA || opcode === OP_CHANNEL) {
        this._parseDefinitionRecord(opcode, new BinaryCursor(inner.bytes(length)));
      }
      inner.offset = start + length;
    }
  }
}
