import * as Comlink from "comlink";
import type { MessageEvent, Time } from '@/core/types/ros';
import type { IMessageCursor } from "./types";
import { toNano } from '@/shared/utils/time';
import type { WorkerTransportConfig } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { collectTransferables } from "./transferables";
import { workerPerf } from "./workerPerf";

type MessageCursorOptions = {
  latestOnlyTopics?: readonly string[];
  maxBufferDurationMs?: number;
};

type MessageCursorConfig = WorkerTransportConfig & MessageCursorOptions;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function toThrownError(err: unknown): Error {
  if (err instanceof Error) return err;
  try {
    return new Error(typeof err === 'string' ? err : JSON.stringify(err));
  } catch {
    return new Error('MessageCursor pump failed');
  }
}

export class MessageCursor implements IMessageCursor<unknown> {
  private static readonly DEFAULT_MAX_BATCH_MESSAGES = 256;
  private static readonly DEFAULT_MAX_BATCH_WALL_MS = 6;
  private static readonly DEFAULT_MAX_BUFFER_MESSAGES = 768;
  private static readonly DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
  private static readonly EMPTY_QUEUE_WAIT_MS = 50;
  private static readonly MAX_PUMP_SLICE_MESSAGES = 64;
  private static readonly MAX_PUMP_SLICE_WALL_MS = 8;
  private _iterator: AsyncIterableIterator<MessageEvent>;
  private _transportConfig: WorkerTransportConfig;
  private _latestOnlyTopics: ReadonlySet<string>;
  private _maxBufferDurationMs: number | undefined;
  private _sharedRing?: SharedPayloadRing;
  private _queue: MessageEvent[] = [];
  private _queueBytes = 0;
  private _done = false;
  private _closed = false;
  private _pumpError: unknown;
  private _queueWaiters: Array<() => void> = [];
  private _capacityWaiters: Array<() => void> = [];
  private _pendingMessage: MessageEvent | undefined;

  constructor(
    iterator: AsyncIterableIterator<MessageEvent>,
    transportConfig: MessageCursorConfig,
  ) {
    this._iterator = iterator;
    this._transportConfig = transportConfig;
    this._latestOnlyTopics = new Set(transportConfig.latestOnlyTopics ?? []);
    const maxBufferDurationMs = transportConfig.maxBufferDurationMs;
    this._maxBufferDurationMs = typeof maxBufferDurationMs === "number" && Number.isFinite(maxBufferDurationMs)
      ? Math.max(1, maxBufferDurationMs)
      : undefined;
    if (transportConfig.mode === "sab" && transportConfig.payloadRing) {
      this._sharedRing = new SharedPayloadRing(transportConfig.payloadRing);
    }
    void this._pump();
  }

  async next(): Promise<IteratorResult<MessageEvent>> {
    await this._waitForQueue();
    if (this._pumpError) {
      throw toThrownError(this._pumpError);
    }
    const nextMessage = this._dequeue();
    if (!nextMessage) {
      return { done: true, value: undefined };
    }
    return this._transferMessage(nextMessage);
  }

  async nextBatch(
    durationMs: number,
    options?: { maxMessages?: number; maxWallTimeMs?: number; endTime?: Time; waitForData?: boolean },
  ): Promise<MessageEvent[]> {
    const batchStart = performance.now();
    const maxMessages = Math.max(1, options?.maxMessages ?? MessageCursor.DEFAULT_MAX_BATCH_MESSAGES);
    const maxWallTimeMs = Math.max(1, options?.maxWallTimeMs ?? MessageCursor.DEFAULT_MAX_BATCH_WALL_MS);
    const messages: MessageEvent[] = [];
    const startTime = Date.now();
    const waitStart = performance.now();

    await this._waitForQueue(options?.waitForData ? undefined : MessageCursor.EMPTY_QUEUE_WAIT_MS);
    workerPerf.record("cursor.nextBatch.waitForQueue", performance.now() - waitStart);
    if (this._pumpError) {
      throw toThrownError(this._pumpError);
    }
    const first = this._takeNextQueuedMessage();
    if (!first) {
      workerPerf.recordGauge("cursor.queue.messages", this._queue.length);
      workerPerf.recordGauge("cursor.queue.mb", this._queueBytes / (1024 * 1024));
      workerPerf.recordGauge("cursor.queue.durationMs", this._queueDurationMs());
      workerPerf.recordGauge("cursor.nextBatch.rawMessages", 0);
      workerPerf.recordGauge("cursor.nextBatch.sentMessages", 0);
      return [];
    }
    if (options?.endTime && toNano(first.receiveTime) > toNano(options.endTime)) {
      this._pendingMessage = first;
      workerPerf.recordGauge("cursor.nextBatch.rawMessages", 0);
      workerPerf.recordGauge("cursor.nextBatch.sentMessages", 0);
      return [];
    }
    messages.push(first);

    const dataStartNano = toNano(first.receiveTime);
    const dataEndNano = options?.endTime ? toNano(options.endTime) : dataStartNano + BigInt(Math.round(durationMs * 1000000));

    while (Date.now() - startTime < maxWallTimeMs) {
      const result = this._takeNextQueuedMessage();
      if (!result) break;

      if (toNano(result.receiveTime) > dataEndNano) {
        this._pendingMessage = result;
        break;
      }
      messages.push(result);
      if (messages.length >= maxMessages) break;
    }

    const coalesced = this._coalesceLatestOnlyTopics(messages);
    workerPerf.recordGauge("cursor.queue.messages", this._queue.length);
    workerPerf.recordGauge("cursor.queue.mb", this._queueBytes / (1024 * 1024));
    workerPerf.recordGauge("cursor.queue.durationMs", this._queueDurationMs());
    workerPerf.recordGauge("cursor.nextBatch.rawMessages", messages.length);
    workerPerf.recordGauge("cursor.nextBatch.sentMessages", coalesced.length);
    const transferred = this._transferBatch(coalesced);
    workerPerf.record("cursor.nextBatch.total", performance.now() - batchStart);
    return transferred;
  }

  async end(): Promise<void> {
    this._closed = true;
    this._notifyQueueWaiters();
    this._notifyCapacityWaiters();
    if (this._iterator.return) {
      await this._iterator.return();
    }
  }

  private async _pump(): Promise<void> {
    try {
      let sliceStart = performance.now();
      let sliceMessages = 0;
      while (!this._closed && !this._done) {
        if (
          this._queue.length >= MessageCursor.DEFAULT_MAX_BUFFER_MESSAGES ||
          this._queueBytes >= MessageCursor.DEFAULT_MAX_BUFFER_BYTES ||
          this._isPastBufferDurationLimit()
        ) {
          await this._waitForCapacity();
          continue;
        }

        const result = await workerPerf.timeAsync("cursor.iterator.next", () => this._iterator.next());
        if (result.done) {
          this._done = true;
          this._notifyQueueWaiters();
          return;
        }

        const normalized = workerPerf.time("cursor.normalize", () => this._normalizeMessage(result.value));
        this._queue.push(normalized);
        this._queueBytes += this._estimateMessageBytes(normalized);
        this._notifyQueueWaiters();

        sliceMessages += 1;
        const elapsedMs = performance.now() - sliceStart;
        if (
          sliceMessages >= MessageCursor.MAX_PUMP_SLICE_MESSAGES ||
          elapsedMs >= MessageCursor.MAX_PUMP_SLICE_WALL_MS
        ) {
          workerPerf.record("cursor.pump.slice", elapsedMs);
          workerPerf.recordGauge("cursor.queue.messages", this._queue.length);
          workerPerf.recordGauge("cursor.queue.mb", this._queueBytes / (1024 * 1024));
          workerPerf.recordGauge("cursor.queue.durationMs", this._queueDurationMs());
          await yieldToEventLoop();
          sliceStart = performance.now();
          sliceMessages = 0;
        }
      }
    } catch (error) {
      if (!this._closed) {
        this._pumpError = error;
        this._notifyQueueWaiters();
      }
    }
  }

  private _dequeue(): MessageEvent | undefined {
    const message = this._queue.shift();
    if (!message) {
      return undefined;
    }
    this._queueBytes = Math.max(0, this._queueBytes - this._estimateMessageBytes(message));
    this._notifyCapacityWaiters();
    return message;
  }

  private _takeNextQueuedMessage(): MessageEvent | undefined {
    const pending = this._pendingMessage;
    if (pending) {
      this._pendingMessage = undefined;
      return pending;
    }
    return this._dequeue();
  }

  private async _waitForQueue(timeoutMs?: number): Promise<void> {
    if (this._queue.length > 0 || this._done || this._closed || this._pumpError) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        if (timeout != undefined) {
          clearTimeout(timeout);
        }
        resolve();
      };
      const timeout =
        timeoutMs == undefined
          ? undefined
          : setTimeout(() => {
              this._queueWaiters = this._queueWaiters.filter((waiter) => waiter !== done);
              resolve();
            }, timeoutMs);
      this._queueWaiters.push(done);
    });
  }

  private async _waitForCapacity(): Promise<void> {
    if (
      this._closed ||
      (this._queue.length < MessageCursor.DEFAULT_MAX_BUFFER_MESSAGES &&
        this._queueBytes < MessageCursor.DEFAULT_MAX_BUFFER_BYTES &&
        !this._isPastBufferDurationLimit())
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      this._capacityWaiters.push(resolve);
    });
  }

  private _notifyQueueWaiters(): void {
    const waiters = this._queueWaiters;
    this._queueWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private _notifyCapacityWaiters(): void {
    const waiters = this._capacityWaiters;
    this._capacityWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private _transferMessage(message: MessageEvent): IteratorResult<MessageEvent> {
    message = this._prepareMessageForTransport(message);
    if (this._transportConfig.mode === "transfer" || this._transportConfig.mode === "sab") {
      const transferables = workerPerf.time("cursor.collectTransferables", () => collectTransferables([message]));
      if (transferables.length > 0) {
        return Comlink.transfer(
          { done: false, value: message },
          transferables,
        ) as IteratorResult<MessageEvent>;
      }
    }
    return { done: false, value: message };
  }

  private _transferBatch(messages: MessageEvent[]): MessageEvent[] {
    messages = messages.map((message) => this._prepareMessageForTransport(message));
    if (this._transportConfig.mode === "transfer" || this._transportConfig.mode === "sab") {
      const transferables = workerPerf.time("cursor.collectTransferables", () => collectTransferables(messages));
      if (transferables.length > 0) {
        return Comlink.transfer(messages, transferables);
      }
    }
    return messages;
  }

  private _coalesceLatestOnlyTopics(messages: MessageEvent[]): MessageEvent[] {
    if (this._latestOnlyTopics.size === 0 || messages.length <= 1) {
      return messages;
    }
    const latestIndexByTopic = new Map<string, number>();
    for (let index = 0; index < messages.length; index += 1) {
      const topic = messages[index]?.topic;
      if (topic != undefined && this._latestOnlyTopics.has(topic)) {
        latestIndexByTopic.set(topic, index);
      }
    }
    if (latestIndexByTopic.size === 0) {
      return messages;
    }
    return messages.filter((message, index) => {
      const latestIndex = latestIndexByTopic.get(message.topic);
      return latestIndex == undefined || latestIndex === index;
    });
  }

  private _queueDurationMs(): number {
    const first = this._pendingMessage ?? this._queue[0];
    const last = this._queue[this._queue.length - 1] ?? this._pendingMessage;
    if (!first || !last) {
      return 0;
    }
    const durationNs = toNano(last.receiveTime) - toNano(first.receiveTime);
    if (durationNs <= 0n) {
      return 0;
    }
    return Number(durationNs) / 1e6;
  }

  private _isPastBufferDurationLimit(): boolean {
    return this._maxBufferDurationMs != undefined && this._queueDurationMs() >= this._maxBufferDurationMs;
  }

  private _prepareMessageForTransport(event: MessageEvent): MessageEvent {
    const message = event.message;
    if (!message || typeof message !== "object") {
      return event;
    }

    const messageRecord = message as Record<string, unknown>;
    const dataField = messageRecord.data;
    if (!(dataField instanceof Uint8Array)) {
      return event;
    }

    if (
      this._transportConfig.mode === "sab" &&
      this._sharedRing &&
      dataField.byteLength >= this._transportConfig.binaryPayloadThresholdBytes
    ) {
      const sharedRef = workerPerf.time(
        "cursor.sharedRing.write",
        () => this._sharedRing!.write(dataField),
        dataField.byteLength,
      );
      if (sharedRef) {
        return {
          ...event,
          payloadKind: "hybrid-sab",
          sizeInBytes: dataField.byteLength,
          message: {
            ...messageRecord,
            data: sharedRef,
          },
        };
      }
    }

    // CDR deserializers return zero-copy subarrays backed by the entire
    // decompressed MCAP chunk (~779 KiB+). Without compacting, `collectTransferables`
    // rejects the shared chunk buffer and `postMessage` clones the full chunk per
    // batch, and the Image panel copies it again before transferring to its render
    // worker. Compacting once here enables end-to-end zero-copy transfers and keeps
    // cached chunk buffers completely unshared.
    if (
      (this._transportConfig.mode === "transfer" || this._transportConfig.mode === "sab") &&
      dataField.byteLength > 0 &&
      dataField.buffer instanceof ArrayBuffer &&
      (dataField.byteOffset !== 0 || dataField.byteLength !== dataField.buffer.byteLength) &&
      dataField.buffer.byteLength > dataField.byteLength * 2
    ) {
      return {
        ...event,
        sizeInBytes: dataField.byteLength,
        message: {
          ...messageRecord,
          data: dataField.slice(),
        },
      };
    }

    return event;
  }

  private _estimateMessageBytes(event: MessageEvent): number {
    const message = event.message;
    if (!message || typeof message !== "object") {
      return 0;
    }
    const data = (message as Record<string, unknown>).data;
    if (data instanceof Uint8Array) {
      return data.byteLength;
    }
    const sizeInBytes = (event as MessageEvent & { sizeInBytes?: number }).sizeInBytes;
    return typeof sizeInBytes === "number" && Number.isFinite(sizeInBytes) ? sizeInBytes : 0;
  }

  private _normalizeMessage(event: MessageEvent): MessageEvent {
    const threshold = this._transportConfig.binaryPayloadThresholdBytes;
    const message = event.message;
    if (!message || typeof message !== "object") {
      return event;
    }

    const messageRecord = message as Record<string, unknown>;
    const dataField = messageRecord.data;
    if (!(dataField instanceof Uint8Array)) {
      return event;
    }
    if (dataField.byteLength < threshold) {
      return event;
    }

    if (this._transportConfig.mode === "sab" && this._sharedRing) {
      return event;
    }

    if (this._transportConfig.mode === "transfer") {
      const mutableEvent = event as MessageEvent & { payloadKind?: string; sizeInBytes?: number };
      mutableEvent.payloadKind = "hybrid-transfer";
      mutableEvent.sizeInBytes = dataField.byteLength;
      return mutableEvent;
    }
    return event;
  }
}
