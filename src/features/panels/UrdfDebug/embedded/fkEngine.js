/** Standalone jointstate2tf FK engine for exported MCAP scripts. */

function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function quatIdentity() {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function vec3Add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vec3Scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function vec3Length(a) {
  return Math.hypot(a.x, a.y, a.z);
}

function vec3Normalize(a) {
  const len = vec3Length(a) || 1;
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

function quatMultiply(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function quatFromAxisAngle(axis, angle) {
  const n = vec3Normalize(axis);
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
}

function quatFromRPY(roll, pitch, yaw) {
  const cx = Math.cos(roll * 0.5);
  const sx = Math.sin(roll * 0.5);
  const cy = Math.cos(pitch * 0.5);
  const sy = Math.sin(pitch * 0.5);
  const cz = Math.cos(yaw * 0.5);
  const sz = Math.sin(yaw * 0.5);
  return {
    w: cz * cy * cx + sz * sy * sx,
    x: cz * cy * sx - sz * sy * cx,
    y: cz * sy * cx + sz * cy * sx,
    z: sz * cy * cx - cz * sy * sx,
  };
}

function vec3RotateByQuat(v, q) {
  const { x, y, z } = v;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
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

function composeTR(a, b) {
  return {
    r: quatMultiply(a.r, b.r),
    t: vec3Add(a.t, vec3RotateByQuat(b.t, a.r)),
  };
}

export class JointState2TF {
  constructor(model) {
    this.model = model;
  }

  static fromXml(opts) {
    return new JointState2TF(parseUrdf(opts.xml));
  }

  setJointState(jointState) {
    const nameToPos = new Map();
    jointState.name.forEach((n, i) => nameToPos.set(n, jointState.position[i] ?? 0));
    nameToPos.forEach((pos, name) => {
      const j = this.model.jointsByName.get(name);
      if (j) j.q = pos;
    });
  }

  compute(options = {}) {
    const transforms = [];
    const publishTimeNs = options.publishTimeNs != null ? Number(options.publishTimeNs) : null;
    this.model.jointsByName.forEach((joint) => {
      const motion = jointMotionTR(joint);
      const rel = composeTR(joint.origin, motion);
      const sec = publishTimeNs != null ? Math.trunc(publishTimeNs / 1e9) : 0;
      const nanosec = publishTimeNs != null ? Math.trunc(publishTimeNs % 1e9) : 0;
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

  computeFromJointState(jointState, options = {}) {
    this.setJointState(jointState);
    return this.compute(options);
  }
}

function parseUrdf(xml) {
  const joints = extractJointBlocks(xml).map(parseJointBlock).filter(Boolean);
  const jointsByName = new Map();
  const jointsByParentLink = new Map();
  const linkParent = new Map();
  for (const j of joints) {
    jointsByName.set(j.name, j);
    linkParent.set(j.child, j.parent);
    const arr = jointsByParentLink.get(j.parent) ?? [];
    arr.push(j);
    jointsByParentLink.set(j.parent, arr);
  }
  return { jointsByName, jointsByParentLink, linkParent };
}

function extractJointBlocks(xml) {
  const blocks = [];
  const re = /<joint\b[\s\S]*?<\/joint>/g;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

function parseJointBlock(block) {
  const openMatch = /<joint\b([^>]*)>/.exec(block);
  if (!openMatch) return null;
  const openAttrs = parseAttrs(openMatch[1]);
  const name = (openAttrs.name ?? '').trim();
  const type = (openAttrs.type ?? 'fixed').trim();
  const parentLink = parseSingleTagAttr(block, 'parent', 'link');
  const childLink = parseSingleTagAttr(block, 'child', 'link');
  if (!name || !parentLink || !childLink) return null;
  const originAttrs = parseFirstSelfOrOpenTag(block, 'origin');
  const originT = parseXyz(originAttrs?.xyz);
  const originRpy = parseRpy(originAttrs?.rpy);
  const origin = { r: originRpy, t: originT };
  let axis = vec3(1, 0, 0);
  const axisAttrs = parseFirstSelfOrOpenTag(block, 'axis');
  if (axisAttrs?.xyz) axis = parseXyzVec(axisAttrs.xyz);
  const movable = ['revolute', 'continuous', 'prismatic', 'fixed'];
  return {
    name,
    type: movable.includes(type) ? type : 'fixed',
    parent: parentLink,
    child: childLink,
    origin,
    axis: vec3Normalize(axis),
    q: 0,
  };
}

function parseAttrs(s) {
  const out = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function parseSingleTagAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b([^>]*)\\/>`);
  const m = re.exec(block);
  if (!m) return null;
  const attrs = parseAttrs(m[1] ?? '');
  const v = attrs[attr];
  return typeof v === 'string' ? v.trim() : null;
}

function parseFirstSelfOrOpenTag(block, tag) {
  let re = new RegExp(`<${tag}\\b([^>]*)\\/>`);
  let m = re.exec(block);
  if (m) return parseAttrs(m[1] ?? '');
  re = new RegExp(`<${tag}\\b([^>]*)>`);
  m = re.exec(block);
  if (m) return parseAttrs(m[1] ?? '');
  return null;
}

function parseXyz(s) {
  if (!s) return vec3(0, 0, 0);
  const [x, y, z] = s.split(/\s+/).map(Number);
  return vec3(x || 0, y || 0, z || 0);
}

function parseXyzVec(s) {
  return parseXyz(s);
}

function parseRpy(s) {
  if (!s) return quatIdentity();
  const [r, p, y] = s.split(/\s+/).map(Number);
  return quatFromRPY(r || 0, p || 0, y || 0);
}

function jointMotionTR(j) {
  switch (j.type) {
    case 'revolute':
    case 'continuous':
      return { r: quatFromAxisAngle(j.axis, j.q), t: vec3(0, 0, 0) };
    case 'prismatic':
      return { r: quatIdentity(), t: vec3Scale(j.axis, j.q) };
    default:
      return { r: quatIdentity(), t: vec3(0, 0, 0) };
  }
}
