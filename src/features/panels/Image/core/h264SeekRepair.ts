import type { Player } from '@/core/types/player';
import type { MessageEvent as RosMessageEvent, Time } from '@/core/types/ros';
import { addMs, toNano } from '@/shared/utils/time';
import { containsH264IdrNal } from './h264';
import { selectLatestCompleteH264Gop } from './h264Queue';
import type { ImageRenderWorkerRequest, ImageWorkerFrameEnvelope } from './imageWorkerProtocol';
import { getH264MessagePayload, isH264MessageEvent, toWorkerFrame } from './messageFrameAdapter';

/** Progressive lookback windows when searching for a keyframe before a seek target. */
export const H264_SEEK_WINDOWS_MS = [2000, 5000, 10_000, 30_000] as const;

/** Maximum frame messages posted for one seek repair. */
export const H264_SEEK_MAX_FRAMES = 180;

/** Forward read when bootstrapping at/before the file's first IDR. */
export const H264_BOOTSTRAP_FORWARD_MS = 2_000;

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
  const queryEnd = addMs(coverageEnd, H264_BOOTSTRAP_FORWARD_MS);

  for (const windowMs of H264_SEEK_WINDOWS_MS) {
    const start = addMs(targetTime, -windowMs);
    const messages = await player.getMessagesInTimeRange({
      start,
      end: queryEnd,
      topics: [topic],
    });
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

  const mergedEvents = mergeH264BootstrapWithLiveFrames(bootstrapEvents, liveEvents);
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
