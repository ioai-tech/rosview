/**
 * Generate a minimal indexed MCAP for public/examples/test_5s.mcap and Playwright.
 * Includes JSON-encoded /camera/.../compressed messages so the timeline has non-zero span.
 */
import { McapWriter } from '@mcap/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class BufferWritable {
  /** @type {Buffer[]} */
  #chunks = [];
  /** @type {bigint} */
  #pos = 0n;

  position() {
    return this.#pos;
  }

  /** @param {Uint8Array} buffer */
  write(buffer) {
    const b = Buffer.from(buffer);
    this.#chunks.push(b);
    this.#pos += BigInt(b.byteLength);
    return Promise.resolve();
  }

  getBuffer() {
    return Buffer.concat(this.#chunks);
  }
}

const writable = new BufferWritable();
const writer = new McapWriter({
  writable,
  useStatistics: true,
  useChunks: true,
  useChunkIndex: true,
});

await writer.start({ profile: 'ros2', library: 'rosview-gen' });

const schemaId = await writer.registerSchema({
  name: 'sensor_msgs/msg/CompressedImage',
  encoding: 'jsonschema',
  data: new TextEncoder().encode('{"type":"object"}'),
});

const channelId = await writer.registerChannel({
  schemaId,
  topic: '/camera/top/color/image_raw/compressed',
  messageEncoding: 'json',
  metadata: new Map(),
});

const messageTimes = [1_000_000_000n, 3_000_000_000n, 5_000_000_000n];
for (const [idx, ts] of messageTimes.entries()) {
  await writer.addMessage({
    channelId,
    sequence: idx + 1,
    logTime: ts,
    publishTime: ts,
    data: new TextEncoder().encode(JSON.stringify({ format: 'jpeg', data: '' })),
  });
}

const jointSchemaId = await writer.registerSchema({
  name: 'sensor_msgs/msg/JointState',
  encoding: 'jsonschema',
  data: new TextEncoder().encode('{"type":"object"}'),
});

const jointChannelId = await writer.registerChannel({
  schemaId: jointSchemaId,
  topic: '/joint_states',
  messageEncoding: 'json',
  metadata: new Map(),
});

const jointNames = ['joint1', 'joint2', 'joint3', 'joint4', 'joint5', 'joint6', 'joint7', 'drive_joint'];
const jointPositions = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0.3, -0.2, 0.5, 0.1, -0.4, 0.2, 0.1, 0.42],
  [0.6, -0.4, 1.0, 0.2, -0.8, 0.4, 0.2, 0.85],
];

for (const [idx, ts] of messageTimes.entries()) {
  await writer.addMessage({
    channelId: jointChannelId,
    sequence: idx + 1,
    logTime: ts,
    publishTime: ts,
    data: new TextEncoder().encode(
      JSON.stringify({
        header: { stamp: { sec: Number(ts / 1_000_000_000n), nanosec: Number(ts % 1_000_000_000n) }, frame_id: '' },
        name: jointNames,
        position: jointPositions[idx],
        velocity: [],
        effort: [],
      }),
    ),
  });
}

await writer.end();

const outPath = path.join(__dirname, '../public/examples/test_5s.mcap');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, writable.getBuffer());
console.log('Wrote', outPath, `(${writable.getBuffer().length} bytes)`);
