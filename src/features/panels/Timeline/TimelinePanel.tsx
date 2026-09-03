import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useShallow } from 'zustand/react/shallow';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import type { Player } from '@/core/types/player';
import type { DataQualityIssueRange, DataQualityReport, MessageEvent } from '@/core/types/ros';
import { toNano } from '@/shared/utils/time';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import type { TimelineConfig } from './defaults';

interface TimelinePanelProps {
  player: Player;
  config: TimelineConfig;
}

type TopicSample = {
  minNs: bigint;
  maxNs: bigint;
  count: number;
};

type TopicRow = {
  name: string;
  messageCount?: number;
  durationSec?: number;
  leftPercent?: number;
  widthPercent?: number;
  dropSegments: Array<{ leftPercent: number; widthPercent: number }>;
};

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function dropRangesForTopic(topic: string, report: DataQualityReport | undefined): DataQualityIssueRange[] {
  if (!report || report.status !== 'ready') return [];
  const source = report.incidents ?? report.ranges;
  return source.filter(
    (range) =>
      range.topicNames.includes(topic) &&
      range.type === 'topic_frame_drop',
  );
}

function buildTopicSamples(messages: MessageEvent[]): Map<string, TopicSample> {
  const out = new Map<string, TopicSample>();
  for (const message of messages) {
    const ts = toNano(message.receiveTime);
    const current = out.get(message.topic);
    if (!current) {
      out.set(message.topic, { minNs: ts, maxNs: ts, count: 1 });
      continue;
    }
    current.minNs = ts < current.minNs ? ts : current.minNs;
    current.maxNs = ts > current.maxNs ? ts : current.maxNs;
    current.count += 1;
  }
  return out;
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({ player, config }) => {
  const { formatMessage } = useIntl();
  const { topics, startTime, endTime, report } = useMessagePipeline(
    useShallow((state: MessagePipelineState) => ({
      topics: state.sortedTopics,
      startTime: state.playerState.activeData?.startTime,
      endTime: state.playerState.activeData?.endTime,
      report: state.playerState.progress.dataQualityReport,
    })),
  );
  const [samplesByTopic, setSamplesByTopic] = useState<Map<string, TopicSample>>(new Map());
  const markerRef = useRef<HTMLDivElement | null>(null);
  const markerContainerRef = useRef<HTMLDivElement | null>(null);
  const rangeRef = useRef<{ startNs: bigint; totalNs: bigint } | undefined>(undefined);
  const latestTimeNsRef = useRef<bigint | undefined>(undefined);
  const cancelFrameRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function readTopicTimeBounds() {
      if (!player.getMessagesInTimeRange || !startTime || !endTime || topics.length === 0) {
        setSamplesByTopic(new Map());
        return;
      }
      try {
        const messages = await player.getMessagesInTimeRange({
          start: startTime,
          end: endTime,
          topics: topics.map((topic) => topic.name),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setSamplesByTopic(buildTopicSamples(messages));
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          return;
        }
        if (!controller.signal.aborted) {
          console.warn('TimelinePanel: failed to read topic time bounds', error);
          setSamplesByTopic(new Map());
        }
      }
    }
    void readTopicTimeBounds();
    return () => {
      controller.abort();
    };
  }, [player, topics, startTime, endTime]);

  const rows = useMemo<TopicRow[]>(() => {
    if (!startTime || !endTime) return [];
    const startNs = toNano(startTime);
    const endNs = toNano(endTime);
    const totalNs = endNs - startNs;
    if (totalNs <= 0n) return [];

    return topics.map((topic) => {
      const sample = samplesByTopic.get(topic.name);
      let leftPercent: number | undefined;
      let widthPercent: number | undefined;
      let durationSec = topic.durationSec;

      if (sample) {
        const segmentStartNs = sample.minNs < startNs ? startNs : sample.minNs;
        const segmentEndNs = sample.maxNs > endNs ? endNs : sample.maxNs;
        const segmentDurationNs = segmentEndNs - segmentStartNs;
        if (segmentDurationNs >= 0n) {
          leftPercent = clampPercent(Number(((segmentStartNs - startNs) * 10000n) / totalNs) / 100);
          widthPercent = clampPercent(Number((segmentDurationNs * 10000n) / totalNs) / 100);
          durationSec = Number(segmentDurationNs) / 1e9;
        }
      }

      const shouldShowDrops = config.showDrops;
      const dropSegments = shouldShowDrops
        ? dropRangesForTopic(topic.name, report)
            .map((range) => {
              const rangeStartNs = toNano(range.start);
              const rangeEndNs = toNano(range.end);
              const clampedStart = rangeStartNs < startNs ? startNs : rangeStartNs;
              const clampedEnd = rangeEndNs > endNs ? endNs : rangeEndNs;
              const widthNs = clampedEnd - clampedStart;
              if (widthNs <= 0n) return undefined;
              return {
                leftPercent: clampPercent(Number(((clampedStart - startNs) * 10000n) / totalNs) / 100),
                widthPercent: Math.max(0.3, clampPercent(Number((widthNs * 10000n) / totalNs) / 100)),
              };
            })
            .filter((segment): segment is { leftPercent: number; widthPercent: number } => Boolean(segment))
        : [];

      return {
        name: topic.name,
        messageCount: topic.messageCount,
        durationSec,
        leftPercent,
        widthPercent,
        dropSegments,
      };
    });
  }, [config.showDrops, endTime, report, samplesByTopic, startTime, topics]);

  const paintMarker = useCallback((timeNs: bigint | undefined) => {
    const marker = markerRef.current;
    const container = markerContainerRef.current;
    const range = rangeRef.current;
    if (!marker || !container || !range || timeNs == undefined) {
      if (marker) marker.style.opacity = '0';
      return;
    }

    const clampedTimeNs = timeNs < range.startNs
      ? range.startNs
      : (timeNs > range.startNs + range.totalNs ? range.startNs + range.totalNs : timeNs);
    const ratio = Number((clampedTimeNs - range.startNs) * 10000n / range.totalNs) / 10000;
    const offsetPx = Math.max(0, Math.min(container.clientWidth, container.clientWidth * ratio));
    marker.style.transform = `translateX(${offsetPx}px)`;
    marker.style.opacity = '1';
  }, []);

  useEffect(() => {
    if (!startTime || !endTime) {
      rangeRef.current = undefined;
      paintMarker(undefined);
      return;
    }
    const startNs = toNano(startTime);
    const endNs = toNano(endTime);
    const totalNs = endNs - startNs;
    if (totalNs <= 0n) {
      rangeRef.current = undefined;
      paintMarker(undefined);
      return;
    }
    rangeRef.current = { startNs, totalNs };
    paintMarker(latestTimeNsRef.current);
  }, [endTime, paintMarker, startTime]);

  useEffect(() => {
    const unsub = player.subscribeCurrentTime((time) => {
      latestTimeNsRef.current = toNano(time);
      if (cancelFrameRef.current != null) {
        return;
      }
      cancelFrameRef.current = scheduleFrame(() => {
        cancelFrameRef.current = null;
        paintMarker(latestTimeNsRef.current);
      });
    });
    return () => {
      unsub();
      cancelFrameRef.current?.();
      cancelFrameRef.current = null;
    };
  }, [paintMarker, player]);

  useEffect(() => {
    const container = markerContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      paintMarker(latestTimeNsRef.current);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [paintMarker]);

  if (!startTime || !endTime || rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        {formatMessage({ id: 'panels.timeline.empty' })}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-2">
      <div className="relative space-y-2">
        <div
          ref={markerContainerRef}
          className="pointer-events-none absolute inset-0 z-10"
          aria-hidden
        >
          <div
            ref={markerRef}
            className="absolute inset-y-0 left-0 w-px bg-amber-500/80 opacity-0"
            style={{ transform: 'translateX(0px)' }}
            title={formatMessage({ id: 'panels.timeline.currentTimeMarker' })}
          />
        </div>
        {rows.map((row) => {
          const durationLabel =
            row.durationSec == undefined
              ? formatMessage({ id: 'panels.timeline.durationUnavailable' })
              : formatMessage(
                  { id: 'panels.timeline.durationSeconds' },
                  { seconds: row.durationSec.toFixed(row.durationSec >= 10 ? 1 : 2) },
                );
          const messageCount = row.messageCount ?? 0;
          const hasSegment = row.leftPercent != undefined && row.widthPercent != undefined;
          return (
            <div key={row.name} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[12px] leading-4 text-foreground/90">
                <div className="min-w-0 truncate" title={row.name}>
                  {row.name}
                </div>
                <div className="shrink-0 text-muted-foreground">
                  ({formatMessage({ id: 'panels.timeline.messageCount' }, { count: messageCount })}) ({durationLabel})
                </div>
              </div>
              <div className="relative h-1 overflow-hidden rounded bg-muted/60">
                {hasSegment && (
                  <div
                    className="absolute top-0 h-1 rounded bg-primary/80"
                    style={{ left: `${row.leftPercent}%`, width: `${Math.max(0.8, row.widthPercent ?? 0)}%` }}
                  />
                )}
                {row.dropSegments.map((segment, index) => (
                  <div
                    key={`${row.name}-drop-${index}`}
                    className="absolute top-0 h-1 bg-destructive"
                    style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
