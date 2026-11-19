/**
 * Synthetic indexed MCAP with the shape of an egocentric "scene" recording (no real data):
 * many small chunks carrying a camera, a live point cloud, /tf and a trajectory, and a LAST chunk
 * whose time range spans the whole recording because the map and /tf_static are stamped at the
 * first frame but written when the recording ends (the map is only known then).
 *
 *   node scripts/gen-test-mcap-ego-scene.mjs <out.mcap> [seconds=120] [mapMiB=6] [jpegKiB=24]
 *
 * Topics: /camera/head_left/image_rect/compressed (CompressedImage, 10 Hz), /scene/points
 * (PointCloud2, 5 Hz), /tf (30 Hz), /human/head_trajectory (MarkerArray, every 30 s and at the end),
 * /tf_static and /scene/map (PointCloud2, `mapMiB`) at the first stamp, written last.
 */
import { McapWriter } from '@mcap/core';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import fs from 'node:fs';
import { readFixture } from './mcap-fixture-utils.mjs';

const out = process.argv[2];
if (!out) {
  console.error('usage: gen-test-mcap-ego-scene.mjs <out.mcap> [seconds] [mapMiB] [jpegKiB]');
  process.exit(2);
}
const seconds = Number(process.argv[3] ?? 120);
const mapMiB = Number(process.argv[4] ?? 6);
const jpegKiB = Number(process.argv[5] ?? 24);

const SEP = '='.repeat(80);
const DEFS = {
  'builtin_interfaces/Time': 'int32 sec\nuint32 nanosec',
  'builtin_interfaces/Duration': 'int32 sec\nuint32 nanosec',
  'std_msgs/Header': 'builtin_interfaces/Time stamp\nstring frame_id',
  'std_msgs/ColorRGBA': 'float32 r\nfloat32 g\nfloat32 b\nfloat32 a',
  'geometry_msgs/Vector3': 'float64 x\nfloat64 y\nfloat64 z',
  'geometry_msgs/Point': 'float64 x\nfloat64 y\nfloat64 z',
  'geometry_msgs/Quaternion': 'float64 x\nfloat64 y\nfloat64 z\nfloat64 w',
  'geometry_msgs/Pose': 'Point position\nQuaternion orientation',
  'geometry_msgs/Transform': 'Vector3 translation\nQuaternion rotation',
  'geometry_msgs/TransformStamped': 'std_msgs/Header header\nstring child_frame_id\nTransform transform',
  'tf2_msgs/TFMessage': 'geometry_msgs/TransformStamped[] transforms',
  'sensor_msgs/CompressedImage': 'std_msgs/Header header\nstring format\nuint8[] data',
  'sensor_msgs/PointField': 'string name\nuint32 offset\nuint8 datatype\nuint32 count',
  'sensor_msgs/PointCloud2':
    'std_msgs/Header header\nuint32 height\nuint32 width\nPointField[] fields\nbool is_bigendian\n' +
    'uint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense',
  'visualization_msgs/Marker':
    'std_msgs/Header header\nstring ns\nint32 id\nint32 type\nint32 action\ngeometry_msgs/Pose pose\n' +
    'geometry_msgs/Vector3 scale\nstd_msgs/ColorRGBA color\nbuiltin_interfaces/Duration lifetime\n' +
    'bool frame_locked\ngeometry_msgs/Point[] points\nstd_msgs/ColorRGBA[] colors\nstring text\n' +
    'string mesh_resource\nbool mesh_use_embedded_materials',
  'visualization_msgs/MarkerArray': 'Marker[] markers',
};
const DEPS = {
  'std_msgs/Header': ['builtin_interfaces/Time'],
  'geometry_msgs/Pose': ['geometry_msgs/Point', 'geometry_msgs/Quaternion'],
  'geometry_msgs/Transform': ['geometry_msgs/Vector3', 'geometry_msgs/Quaternion'],
  'geometry_msgs/TransformStamped': ['std_msgs/Header', 'geometry_msgs/Transform'],
  'tf2_msgs/TFMessage': ['geometry_msgs/TransformStamped'],
  'sensor_msgs/CompressedImage': ['std_msgs/Header'],
  'sensor_msgs/PointCloud2': ['std_msgs/Header', 'sensor_msgs/PointField'],
  'visualization_msgs/Marker': [
    'std_msgs/Header',
    'geometry_msgs/Pose',
    'geometry_msgs/Vector3',
    'std_msgs/ColorRGBA',
    'builtin_interfaces/Duration',
    'geometry_msgs/Point',
  ],
  'visualization_msgs/MarkerArray': ['visualization_msgs/Marker'],
};
function msgdef(type) {
  const seen = [];
  const visit = (name) => {
    for (const dep of DEPS[name] ?? []) {
      if (!seen.includes(dep)) {
        seen.push(dep);
        visit(dep);
      }
    }
  };
  visit(type);
  return [DEFS[type], ...seen.map((dep) => `${SEP}\nMSG: ${dep}\n${DEFS[dep]}`)].join('\n') + '\n';
}

class FileWritable {
  #fd = fs.openSync(out, 'w');
  #pos = 0n;
  position() {
    return this.#pos;
  }
  write(buf) {
    fs.writeSync(this.#fd, buf);
    this.#pos += BigInt(buf.byteLength);
    return Promise.resolve();
  }
  close() {
    fs.closeSync(this.#fd);
  }
}

const writable = new FileWritable();
const writer = new McapWriter({
  writable,
  useStatistics: true,
  useChunks: true,
  useChunkIndex: true,
  useMessageIndex: true,
  chunkSize: 512 * 1024,
});
await writer.start({ profile: 'ros2', library: 'rosview-gen' });

const encoders = new Map();
const channels = new Map();
async function channel(topic, type) {
  if (!encoders.has(type)) {
    const text = msgdef(type);
    const schemaId = await writer.registerSchema({
      name: type.replace('/', '/msg/'),
      encoding: 'ros2msg',
      data: new TextEncoder().encode(text),
    });
    encoders.set(type, { schemaId, writer: new MessageWriter(parseMessageDefinition(text, { ros2: true })) });
  }
  const { schemaId, writer: enc } = encoders.get(type);
  const channelId = await writer.registerChannel({ schemaId, topic, messageEncoding: 'cdr', metadata: new Map() });
  channels.set(topic, { channelId, enc });
}

let seq = 0;
async function write(topic, ns, message) {
  const { channelId, enc } = channels.get(topic);
  await writer.addMessage({ channelId, sequence: seq++, logTime: ns, publishTime: ns, data: enc.writeMessage(message) });
}

const IMAGE = '/camera/head_left/image_rect/compressed';
await channel('/tf_static', 'tf2_msgs/TFMessage');
await channel('/tf', 'tf2_msgs/TFMessage');
await channel(IMAGE, 'sensor_msgs/CompressedImage');
await channel('/scene/points', 'sensor_msgs/PointCloud2');
await channel('/scene/map', 'sensor_msgs/PointCloud2');
await channel('/human/head_trajectory', 'visualization_msgs/MarkerArray');

/** Valid JPEG: the 1x1 fixture with COM segments of deterministic pseudo-random bytes. */
function paddedJpeg(seed) {
  const base = readFixture('media/jpeg-1x1.bin');
  const parts = [base.subarray(0, 2)];
  let state = (seed * 2654435761) >>> 0;
  let remaining = jpegKiB * 1024;
  while (remaining > 0) {
    const len = Math.min(remaining, 60000);
    const seg = Buffer.alloc(len + 4);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(len + 2, 2);
    for (let i = 0; i < len; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      seg[4 + i] = state >>> 24;
    }
    parts.push(seg);
    remaining -= len;
  }
  parts.push(base.subarray(2));
  return Buffer.concat(parts);
}

const FIELDS = [
  { name: 'x', offset: 0, datatype: 7, count: 1 },
  { name: 'y', offset: 4, datatype: 7, count: 1 },
  { name: 'z', offset: 8, datatype: 7, count: 1 },
  { name: 'rgb', offset: 12, datatype: 7, count: 1 },
];
function cloud(ns, frame, count, seed) {
  const data = Buffer.alloc(count * 16);
  let state = seed >>> 0;
  const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < count; i++) {
    data.writeFloatLE(rnd() * 4 - 2, i * 16);
    data.writeFloatLE(rnd() * 4 - 2, i * 16 + 4);
    data.writeFloatLE(rnd() * 2, i * 16 + 8);
    data.writeUInt32LE(0x3366cc, i * 16 + 12);
  }
  return {
    header: header(ns, frame),
    height: 1,
    width: count,
    fields: FIELDS,
    is_bigendian: false,
    point_step: 16,
    row_step: count * 16,
    data,
    is_dense: true,
  };
}
function header(ns, frame_id) {
  return { stamp: { sec: Number(ns / 1_000_000_000n), nanosec: Number(ns % 1_000_000_000n) }, frame_id };
}
function tf(ns, parent, child, [x, y, z]) {
  return {
    header: header(ns, parent),
    child_frame_id: child,
    transform: { translation: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  };
}
const headAt = (s) => [Math.cos(s / 10), Math.sin(s / 10), 1.5];
function trajectory(ns, upToS) {
  const points = [];
  for (let s = 0; s <= upToS; s += 0.5) {
    const [x, y, z] = headAt(s);
    points.push({ x, y, z });
  }
  const marker = (action, pts) => ({
    header: header(ns, 'world'),
    ns: 'head_trajectory',
    id: 0,
    type: 4,
    action,
    pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    scale: { x: 0.01, y: 0, z: 0 },
    color: { r: 1, g: 0.6, b: 0.1, a: 1 },
    lifetime: { sec: 0, nanosec: 0 },
    frame_locked: false,
    points: pts,
    colors: [],
    text: '',
    mesh_resource: '',
    mesh_use_embedded_materials: false,
  });
  return { markers: [marker(3, []), marker(0, points)] };
}

const jpegs = Array.from({ length: 6 }, (_, i) => paddedJpeg(i + 1));
const T0 = 1_700_000_000_000_000_000n;
const totalMs = Math.round(seconds * 1000);
for (let ms = 0; ms <= totalMs; ms += 1) {
  const ns = T0 + BigInt(ms) * 1_000_000n;
  if (ms % 33 === 0) await write('/tf', ns, { transforms: [tf(ns, 'world', 'head_left', headAt(ms / 1000))] });
  if (ms % 100 === 0) {
    await write(IMAGE, ns, { header: header(ns, 'head_left_rect'), format: 'jpeg', data: jpegs[(ms / 100) % jpegs.length] });
  }
  if (ms % 200 === 0) await write('/scene/points', ns, cloud(ns, 'head_left_rect', 1000, ms + 1));
  if (ms % 30_000 === 0) await write('/human/head_trajectory', ns, trajectory(ns, ms / 1000));
}
// Known only when the recording ends; stamped at its first frame.
const tEnd = T0 + BigInt(totalMs) * 1_000_000n;
await write('/human/head_trajectory', tEnd, trajectory(tEnd, totalMs / 1000));
await write('/tf_static', T0, { transforms: [tf(T0, 'head_left', 'head_left_rect', [0, 0, 0])] });
await write('/scene/map', T0, cloud(T0, 'world', Math.round((mapMiB * 1024 * 1024) / 16), 7));
await writer.end();
writable.close();
console.log('Wrote', out, `(${fs.statSync(out).size} bytes)`);
