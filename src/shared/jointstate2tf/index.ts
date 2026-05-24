// Internal, dependency-free minimal math + URDF parser for FK computation

// -----------------------------
// Public Types
// -----------------------------

export type Time = { sec: number; nanosec: number };
export type Header = { stamp: Time; frame_id: string };

export type JointState = {
  header: Header;
  name: string[];
  position: number[];
  velocity?: number[];
  effort?: number[];
};

export type Quaternion = { x: number; y: number; z: number; w: number };
export type Vector3 = { x: number; y: number; z: number };
export type Transform = { translation: Vector3; rotation: Quaternion };
export type TransformStamped = { header: Header; child_frame_id: string; transform: Transform };
export type TFMessage = { transforms: TransformStamped[] };

export type CreateFromUrlOptions = { url: string };
export type CreateFromXmlOptions = { xml: string };
export type ComputeOptions = { publishTimeNs?: number };

// -----------------------------
// Minimal math (dependency-free)
// -----------------------------

type Float = number;

type MathVec3 = { x: Float; y: Float; z: Float };
type MathQuat = { x: Float; y: Float; z: Float; w: Float };

function vec3(x = 0, y = 0, z = 0): MathVec3 {
  return { x, y, z };
}

function quatIdentity(): MathQuat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function vec3Add(a: MathVec3, b: MathVec3): MathVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vec3Scale(a: MathVec3, s: Float): MathVec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function vec3Length(a: MathVec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function vec3Normalize(a: MathVec3): MathVec3 {
  const len = vec3Length(a) || 1;
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

function quatMultiply(a: MathQuat, b: MathQuat): MathQuat {
  // Returns a*b (apply b, then a)
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function quatFromAxisAngle(axis: MathVec3, angle: number): MathQuat {
  const n = vec3Normalize(axis);
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
}

function quatFromRPY(roll: number, pitch: number, yaw: number): MathQuat {
  // URDF rpy applied as fixed axes X(roll) -> Y(pitch) -> Z(yaw)
  const cx = Math.cos(roll * 0.5), sx = Math.sin(roll * 0.5);
  const cy = Math.cos(pitch * 0.5), sy = Math.sin(pitch * 0.5);
  const cz = Math.cos(yaw * 0.5), sz = Math.sin(yaw * 0.5);
  // R = Rz(yaw) * Ry(pitch) * Rx(roll)
  return {
    w: cz * cy * cx + sz * sy * sx,
    x: cz * cy * sx - sz * sy * cx,
    y: cz * sy * cx + sz * cy * sx,
    z: sz * cy * cx - cz * sy * sx,
  };
}

function vec3RotateByQuat(v: MathVec3, q: MathQuat): MathVec3 {
  // Rotate vector v by quaternion q using q*v*q^-1 (optimized)
  const { x, y, z } = v;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  // v' = v + 2*q_vec x (q_vec x v + qw*v)
  const uvx = qy * z - qz * y;
  const uvy = qz * x - qx * z;
  const uvz = qx * y - qy * x;
  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;
  return {
    x: x + 2 * (qw * uvx + uuvx),
    y: y + 2 * (qw * uvy + uuvy),
    z: z + 2 * (qw * uvz + uuvz),
  };
}

type TransformTR = { r: MathQuat; t: MathVec3 };

function composeTR(a: TransformTR, b: TransformTR): TransformTR {
  // a followed by b
  return {
    r: quatMultiply(a.r, b.r),
    t: vec3Add(a.t, vec3RotateByQuat(b.t, a.r)),
  };
}

// -----------------------------
// JointState2TF: minimal, fast URDF FK engine
// -----------------------------

/**
 * JointState -> TF converter backed by URDF. The URDF is parsed once when the
 * instance is created, so repeated computations only set joint values and
 * read relative transforms, optimizing for high-frequency updates.
 */
type UrdfJoint = {
  name: string;
  type: 'revolute' | 'continuous' | 'prismatic' | 'fixed';
  parent: string;
  child: string;
  origin: TransformTR; // from parent link frame to joint frame
  axis: MathVec3; // joint axis in joint frame
  q: number; // current joint value (rad or meters)
};

type UrdfModel = {
  jointsByName: Map<string, UrdfJoint>;
  jointsByParentLink: Map<string, UrdfJoint[]>;
  linkParent: Map<string, string>; // child link -> parent link
};

export default class JointState2TF {
  private readonly model: UrdfModel;

  private constructor(model: UrdfModel) {
    this.model = model;
  }

  /** Create an instance by loading URDF from a URL. */
  static async fromUrl(opts: CreateFromUrlOptions): Promise<JointState2TF> {
    const xml = await fetchText(opts.url);
    const model = parseUrdf(xml);
    return new JointState2TF(model);
  }

  /** Create an instance by parsing URDF XML content. */
  static fromXml(opts: CreateFromXmlOptions): JointState2TF {
    const model = parseUrdf(opts.xml);
    return new JointState2TF(model);
  }

  /** Set joint values on the internal model. */
  setJointState(jointState: JointState): void {
    const nameToPos = new Map<string, number>();
    jointState.name.forEach((n, i) => nameToPos.set(n, jointState.position[i] ?? 0));
    nameToPos.forEach((pos, name) => {
      const j = this.model.jointsByName.get(name);
      if (j) j.q = pos;
    });
  }

  /** Compute TF for all child->parent pairs defined by the URDF (relative transforms). */
  compute(options: ComputeOptions = {}): TFMessage {
    const transforms: TransformStamped[] = [];

    // For each joint, compute parent->child transform: T = origin * motion(q)
    this.model.jointsByName.forEach((joint) => {
      const motion = jointMotionTR(joint);
      const rel = composeTR(joint.origin, motion);

      const sec = options.publishTimeNs ? Math.trunc(options.publishTimeNs / 1e9) : 0;
      const nanosec = options.publishTimeNs ? Math.trunc(options.publishTimeNs % 1e9) : 0;

      transforms.push({
        header: { stamp: { sec, nanosec }, frame_id: joint.parent },
        child_frame_id: joint.child,
        transform: {
          translation: { x: rel.t.x, y: rel.t.y, z: rel.t.z },
          rotation: { x: rel.r.x, y: rel.r.y, z: rel.r.z, w: rel.r.w },
        },
      });
    });

    return { transforms };
  }

  /** Convenience: set joint state then compute TF in a single call. */
  computeFromJointState(jointState: JointState, options: ComputeOptions = {}): TFMessage {
    this.setJointState(jointState);
    return this.compute(options);
  }
}

// -----------------------------
// Internal helpers
// -----------------------------

// -----------------------------
// Internal helpers: URDF parsing and I/O
// -----------------------------

async function fetchText(url: string): Promise<string> {
  const { fetch } = globalThis;
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this environment; provide XML via fromXml().');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch URDF: ${res.status} ${res.statusText}`);
  return await res.text();
}

function parseUrdf(xml: string): UrdfModel {
  const joints = extractJointBlocks(xml).map(parseJointBlock).filter((j): j is UrdfJoint => !!j);

  const jointsByName = new Map<string, UrdfJoint>();
  const jointsByParentLink = new Map<string, UrdfJoint[]>();
  const linkParent = new Map<string, string>();
  for (const j of joints) {
    jointsByName.set(j.name, j);
    linkParent.set(j.child, j.parent);
    const arr = jointsByParentLink.get(j.parent) ?? [];
    arr.push(j);
    jointsByParentLink.set(j.parent, arr);
  }
  return { jointsByName, jointsByParentLink, linkParent };
}

function extractJointBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<joint\b[\s\S]*?<\/joint>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

function parseJointBlock(block: string): UrdfJoint | null {
  const openMatch = /<joint\b([^>]*)>/.exec(block);
  if (!openMatch) return null;
  const openAttrs = parseAttrs(openMatch[1]);
  const name = (openAttrs['name'] ?? '').trim();
  const type = (openAttrs['type'] ?? 'fixed').trim() as UrdfJoint['type'];

  const parentLink = parseSingleTagAttr(block, 'parent', 'link');
  const childLink = parseSingleTagAttr(block, 'child', 'link');
  if (!name || !parentLink || !childLink) return null;

  const originAttrs = parseFirstSelfOrOpenTag(block, 'origin');
  const originT = parseXyz(originAttrs?.xyz);
  const originRpy = parseRpy(originAttrs?.rpy);
  const origin: TransformTR = { r: originRpy, t: originT };

  let axis = vec3(1, 0, 0);
  const axisAttrs = parseFirstSelfOrOpenTag(block, 'axis');
  if (axisAttrs?.xyz) axis = parseXyzVec(axisAttrs.xyz);

  return {
    name,
    type: (['revolute', 'continuous', 'prismatic', 'fixed'] as const).includes(type) ? type : 'fixed',
    parent: parentLink,
    child: childLink,
    origin,
    axis: vec3Normalize(axis),
    q: 0,
  };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function parseSingleTagAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b([^>]*)\\/>`);
  const m = re.exec(block);
  if (!m) return null;
  const attrs = parseAttrs(m[1] ?? '');
  const v = attrs[attr];
  return typeof v === 'string' ? v.trim() : null;
}

function parseFirstSelfOrOpenTag(block: string, tag: string): Record<string, string> | null {
  // Prefer self-closing, else opening tag
  let re = new RegExp(`<${tag}\\b([^>]*)\\/>`);
  let m = re.exec(block);
  if (m) return parseAttrs(m[1] ?? '');
  re = new RegExp(`<${tag}\\b([^>]*)>`);
  m = re.exec(block);
  if (m) return parseAttrs(m[1] ?? '');
  return null;
}

function parseXyz(s?: string): MathVec3 {
  if (!s) return vec3(0, 0, 0);
  const [x, y, z] = s.split(/\s+/).map(Number);
  return vec3(x || 0, y || 0, z || 0);
}

function parseXyzVec(s: string): MathVec3 {
  return parseXyz(s);
}

function parseRpy(s?: string): MathQuat {
  if (!s) return quatIdentity();
  const [r, p, y] = s.split(/\s+/).map(Number);
  return quatFromRPY(r || 0, p || 0, y || 0);
}

function jointMotionTR(j: UrdfJoint): TransformTR {
  switch (j.type) {
    case 'revolute':
    case 'continuous': {
      const r = quatFromAxisAngle(j.axis, j.q);
      return { r, t: vec3(0, 0, 0) };
    }
    case 'prismatic': {
      const t = vec3Scale(j.axis, j.q);
      return { r: quatIdentity(), t };
    }
    case 'fixed':
    default:
      return { r: quatIdentity(), t: vec3(0, 0, 0) };
  }
}

