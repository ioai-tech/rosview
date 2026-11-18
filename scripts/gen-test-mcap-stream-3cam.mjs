/**
 * Large synthetic indexed MCAP for streaming / Range measurements (not committed output).
 * Shape: 3 CompressedImage cameras at 30 Hz with ~100 KiB JPEGs, a 100 Hz and a 200 Hz
 * JointState topic, uncompressed ~800 KiB chunks, a summary section.
 *
 *   node scripts/gen-test-mcap-stream-3cam.mjs <out.mcap> [seconds=20.5] [jpegKiB=100]
 */
import { McapWriter } from '@mcap/core';
import { MessageWriter } from '@foxglove/rosmsg2-serialization';
import { parse as parseMessageDefinition } from '@foxglove/rosmsg';
import fs from 'node:fs';
import {
  encodeCompressedImageCdr,
  getCompressedImageSchemaBytes,
  readFixture,
} from './mcap-fixture-utils.mjs';

const out = process.argv[2];
if (!out) {
  console.error('usage: gen-test-mcap-stream-3cam.mjs <out.mcap> [seconds] [jpegKiB]');
  process.exit(2);
}
const seconds = Number(process.argv[3] ?? 20.5);
const jpegKiB = Number(process.argv[4] ?? 100);

const JOINT_STATE = `std_msgs/Header header
string[] name
float64[] position
float64[] velocity
float64[] effort

================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id

================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
`;
const jointWriter = new MessageWriter(parseMessageDefinition(JOINT_STATE, { ros2: true }));

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
  chunkSize: 800 * 1024,
});
await writer.start({ profile: 'ros2', library: 'rosview-gen' });

const imgSchema = await writer.registerSchema({
  name: 'sensor_msgs/msg/CompressedImage',
  encoding: 'ros2msg',
  data: getCompressedImageSchemaBytes(),
});
const jointSchema = await writer.registerSchema({
  name: 'sensor_msgs/msg/JointState',
  encoding: 'ros2msg',
  data: new TextEncoder().encode(JOINT_STATE),
});
const reg = (schemaId, topic) =>
  writer.registerChannel({ schemaId, topic, messageEncoding: 'cdr', metadata: new Map() });

const cams = [
  await reg(imgSchema, '/camera/head/color/image_raw/compressed'),
  await reg(imgSchema, '/camera/left/color/image_raw/compressed'),
  await reg(imgSchema, '/camera/right/color/image_raw/compressed'),
];
const joints = [await reg(jointSchema, '/joint_states'), await reg(jointSchema, '/joint_cmd')];
const names = Array.from({ length: 14 }, (_, i) => `joint${i + 1}`);

const jpegs = Array.from({ length: 8 }, (_, i) => paddedJpeg(i + 1));
const T0 = 1_700_000_000_000_000_000n;
const total = BigInt(Math.round(seconds * 1000)); // ms
let seq = 0;
for (let ms = 0n; ms < total; ms++) {
  const t = T0 + ms * 1_000_000n;
  const stamp = { sec: Number(t / 1_000_000_000n), nsec: Number(t % 1_000_000_000n) };
  const msgs = [];
  if (ms % 33n === 0n) {
    cams.forEach((ch, i) =>
      msgs.push([ch, encodeCompressedImageCdr(stamp, 'jpeg', jpegs[(Number(ms / 33n) + i) % jpegs.length])]),
    );
  }
  const phase = Number(ms) / 1000;
  const joint = (offset) => ({
    header: { stamp, frame_id: '' },
    name: names,
    position: names.map((_, i) => Math.sin(phase * (1 + i * 0.1) + offset)),
    velocity: names.map(() => 0),
    effort: names.map(() => 0),
  });
  if (ms % 10n === 0n) msgs.push([joints[0], jointWriter.writeMessage(joint(0))]);
  if (ms % 5n === 0n) msgs.push([joints[1], jointWriter.writeMessage(joint(0.2))]);
  for (const [channelId, data] of msgs) {
    await writer.addMessage({ channelId, sequence: seq++, logTime: t, publishTime: t, data });
  }
}
await writer.end();
writable.close();
console.log('Wrote', out, `(${fs.statSync(out).size} bytes)`);
