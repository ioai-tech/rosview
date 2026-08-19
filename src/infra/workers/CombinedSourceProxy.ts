import type {
  DataQualityIssueCounts,
  DataQualityReport,
  Initialization,
  MessageEvent,
  PlayerProblem,
} from '@/core/types/ros';
import { fromNano, toNano } from '@/shared/utils/time';
import type { ISourceHandle, ResolveHighFrequencyLaneOptions } from './ISourceHandle';
import type {
  GetAdjacentMessageArgs,
  GetBackfillMessagesArgs,
  IMessageCursor,
  LoadProgress,
  MessageIteratorArgs,
  PlaybackBufferStatus,
  PreparePlaybackBufferArgs,
  SourceInitProgress,
  SourceInitProgressCallback,
} from './types';
import type { TransportDiagnostics } from './transport';
import type { WorkerSerializedSource } from './WorkerSerializedSource';
import { mergeInitializations } from './mergeInitialization';
import { CombinedMessageCursor, getMessageSourceIndex, tagMessageSourceIndex } from './CombinedMessageCursor';

export interface CombinedSourceMember {
  /** Display label for this member (typically the file/URL basename), surfaced in the topic list "more" menu. */
  label: string;
  source: WorkerSerializedSource;
  initArgs: Record<string, unknown>;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'unknown error';
}

function errorFromReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(errorMessage(reason));
}

function aggregateInitProgress(parts: Array<SourceInitProgress | undefined>): SourceInitProgress {
  const defined = parts.filter((part): part is SourceInitProgress => part != null);
  if (defined.length === 0) {
    return { phase: 'connecting', loadedBytes: 0, totalBytes: 0 };
  }
  const loadedBytes = defined.reduce((sum, part) => sum + part.loadedBytes, 0);
  const totalBytes = defined.reduce((sum, part) => sum + part.totalBytes, 0);
  const transferredBytes = defined.reduce((sum, part) => sum + (part.transferredBytes ?? 0), 0);
  const phase = defined.some((part) => part.phase === 'downloading')
    ? 'downloading'
    : defined.some((part) => part.phase === 'opening')
      ? 'opening'
      : 'connecting';
  return { phase, loadedBytes, totalBytes, transferredBytes };
}

/**
 * Merges N independent `WorkerSerializedSource` instances (each backed by its
 * own Worker, possibly a different format) into a single `ISourceHandle` that
 * `IterablePlayer` can drive as if it were one recording. Each member keeps
 * parsing/decoding on its own thread; this class only does lightweight
 * fan-out/merge work on the main thread.
 */
export class CombinedSourceProxy implements ISourceHandle {
  private _members: CombinedSourceMember[];
  private _activeMemberIndices: number[] = [];
  private _memberIndicesByTopic = new Map<string, number[]>();

  constructor(members: CombinedSourceMember[]) {
    if (members.length < 2) {
      throw new Error('CombinedSourceProxy requires at least 2 members; use WorkerSerializedSource directly for a single file');
    }
    this._members = members;
  }

  async initialize(
    args: Record<string, unknown>,
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization> {
    const memberProgress: Array<SourceInitProgress | undefined> = this._members.map(() => undefined);
    const results = await Promise.allSettled(
      this._members.map((member, memberIndex) =>
        member.source.initialize(
          { ...member.initArgs, ...args },
          onProgress
            ? (progress) => {
                memberProgress[memberIndex] = progress;
                onProgress(aggregateInitProgress(memberProgress));
              }
            : undefined,
        ),
      ),
    );

    const succeededSources: Array<{ label: string; initialization: Initialization }> = [];
    const succeededIndices: number[] = [];
    const loadProblems: PlayerProblem[] = [];

    results.forEach((result, memberIndex) => {
      const member = this._members[memberIndex];
      if (result.status === 'fulfilled') {
        succeededSources.push({ label: member.label, initialization: result.value });
        succeededIndices.push(memberIndex);
        return;
      }
      loadProblems.push({
        severity: 'error',
        message: `Failed to load "${member.label}" and it was excluded from the merged session: ${errorMessage(result.reason)}`,
      });
      // The worker for this member is otherwise unused for the lifetime of
      // this session; terminate it now rather than leaking the thread.
      try {
        member.source.terminate();
      } catch {
        // best-effort cleanup
      }
    });

    if (succeededSources.length === 0) {
      const firstRejected = results.find((r) => r.status === 'rejected');
      throw firstRejected && firstRejected.status === 'rejected'
        ? errorFromReason(firstRejected.reason)
        : new Error('All members failed to initialize');
    }

    this._activeMemberIndices = succeededIndices;
    const { initialization, memberIndicesByTopic } = mergeInitializations(succeededSources);

    const remapped = new Map<string, number[]>();
    for (const [topic, localIndices] of memberIndicesByTopic) {
      remapped.set(
        topic,
        localIndices.map((localIndex) => succeededIndices[localIndex]),
      );
    }
    this._memberIndicesByTopic = remapped;

    return {
      ...initialization,
      problems: [...loadProblems, ...initialization.problems],
    };
  }

  private _activeMembers(): CombinedSourceMember[] {
    return this._activeMemberIndices.map((i) => this._members[i]);
  }

  private _relevantMemberIndices(topics: readonly string[]): number[] {
    const set = new Set<number>();
    for (const topic of topics) {
      const indices = this._memberIndicesByTopic.get(topic);
      if (!indices) continue;
      for (const i of indices) set.add(i);
    }
    return Array.from(set);
  }

  async getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>> {
    const relevant = this._relevantMemberIndices(args.topics);
    if (relevant.length === 0) {
      return new CombinedMessageCursor([]);
    }
    const children = await Promise.all(
      relevant.map(async (memberIndex) => ({
        sourceIndex: memberIndex,
        cursor: await this._members[memberIndex].source.getMessageCursor(args),
      })),
    );
    return new CombinedMessageCursor(children);
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    const relevant = this._relevantMemberIndices(args.topics);
    if (relevant.length === 0) return [];
    const perMember = await Promise.all(
      relevant.map(async (memberIndex) => {
        const messages = await this._members[memberIndex].source.getBackfillMessages(args);
        return messages.map((m) => tagMessageSourceIndex(m, memberIndex));
      }),
    );
    const byTopic = new Map<string, MessageEvent>();
    for (const messages of perMember) {
      for (const message of messages) {
        const existing = byTopic.get(message.topic);
        if (!existing || toNano(message.receiveTime) > toNano(existing.receiveTime)) {
          byTopic.set(message.topic, message);
        }
      }
    }
    return Array.from(byTopic.values());
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    const relevant = this._relevantMemberIndices(args.topics);
    if (relevant.length === 0) return null;
    const candidates = (
      await Promise.all(
        relevant.map(async (memberIndex) => {
          const msg = await this._members[memberIndex].source.getAdjacentMessage(args);
          return msg ? tagMessageSourceIndex(msg, memberIndex) : null;
        }),
      )
    ).filter((m): m is MessageEvent => m != null);
    if (candidates.length === 0) return null;
    const pickBetter =
      args.direction === 'next'
        ? (a: MessageEvent, b: MessageEvent) => (toNano(a.receiveTime) <= toNano(b.receiveTime) ? a : b)
        : (a: MessageEvent, b: MessageEvent) => (toNano(a.receiveTime) >= toNano(b.receiveTime) ? a : b);
    return candidates.reduce(pickBetter);
  }

  async preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus> {
    const relevant = this._relevantMemberIndices(args.topics);
    if (relevant.length === 0) return { ready: true };
    const statuses = await Promise.all(
      relevant.map((memberIndex) => this._members[memberIndex].source.preparePlaybackBuffer(args)),
    );
    const ready = statuses.every((s) => s.ready);
    const bufferedUntilNs = statuses
      .map((s) => (s.bufferedUntil ? toNano(s.bufferedUntil) : undefined))
      .filter((v): v is bigint => v != null);
    const bufferedUntil =
      bufferedUntilNs.length > 0 ? fromNano(bufferedUntilNs.reduce((a, b) => (a < b ? a : b))) : undefined;
    const bufferedAheadMsValues = statuses
      .map((s) => s.bufferedAheadMs)
      .filter((v): v is number => typeof v === 'number');
    return {
      ready,
      bufferedUntil,
      bufferedAheadMs: bufferedAheadMsValues.length > 0 ? Math.min(...bufferedAheadMsValues) : undefined,
    };
  }

  async getLoadProgress(): Promise<LoadProgress> {
    const members = this._activeMembers();
    if (members.length === 0) {
      return { downloadedByteRanges: [], totalBytes: 0, percent: 0, parsedMessageRanges: [] };
    }
    const progresses = await Promise.all(members.map((m) => m.source.getLoadProgress()));
    const totalBytes = progresses.reduce((sum, p) => sum + (p.totalBytes || 0), 0);
    const downloadedBytes = progresses.reduce(
      (sum, p) => sum + (p.totalBytes || 0) * (Number.isFinite(p.percent) ? p.percent : 0) / 100,
      0,
    );
    // Byte-range progress is not meaningful once merged across files with
    // unrelated byte spaces; only the aggregate percent and the (message)
    // time-range union below are surfaced to the UI for combined sessions.
    const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 100;
    const parsedMessageRanges = progresses.flatMap((p) => p.parsedMessageRanges);
    const bufferedAheadMsValues = progresses
      .map((p) => p.bufferedAheadMs)
      .filter((v): v is number => typeof v === 'number');
    return {
      downloadedByteRanges: [],
      totalBytes,
      percent,
      parsedMessageRanges,
      bufferedAheadMs: bufferedAheadMsValues.length > 0 ? Math.min(...bufferedAheadMsValues) : undefined,
    };
  }

  async startDataQualityScan(): Promise<void> {
    await Promise.all(this._activeMembers().map((m) => m.source.startDataQualityScan()));
  }

  async getDataQualityReport(): Promise<DataQualityReport | undefined> {
    const members = this._activeMembers();
    if (members.length === 0) return undefined;
    const reports = await Promise.all(members.map((m) => m.source.getDataQualityReport()));
    const defined = reports.filter((r): r is DataQualityReport => r != null);
    if (defined.length === 0) return undefined;
    const status = defined.some((r) => r.status === 'scanning')
      ? 'scanning'
      : defined.every((r) => r.status === 'ready')
        ? 'ready'
        : 'idle';
    const issueCounts = defined.reduce<DataQualityIssueCounts>(
      (acc, r) => {
        for (const key of Object.keys(r.issueCounts) as Array<keyof DataQualityIssueCounts>) {
          acc[key] = (acc[key] ?? 0) + r.issueCounts[key];
        }
        return acc;
      },
      { timestamp_rollback: 0, topic_frame_drop: 0 },
    );
    const totalMessagesValues = defined.map((r) => r.totalMessages).filter((v): v is number => typeof v === 'number');
    const incidents = defined.flatMap((r) => r.incidents ?? []);
    return {
      status,
      scannedMessages: defined.reduce((sum, r) => sum + r.scannedMessages, 0),
      totalMessages: totalMessagesValues.length > 0 ? totalMessagesValues.reduce((a, b) => a + b, 0) : undefined,
      updatedAt: Math.max(...defined.map((r) => r.updatedAt)),
      issueCounts,
      ranges: defined.flatMap((r) => r.ranges),
      issues: defined.flatMap((r) => r.issues),
      ...(incidents.length > 0 ? { incidents } : {}),
    };
  }

  async getTransportDiagnostics(): Promise<TransportDiagnostics> {
    const members = this._activeMembers();
    if (members.length === 0) {
      return { mode: 'comlink', droppedPayloads: 0, stalePayloadRefs: 0 };
    }
    const diagnostics = await Promise.all(members.map((m) => m.source.getTransportDiagnostics()));
    const first = diagnostics[0];
    const allSameMode = diagnostics.every((d) => d.mode === first.mode);
    return {
      mode: allSameMode ? first.mode : 'comlink',
      fallbackReason: allSameMode ? first.fallbackReason : 'Merged session mixes multiple transport modes across sources',
      crossOriginIsolated: diagnostics.every((d) => d.crossOriginIsolated !== false),
      binaryPayloadThresholdBytes: first.binaryPayloadThresholdBytes,
      sharedPayloadRing: diagnostics.find((d) => d.sharedPayloadRing)?.sharedPayloadRing,
      droppedPayloads: diagnostics.reduce((sum, d) => sum + d.droppedPayloads, 0),
      stalePayloadRefs: diagnostics.reduce((sum, d) => sum + d.stalePayloadRefs, 0),
    };
  }

  resolveMessageBatch(messages: MessageEvent[]): MessageEvent[] {
    if (messages.length === 0) return messages;
    const bucketsByMember = new Map<number, { indices: number[]; messages: MessageEvent[] }>();
    messages.forEach((message, i) => {
      const sourceIndex = getMessageSourceIndex(message);
      if (sourceIndex == null || !this._members[sourceIndex]) return;
      const bucket = bucketsByMember.get(sourceIndex) ?? { indices: [], messages: [] };
      bucket.indices.push(i);
      bucket.messages.push(message);
      bucketsByMember.set(sourceIndex, bucket);
    });
    if (bucketsByMember.size === 0) {
      return messages;
    }
    const out = messages.slice();
    for (const [memberIndex, bucket] of bucketsByMember) {
      const resolved = this._members[memberIndex].source.resolveMessageBatch(bucket.messages);
      resolved.forEach((message, j) => {
        out[bucket.indices[j]] = message;
      });
    }
    return out;
  }

  resolveMessageForHighFrequencyLane(
    message: MessageEvent,
    options?: ResolveHighFrequencyLaneOptions,
  ): MessageEvent {
    const sourceIndex = getMessageSourceIndex(message);
    if (sourceIndex == null || !this._members[sourceIndex]) return message;
    return this._members[sourceIndex].source.resolveMessageForHighFrequencyLane(message, options);
  }

  terminate(): void {
    for (const member of this._members) {
      member.source.terminate();
    }
  }
}
