import type { MessageEvent, Time } from '@/core/types/ros';
import type { TopicAdapter } from '../types';
import {
  DEX3_JOINT_NAMES,
  DEX3_FRAME_SCHEMA,
  FLOATING_BASE_DOF,
  G1_29DOF_JOINT_NAMES,
  WHOLE_BODY_FRAME_SCHEMA,
  WHOLE_BODY_META_SCHEMA,
  buildWholeBodyDatatypes,
} from './schemas';

/**
 * Adapters for the IO-AI whole-body teleop recorder (`ioai.wbc.*` MCAP
 * profile, e.g. Unitree G1 + Dex3 hands):
 *
 * - `whole_body.frame` → `<base>/colors|depths/<camera>` (`sensor_msgs/msg/CompressedImage`
 *   for base64 JPEG/PNG, `sensor_msgs/msg/Image` for raw), `<base>/joint_states`
 *   (G1 body + Dex3 hands) and `<base>/base_pose` (floating base). The frame
 *   topic itself keeps its data with base64 payloads replaced by a placeholder.
 * - `unitree.dex3.frame` → `<base>/state` and `<base>/command` joint states.
 * - `whole_body.meta` → a hint when hand data lives in a sidecar file that
 *   wasn't opened.
 */

interface FrameImage {
  data?: unknown;
  encoding?: string;
  width?: number;
  height?: number;
  channels?: number;
}

interface WholeBodyFrame {
  colors?: Record<string, FrameImage> | null;
  depths?: Record<string, FrameImage> | null;
  states?: { robot_q_current?: number[]; dex3_q?: number[] } | null;
  dex3?: { joint_names?: string[] } | null;
}

const COMPRESSED_FORMATS = new Set(['jpeg', 'jpg', 'png']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function decodeBase64(text: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (fromBase64) return fromBase64(text);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isCompressedImage(image: FrameImage): boolean {
  return COMPRESSED_FORMATS.has((image.encoding ?? '').toLowerCase());
}

function rawImageEncoding(image: FrameImage, byteLength: number): string {
  const encoding = (image.encoding ?? '').toLowerCase();
  if (encoding && encoding !== 'raw') return encoding;
  const pixels = (image.width ?? 0) * (image.height ?? 0);
  const channels = image.channels ?? 1;
  if (channels === 1) return pixels > 0 && byteLength >= pixels * 2 ? '16UC1' : 'mono8';
  return channels === 4 ? 'rgba8' : 'rgb8';
}

function headerFor(time: Time, frameId: string) {
  return { stamp: { sec: time.sec, nanosec: time.nsec }, frame_id: frameId };
}

function imageMessage(image: FrameImage, time: Time, frameId: string): unknown {
  const data = typeof image.data === 'string' ? decodeBase64(image.data) : new Uint8Array();
  if (isCompressedImage(image)) {
    return {
      header: headerFor(time, frameId),
      format: (image.encoding ?? 'jpeg').toLowerCase(),
      data,
    };
  }
  const width = image.width ?? 0;
  const height = image.height ?? 0;
  return {
    header: headerFor(time, frameId),
    height,
    width,
    encoding: rawImageEncoding(image, data.byteLength),
    is_bigendian: 0,
    step: height > 0 ? Math.floor(data.byteLength / height) : 0,
    data,
  };
}

function jointStateMessage(frame: WholeBodyFrame, time: Time): unknown {
  const q = frame.states?.robot_q_current ?? [];
  const hasG1Layout = q.length === FLOATING_BASE_DOF + G1_29DOF_JOINT_NAMES.length;
  const bodyPositions = hasG1Layout ? q.slice(FLOATING_BASE_DOF) : q;
  const bodyNames = hasG1Layout ? G1_29DOF_JOINT_NAMES : bodyPositions.map((_, i) => `robot_q_current_${i}`);

  const handPositions = frame.states?.dex3_q ?? [];
  const handNames = handPositions.map((_, i) => frame.dex3?.joint_names?.[i] ?? `dex3_joint_${i}`);

  // Body joint velocities aren't recorded, so `velocity` stays empty (hand `dex3_dq` remains on the frame topic).
  return {
    header: headerFor(time, 'base_link'),
    name: [...bodyNames, ...handNames],
    position: [...bodyPositions, ...handPositions],
    velocity: [],
    effort: [],
  };
}

function basePoseMessage(frame: WholeBodyFrame, time: Time): unknown {
  const [x, y, z, qw, qx, qy, qz] = frame.states?.robot_q_current ?? [];
  return {
    header: headerFor(time, 'world'),
    pose: {
      position: { x, y, z },
      orientation: { x: qx, y: qy, z: qz, w: qw },
    },
  };
}

function stripImagePayloads(group: Record<string, FrameImage> | null | undefined) {
  if (!isRecord(group)) return group;
  const out: Record<string, FrameImage> = {};
  for (const [key, image] of Object.entries(group)) {
    if (!isRecord(image) || typeof image.data !== 'string') {
      out[key] = image;
      continue;
    }
    const encoding = typeof image.encoding === 'string' ? image.encoding : 'binary';
    out[key] = { ...image, data: `<${encoding} base64, ${image.data.length} chars>` };
  }
  return out;
}


function frameBase(sourceTopic: string): string {
  return sourceTopic.replace(/\/frame$/, '');
}

const datatypes = buildWholeBodyDatatypes();

export const wholeBodyFrameAdapter: TopicAdapter = {
  id: 'ioai.whole_body.frame',
  schemaNames: [WHOLE_BODY_FRAME_SCHEMA],
  datatypes,
  plan(sourceTopic, sample) {
    if (!isRecord(sample)) return undefined;
    const first = sample as WholeBodyFrame;
    const base = frameBase(sourceTopic);
    const derived = [];
    for (const group of ['colors', 'depths'] as const) {
      const images = first[group];
      if (!isRecord(images)) continue;
      for (const [key, image] of Object.entries(images)) {
        if (!isRecord(image)) continue;
        derived.push({
          name: `${base}/${group}/${key}`,
          type: isCompressedImage(image) ? 'sensor_msgs/msg/CompressedImage' : 'sensor_msgs/msg/Image',
          derive: (message: unknown, event: MessageEvent) => {
            const current = (message as WholeBodyFrame)[group]?.[key];
            return isRecord(current) ? imageMessage(current, event.receiveTime, key) : undefined;
          },
        });
      }
    }
    const q = first.states?.robot_q_current;
    if ((Array.isArray(q) && q.length > 0) || Array.isArray(first.states?.dex3_q)) {
      derived.push({
        name: `${base}/joint_states`,
        type: 'sensor_msgs/msg/JointState',
        derive: (message: unknown, event: MessageEvent) => jointStateMessage(message as WholeBodyFrame, event.receiveTime),
      });
    }
    if (Array.isArray(q) && q.length === FLOATING_BASE_DOF + G1_29DOF_JOINT_NAMES.length) {
      derived.push({
        name: `${base}/base_pose`,
        type: 'geometry_msgs/msg/PoseStamped',
        derive: (message: unknown, event: MessageEvent) => basePoseMessage(message as WholeBodyFrame, event.receiveTime),
      });
    }
    return {
      derived,
      transformSource: (message) => {
        if (!isRecord(message)) return message;
        const frame = message as WholeBodyFrame;
        return { ...frame, colors: stripImagePayloads(frame.colors), depths: stripImagePayloads(frame.depths) };
      },
    };
  },
};

interface Dex3Side {
  state?: { position?: number[]; velocity?: number[] };
  command?: { position?: number[]; velocity?: number[]; tau?: number[] };
}

interface Dex3Frame {
  left?: Dex3Side;
  right?: Dex3Side;
}

function dex3JointState(
  frame: Dex3Frame,
  time: Time,
  pick: (side: Dex3Side) => { position?: number[]; velocity?: number[]; effort?: number[] } | undefined,
): unknown {
  const left = frame.left ? pick(frame.left) : undefined;
  const right = frame.right ? pick(frame.right) : undefined;
  const position = [...(left?.position ?? []), ...(right?.position ?? [])];
  const join = (a?: number[], b?: number[]) => {
    const values = [...(a ?? []), ...(b ?? [])];
    return values.length === position.length ? values : [];
  };
  return {
    header: headerFor(time, 'base_link'),
    name: position.map((_, i) => (position.length === DEX3_JOINT_NAMES.length ? DEX3_JOINT_NAMES[i] : `dex3_joint_${i}`)),
    position,
    velocity: join(left?.velocity, right?.velocity),
    effort: join(left?.effort, right?.effort),
  };
}

export const dex3FrameAdapter: TopicAdapter = {
  id: 'unitree.dex3.frame',
  schemaNames: [DEX3_FRAME_SCHEMA],
  datatypes,
  plan(sourceTopic, sample) {
    if (!isRecord(sample)) return undefined;
    const base = frameBase(sourceTopic);
    return {
      derived: [
        {
          name: `${base}/state`,
          type: 'sensor_msgs/msg/JointState',
          derive: (message, event) =>
            dex3JointState(message as Dex3Frame, event.receiveTime, (side) => side.state),
        },
        {
          name: `${base}/command`,
          type: 'sensor_msgs/msg/JointState',
          derive: (message, event) =>
            dex3JointState(message as Dex3Frame, event.receiveTime, (side) =>
              side.command ? { ...side.command, effort: side.command.tau } : undefined,
            ),
        },
      ],
    };
  },
};

export const wholeBodyMetaAdapter: TopicAdapter = {
  id: 'ioai.whole_body.meta',
  schemaNames: [WHOLE_BODY_META_SCHEMA],
  plan(_sourceTopic, sample, init) {
    const sidecar = isRecord(sample) && isRecord(sample.info) && isRecord(sample.info.dex3) ? sample.info.dex3.sidecar : undefined;
    if (typeof sidecar !== 'string' || init.topics.some((topic) => topic.type === DEX3_FRAME_SCHEMA)) {
      return undefined;
    }
    return {
      derived: [],
      problems: [
        {
          severity: 'warn',
          message: `Dex3 hand data is recorded in the sidecar file "${sidecar}". Open it together with this file to merge it.`,
        },
      ],
    };
  },
};
