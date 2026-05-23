import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import {
  CANVAS_CAMERA,
  DEFAULT_GRID_SIZE,
  framePerspectiveCameraToGrid,
  GIZMO_AXIS_COLORS,
  GIZMO_MARGIN,
} from '@/features/panels/common/zUpSceneLayout';

export const SceneBackgroundLayer: React.FC<{ background: THREE.ColorRepresentation }> = React.memo(
  ({ background }) => <color attach="background" args={[background]} />,
);
SceneBackgroundLayer.displayName = 'SceneBackgroundLayer';

/**
 * Z-up perspective camera framed to the default ground grid (same as 3D panel).
 * Declares the default camera via drei's PerspectiveCamera and frames it through a ref.
 */
export const ZUpCameraSetup: React.FC = () => {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const didInitialFitRef = useRef(false);
  const { size, invalidate } = useThree();

  useLayoutEffect(() => {
    const persp = cameraRef.current;
    if (!persp || didInitialFitRef.current) return;

    const w = size.width;
    const h = size.height;
    if (w <= 0 || h <= 0) return;

    framePerspectiveCameraToGrid(persp, new THREE.Vector3(0, 0, 0), DEFAULT_GRID_SIZE);
    didInitialFitRef.current = true;
    invalidate();
  }, [size.width, size.height, invalidate]);

  return (
    <PerspectiveCamera
      ref={cameraRef}
      makeDefault
      fov={CANVAS_CAMERA.fov}
      near={CANVAS_CAMERA.near}
      far={CANVAS_CAMERA.far}
      position={CANVAS_CAMERA.position}
      up={CANVAS_CAMERA.up}
    />
  );
};

export const R3fZUpGizmoLayer: React.FC<{ labelColor: string }> = React.memo(({ labelColor }) => {
  const { invalidate } = useThree();
  const handleControlsChange = useCallback(() => {
    invalidate();
  }, [invalidate]);
  return (
    <>
      <OrbitControls makeDefault={true} onChange={handleControlsChange} />
      <GizmoHelper alignment="bottom-right" margin={GIZMO_MARGIN}>
        <GizmoViewport axisColors={GIZMO_AXIS_COLORS} labelColor={labelColor} />
      </GizmoHelper>
    </>
  );
});
R3fZUpGizmoLayer.displayName = 'R3fZUpGizmoLayer';
