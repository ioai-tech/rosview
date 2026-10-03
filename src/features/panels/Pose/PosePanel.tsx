import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveEventTimestamp, timeToSec } from '@/core/analysis/timeSeries';
import { messageBus } from '@/core/pipeline/messageBus';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { Player } from '@/core/types/player';
import {
  readPoseStampedFrameId,
  readPoseStampedOrientation,
  readPoseStampedPosition3,
} from '@/features/panels/common/poseExtractors';
import {
  getScenePanelThemeColors,
  type ScenePanelThemeColors,
} from '@/features/panels/common/scenePanelTheme';
import {
  ThreeCanvas,
  createAxesHelper,
  createZUpGrid,
  createZUpLights,
  useSceneObject,
  useThreeCanvas,
} from '@/features/panels/common/threeCanvas';
import {
  CANVAS_CAMERA,
  CANVAS_GL,
  DEFAULT_GRID_DIVISIONS,
  DEFAULT_GRID_SIZE,
} from '@/features/panels/common/zUpSceneLayout';
import { useRosViewTheme } from '@/features/viewer/RosViewProvider';
import { useIntl } from 'react-intl';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { TransformTree } from '../ThreeD/core/transformTree';
import type { PoseConfig } from './defaults';
import { buildTrajectoryLineBands, type TrajectoryLineBand } from './trajectory';

interface PosePanelProps {
  player: Player;
  panelId: string;
  config: PoseConfig;
}

type PoseSample = {
  t: number;
  frameId: string;
  position: [number, number, number];
  orientation: [number, number, number, number];
};

type PoseTrack = {
  topic: string;
  color: string;
  samples: PoseSample[];
};

const DEFAULT_TOPIC_COLORS = ['#38bdf8', '#f97316', '#22c55e', '#e879f9', '#f43f5e', '#facc15'] as const;

function isPoseStampedType(typeName: string): boolean {
  const normalized = typeName.trim().toLowerCase();
  return normalized === 'geometry_msgs/msg/posestamped' || normalized === 'geometry_msgs/posestamped';
}

/** Re-request a frame when topic visibility or trail data changes (demand loop). */
const PoseDemandInvalidate: React.FC<{ signature: string }> = ({ signature }) => {
  const handle = useThreeCanvas();
  useEffect(() => {
    handle.invalidate();
  }, [handle, signature]);
  return null;
};

const PoseSceneChrome: React.FC<{ colors: ScenePanelThemeColors }> = ({ colors }) => {
  const { scene, invalidate } = useThreeCanvas();

  useLayoutEffect(() => {
    const lights = createZUpLights({ preset: 'full', colors });
    const grid = createZUpGrid({
      size: DEFAULT_GRID_SIZE,
      divisions: DEFAULT_GRID_DIVISIONS,
      rotationX: Math.PI / 2,
      primary: colors.gridPrimary,
      secondary: colors.gridSecondary,
    });
    const axes = createAxesHelper(1);
    scene.add(lights.object);
    scene.add(grid.object);
    scene.add(axes.object);
    invalidate();
    return () => {
      scene.remove(lights.object);
      scene.remove(grid.object);
      scene.remove(axes.object);
      lights.dispose();
      grid.dispose();
      axes.dispose();
      invalidate();
    };
  }, [colors, invalidate, scene]);

  return null;
};

const BandLine: React.FC<{ band: TrajectoryLineBand; color: string }> = ({ band, color }) => {
  const handle = useThreeCanvas();
  const lineObject = useMemo(() => {
    const geometry = new LineGeometry();
    geometry.setPositions(band.points.flat());
    const material = new LineMaterial({
      color,
      linewidth: band.width,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
    });
    // LineMaterial defaults resolution to (1, 1). Set from the live handle
    // before useSceneObject invalidates so the first demand frame is not fat.
    material.resolution.set(Math.max(1, handle.size.width), Math.max(1, handle.size.height));
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    return line;
  }, [band.points, band.width, color, handle]);

  useLayoutEffect(() => {
    const material = lineObject.material;
    const syncResolution = (size: { width: number; height: number }) => {
      material.resolution.set(Math.max(1, size.width), Math.max(1, size.height));
    };
    syncResolution(handle.size);
    return handle.onResize(syncResolution);
  }, [handle, lineObject]);

  useEffect(
    () => () => {
      lineObject.geometry.dispose();
      lineObject.material.dispose();
    },
    [lineObject],
  );

  useSceneObject(lineObject);
  return null;
};

const PoseTrail: React.FC<{ track: PoseTrack; minLineWidth: number; maxLineWidth: number }> = ({
  track,
  minLineWidth,
  maxLineWidth,
}) => {
  const points = useMemo(() => track.samples.map((sample) => sample.position), [track.samples]);
  const bands = useMemo(() => buildTrajectoryLineBands(points, minLineWidth, maxLineWidth), [
    maxLineWidth,
    minLineWidth,
    points,
  ]);
  return (
    <>
      {bands.map((band) => (
        <BandLine key={`${track.topic}:${band.key}`} band={band} color={track.color} />
      ))}
    </>
  );
};

const SHARED_POSE_SPHERE_GEOMETRY = new THREE.SphereGeometry(1, 12, 8);

const PoseAxes: React.FC<{ sample: PoseSample; scale: number; color: string }> = ({
  sample,
  scale,
  color,
}) => {
  const { invalidate } = useThreeCanvas();
  const group = useMemo(() => {
    const root = new THREE.Group();
    root.add(new THREE.AxesHelper(scale));
    const mesh = new THREE.Mesh(
      SHARED_POSE_SPHERE_GEOMETRY,
      new THREE.MeshStandardMaterial({ color }),
    );
    mesh.scale.setScalar(Math.max(scale * 0.12, 0.01));
    root.add(mesh);
    return root;
  }, [color, scale]);

  useLayoutEffect(() => {
    group.position.set(sample.position[0], sample.position[1], sample.position[2]);
    group.quaternion.set(
      sample.orientation[0],
      sample.orientation[1],
      sample.orientation[2],
      sample.orientation[3],
    );
    invalidate();
  }, [group, invalidate, sample.orientation, sample.position]);

  useEffect(
    () => () => {
      group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry && mesh.geometry !== SHARED_POSE_SPHERE_GEOMETRY) {
          mesh.geometry.dispose();
        }
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!material) return;
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose());
        } else {
          material.dispose();
        }
      });
    },
    [group],
  );

  useSceneObject(group);
  return null;
};

export const PosePanel: React.FC<PosePanelProps> = ({ player, panelId, config }) => {
  const { resolvedTheme } = useRosViewTheme();
  const { formatMessage } = useIntl();
  const topics = useMessagePipeline((state) => state.sortedTopics);
  const autoPoseTopics = useMemo(
    () => topics.filter((topic) => isPoseStampedType(topic.type)),
    [topics],
  );
  const tfTopics = useMemo(
    () =>
      topics
        .filter(
          (topic) =>
            topic.type.includes('TFMessage') ||
            topic.type.includes('tf2_msgs') ||
            topic.type.includes('tf/tfMessage'),
        )
        .map((topic) => topic.name),
    [topics],
  );
  const tfTopicSet = useMemo(() => new Set(tfTopics), [tfTopics]);
  const transformTreeRef = useRef<TransformTree>(new TransformTree());
  const [tracks, setTracks] = useState<PoseTrack[]>([]);
  const [tfUnavailable, setTfUnavailable] = useState(false);
  const lastPlaybackSecRef = useRef<number | null>(null);
  const configuredByTopic = useMemo(
    () => new Map(config.topics.map((entry) => [entry.topic, entry])),
    [config.topics],
  );
  const effectiveTopics = useMemo(() => {
    return autoPoseTopics.map((topic, index) => {
      const configured = configuredByTopic.get(topic.name);
      return {
        topic: topic.name,
        color: configured?.color ?? DEFAULT_TOPIC_COLORS[index % DEFAULT_TOPIC_COLORS.length],
        enabled: configured?.enabled ?? true,
      };
    });
  }, [autoPoseTopics, configuredByTopic]);
  const enabledTopics = useMemo(
    () => effectiveTopics.filter((entry) => entry.enabled !== false && entry.topic.length > 0),
    [effectiveTopics],
  );
  const topicNames = useMemo(() => enabledTopics.map((entry) => entry.topic), [enabledTopics]);
  const topicSettingByName = useMemo(
    () => new Map(enabledTopics.map((entry) => [entry.topic, entry])),
    [enabledTopics],
  );

  useEffect(() => {
    const allowed = new Set(topicNames);
    setTracks((prev) => prev.filter((track) => allowed.has(track.topic)));
  }, [topicNames]);

  useEffect(() => {
    const subscriptions = [...topicNames];
    if (config.frameMode === 'tfAligned') {
      subscriptions.push(...tfTopics);
    }
    const uniqueTopics = Array.from(new Set(subscriptions));
    if (uniqueTopics.length === 0) {
      player.unregisterSubscriptions(panelId);
      setTracks([]);
      return;
    }
    player.registerSubscriptions(
      panelId,
      uniqueTopics.map((topic) => ({ topic, subscriberId: panelId })),
    );
    return () => player.unregisterSubscriptions(panelId);
  }, [config.frameMode, panelId, player, tfTopics, topicNames]);

  useEffect(
    () =>
      player.subscribeCurrentTime((time) => {
        const sec = timeToSec(time);
        const previous = lastPlaybackSecRef.current;
        if (previous != null && previous - sec > 0.02) {
          transformTreeRef.current = new TransformTree();
          setTracks([]);
        }
        lastPlaybackSecRef.current = sec;
      }),
    [player],
  );

  const processSubscriberBatch = useCallback(() => {
    const messages = messageBus.getSubscriberMessages(panelId);
    if (!messages || messages.length === 0) return;
    setTracks((prev) => {
      const byTopic = new Map(prev.map((track) => [track.topic, track]));
      let tfMissing = config.frameMode === 'tfAligned';
      for (const message of messages) {
        if (tfTopicSet.has(message.topic)) {
          const payload = message.message as {
            transforms?: Array<{
              header?: { frame_id?: string; stamp?: { sec?: number; nsec?: number; nanosec?: number } };
              child_frame_id?: string;
              transform?: {
                translation?: { x?: number; y?: number; z?: number };
                rotation?: { x?: number; y?: number; z?: number; w?: number };
              };
            }>;
          };
          if (!Array.isArray(payload.transforms)) continue;
          for (const transform of payload.transforms) {
            const parent = transform.header?.frame_id;
            const child = transform.child_frame_id;
            const translation = transform.transform?.translation;
            const rotation = transform.transform?.rotation;
            const stamp = transform.header?.stamp;
            const sec = stamp?.sec;
            const nsec = stamp?.nsec ?? stamp?.nanosec;
            if (
              typeof parent !== 'string' ||
              typeof child !== 'string' ||
              !translation ||
              !rotation ||
              typeof translation.x !== 'number' ||
              typeof translation.y !== 'number' ||
              typeof translation.z !== 'number' ||
              typeof rotation.x !== 'number' ||
              typeof rotation.y !== 'number' ||
              typeof rotation.z !== 'number' ||
              typeof rotation.w !== 'number' ||
              typeof sec !== 'number' ||
              typeof nsec !== 'number'
            ) {
              continue;
            }
            const translationValue = translation as { x: number; y: number; z: number };
            const rotationValue = rotation as { x: number; y: number; z: number; w: number };
            const stampNs = BigInt(sec) * 1_000_000_000n + BigInt(nsec);
            transformTreeRef.current.addTransform(
              parent,
              child,
              stampNs,
              translationValue,
              rotationValue,
            );
          }
          continue;
        }

        const setting = topicSettingByName.get(message.topic);
        if (!setting) continue;
        if (!isPoseStampedType(message.schemaName)) continue;

        const position = readPoseStampedPosition3(message.message);
        const orientation = readPoseStampedOrientation(message.message);
        if (!position || !orientation) continue;

        const timestampResolution = resolveEventTimestamp(message, 'headerStamp');
        const timestamp = timeToSec(timestampResolution.time);
        const stampNs =
          BigInt(timestampResolution.time.sec) * 1_000_000_000n +
          BigInt(timestampResolution.time.nsec);
        const frameId = readPoseStampedFrameId(message.message);
        let nextPosition = position;
        let nextOrientation = orientation;

        if (config.frameMode === 'tfAligned' && frameId && config.targetFrame) {
          const relative = transformTreeRef.current.getRelativeTransform(
            config.targetFrame,
            frameId,
            stampNs,
          );
          if (relative) {
            const transformedPosition = new THREE.Vector3(...position)
              .applyQuaternion(relative.rotation)
              .add(relative.position);
            const transformedOrientation = relative.rotation.multiply(
              new THREE.Quaternion(...orientation),
            );
            nextPosition = [transformedPosition.x, transformedPosition.y, transformedPosition.z];
            nextOrientation = [
              transformedOrientation.x,
              transformedOrientation.y,
              transformedOrientation.z,
              transformedOrientation.w,
            ];
            tfMissing = false;
          }
        }

        const existing = byTopic.get(message.topic);
        const nextSamples: PoseSample[] = [
          ...(existing?.samples ?? []),
          {
            t: timestamp,
            frameId,
            position: nextPosition,
            orientation: nextOrientation,
          },
        ];
        const cutoff = timestamp - config.historySec;
        const trimmed = nextSamples.filter((sample) => sample.t >= cutoff);
        byTopic.set(message.topic, {
          topic: message.topic,
          color: setting.color,
          samples: trimmed,
        });
      }

      setTfUnavailable(tfMissing);
      return Array.from(byTopic.values()).filter((track) => track.samples.length > 0);
    });
  }, [
    config.frameMode,
    config.historySec,
    config.targetFrame,
    panelId,
    tfTopicSet,
    topicSettingByName,
  ]);

  useEffect(() => {
    const unsubscribe = messageBus.subscribeToMessages(panelId, processSubscriberBatch);
    processSubscriberBatch();
    return unsubscribe;
  }, [panelId, processSubscriberBatch]);

  useEffect(() => {
    if (config.frameMode !== 'tfAligned') {
      setTfUnavailable(false);
    } else if (tfTopics.length === 0) {
      setTfUnavailable(true);
    }
  }, [config.frameMode, tfTopics.length]);

  const colors = useMemo(() => getScenePanelThemeColors(resolvedTheme), [resolvedTheme]);
  const panelClass = colors.panelBackgroundClassName;
  const latestSamples = useMemo(
    () =>
      tracks
        .map((track) => ({
          topic: track.topic,
          color: track.color,
          sample: track.samples[track.samples.length - 1],
        }))
        .filter((entry) => entry.sample != null),
    [tracks],
  );

  const demandInvalidateSignature = useMemo(
    () =>
      `${topicNames.join('\u0001')}|${tracks.map((t) => `${t.topic}:${t.samples.length}`).join('\u0001')}`,
    [topicNames, tracks],
  );

  return (
    <div className={`relative h-full w-full overflow-hidden contain-strict ${panelClass}`}>
      {tfUnavailable && (
        <div
          className={`pointer-events-none absolute left-2 top-2 z-10 rounded border px-2 py-1 text-[10px] ${colors.overlayClassName}`}
        >
          {formatMessage({ id: 'panels.pose.overlay.tfFallback' })}
        </div>
      )}
      {enabledTopics.length > 0 && (
        <div
          className={`pointer-events-none absolute right-2 top-2 z-10 max-w-[min(24rem,48vw)] space-y-1 rounded px-2 py-1 text-[10px] font-mono ${colors.overlayClassName}`}
        >
          {enabledTopics.map((entry) => (
            <div key={entry.topic} className="flex items-center gap-1 overflow-hidden">
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: entry.color }} />
              <span className="truncate">{entry.topic}</span>
            </div>
          ))}
        </div>
      )}
      <ThreeCanvas
        shadows
        gl={CANVAS_GL}
        camera={CANVAS_CAMERA}
        background={colors.sceneBackground}
        gizmoLabelColor={colors.gizmoLabelColor}
      >
        <PoseSceneChrome colors={colors} />
        <PoseDemandInvalidate signature={demandInvalidateSignature} />
        {tracks.map((track) => (
          <PoseTrail
            key={track.topic}
            track={track}
            minLineWidth={config.minLineWidth}
            maxLineWidth={config.maxLineWidth}
          />
        ))}
        {config.showOrientation &&
          latestSamples.map((entry) => (
            <PoseAxes
              key={`${entry.topic}:axes`}
              sample={entry.sample}
              scale={config.orientationScale}
              color={entry.color}
            />
          ))}
      </ThreeCanvas>
    </div>
  );
};
