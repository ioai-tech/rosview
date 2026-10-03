import React, { useMemo } from 'react';
import type { DataQualityIssueRange, DataQualityReport, Time } from '@/core/types/ros';
import { toNano } from '@/shared/utils/time';

interface PlaybackQualityMarkersLaneProps {
  startTime?: Time;
  endTime?: Time;
  report?: DataQualityReport;
  onSelectRange: (range: DataQualityIssueRange) => void;
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function timeToPercent(current: Time, start: Time, end: Time): number {
  const total = toNano(end) - toNano(start);
  if (total <= 0n) return 0;
  const currentNano = toNano(current) - toNano(start);
  return clampPercent(Number((currentNano * 10000n) / total) / 100);
}

type QualityMarkerView = {
  range: DataQualityIssueRange;
  left: number;
  width: number;
};

/**
 * Dedicated quality lane below playback track.
 * Memoized to avoid re-computing marker layout on every player tick.
 */
export const PlaybackQualityMarkersLane = React.memo(function PlaybackQualityMarkersLane({
  startTime,
  endTime,
  report,
  onSelectRange,
}: PlaybackQualityMarkersLaneProps) {
  const markers = useMemo<QualityMarkerView[]>(() => {
    if (!startTime || !endTime || !report) return [];
    return (report.incidents ?? report.ranges)
      .map((range) => {
        const left = clampPercent(timeToPercent(range.start, startTime, endTime));
        const rawWidth = clampPercent(timeToPercent(range.end, startTime, endTime) - left);
        return {
          range,
          left,
          width: Math.max(0.3, rawWidth),
        };
      })
      .filter((entry) => entry.width > 0);
  }, [report, startTime, endTime]);

  const { warnMarkers, errorMarkers } = useMemo(() => {
    const warn: QualityMarkerView[] = [];
    const err: QualityMarkerView[] = [];
    for (const m of markers) {
      if (m.range.severity === 'error') err.push(m);
      else warn.push(m);
    }
    return { warnMarkers: warn, errorMarkers: err };
  }, [markers]);

  const markerButton = (entry: QualityMarkerView, layer: 'warn' | 'error') => {
    const { range, left, width } = entry;
    const isError = layer === 'error';
    return (
      <button
        key={`quality-lane-${range.id}`}
        type="button"
        className={
          isError
            ? 'absolute top-0 z-12 h-full bg-destructive shadow-xs ring-1 ring-destructive/60 hover:bg-destructive'
            : 'absolute top-0 z-6 h-full bg-amber-500/80 hover:bg-amber-500'
        }
        style={{ left: `${left}%`, width: `${width}%` }}
        title={`${range.scope}: ${range.topicNames.join(', ')} (${range.count})`}
        onClick={(event) => {
          event.stopPropagation();
          onSelectRange(range);
        }}
      />
    );
  };

  return (
    <div className="relative isolate h-1" data-testid="quality-markers-lane">
      {warnMarkers.map((m) => markerButton(m, 'warn'))}
      {errorMarkers.map((m) => markerButton(m, 'error'))}
    </div>
  );
});
