/**
 * Minimal unindexed whole-body teleop MCAP (IO-AI `ioai.wbc.dex3.v1` profile,
 * e.g. Unitree G1 + Dex3) for E2E: JSON `whole_body.frame` messages carrying
 * base64 JPEG cameras + joint state, written without chunks or a summary
 * section like the streaming recorder does.
 */
import { McapWriter } from '@mcap/core';
import { BufferWritable, readFixture, writeExample } from './mcap-fixture-utils.mjs';

const jpegBase64 = readFixture('media/jpeg-1x1.bin').toString('base64');
const encoder = new TextEncoder();

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
await writer.start({ profile: 'ioai.wbc.dex3.v1', library: 'rosview-gen' });

async function jsonChannel(topic, schemaName) {
  const schemaId = await writer.registerSchema({
    name: schemaName,
    encoding: 'jsonschema',
    data: encoder.encode('{"type":"object"}'),
  });
  return await writer.registerChannel({ topic, schemaId, messageEncoding: 'json', metadata: new Map() });
}

const metaChannel = await jsonChannel('/episode/meta', 'whole_body.meta');
const dex3Channel = await jsonChannel('/dex3/frame', 'unitree.dex3.frame');
const frameChannel = await jsonChannel('/whole_body/frame', 'whole_body.frame');

const dex3JointNames = ['left', 'right'].flatMap((side) =>
  ['thumb_0', 'thumb_1', 'thumb_2', 'middle_0', 'middle_1', 'index_0', 'index_1'].map(
    (joint) => `${side}_hand_${joint}_joint`,
  ),
);

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

const START_NS = 1_000_000_000n;
const FRAME_NS = 100_000_000n;
const FRAMES = 30;

await add(metaChannel, START_NS, { info: { robot: 'g1', dex3: { joint_names: dex3JointNames } }, text: {} });
for (let idx = 0; idx < FRAMES; idx++) {
  const t = START_NS + BigInt(idx) * FRAME_NS + 1n;
  const phase = idx / FRAMES;
  const dex3Q = dex3JointNames.map((_, i) => Math.sin(phase * Math.PI * 2 + i) * 0.5);
  await add(dex3Channel, t, { version: 1, left: { state: { position: dex3Q.slice(0, 7) } }, right: { state: { position: dex3Q.slice(7) } } });
  await add(frameChannel, t + 1n, {
    idx,
    sample_time_ns: Number(t),
    colors: {
      color_0: { channels: 3, data: jpegBase64, encoding: 'jpeg', height: 1, width: 1 },
      color_1: { channels: 3, data: jpegBase64, encoding: 'jpeg', height: 1, width: 1 },
    },
    depths: {},
    states: {
      robot_q_current: [phase, 0, 0.8, 1, 0, 0, 0, ...Array.from({ length: 29 }, (_, i) => Math.sin(phase * Math.PI * 2 + i) * 0.3)],
      dex3_q: dex3Q,
      dex3_dq: dex3Q.map(() => 0),
    },
    actions: { frame: [phase, -phase] },
    audios: null,
    tactiles: null,
    dex3: { version: 1, joint_names: dex3JointNames },
  });
}

await writer.end();
writeExample('test_whole_body.mcap', writable.getBuffer());
