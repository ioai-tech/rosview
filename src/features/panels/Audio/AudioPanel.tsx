import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useShallow } from 'zustand/react/shallow';
import { timeToNs } from '@/core/analysis/timeSeries';
import type { Player } from '@/core/types/player';
import { messageBus } from '@/core/pipeline/messageBus';
import { useSubscriberSeq } from '@/core/pipeline/useMessageBus';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { TopicInfo } from '@/core/types/ros';
import { Button } from '@/shared/ui/button';
import {
  isAudioCommonInfoSchema,
  isAudioPanelMainTopicSchema,
  isRawAudioSchema,
} from '@/shared/ros/rosMessageTypes';
import { TopicQuickPicker } from '../framework/TopicQuickPicker';
import type { AudioConfig } from './defaults';
import { AudioPlaybackController } from './core/audioPlaybackController';
import { normalizeAudioMessage } from './core/normalize';
import { heuristicAudioInfoTopics, ingestAudioInfoFromEvent } from './core/resolveAudioInfo';
import type { ParsedAudioInfo } from './core/types';
import { WaveformEnvelopeBuffer } from './core/waveformBuffer';

export type AudioPanelProps = AudioConfig & {
  player: Player;
  panelId: string;
  setConfig: (next: AudioConfig | ((prev: AudioConfig) => AudioConfig)) => void;
};

function filterMainAudioTopics(topics: ReadonlyArray<TopicInfo>): TopicInfo[] {
  return topics.filter((t) => isAudioPanelMainTopicSchema(t.type));
}

export const AudioPanel: React.FC<AudioPanelProps> = (props) => {
  const { formatMessage } = useIntl();
  const { player, panelId, setConfig, ...config } = props;

  const topics = useMessagePipeline((s) => s.sortedTopics);
  const { isPlaying, speed } = useMessagePipeline(
    useShallow((s) => ({
      isPlaying: s.playerState.activeData?.isPlaying ?? false,
      speed: s.playerState.activeData?.speed ?? 1,
    })),
  );

  const mainTopicType = useMemo(
    () => topics.find((t) => t.name === config.topic)?.type ?? '',
    [topics, config.topic],
  );

  const subscribedTopics = useMemo(() => {
    if (!config.topic) return [];
    const set = new Set<string>([config.topic]);
    if (config.audioInfoTopic.trim().length > 0) {
      set.add(config.audioInfoTopic.trim());
    }
    if (!isRawAudioSchema(mainTopicType)) {
      for (const h of heuristicAudioInfoTopics(config.topic)) {
        if (topics.some((t) => t.name === h && isAudioCommonInfoSchema(t.type))) {
          set.add(h);
        }
      }
    }
    return [...set];
  }, [config.topic, config.audioInfoTopic, mainTopicType, topics]);

  const infoCacheRef = useRef<Map<string, ParsedAudioInfo>>(new Map());
  const currentLogNsRef = useRef<bigint>(0n);
  const prevLogNsRef = useRef<bigint | null>(null);
  const controllerRef = useRef(new AudioPlaybackController());
  const waveRef = useRef(new WaveformEnvelopeBuffer(config.waveformWindowSec));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [statusKey, setStatusKey] = useState<string>('waiting');
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const subscriberSeq = useSubscriberSeq(panelId);

  useEffect(() => {
    infoCacheRef.current = new Map();
    waveRef.current = new WaveformEnvelopeBuffer(config.waveformWindowSec);
    controllerRef.current.flush(true);
    setStatusKey(config.topic ? 'waiting' : 'waiting');
  }, [config.topic, config.waveformWindowSec]);

  useEffect(() => {
    if (subscribedTopics.length === 0) {
      player.unregisterSubscriptions(panelId);
      return () => player.unregisterSubscriptions(panelId);
    }
    player.registerSubscriptions(
      panelId,
      subscribedTopics.map((topic) => ({ topic, subscriberId: panelId })),
    );
    return () => player.unregisterSubscriptions(panelId);
  }, [panelId, player, subscribedTopics]);

  useEffect(() => {
    controllerRef.current.setVolume(config.mute ? 0 : config.volume);
  }, [config.volume, config.mute]);

  const allowPlayback = useMemo(() => {
    if (!isPlaying || config.mute) return false;
    return Math.abs(speed - 1) < 1e-4;
  }, [isPlaying, config.mute, speed]);

  useEffect(() => {
    return player.subscribeCurrentTime((time) => {
      const ns = timeToNs(time);
      controllerRef.current.handlePlaybackTimeJump(prevLogNsRef.current, ns);
      prevLogNsRef.current = ns;
      currentLogNsRef.current = ns;
    });
  }, [player]);

  useEffect(() => {
    if (!isPlaying) {
      controllerRef.current.suspend();
    } else {
      void controllerRef.current.resume();
    }
  }, [isPlaying]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    return () => {
      ctrl.dispose();
    };
  }, []);

  useEffect(() => {
    if (!allowPlayback) {
      controllerRef.current.flush(false);
    }
  }, [allowPlayback]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const wave = waveRef.current;
    if (!canvas || !wave) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'hsl(var(--muted))';
    ctx.fillRect(0, 0, w, h);
    const samples = wave.getSamples();
    if (samples.length < 2) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) return;
    const t0 = first.tNs;
    const t1 = last.tNs;
    const span = t1 > t0 ? Number(t1 - t0) : 1;
    ctx.strokeStyle = config.waveformColor;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!s) continue;
      const x = (Number(s.tNs - t0) / span) * w;
      const yMin = h * (0.5 - 0.45 * s.min);
      if (i === 0) ctx.moveTo(x, yMin);
      else ctx.lineTo(x, yMin);
    }
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (!s) continue;
      const x = (Number(s.tNs - t0) / span) * w;
      const yMax = h * (0.5 - 0.45 * s.max);
      ctx.lineTo(x, yMax);
    }
    ctx.closePath();
    ctx.fillStyle = `${config.waveformColor}55`;
    ctx.fill();
    ctx.stroke();
  }, [config.waveformColor]);

  useLayoutEffect(() => {
    drawWaveform();
  }, [drawWaveform, subscriberSeq, config.waveformWindowSec]);

  useEffect(() => {
    void subscriberSeq;
    if (!config.topic || !mainTopicType) {
      setStatusKey('waiting');
      return;
    }
    const batch = messageBus.getSubscriberMessages(panelId);
    if (!batch || batch.length === 0) return;

    for (const ev of batch) {
      const meta = topics.find((x) => x.name === ev.topic)?.type ?? '';
      if (isAudioCommonInfoSchema(meta)) {
        ingestAudioInfoFromEvent(ev.topic, ev.message, infoCacheRef.current);
      }
    }

    const mainEvents = batch.filter((e) => e.topic === config.topic);
    if (mainEvents.length === 0) return;

    const ctrl = controllerRef.current;
    const wave = waveRef.current;

    let lastOk = false;
    for (const ev of mainEvents) {
      const res = normalizeAudioMessage(ev, mainTopicType, infoCacheRef.current, {
        defaults: {
          sampleRate: config.defaultSampleRate,
          channels: config.defaultChannels,
          sampleFormat: config.defaultSampleFormat,
        },
        audioInfoTopic: config.audioInfoTopic.trim() || undefined,
      });
      if (!res.ok) {
        setStatusKey(res.error);
        continue;
      }
      lastOk = true;
      wave.pushFrame(res.frame);
      const curNs = currentLogNsRef.current;
      const can = allowPlayback;
      if (can) {
        void (async () => {
          const running = await ctrl.ensureRunning();
          if (!running) {
            setNeedsUnlock(true);
            return;
          }
          setNeedsUnlock(false);
          ctrl.scheduleChunk(res.frame, curNs, can);
        })();
      }
    }
    if (lastOk) {
      setStatusKey('playing');
    }
    requestAnimationFrame(drawWaveform);
  }, [
    subscriberSeq,
    allowPlayback,
    config.topic,
    config.audioInfoTopic,
    config.defaultSampleRate,
    config.defaultChannels,
    config.defaultSampleFormat,
    mainTopicType,
    panelId,
    topics,
    drawWaveform,
  ]);

  const statusLabel = useMemo(() => {
    if (!config.topic) return formatMessage({ id: 'panels.audio.status.waitingTopic' });
    if (!allowPlayback && isPlaying && !config.mute) {
      if (Math.abs(speed - 1) >= 1e-4) {
        return formatMessage({ id: 'panels.audio.status.mutedNon1x' });
      }
    }
    switch (statusKey) {
      case 'waiting':
        return formatMessage({ id: 'panels.audio.status.waiting' });
      case 'playing':
        return formatMessage({ id: 'panels.audio.status.playing' });
      case 'unsupported_raw_audio_format':
        return formatMessage({ id: 'panels.audio.status.unsupportedRawFormat' });
      case 'unsupported_coding_format':
        return formatMessage({ id: 'panels.audio.status.unsupportedCoding' });
      case 'unsupported_sample_format':
        return formatMessage({ id: 'panels.audio.status.unsupportedSampleFormat' });
      case 'invalid_raw_audio':
        return formatMessage({ id: 'panels.audio.status.invalidRaw' });
      case 'empty_audio_payload':
        return formatMessage({ id: 'panels.audio.status.emptyPayload' });
      case 'unsupported_schema':
        return formatMessage({ id: 'panels.audio.status.unsupportedSchema' });
      case 'audio_info_metadata_only':
        return formatMessage({ id: 'panels.audio.status.infoOnly' });
      default:
        return statusKey;
    }
  }, [allowPlayback, config.mute, config.topic, formatMessage, isPlaying, speed, statusKey]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card" data-testid="audio-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <TopicQuickPicker
          value={config.topic}
          onChange={(topic) => setConfig((prev) => ({ ...prev, topic }))}
          topics={filterMainAudioTopics(topics)}
          placeholder={formatMessage({ id: 'panels.audio.topicPlaceholder' })}
          className="min-w-0 flex-1"
        />
        {needsUnlock ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="audio-unlock"
            onClick={() => {
              void controllerRef.current?.ensureRunning().then((ok) => setNeedsUnlock(!ok));
            }}
          >
            {formatMessage({ id: 'panels.audio.unlock' })}
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
        <span className="truncate font-mono">{statusLabel}</span>
        {config.topic && mainTopicType && !isRawAudioSchema(mainTopicType) ? (
          <span className="shrink-0 text-[9px] opacity-80">
            {formatMessage({ id: 'panels.audio.infoCacheHint' })}
          </span>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 min-w-0 p-2">
        <canvas ref={canvasRef} className="h-full w-full rounded border border-border/50 bg-muted/30" />
      </div>
    </div>
  );
};
