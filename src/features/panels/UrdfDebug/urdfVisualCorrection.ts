/** teleop_tf `rotate_mesh`: post-multiply visual origin by R(-π/2, 0, 0). */
export const TELEOP_ROTATE_MESH_RPY: [number, number, number] = [-Math.PI / 2, 0, 0];

export type UrdfVisualCorrectionOptions = {
  rotateMeshVisuals: boolean;
  visualRpyOffset: [number, number, number];
};

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/** URDF / scipy extrinsic xyz: R = Rz(yaw) * Ry(pitch) * Rx(roll). */
export function rotationMatrixFromRpy(roll: number, pitch: number, yaw: number): Mat3 {
  const cx = Math.cos(roll);
  const sx = Math.sin(roll);
  const cy = Math.cos(pitch);
  const sy = Math.sin(pitch);
  const cz = Math.cos(yaw);
  const sz = Math.sin(yaw);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

export function rpyFromRotationMatrix(m: Mat3): [number, number, number] {
  const sy = -m[2][0];
  if (Math.abs(sy) < 1 - 1e-6) {
    const pitch = Math.asin(sy);
    const roll = Math.atan2(m[2][1], m[2][2]);
    const yaw = Math.atan2(m[1][0], m[0][0]);
    return [roll, pitch, yaw];
  }
  const pitch = sy > 0 ? Math.PI / 2 : -Math.PI / 2;
  const roll = Math.atan2(-m[0][1], m[1][1]);
  return [roll, pitch, 0];
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out as Mat3;
}

/** Match teleop_tf `update_rpy_in_xml`: origin' = origin @ R(-π/2, 0, 0), then optional offset. */
export function transformVisualOriginRpy(
  rpy: [number, number, number],
  options: UrdfVisualCorrectionOptions,
): [number, number, number] {
  let matrix = rotationMatrixFromRpy(rpy[0], rpy[1], rpy[2]);
  if (options.rotateMeshVisuals) {
    const fix = rotationMatrixFromRpy(...TELEOP_ROTATE_MESH_RPY);
    matrix = multiplyMat3(matrix, fix);
  }
  if (!options.visualRpyOffset.every((value) => value === 0)) {
    const offset = rotationMatrixFromRpy(
      options.visualRpyOffset[0],
      options.visualRpyOffset[1],
      options.visualRpyOffset[2],
    );
    matrix = multiplyMat3(matrix, offset);
  }
  return rpyFromRotationMatrix(matrix);
}

export function applyUrdfVisualCorrection(
  urdfText: string,
  options: UrdfVisualCorrectionOptions,
): string {
  if (!options.rotateMeshVisuals && options.visualRpyOffset.every((value) => value === 0)) {
    return urdfText;
  }
  return urdfText.replace(
    /(<visual\b[\s\S]*?<origin\b[^>]*\brpy=")([^"]*)(")/g,
    (_match, prefix: string, rpyRaw: string, suffix: string) => {
      const parts = rpyRaw.split(/\s+/).map(Number);
      const roll = Number.isFinite(parts[0]) ? parts[0] : 0;
      const pitch = Number.isFinite(parts[1]) ? parts[1] : 0;
      const yaw = Number.isFinite(parts[2]) ? parts[2] : 0;
      const next = transformVisualOriginRpy([roll, pitch, yaw], options);
      return `${prefix}${next[0]} ${next[1]} ${next[2]}${suffix}`;
    },
  );
}

/** Embedded into exported MCAP scripts (keep in sync with applyUrdfVisualCorrection). */
export const URDF_VISUAL_CORRECTION_JS = `
const TELEOP_ROTATE_MESH_RPY = [-Math.PI / 2, 0, 0];

function rotationMatrixFromRpy(roll, pitch, yaw) {
  const cx = Math.cos(roll), sx = Math.sin(roll);
  const cy = Math.cos(pitch), sy = Math.sin(pitch);
  const cz = Math.cos(yaw), sz = Math.sin(yaw);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

function rpyFromRotationMatrix(m) {
  const sy = -m[2][0];
  if (Math.abs(sy) < 1 - 1e-6) {
    const pitch = Math.asin(sy);
    const roll = Math.atan2(m[2][1], m[2][2]);
    const yaw = Math.atan2(m[1][0], m[0][0]);
    return [roll, pitch, yaw];
  }
  const pitch = sy > 0 ? Math.PI / 2 : -Math.PI / 2;
  const roll = Math.atan2(-m[0][1], m[1][1]);
  return [roll, pitch, 0];
}

function multiplyMat3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

function transformVisualOriginRpy(rpy, options) {
  let matrix = rotationMatrixFromRpy(rpy[0], rpy[1], rpy[2]);
  if (options.rotateMeshVisuals) {
    matrix = multiplyMat3(matrix, rotationMatrixFromRpy(...TELEOP_ROTATE_MESH_RPY));
  }
  const offset = options.visualRpyOffset ?? [0, 0, 0];
  if (!offset.every((value) => value === 0)) {
    matrix = multiplyMat3(matrix, rotationMatrixFromRpy(offset[0], offset[1], offset[2]));
  }
  return rpyFromRotationMatrix(matrix);
}

function prepareUrdfXml(xml, recipe) {
  const urdf = recipe.urdf ?? {};
  const options = {
    rotateMeshVisuals: !!urdf.rotateMeshVisuals,
    visualRpyOffset: Array.isArray(urdf.visualRpyOffset) ? urdf.visualRpyOffset : [0, 0, 0],
  };
  if (!options.rotateMeshVisuals && options.visualRpyOffset.every((value) => value === 0)) {
    return xml;
  }
  return xml.replace(
    /(<visual\\b[\\s\\S]*?<origin\\b[^>]*\\brpy=")([^"]*)(")/g,
    (_match, prefix, rpyRaw, suffix) => {
      const parts = rpyRaw.split(/\\s+/).map(Number);
      const roll = Number.isFinite(parts[0]) ? parts[0] : 0;
      const pitch = Number.isFinite(parts[1]) ? parts[1] : 0;
      const yaw = Number.isFinite(parts[2]) ? parts[2] : 0;
      const next = transformVisualOriginRpy([roll, pitch, yaw], options);
      return \`\${prefix}\${next[0]} \${next[1]} \${next[2]}\${suffix}\`;
    },
  );
}
`.trim();
