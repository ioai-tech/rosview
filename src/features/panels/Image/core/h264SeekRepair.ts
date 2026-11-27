import type { Player } from '@/core/types/player';
import type { MessageEvent as RosMessageEvent, Time } from '@/core/types/ros';
import { withTimeout } from '@/shared/utils/asyncTimeout';
import { addMs, toNano } from '@/shared/utils/time';
import { containsH264IdrNal, parseH264SpsCodec } from './h264';
import { selectLatestCompleteH264Gop } from './h264Queue';
import type { ImageRenderWorkerRequest, ImageWorkerFrameEnvelope } from './imageWorkerProtocol';
import { getH264MessagePayload, isH264MessageEvent, toWorkerFrame } from './messageFrameAdapter';

/** Progressive lookback windows when searching for a keyframe before a seek target. */
export const H264_SEEK_WINDOWS_MS = [2000, 5000, 10_000, 30_000] as const;

/**
 * Maximum frame messages posted for one seek repair.
 *
 * Must exceed one GOP for the recordings we support, otherwise a seek target
 * further than this from its IDR silently lands on the wrong frame. Robot
 * recordings routinely use a 256-frame (8.5s at 30fps) keyframe interval, and
 * some carry a single IDR for the whole file.
 */
export const H264_SEEK_MAX_FRAMES = 600;

/** Forward read when bootstrapping at/before the file's first IDR. */
/** Small forward slack on the initial lookback window for file-start IDRs (e.g. +19..33ms). */
const H264_BOOTSTRAP_INITIAL_FORWARD_MS = 200;
export const H264_BOOTSTRAP_FORWARD_MS = 2_000;
export const H264_BOOTSTRAP_DEADLINE_MS = 15_000;
export const H264_BOOTSTRAP_WINDOW_TIMEOUT_MS = 5_000;

function maxReceiveTime(a: Time, b: Time): Time {
  return toNano(a) >= toNano(b) ? a : b;
}

function compareReceiveTime(a: RosMessageEvent, b: RosMessageEvent): number {
  const diff = toNano(a.receiveTime) - toNano(b.receiveTime);
  if (diff < 0n) {
    return -1;
  }
  if (diff > 0n) {
    return 1;
  }
  return 0;
}

function sortByReceiveTime(messages: RosMessageEvent[]): RosMessageEvent[] {
  return [...messages].sort(compareReceiveTime);
}

export function maxH264MessageReceiveTime(messages: RosMessageEvent[]): Time | undefined {
  let latest: Time | undefined;
  for (const event of messages) {
    if (!isH264MessageEvent(event)) {
      continue;
    }
    if (!latest || toNano(event.receiveTime) > toNano(latest)) {
      latest = event.receiveTime;
    }
  }
  return latest;
}

export function findFirstH264IdrReceiveTime(messages: RosMessageEvent[]): Time | undefined {
  for (const event of sortByReceiveTime(messages.filter(isH264MessageEvent))) {
    const payload = getH264MessagePayload(event);
    if (payload && containsH264IdrNal(payload)) {
      return event.receiveTime;
    }
  }
  return undefined;
}

export function preparedBootstrapContainsIdr(
  frames: readonly ImageWorkerFrameEnvelope[],
): boolean {
  return frames.some(
    (frame) => frame.kind === 'compressed' && containsH264IdrNal(frame.data),
  );
}

export function findLatestH264KeyFrameIndex(messages: RosMessageEvent[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const event = messages[i];
    if (!event) {
      continue;
    }
    const payload = getH264MessagePayload(event);
    if (payload && containsH264IdrNal(payload)) {
      return i;
    }
  }
  return -1;
}

export function selectH264SeekRepairFrames(
  messages: RosMessageEvent[],
  targetTime: Time,
): RosMessageEvent[] {
  const targetNs = toNano(targetTime);
  const h264Messages = sortByReceiveTime(
    messages.filter((event) => isH264MessageEvent(event) && toNano(event.receiveTime) <= targetNs),
  );

  const candidates = h264Messages.flatMap((event) => {
    const data = getH264MessagePayload(event);
    return data ? [{ event, data }] : [];
  });
  if (findLatestH264KeyFrameIndex(h264Messages) < 0) {
    return [];
  }

  return limitH264SeekRepairFrames(selectLatestCompleteH264Gop(candidates).frames)
    .map(({ event }) => event);
}

/**
 * Bootstrap selection for an arbitrary playhead. Falls back to the file's first
 * IDR when the target time is still before the initial random-access point.
 */
export function selectH264BootstrapFrames(
  messages: RosMessageEvent[],
  targetTime: Time,
  options: { coverageEndTime?: Time } = {},
): RosMessageEvent[] {
  const seekRepair = selectH264SeekRepairFrames(messages, targetTime);
  if (seekRepair.length > 0) {
    return seekRepair;
  }

  const firstIdrTime = findFirstH264IdrReceiveTime(messages);
  if (!firstIdrTime) {
    return [];
  }

  const coverageEnd = options.coverageEndTime ?? targetTime;
  const effectiveEnd = maxReceiveTime(maxReceiveTime(coverageEnd, targetTime), firstIdrTime);
  return selectH264SeekRepairFrames(messages, effectiveEnd);
}

export function limitH264SeekRepairFrames<T extends { data: Uint8Array }>(
  frames: readonly T[],
): T[] {
  const idrIndex = frames.findIndex(({ data }) => containsH264IdrNal(data));
  if (idrIndex < 0 || idrIndex >= H264_SEEK_MAX_FRAMES) {
    return [];
  }
  // Keep the decodable prefix from config/real IDR forward. Taking the tail
  // would discard dependencies and turn a delta into an invalid access point.
  return frames.slice(0, H264_SEEK_MAX_FRAMES);
}

export function receiveTimeKey(time: Time): string {
  return `${time.sec}:${time.nsec}`;
}

export function dedupeH264MessageEventsByReceiveTime(
  messages: RosMessageEvent[],
): RosMessageEvent[] {
  const seen = new Set<string>();
  const deduped: RosMessageEvent[] = [];
  for (const event of messages) {
    const key = receiveTimeKey(event.receiveTime);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

/**
 * Check whether live frames buffered during an in-flight playback bootstrap
 * already provide a complete decodable random-access point at or after
 * `targetTime`. When true, the panel can cancel the backward range scan and
 * resume immediately from the live IDR instead of blocking for seconds on
 * historical chunks that would be discarded anyway.
 */
export function trySelectLiveH264BootstrapFrames(
  liveEvents: readonly RosMessageEvent[],
  targetTime: Time,
  options: { requireSps?: boolean } = {},
): RosMessageEvent[] {
  const targetNs = toNano(targetTime);
  const h264Events = dedupeH264MessageEventsByReceiveTime(
    sortByReceiveTime(liveEvents.filter(isH264MessageEvent)),
  );
  const hasEligibleIdr = h264Events.some((event) => {
    if (toNano(event.receiveTime) < targetNs) {
      return false;
    }
    const payload = getH264MessagePayload(event);
    return payload != null && containsH264IdrNal(payload);
  });
  if (!hasEligibleIdr) {
    return [];
  }

  const candidates = h264Events.flatMap((event) => {
    const data = getH264MessagePayload(event);
    return data ? [{ event, data }] : [];
  });
  const selected = limitH264SeekRepairFrames(selectLatestCompleteH264Gop(candidates).frames).map(
    ({ event }) => event,
  );
  if (selected.length === 0) {
    return [];
  }
  if (options.requireSps) {
    const hasSps = selected.some((event) => {
      const payload = getH264MessagePayload(event);
      return payload != null && parseH264SpsCodec(payload) != null;
    });
    if (!hasSps) {
      return [];
    }
  }
  return selected;
}

export function mergeH264BootstrapWithLiveFrames(
  bootstrapEvents: RosMessageEvent[],
  liveEvents: RosMessageEvent[],
): RosMessageEvent[] {
  return dedupeH264MessageEventsByReceiveTime(
    sortByReceiveTime([...bootstrapEvents, ...liveEvents]),
  );
}

export function toWorkerFramesFromEvents(
  events: RosMessageEvent[],
  options: { transferOwnership?: boolean } = {},
): { frames: ImageWorkerFrameEnvelope[]; transfer: Transferable[] } {
  const frames: ImageWorkerFrameEnvelope[] = [];
  const transfer: Transferable[] = [];
  for (const event of events) {
    const next = toWorkerFrame(event, options);
    if (!next) {
      continue;
    }
    frames.push(next.frame);
    transfer.push(...next.transfer);
  }
  return { frames, transfer };
}

export async function fetchH264BootstrapFrames(
  player: Player,
  topic: string,
  targetTime: Time,
  options: { signal?: AbortSignal; coverageEndTime?: Time } = {},
): Promise<RosMessageEvent[]> {
  if (!player.getMessagesInTimeRange || options.signal?.aborted) {
    return [];
  }

  const coverageEnd = options.coverageEndTime ?? targetTime;
  const deadline = Date.now() + H264_BOOTSTRAP_DEADLINE_MS;

  for (let windowIndex = 0; windowIndex < H264_SEEK_WINDOWS_MS.length; windowIndex += 1) {
    const windowMs = H264_SEEK_WINDOWS_MS[windowIndex];
    if (options.signal?.aborted || Date.now() >= deadline) {
      return [];
    }
    const start = addMs(targetTime, -windowMs);
    // Avoid reading 2 s of future chunks on the common first window when a
    // preceding IDR is already within 2 s; keep 200 ms slack for file-start IDRs
    // and fall back to the full 2 s forward reach on wider windows.
    const queryEnd = addMs(
      coverageEnd,
      windowIndex === 0 ? H264_BOOTSTRAP_INITIAL_FORWARD_MS : H264_BOOTSTRAP_FORWARD_MS,
    );
    const remainingMs = Math.max(1, deadline - Date.now());
    // Each window's read has its own abort: a read the repair stopped waiting for (timeout,
    // abort, error) must stop too. As a frame-priority read it holds back every panel's
    // window reads, and the next, larger window would otherwise run beside it.
    const windowRead = new AbortController();
    const stopWindowRead = (): void => windowRead.abort();
    options.signal?.addEventListener('abort', stopWindowRead, { once: true });
    let messages: RosMessageEvent[];
    try {
      messages = await withTimeout(
        player.getMessagesInTimeRange({
          start,
          end: queryEnd,
          topics: [topic],
          signal: windowRead.signal,
          // The image on screen waits for this keyframe: it goes ahead of panels' window reads.
          priority: 'frame',
        }),
        Math.min(H264_BOOTSTRAP_WINDOW_TIMEOUT_MS, remainingMs),
        'H.264 bootstrap range read timed out',
      );
    } finally {
      options.signal?.removeEventListener('abort', stopWindowRead);
      windowRead.abort();
    }
    if (options.signal?.aborted) {
      return [];
    }

    const repairFrames = selectH264BootstrapFrames(
      messages.filter((event) => event.topic === topic),
      targetTime,
      { coverageEndTime: coverageEnd },
    );
    if (repairFrames.length > 0) {
      return repairFrames;
    }
  }

  return [];
}

export function postH264Bootstrap(
  worker: Worker,
  frames: ImageWorkerFrameEnvelope[],
  options: { preserveFrame?: boolean; transfer?: Transferable[] } = {},
): boolean {
  if (frames.length === 0 || !preparedBootstrapContainsIdr(frames)) {
    return false;
  }
  worker.postMessage(
    {
      type: 'bootstrapH264',
      frames,
      preserveFrame: options.preserveFrame,
    } satisfies ImageRenderWorkerRequest,
    options.transfer ?? [],
  );
  return true;
}

export interface ExecuteH264BootstrapArgs {
  player: Player;
  worker: Worker;
  topic: string;
  targetTime: Time;
  liveEvents?: RosMessageEvent[];
  signal?: AbortSignal;
  preserveFrame?: boolean;
  transferOwnership?: boolean;
}

/** Fetch, merge, validate, and post one atomic H.264 bootstrap batch. */
export async function executeH264Bootstrap(args: ExecuteH264BootstrapArgs): Promise<boolean> {
  const {
    player,
    worker,
    topic,
    targetTime,
    liveEvents = [],
    signal,
    preserveFrame = false,
    transferOwnership = false,
  } = args;

  if (signal?.aborted) {
    return false;
  }

  const coverageEnd = maxH264MessageReceiveTime(liveEvents) ?? targetTime;
  const bootstrapEvents = await fetchH264BootstrapFrames(player, topic, targetTime, {
    signal,
    coverageEndTime: coverageEnd,
  });
  if (signal?.aborted) {
    return false;
  }

  const mergedRaw = mergeH264BootstrapWithLiveFrames(bootstrapEvents, liveEvents);
  if (mergedRaw.length === 0) {
    return false;
  }
  // If newer live frames already brought a complete IDR GOP while bootstrap was
  // in flight, start from that latest complete GOP instead of decoding a stale
  // prefix or bridging across frames dropped by the live buffer cap.
  const latestLiveIdrIndex = findLatestH264KeyFrameIndex(liveEvents);
  const mergedCandidates = mergedRaw.flatMap((event) => {
    const data = getH264MessagePayload(event);
    return data ? [{ event, data }] : [];
  });
  const mergedEvents =
    latestLiveIdrIndex >= 0
      ? limitH264SeekRepairFrames(selectLatestCompleteH264Gop(mergedCandidates).frames).map(
          ({ event }) => event,
        )
      : mergedRaw;
  if (mergedEvents.length === 0) {
    return false;
  }

  const prepared = toWorkerFramesFromEvents(mergedEvents, { transferOwnership });
  return postH264Bootstrap(worker, prepared.frames, {
    preserveFrame,
    transfer: prepared.transfer,
  });
}

export async function bootstrapH264FromTime(
  player: Player,
  worker: Worker,
  topic: string,
  targetTime: Time,
  options: {
    signal?: AbortSignal;
    preserveFrame?: boolean;
    liveEvents?: RosMessageEvent[];
    transferOwnership?: boolean;
  } = {},
): Promise<boolean> {
  if (options.signal?.aborted) {
    return false;
  }

  return executeH264Bootstrap({
    player,
    worker,
    topic,
    targetTime,
    liveEvents: options.liveEvents,
    signal: options.signal,
    preserveFrame: options.preserveFrame,
    transferOwnership: options.transferOwnership,
  });
}

export async function repairH264Seek(
  player: Player,
  worker: Worker,
  topic: string,
  targetTime: Time,
  options: { signal?: AbortSignal; liveEvents?: RosMessageEvent[] } = {},
): Promise<boolean> {
  if (options.signal?.aborted) {
    return false;
  }

  return bootstrapH264FromTime(player, worker, topic, targetTime, {
    signal: options.signal,
    preserveFrame: true,
    liveEvents: options.liveEvents,
    transferOwnership: false,
  });
}
