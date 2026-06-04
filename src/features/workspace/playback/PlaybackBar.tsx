import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PLAYBACK_SPEED_MAX } from '@/core/types/player';
import { CalendarClock, Pause, Play, SkipBack, SkipForward, Timer } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useIntl } from 'react-intl';
import type { Player } from '@/core/types/player';
import type { Time, TimeRange } from '@/core/types/ros';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import { resolveStepMsFromModifiers } from '@/shared/utils/playbackStep';
import { formatLocalTimestamp, formatRelativeTime, toNano } from '@/shared/utils/time';
import { compactTimeRanges } from '@/shared/utils/timeRanges';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import { useSidebarStore } from '@/shared/hooks/useSidebarStore';
import { Button } from '@/shared/ui/button';
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from '@/shared/ui/menubar';
import type { DataQualityIssueRange } from '@/core/types/ros';
import { PlaybackQualityMarkersLane } from './PlaybackQualityMarkersLane';
import type { RosViewExtension, RosViewExtensionContext } from '@/core/extensions/types';
import { PlaybackOverlayHost } from '@/features/extensions/PlaybackOverlayHost';

interface PlaybackBarProps {
  player: Player;
  extensionContext: RosViewExtensionContext;
  extensions?: RosViewExtension[];
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

function percentToTime(percent: number, start: Time, end: Time): Time {
  const p = clampPercent(percent) / 100;
  const total = toNano(end) - toNano(start);
  const delta = BigInt(Math.round(Number(total) * p));
  const seekNano = toNano(start) + delta;
  const sec = Number(seekNano / 1000000000n);
  const nsec = Number(seekNano % 1000000000n);
  return { sec, nsec };
}

const PRESET_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8] as const;
const PRESET_SAMPLING_FPS = [15, 30, 45] as const;

const MENUBAR_PLAYBACK_SPEED = 'playback-menubar-speed';
const MENUBAR_PLAYBACK_FPS = 'playback-menubar-fps';
const MENUBAR_PLAYBACK_LOOP = 'playback-menubar-loop';

/** Compact menubar triggers: Navbar-like chrome, no chevron, width follows label. */
const PLAYBACK_MENUBAR_TRIGGER_CLASS =
  'h-7 w-fit min-w-0 shrink-0 justify-center gap-1 rounded-sm border border-transparent px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground shadow-none hover:text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 data-[highlighted]:border-transparent';

const TRANSPORT_ICON_BTN_CLASS =
  'h-9 w-9 shrink-0 rounded-full transition-all hover:bg-accent active:scale-95 text-foreground';

/** Primary play/pause control: larger filled button vs ghost step buttons. */
const PLAYBACK_PRIMARY_TRANSPORT_CLASS =
  'h-10 w-10 shrink-0 rounded-full shadow-md transition-all hover:bg-primary/90 active:scale-[0.97] focus-visible:ring-offset-background [&_svg]:!size-[22px] [&_svg]:shrink-0';

type PlaybackTimeDisplayMode = 'relative' | 'absolute';

const PLAYBACK_TIME_MODE_STORAGE_KEY = 'rosview-playback-time-display';
const DEFAULT_PROGRESS_RANGE_BUDGET = 48;

function readStoredPlaybackTimeMode(): PlaybackTimeDisplayMode {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return 'relative';
  try {
    const v = globalThis.localStorage.getItem(PLAYBACK_TIME_MODE_STORAGE_KEY);
    return v === 'absolute' ? 'absolute' : 'relative';
  } catch {
    return 'relative';
  }
}

function formatHoverSeekLabel(t: Time, start: Time, mode: PlaybackTimeDisplayMode): string {
  return mode === 'relative' ? formatRelativeTime(t, start) : formatLocalTimestamp(t);
}

function formatPlaybackTimeLine(time: Time, start: Time, end: Time, mode: PlaybackTimeDisplayMode): string {
  if (mode === 'relative') {
    return `${formatRelativeTime(time, start)} / ${formatRelativeTime(end, start)}`;
  }
  return `${formatLocalTimestamp(time)} / ${formatLocalTimestamp(end)}`;
}

function updateHoverChrome(
  hoverLineEl: HTMLDivElement | null,
  hoverTipEl: HTMLDivElement | null,
  percent: number | null,
  startTime: Time | undefined,
  endTime: Time | undefined,
  mode: PlaybackTimeDisplayMode,
  lastHoverPercentRef: React.MutableRefObject<number | null>,
) {
  if (!hoverLineEl || !hoverTipEl) return;
  if (percent == null || !startTime || !endTime) {
    lastHoverPercentRef.current = null;
    hoverLineEl.style.opacity = '0';
    hoverTipEl.style.opacity = '0';
    hoverTipEl.style.pointerEvents = 'none';
    return;
  }
  lastHoverPercentRef.current = percent;
  const t = percentToTime(percent, startTime, endTime);
  hoverLineEl.style.opacity = '1';
  hoverLineEl.style.left = `${percent}%`;
  hoverTipEl.style.opacity = '1';
  hoverTipEl.style.left = `${percent}%`;
  hoverTipEl.style.pointerEvents = 'none';
  hoverTipEl.textContent = formatHoverSeekLabel(t, startTime, mode);
}

export const PlaybackBar: React.FC<PlaybackBarProps> = ({ player, extensionContext, extensions = [] }) => {
  const { formatMessage } = useIntl();
  const {
    startTime,
    endTime,
    isPlaying,
    isLooping,
    speed,
    samplingFps,
    parsedMessageRanges,
    dataQualityReport,
  } = useMessagePipeline(
    useShallow((s) => {
      const ad = s.playerState.activeData;
      const pr = s.playerState.progress;
      return {
        startTime: ad?.startTime,
        endTime: ad?.endTime,
        isPlaying: ad?.isPlaying ?? false,
        isLooping: ad?.isLooping ?? true,
        speed: ad?.speed ?? 1,
        samplingFps: pr.samplingFps,
        parsedMessageRanges: pr.parsedMessageRanges,
        dataQualityReport: pr.dataQualityReport,
      };
    }),
  );
  const openQuality = useSidebarStore((s) => s.openQuality);

  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const hoverLineRef = useRef<HTMLDivElement>(null);
  const hoverTooltipRef = useRef<HTMLDivElement>(null);
  const playbackTimeRef = useRef<HTMLDivElement>(null);

  const startTimeRef = useRef<Time | undefined>(undefined);
  const endTimeRef = useRef<Time | undefined>(undefined);
  const latestTimeRef = useRef<Time | undefined>(player.getCurrentTime());
  const isDraggingRef = useRef(false);
  const lastHoverPercentRef = useRef<number | null>(null);
  const cancelPlaybackFrameRef = useRef<(() => void) | null>(null);

  const [timeDisplayMode, setTimeDisplayMode] = useState<PlaybackTimeDisplayMode>(() => readStoredPlaybackTimeMode());
  const [playbackSettingsMenubarValue, setPlaybackSettingsMenubarValue] = useState('');
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const timeDisplayModeRef = useRef<PlaybackTimeDisplayMode>(readStoredPlaybackTimeMode());

  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useLayoutEffect(() => {
    timeDisplayModeRef.current = timeDisplayMode;
  }, [timeDisplayMode]);

  const playbackOverlays = useMemo(
    () =>
      extensions
        .flatMap((extension) => [
          ...(extension.playbackOverlays ?? []),
          ...(extension.timelineOverlays ?? []),
        ])
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [extensions],
  );

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) {
      return;
    }

    const updateTrackWidth = () => {
      const rect = track.getBoundingClientRect();
      setTrackWidthPx((prev) => {
        const next = Math.round(rect.width);
        return prev === next ? prev : next;
      });
    };

    updateTrackWidth();
    const resizeObserver = new ResizeObserver(updateTrackWidth);
    resizeObserver.observe(track);
    window.addEventListener('resize', updateTrackWidth);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateTrackWidth);
    };
  }, []);

  const effectiveSamplingFps = samplingFps ?? player.getSamplingFps();
  const fpsSelectOptions = useMemo(() => {
    const cur = Math.round(Number.isFinite(effectiveSamplingFps) ? effectiveSamplingFps : 30);
    return Array.from(new Set<number>([...PRESET_SAMPLING_FPS, cur])).sort((a, b) => a - b);
  }, [effectiveSamplingFps]);

  const roundedSamplingFps = Math.round(Number.isFinite(effectiveSamplingFps) ? effectiveSamplingFps : 30);

  const setProgressPercent = useCallback((percent: number) => {
    const p = clampPercent(percent);
    fillRef.current?.style.setProperty('width', `${p}%`);
    thumbRef.current?.style.setProperty('left', `${p}%`);
  }, []);

  const writeTimeLabels = useCallback((time: Time) => {
    const st = startTimeRef.current;
    const et = endTimeRef.current;
    if (!st || !et) return;
    const el = playbackTimeRef.current;
    if (!el) return;
    el.textContent = formatPlaybackTimeLine(time, st, et, timeDisplayModeRef.current);
  }, []);

  const applyPlaybackTime = useCallback(
    (time: Time) => {
      latestTimeRef.current = time;
      if (isDraggingRef.current) return;
      const st = startTimeRef.current;
      const et = endTimeRef.current;
      if (!st || !et) return;
      setProgressPercent(timeToPercent(time, st, et));
      writeTimeLabels(time);
    },
    [setProgressPercent, writeTimeLabels],
  );

  const playbackBoundsKey =
    startTime && endTime ? `${startTime.sec}:${startTime.nsec}|${endTime.sec}:${endTime.nsec}` : '';
  const prevBoundsKeyRef = useRef('');

  useLayoutEffect(() => {
    startTimeRef.current = startTime;
    endTimeRef.current = endTime;
    if (!startTime || !endTime) return;
    if (playbackBoundsKey !== prevBoundsKeyRef.current) {
      prevBoundsKeyRef.current = playbackBoundsKey;
      latestTimeRef.current = startTime;
    } else if (!latestTimeRef.current) {
      latestTimeRef.current = startTime;
    }
    if (!isDraggingRef.current && latestTimeRef.current) {
      applyPlaybackTime(latestTimeRef.current);
    }
  }, [playbackBoundsKey, startTime, endTime, applyPlaybackTime]);

  useEffect(() => {
    if (!startTime || !endTime) return;
    return player.subscribeCurrentTime((time) => {
      latestTimeRef.current = time;
      if (cancelPlaybackFrameRef.current != null) {
        return;
      }
      cancelPlaybackFrameRef.current = scheduleFrame(() => {
        cancelPlaybackFrameRef.current = null;
        const latest = latestTimeRef.current;
        if (latest) {
          applyPlaybackTime(latest);
        }
      });
    });
  }, [player, startTime, endTime, applyPlaybackTime]);

  useEffect(() => {
    return () => {
      cancelPlaybackFrameRef.current?.();
      cancelPlaybackFrameRef.current = null;
    };
  }, []);

  const loadedRanges = useMemo<Array<{ left: number; width: number }>>(() => {
    if (!startTime || !endTime) return [];
    const totalNs = toNano(endTime) - toNano(startTime);
    const trackBudget = trackWidthPx > 0 ? Math.max(12, Math.floor(trackWidthPx / 6)) : DEFAULT_PROGRESS_RANGE_BUDGET;
    const nsPerPixel = trackWidthPx > 0 && totalNs > 0n ? totalNs / BigInt(trackWidthPx) : 0n;
    const visualGapNs = nsPerPixel > 0n ? nsPerPixel * 2n : 0n;
    const visuallyCompacted = compactTimeRanges(parsedMessageRanges ?? [], {
      maxGapNs: visualGapNs,
      maxRanges: trackBudget,
      maxBudgetMergeGapNs: visualGapNs > 0n ? visualGapNs * 6n : 0n,
    });

    return visuallyCompacted
      .map((range: TimeRange) => {
        const left = clampPercent(timeToPercent(range.start, startTime, endTime));
        const width = clampPercent(timeToPercent(range.end, startTime, endTime) - left);
        return { left, width };
      })
      .filter((range: { left: number; width: number }) => range.width > 0);
  }, [parsedMessageRanges, startTime, endTime, trackWidthPx]);

  const getPercentFromClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clampPercent(((clientX - rect.left) / rect.width) * 100);
  };

  const commitSeek = (percent: number) => {
    const st = startTimeRef.current;
    const et = endTimeRef.current;
    if (!st || !et) return;
    player.seek(percentToTime(percent, st, et));
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = startTimeRef.current;
    const et = endTimeRef.current;
    if (!st || !et) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const percent = getPercentFromClientX(e.clientX);
    isDraggingRef.current = true;
    setProgressPercent(percent);
    writeTimeLabels(percentToTime(percent, st, et));
    updateHoverChrome(
      hoverLineRef.current,
      hoverTooltipRef.current,
      percent,
      st,
      et,
      timeDisplayModeRef.current,
      lastHoverPercentRef,
    );
  };

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = startTimeRef.current;
    const et = endTimeRef.current;
    const percent = getPercentFromClientX(e.clientX);
    if (isDraggingRef.current) {
      if (st && et) {
        setProgressPercent(percent);
        writeTimeLabels(percentToTime(percent, st, et));
      }
      updateHoverChrome(
        hoverLineRef.current,
        hoverTooltipRef.current,
        percent,
        st,
        et,
        timeDisplayModeRef.current,
        lastHoverPercentRef,
      );
    } else {
      updateHoverChrome(
        hoverLineRef.current,
        hoverTooltipRef.current,
        percent,
        st,
        et,
        timeDisplayModeRef.current,
        lastHoverPercentRef,
      );
    }
  };

  const handleTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const percent = getPercentFromClientX(e.clientX);
    isDraggingRef.current = false;
    commitSeek(percent);
  };

  const handleTrackPointerLeave = () => {
    if (!isDraggingRef.current) {
      updateHoverChrome(
        hoverLineRef.current,
        hoverTooltipRef.current,
        null,
        undefined,
        undefined,
        timeDisplayModeRef.current,
        lastHoverPercentRef,
      );
    }
  };

  const handleTogglePlay = () => {
    if (isPlaying) player.pause();
    else player.play();
  };

  const handleStep = (direction: -1 | 1, e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.altKey) {
      player.stepBy(direction * resolveStepMsFromModifiers(e));
    } else {
      player.stepMessage(direction);
    }
  };

  const refreshHoverAfterTimeModeChange = useCallback(() => {
    const p = lastHoverPercentRef.current;
    const st = startTimeRef.current;
    const et = endTimeRef.current;
    if (p == null || !st || !et) return;
    updateHoverChrome(
      hoverLineRef.current,
      hoverTooltipRef.current,
      p,
      st,
      et,
      timeDisplayModeRef.current,
      lastHoverPercentRef,
    );
  }, []);

  const handleToggleTimeDisplayMode = () => {
    const next: PlaybackTimeDisplayMode = timeDisplayModeRef.current === 'relative' ? 'absolute' : 'relative';
    timeDisplayModeRef.current = next;
    try {
      globalThis.localStorage?.setItem(PLAYBACK_TIME_MODE_STORAGE_KEY, next);
    } catch {
      /* ignore quota / private mode */
    }
    setTimeDisplayMode(next);
    const t = latestTimeRef.current;
    const st = startTimeRef.current;
    const et = endTimeRef.current;
    if (t && st && et) {
      writeTimeLabels(t);
    }
    refreshHoverAfterTimeModeChange();
  };

  const handleSelectQualityRange = useCallback(
    (range: DataQualityIssueRange) => {
      openQuality({ type: range.type, topic: range.topicNames[0], severity: range.severity });
      player.seek(range.start);
    },
    [openQuality, player],
  );

  return (
    <div className="border-t border-border/70 bg-card px-3 py-1.5 shrink-0" data-testid="playback-bar">
      <div className="flex flex-col gap-1">
        <PlaybackOverlayHost overlays={playbackOverlays} context={extensionContext} />
        <div
          ref={trackRef}
          data-testid="playback-track"
          className="relative h-2 rounded-full bg-muted/65 cursor-pointer touch-none select-none transition-colors hover:bg-muted/75"
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          onPointerCancel={handleTrackPointerUp}
          onPointerLeave={handleTrackPointerLeave}
        >
          {loadedRanges.map((range: { left: number; width: number }, idx: number) => (
            <div
              key={`loaded-${idx}`}
              data-testid="playback-loaded-range"
              className="pointer-events-none absolute inset-y-0 rounded-full bg-muted-foreground/35"
              style={{ left: `${range.left}%`, width: `${range.width}%` }}
            />
          ))}
          <div
            ref={fillRef}
            data-testid="playback-progress-fill"
            className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary/75 to-primary"
            style={{ width: '0%' }}
          />
          <div
            ref={hoverLineRef}
            data-testid="playback-hover-line"
            className="ros-playback-center-xy pointer-events-none absolute top-1/2 z-[2] h-6 w-px bg-primary/55 opacity-0"
            style={{ left: '0%' }}
          />
          <div
            ref={thumbRef}
            data-testid="playback-thumb"
            className="ros-playback-center-xy pointer-events-none absolute top-1/2 z-[3] h-3 w-3 rounded-full border border-primary bg-background"
            style={{ left: '0%' }}
          />
          <div
            ref={hoverTooltipRef}
            data-testid="playback-hover-time"
            className="ros-playback-center-x pointer-events-none absolute -top-8 z-10 rounded-md border border-border bg-popover px-2 py-1 text-[10px] font-mono text-popover-foreground opacity-0 shadow-lg"
            style={{ left: '0%' }}
          />
        </div>
        <PlaybackQualityMarkersLane
          startTime={startTime}
          endTime={endTime}
          report={dataQualityReport}
          onSelectRange={handleSelectQualityRange}
        />

        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 w-full text-[12px] font-mono">
          <div className="flex min-w-0 items-center gap-1 px-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="playback-time-display-mode"
              className="h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={
                timeDisplayMode === 'relative'
                  ? formatMessage({ id: 'playback.timeMode.relative.aria' })
                  : formatMessage({ id: 'playback.timeMode.absolute.aria' })
              }
              title={
                timeDisplayMode === 'relative'
                  ? formatMessage({ id: 'playback.timeMode.relative.title' })
                  : formatMessage({ id: 'playback.timeMode.absolute.title' })
              }
              onClick={handleToggleTimeDisplayMode}
            >
              {timeDisplayMode === 'relative' ? (
                <Timer size={15} strokeWidth={2} aria-hidden />
              ) : (
                <CalendarClock size={15} strokeWidth={2} aria-hidden />
              )}
            </Button>
            <div
              ref={playbackTimeRef}
              className="min-w-0 flex-1 truncate tabular-nums text-muted-foreground/85"
              title={timeDisplayMode === 'absolute' ? timezone : undefined}
            />
          </div>

          <div className="flex items-center justify-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={TRANSPORT_ICON_BTN_CLASS}
              aria-label={formatMessage({ id: 'playback.stepBack.aria' })}
              title={formatMessage({ id: 'playback.stepBack.title' })}
              onClick={(e) => handleStep(-1, e)}
            >
              <SkipBack size={18} strokeWidth={2} />
            </Button>
            <Button
              type="button"
              variant="default"
              size="icon"
              className={PLAYBACK_PRIMARY_TRANSPORT_CLASS}
              aria-label={
                isPlaying ? formatMessage({ id: 'playback.pause' }) : formatMessage({ id: 'playback.play' })
              }
              title={isPlaying ? formatMessage({ id: 'playback.pause' }) : formatMessage({ id: 'playback.play' })}
              onClick={handleTogglePlay}
            >
              {isPlaying ? <Pause strokeWidth={2} aria-hidden /> : <Play strokeWidth={2} className="ml-0.5" aria-hidden />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={TRANSPORT_ICON_BTN_CLASS}
              aria-label={formatMessage({ id: 'playback.stepForward.aria' })}
              title={formatMessage({ id: 'playback.stepForward.title' })}
              onClick={(e) => handleStep(1, e)}
            >
              <SkipForward size={18} strokeWidth={2} />
            </Button>
          </div>

          <div className="flex justify-end">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Menubar
                value={playbackSettingsMenubarValue}
                onValueChange={setPlaybackSettingsMenubarValue}
                className="h-7 min-w-0 shrink gap-1 border-0 bg-transparent p-0 shadow-none"
              >
                <MenubarMenu value={MENUBAR_PLAYBACK_SPEED}>
                  <MenubarTrigger
                    type="button"
                    className={PLAYBACK_MENUBAR_TRIGGER_CLASS}
                    data-testid="playback-speed-trigger"
                    aria-label={formatMessage({ id: 'playback.speed.aria' })}
                    title={formatMessage({ id: 'playback.speed.aria' })}
                    onPointerEnter={() => {
                      setPlaybackSettingsMenubarValue(MENUBAR_PLAYBACK_SPEED);
                    }}
                  >
                    {speed === PLAYBACK_SPEED_MAX
                      ? formatMessage({ id: 'playback.speedMax' })
                      : `${speed}x`}
                  </MenubarTrigger>
                  <MenubarContent align="end" sideOffset={6}>
                    <MenubarGroup>
                      {PRESET_SPEEDS.map((item) => (
                        <MenubarItem
                          key={item}
                          className={`text-xs ${speed === item ? 'bg-accent text-accent-foreground' : ''}`}
                          onSelect={() => {
                            player.setSpeed(item);
                          }}
                        >
                          {item}x
                        </MenubarItem>
                      ))}
                      <MenubarItem
                        className={`text-xs ${speed === PLAYBACK_SPEED_MAX ? 'bg-accent text-accent-foreground' : ''}`}
                        onSelect={() => {
                          player.setSpeed(PLAYBACK_SPEED_MAX);
                        }}
                      >
                        {formatMessage({ id: 'playback.speedMax' })}
                      </MenubarItem>
                    </MenubarGroup>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu value={MENUBAR_PLAYBACK_FPS}>
                  <MenubarTrigger
                    type="button"
                    className={PLAYBACK_MENUBAR_TRIGGER_CLASS}
                    data-testid="playback-fps-trigger"
                    aria-label={formatMessage({ id: 'playback.samplingFps.aria' })}
                    title={formatMessage({ id: 'playback.samplingFps.aria' })}
                    onPointerEnter={() => {
                      setPlaybackSettingsMenubarValue(MENUBAR_PLAYBACK_FPS);
                    }}
                  >
                    {roundedSamplingFps} FPS
                  </MenubarTrigger>
                  <MenubarContent align="end" sideOffset={6}>
                    <MenubarGroup>
                      {fpsSelectOptions.map((item) => (
                        <MenubarItem
                          key={item}
                          data-testid={`playback-fps-option-${item}`}
                          className={`text-xs ${roundedSamplingFps === item ? 'bg-accent text-accent-foreground' : ''}`}
                          onSelect={() => {
                            player.setSamplingFps(item);
                          }}
                        >
                          {item} FPS
                        </MenubarItem>
                      ))}
                    </MenubarGroup>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu value={MENUBAR_PLAYBACK_LOOP}>
                  <MenubarTrigger
                    type="button"
                    className={PLAYBACK_MENUBAR_TRIGGER_CLASS}
                    data-testid="playback-loop-trigger"
                    aria-label={formatMessage({ id: 'playback.loop.aria' })}
                    title={formatMessage({ id: 'playback.loop.aria' })}
                    onPointerEnter={() => {
                      setPlaybackSettingsMenubarValue(MENUBAR_PLAYBACK_LOOP);
                    }}
                  >
                    {isLooping
                      ? formatMessage({ id: 'playback.loop.loop' })
                      : formatMessage({ id: 'playback.loop.once' })}
                  </MenubarTrigger>
                  <MenubarContent align="end" sideOffset={6}>
                    <MenubarGroup>
                      <MenubarItem
                        data-testid="playback-loop-option-loop"
                        className={`text-xs ${isLooping ? 'bg-accent text-accent-foreground' : ''}`}
                        onSelect={() => {
                          player.setLooping(true);
                        }}
                      >
                        {formatMessage({ id: 'playback.loop.loop' })}
                      </MenubarItem>
                      <MenubarItem
                        data-testid="playback-loop-option-once"
                        className={`text-xs ${!isLooping ? 'bg-accent text-accent-foreground' : ''}`}
                        onSelect={() => {
                          player.setLooping(false);
                        }}
                      >
                        {formatMessage({ id: 'playback.loop.once' })}
                      </MenubarItem>
                    </MenubarGroup>
                  </MenubarContent>
                </MenubarMenu>
              </Menubar>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
