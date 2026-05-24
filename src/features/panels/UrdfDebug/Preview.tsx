import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import type { Player } from '@/core/types/player';
import type { Time } from '@/core/types/ros';
import { useRosViewTheme } from '@/features/viewer/RosViewProvider';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import {
  applyFramePoses,
  applyJointStates,
  buildRobotRenderable,
  disposeRobotRenderable,
  type MeshLoadProgress,
  type RobotRenderable,
} from '../ThreeD/foxglove-core/renderables';
import type { JointStateMsg } from '../ThreeD/foxglove-core/types';

const Z_UP = new THREE.Vector3(0, 0, 1);
const GIZMO_MARGIN: [number, number] = [80, 80];
const GIZMO_AXIS_COLORS: [string, string, string] = ['#ff3653', '#0adb46', '#2c8fff'];
const CANVAS_CAMERA = {
  position: [3, -3, 2] as [number, number, number],
  up: [0, 0, 1] as [number, number, number],
  fov: 45,
  near: 0.5,
  far: 5000,
};

type ThemeColors = {
  panelBackgroundClassName: string;
  overlayClassName: string;
  sceneBackground: THREE.ColorRepresentation;
  gridPrimary: string;
  gridSecondary: string;
  gizmoLabelColor: string;
  fallbackMeshColor: string;
  meshOutlineColor: string;
};

function getThemeColors(resolvedTheme: 'light' | 'dark'): ThemeColors {
  if (resolvedTheme === 'light') {
    return {
      panelBackgroundClassName: 'bg-slate-50',
      overlayClassName: 'bg-white/80 text-slate-800 border border-slate-200',
      sceneBackground: '#f8fafc',
      gridPrimary: '#cbd5e1',
      gridSecondary: '#e2e8f0',
      gizmoLabelColor: '#0f172a',
      fallbackMeshColor: '#cbd5e1',
      meshOutlineColor: '#1e293b',
    };
  }
  return {
    panelBackgroundClassName: 'bg-[#111]',
    overlayClassName: 'bg-black/50 text-white border border-white/10',
    sceneBackground: '#111111',
    gridPrimary: '#666',
    gridSecondary: '#444',
    gizmoLabelColor: 'white',
    fallbackMeshColor: '#cbd5e1',
    meshOutlineColor: '#94a3b8',
  };
}

const CameraSetup: React.FC = () => {
  const { camera, invalidate } = useThree();
  useEffect(() => {
    camera.up.copy(Z_UP);
    camera.position.set(3, -3, 2);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, invalidate]);
  return null;
};

const ZUpGrid: React.FC<{ colors: ThemeColors }> = ({ colors }) => {
  const ref = useRef<THREE.GridHelper>(null);
  useEffect(() => {
    if (ref.current) ref.current.rotation.x = -Math.PI / 2;
  }, []);
  return <gridHelper ref={ref} args={[10, 10, colors.gridPrimary, colors.gridSecondary]} />;
};

interface RobotPreviewProps {
  player: Player;
  urdf: string;
  jointState: JointStateMsg | null;
  resolveMeshUrl: (rawPath: string) => string;
  fallbackMeshColor: string;
  meshOutlineColor: string;
  onMeshLoadProgressChange?: (progress: MeshLoadProgress | null) => void;
  onMeshIssue?: (meshUrl: string, reason: string) => void;
}

const RobotPreview: React.FC<RobotPreviewProps> = ({
  player,
  urdf,
  jointState,
  resolveMeshUrl,
  fallbackMeshColor,
  meshOutlineColor,
  onMeshLoadProgressChange,
  onMeshIssue,
}) => {
  const [robotModel, setRobotModel] = useState<RobotRenderable | null>(null);
  const jointStateRef = useRef<JointStateMsg | null>(jointState);
  const jointStateDirtyRef = useRef(false);
  const applyPendingRef = useRef(false);
  const cancelApplyFrameRef = useRef<(() => void) | null>(null);
  const playbackTimeRef = useRef<bigint>(0n);
  const { invalidate } = useThree();

  useEffect(() => {
    jointStateRef.current = jointState;
  }, [jointState]);

  const schedulePoseApply = useCallback(() => {
    if (!robotModel || applyPendingRef.current) return;
    applyPendingRef.current = true;
    cancelApplyFrameRef.current = scheduleFrame(() => {
      applyPendingRef.current = false;
      cancelApplyFrameRef.current = null;
      if (jointStateDirtyRef.current) {
        jointStateDirtyRef.current = false;
        applyJointStates(robotModel, jointStateRef.current);
      }
      applyFramePoses(robotModel, playbackTimeRef.current);
      invalidate();
    });
  }, [robotModel, invalidate]);

  useEffect(() => {
    return () => {
      cancelApplyFrameRef.current?.();
      cancelApplyFrameRef.current = null;
      applyPendingRef.current = false;
    };
  }, [robotModel]);

  useEffect(() => {
    const unsubscribe = player.subscribeCurrentTime((time: Time) => {
      playbackTimeRef.current = BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
      schedulePoseApply();
    });
    return unsubscribe;
  }, [player, schedulePoseApply]);

  /* eslint-disable react-hooks/exhaustive-deps -- jointState updates via schedulePoseApply below, not full rebuild */
  useEffect(() => {
    let cancelled = false;
    onMeshLoadProgressChange?.(null);
    void (async () => {
      try {
        const model = await buildRobotRenderable(urdf, {
          resolveMeshUrl,
          warn: (meshUrl, reason) => onMeshIssue?.(meshUrl, reason),
          fallbackMeshColor,
          outlineColor: meshOutlineColor,
          onMeshLoadProgress: (progress) => {
            if (!cancelled) onMeshLoadProgressChange?.(progress);
          },
        });
        if (cancelled) {
          disposeRobotRenderable(model);
          return;
        }
        applyJointStates(model, jointState);
        applyFramePoses(model, playbackTimeRef.current);
        setRobotModel(model);
        onMeshLoadProgressChange?.(null);
      } catch (error) {
        onMeshIssue?.('urdf', error instanceof Error ? error.message : String(error));
        onMeshLoadProgressChange?.(null);
      }
    })();
    return () => {
      cancelled = true;
      onMeshLoadProgressChange?.(null);
      setRobotModel((current) => {
        disposeRobotRenderable(current);
        return null;
      });
    };
  }, [urdf, fallbackMeshColor, meshOutlineColor, resolveMeshUrl, onMeshIssue, onMeshLoadProgressChange]);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    if (!robotModel) return;
    jointStateDirtyRef.current = true;
    schedulePoseApply();
  }, [robotModel, jointState, schedulePoseApply]);

  return robotModel ? <primitive object={robotModel.root} /> : null;
};

export interface UrdfDebugPreviewProps {
  player: Player;
  urdfText: string;
  jointState: JointStateMsg | null;
  resolveMeshUrl: (rawPath: string) => string;
  fallbackMeshColor: string;
  showGrid: boolean;
  showAxes: boolean;
  rotateMeshVisuals?: boolean;
  onMeshLoadProgressChange?: (progress: MeshLoadProgress | null) => void;
  onMeshIssue?: (meshUrl: string, reason: string) => void;
}

export const UrdfDebugPreview: React.FC<UrdfDebugPreviewProps> = ({
  player,
  urdfText,
  jointState,
  resolveMeshUrl,
  fallbackMeshColor,
  showGrid,
  showAxes,
  rotateMeshVisuals = false,
  onMeshLoadProgressChange,
  onMeshIssue,
}) => {
  const { formatMessage } = useIntl();
  const { resolvedTheme } = useRosViewTheme();
  const colors = useMemo(() => getThemeColors(resolvedTheme), [resolvedTheme]);
  const [meshLoadProgress, setMeshLoadProgress] = useState<MeshLoadProgress | null>(null);
  const isMeshLoading =
    meshLoadProgress !== null &&
    meshLoadProgress.total > 0 &&
    meshLoadProgress.loaded < meshLoadProgress.total;

  const handleMeshProgress = useCallback(
    (progress: MeshLoadProgress | null) => {
      setMeshLoadProgress(progress);
      onMeshLoadProgressChange?.(progress);
    },
    [onMeshLoadProgressChange],
  );

  if (!urdfText) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground italic">
        {formatMessage({ id: 'urdfDebug.preview.empty' })}
      </div>
    );
  }

  const overlayLabel = isMeshLoading && meshLoadProgress
    ? formatMessage(
        { id: 'urdfDebug.preview.loadingMesh' },
        { loaded: meshLoadProgress.loaded, total: meshLoadProgress.total },
      )
    : formatMessage(
        { id: 'urdfDebug.preview.title' },
        {
          rotateMesh: formatMessage({
            id: rotateMeshVisuals ? 'urdfDebug.preview.rotateMeshOn' : 'urdfDebug.preview.rotateMeshOff',
          }),
        },
      );

  return (
    <div className={`relative w-full h-full ${colors.panelBackgroundClassName}`}>
      <div
        className={`absolute top-2 left-2 z-10 px-2 py-1 rounded text-[10px] font-mono pointer-events-none ${
          isMeshLoading ? 'animate-pulse' : ''
        } ${colors.overlayClassName}`}
      >
        {overlayLabel}
      </div>
      <Canvas shadows frameloop="demand" camera={CANVAS_CAMERA} gl={{ antialias: true }}>
        <color attach="background" args={[colors.sceneBackground]} />
        <CameraSetup />
        <ambientLight intensity={0.45} />
        <hemisphereLight args={['#ffffff', '#6b7280', 0.55]} />
        <directionalLight position={[6, -4, 8]} intensity={1.05} />
        {showGrid && <ZUpGrid colors={colors} />}
        {showAxes && <axesHelper args={[1]} />}
        <Suspense fallback={null}>
          <RobotPreview
            player={player}
            urdf={urdfText}
            jointState={jointState}
            resolveMeshUrl={resolveMeshUrl}
            fallbackMeshColor={fallbackMeshColor}
            meshOutlineColor={colors.meshOutlineColor}
            onMeshLoadProgressChange={handleMeshProgress}
            onMeshIssue={onMeshIssue}
          />
        </Suspense>
        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={GIZMO_MARGIN}>
          <GizmoViewport axisColors={GIZMO_AXIS_COLORS} labelColor={colors.gizmoLabelColor} />
        </GizmoHelper>
      </Canvas>
    </div>
  );
};
