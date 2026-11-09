#!/usr/bin/env node
/**
 * Synthetic Unitree G1 + Dex3 whole-body teleop recording for the public
 * sample gallery. Mimics the IO-AI recorder layout (`ioai.wbc.dex3.v1`
 * profile): unindexed MCAP, JSON `whole_body.frame` messages with base64 JPEG
 * cameras + joint state, `unitree.dex3.frame` hand messages and
 * `whole_body.meta`. Every value is generated here; no recorded data is used.
 *
 * Usage: node scripts/gen-sample-whole-body.mjs [out.mcap] [seconds]
 */
import fs from 'node:fs';
import { McapWriter } from '@mcap/core';
import jpeg from 'jpeg-js';
import { BufferWritable } from './mcap-fixture-utils.mjs';

const outPath = process.argv[2] ?? 'Unitree_G1_Teleop.mcap';
const seconds = Number(process.argv[3] ?? 20);
const FPS = 30;
const FRAME_NS = BigInt(Math.round(1e9 / FPS));
const START_NS = 1_793_491_200_000_000_000n; // 2026-11-01T00:00:00Z

const G1_JOINTS = 29;
const DEX3_JOINT_NAMES = ['left', 'right'].flatMap((side) =>
  ['thumb_0', 'thumb_1', 'thumb_2', 'middle_0', 'middle_1', 'index_0', 'index_1'].map(
    (joint) => `${side}_hand_${joint}_joint`,
  ),
);

// ── Motion: an 8 s squat-and-reach loop with a 4 s grasp cycle ──────────────
const ease = (t, period) => (1 - Math.cos((2 * Math.PI * t) / period)) / 2;

function bodyPose(t) {
  const squat = ease(t, 8);
  const reach = ease(t + 2, 8);
  const q = new Array(G1_JOINTS).fill(0);
  for (const [offset, side] of [[0, 1], [6, -1]]) {
    q[offset + 0] = -0.3 - 0.45 * squat; // hip pitch
    q[offset + 1] = 0.05 * side; // hip roll
    q[offset + 3] = 0.6 + 0.9 * squat; // knee
    q[offset + 4] = -0.3 - 0.45 * squat; // ankle pitch
  }
  q[12] = 0.3 * Math.sin((2 * Math.PI * t) / 10); // waist yaw
  q[14] = 0.15 * squat; // waist pitch
  for (const [offset, side, phase] of [[15, 1, 0], [22, -1, 0.5]]) {
    const r = ease(t + phase, 8) * 0.6 + reach * 0.4;
    q[offset + 0] = -0.2 - 0.9 * r; // shoulder pitch
    q[offset + 1] = 0.25 * side; // shoulder roll
    q[offset + 3] = 1.1 - 0.7 * r; // elbow
    q[offset + 4] = 0.2 * side * r; // wrist roll
  }
  const yaw = 0.1 * Math.sin((2 * Math.PI * t) / 20);
  const base = [0, 0, 0.79 - 0.16 * squat, Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
  return { q, base, squat, reach };
}

function handPose(t) {
  const g = ease(t, 4);
  const side = (sign) => [0, sign * (0.5 + 0.5 * g), sign * 1.2 * g, -sign * 1.1 * g, -sign * 1.3 * g, -sign * 1.1 * g, -sign * 1.3 * g];
  return { q: [...side(1), ...side(-1)], grasp: g };
}

// ── Tiny software renderer for the camera images ────────────────────────────
function canvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4, 255) };
}

function fill(img, color, inside) {
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
    }
  }
}

function floorAndWall(img, horizon) {
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    const floor = y >= horizon;
    const k = floor ? (y - horizon) / Math.max(1, height - horizon) : y / Math.max(1, horizon);
    const c = floor ? [70 + 40 * k, 74 + 40 * k, 80 + 40 * k] : [205 - 30 * k, 198 - 30 * k, 186 - 30 * k];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Floor tiles give the image visible motion when the camera moves.
      const tile = floor && ((Math.floor(x / 24) + Math.floor(y / 12)) % 2 === 0) ? 10 : 0;
      data[i] = c[0] + tile;
      data[i + 1] = c[1] + tile;
      data[i + 2] = c[2] + tile;
    }
  }
}

const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** Head camera: table with a basket and a ball the arms reach for. */
function renderHead(t, pose, hand, eye) {
  const img = canvas(320, 240);
  const pan = Math.round(40 * Math.sin((2 * Math.PI * t) / 10)) + eye;
  floorAndWall(img, 90 + Math.round(30 * pose.squat));
  fill(img, [150, 112, 74], rect(60 - pan, 120, 280 - pan, 170)); // table
  fill(img, [196, 160, 98], circle(110 - pan, 130, 26)); // basket
  fill(img, [120, 210, 60], circle(220 - pan - 50 * hand.grasp, 140 - 20 * pose.reach, 12)); // ball
  for (const side of [-1, 1]) {
    const reachX = 160 + side * (90 - 40 * pose.reach) - pan / 2;
    fill(img, [215, 218, 222], rect(reachX - 14, 240 - 90 * pose.reach - 40, reachX + 14, 240)); // forearm
    fill(img, [40, 42, 46], circle(reachX, 240 - 90 * pose.reach - 40, 16 - 4 * hand.grasp)); // hand
  }
  return img;
}

/** Wrist camera: close-up of the gripper over the table. */
function renderWrist(t, pose, hand, side) {
  const img = canvas(320, 240);
  floorAndWall(img, 40 + Math.round(40 * pose.reach));
  fill(img, [196, 160, 98], circle(160 + side * 60 * Math.sin(t), 110, 40 + 30 * pose.reach)); // basket
  fill(img, [120, 210, 60], circle(160 - side * 30 * hand.grasp, 150, 22 + 18 * pose.reach)); // ball
  const open = 70 - 40 * hand.grasp;
  fill(img, [36, 38, 42], rect(0, 190, 320, 240)); // palm
  fill(img, [36, 38, 42], rect(160 - open - 30, 120, 160 - open, 200)); // finger
  fill(img, [36, 38, 42], rect(160 + open, 120, 160 + open + 30, 200)); // thumb
  return img;
}

function encodeJpeg(img) {
  return Buffer.from(jpeg.encode(img, 80).data).toString('base64');
}

function sideBySide(left, right) {
  const img = canvas(left.width + right.width, left.height);
  for (let y = 0; y < img.height; y++) {
    left.data.copy(img.data, y * img.width * 4, y * left.width * 4, (y + 1) * left.width * 4);
    right.data.copy(img.data, (y * img.width + left.width) * 4, y * right.width * 4, (y + 1) * right.width * 4);
  }
  return img;
}

// ── MCAP writing (same layout as the recorder: no chunks, no summary) ───────
const writable = new BufferWritable();
const writer = new McapWriter({
  writable,
  useChunks: false,
  useStatistics: false,
  useSummaryOffsets: false,
  useChunkIndex: false,
  useMessageIndex: false,
  useAttachmentIndex: false,
  useMetadataIndex: false,
  repeatSchemas: false,
  repeatChannels: false,
});
await writer.start({ profile: 'ioai.wbc.dex3.v1', library: 'rosview-sample-gen' });

const encoder = new TextEncoder();
async function jsonChannel(topic, schemaName) {
  const schemaId = await writer.registerSchema({
    name: schemaName,
    encoding: 'jsonschema',
    data: encoder.encode('{"type":"object"}'),
  });
  return await writer.registerChannel({ topic, schemaId, messageEncoding: 'json', metadata: new Map() });
}
const dex3Channel = await jsonChannel('/dex3/frame', 'unitree.dex3.frame');
const metaChannel = await jsonChannel('/episode/meta', 'whole_body.meta');
const frameChannel = await jsonChannel('/whole_body/frame', 'whole_body.frame');

let sequence = 0;
async function add(channelId, logTime, payload) {
  await writer.addMessage({
    channelId,
    sequence: sequence++,
    logTime,
    publishTime: logTime,
    data: encoder.encode(JSON.stringify(payload)),
  });
}

const meta = {
  info: {
    author: 'rosview',
    robot: 'unitree g1 (synthetic)',
    image: { fps: FPS, width: 320, height: 240 },
    dex3: { version: 1, joint_names: DEX3_JOINT_NAMES, dof: 14, position_unit: 'rad' },
  },
  text: { desc: 'Synthetic squat-and-reach teleop demo', goal: 'pick up the ball', steps: 'squat; reach; grasp' },
};
await add(metaChannel, START_NS, meta);

const frames = Math.round(seconds * FPS);
let previousHand;
for (let idx = 0; idx < frames; idx++) {
  const t = idx / FPS;
  const time = START_NS + BigInt(idx) * FRAME_NS + 1n;
  const pose = bodyPose(t);
  const hand = handPose(t);
  const dq = previousHand ? hand.q.map((v, i) => (v - previousHand[i]) * FPS) : hand.q.map(() => 0);
  previousHand = hand.q;
  // Nanosecond timestamps as strings: JSON numbers can't hold them exactly.
  const ns = time.toString();
  const dex3Side = (from) => ({
    state: { position: hand.q.slice(from, from + 7), velocity: dq.slice(from, from + 7), source_time_ns: ns },
    command: {
      position: hand.q.slice(from, from + 7),
      velocity: new Array(7).fill(0),
      tau: new Array(7).fill(0),
      kp: new Array(7).fill(1.5),
      kd: new Array(7).fill(0.1),
      mode: [16, 17, 18, 19, 20, 21, 22],
      source_time_ns: ns,
    },
  });
  await add(dex3Channel, time, { version: 1, sample_time_ns: ns, left: dex3Side(0), right: dex3Side(7) });
  await add(frameChannel, time + 1n, {
    idx,
    sample_time_ns: ns,
    colors: {
      color_0: { channels: 3, encoding: 'jpeg', width: 640, height: 240, data: encodeJpeg(sideBySide(renderHead(t, pose, hand, -6), renderHead(t, pose, hand, 6))) },
      color_2: { channels: 3, encoding: 'jpeg', width: 320, height: 240, data: encodeJpeg(renderWrist(t, pose, hand, 1)) },
      color_3: { channels: 3, encoding: 'jpeg', width: 320, height: 240, data: encodeJpeg(renderWrist(t, pose, hand, -1)) },
    },
    depths: {},
    states: {
      hand_state: new Array(12).fill(0),
      robot_q_current: [...pose.base, ...pose.q],
      dex3_q: hand.q,
      dex3_dq: dq,
    },
    actions: { frame: pose.q.map((v) => v * 0.98), dex3_q: hand.q },
    audios: null,
    sim_state: null,
    tactiles: null,
    dex3: { version: 1, joint_names: DEX3_JOINT_NAMES },
  });
}
await add(metaChannel, START_NS + BigInt(frames) * FRAME_NS + 2n, { ...meta, total_frames: frames, duration_s: seconds });

await writer.end();
const buffer = writable.getBuffer();
fs.writeFileSync(outPath, buffer);
console.log('Wrote', outPath, `(${(buffer.length / 1e6).toFixed(1)} MB, ${frames} frames)`);
