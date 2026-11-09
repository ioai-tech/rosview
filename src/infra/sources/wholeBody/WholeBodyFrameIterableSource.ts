import type { Initialization, MessageEvent, Time, TopicInfo } from '@/core/types/ros';
import type { GetAdjacentMessageArgs, IIterableSource } from '../IIterableSource';
import type { MessageIteratorArgs, GetBackfillMessagesArgs } from '@/infra/workers/types';
import {
  FLOATING_BASE_DOF,
  G1_29DOF_JOINT_NAMES,
  WHOLE_BODY_FRAME_SCHEMA,
  buildWholeBodyDatatypes,
} from './schemas';

/**
 * Wraps a source and splits every `whole_body.frame` JSON topic (IO-AI
 * whole-body teleop recorder, e.g. Unitree G1 + Dex3) into standard ROS topics
 * so the stock panels work without knowing the format:
 *
 * - `<base>/colors/<camera>` and `<base>/depths/<camera>` → `sensor_msgs/msg/CompressedImage`
 *   (base64 JPEG/PNG) or `sensor_msgs/msg/Image` (raw)
 * - `<base>/joint_states` → `sensor_msgs/msg/JointState` (G1 body + Dex3 hands)
 * - `<base>/base_pose` → `geometry_msgs/msg/PoseStamped` (floating base)
 *
 * The original frame topic stays available with the base64 image payloads
 * replaced by a short placeholder, which keeps Raw Messages / Plot usable.
 * Sources without such topics pass straight through.
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

type DerivedKind =
  | { kind: 'image'; group: 'colors' | 'depths'; key: string }
  | { kind: 'jointStates' }
  | { kind: 'basePose' };

interface DerivedTopic {
  sourceTopic: string;
  derive: DerivedKind;
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

export class WholeBodyFrameIterableSource implements IIterableSource {
  private _inner: IIterableSource;
  /** Derived topic name → how to build it. */
  private _derived = new Map<string, DerivedTopic>();
  /** Frame source topic → derived topic names. */
  private _derivedBySource = new Map<string, string[]>();

  constructor(inner: IIterableSource) {
    this._inner = inner;
  }

  async initialize(): Promise<Initialization> {
    const init = await this._inner.initialize();
    const frameTopics = init.topics.filter((topic) => topic.type === WHOLE_BODY_FRAME_SCHEMA);
    if (frameTopics.length === 0) return init;

    // Camera names and joint layout are only known from the payload; sample the first frame.
    const samples = await this._inner.getBackfillMessages({
      time: init.start,
      topics: frameTopics.map((topic) => topic.name),
    });

    const topics: TopicInfo[] = [...init.topics];
    for (const sample of samples) {
      if (!isRecord(sample.message)) continue;
      const frame = sample.message as WholeBodyFrame;
      const sourceTopic = sample.topic;
      const base = sourceTopic.replace(/\/frame$/, '');
      const derivedNames: string[] = [];
      const add = (name: string, type: string, derive: DerivedKind) => {
        this._derived.set(name, { sourceTopic, derive });
        derivedNames.push(name);
        topics.push({ name, type });
        init.topicStats[name] = { ...init.topicStats[sourceTopic] };
        init.publishersByTopic[name] = init.publishersByTopic[sourceTopic] ?? [];
      };

      for (const group of ['colors', 'depths'] as const) {
        const images = frame[group];
        if (!isRecord(images)) continue;
        for (const [key, image] of Object.entries(images)) {
          if (!isRecord(image)) continue;
          const type = isCompressedImage(image) ? 'sensor_msgs/msg/CompressedImage' : 'sensor_msgs/msg/Image';
          add(`${base}/${group}/${key}`, type, { kind: 'image', group, key });
        }
      }
      const q = frame.states?.robot_q_current;
      if ((Array.isArray(q) && q.length > 0) || Array.isArray(frame.states?.dex3_q)) {
        add(`${base}/joint_states`, 'sensor_msgs/msg/JointState', { kind: 'jointStates' });
      }
      if (Array.isArray(q) && q.length === FLOATING_BASE_DOF + G1_29DOF_JOINT_NAMES.length) {
        add(`${base}/base_pose`, 'geometry_msgs/msg/PoseStamped', { kind: 'basePose' });
      }
      this._derivedBySource.set(sourceTopic, derivedNames);
    }

    return {
      ...init,
      topics,
      datatypes: { ...buildWholeBodyDatatypes(), ...init.datatypes },
    };
  }

  async *messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent> {
    if (this._derivedBySource.size === 0) {
      yield* this._inner.messageIterator(args);
      return;
    }
    const wanted = new Set(args.topics);
    const innerArgs: MessageIteratorArgs = {
      ...args,
      topics: this._toInnerTopics(args.topics),
      latestOnlyTopics: args.latestOnlyTopics ? this._toInnerTopics(args.latestOnlyTopics) : undefined,
    };
    for await (const event of this._inner.messageIterator(innerArgs)) {
      yield* this._expand(event, wanted);
    }
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (this._derivedBySource.size === 0) {
      return await this._inner.getBackfillMessages(args);
    }
    const wanted = new Set(args.topics);
    const events = await this._inner.getBackfillMessages({ ...args, topics: this._toInnerTopics(args.topics) });
    return events.flatMap((event) => this._expand(event, wanted));
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._inner.getAdjacentMessage) return null;
    if (this._derivedBySource.size === 0) {
      return await this._inner.getAdjacentMessage(args);
    }
    const event = await this._inner.getAdjacentMessage({ ...args, topics: this._toInnerTopics(args.topics) });
    return event ? (this._expand(event, new Set(args.topics))[0] ?? null) : null;
  }

  private _toInnerTopics(topics: readonly string[]): string[] {
    return [...new Set(topics.map((topic) => this._derived.get(topic)?.sourceTopic ?? topic))];
  }

  private _expand(event: MessageEvent, wanted: ReadonlySet<string>): MessageEvent[] {
    const derivedNames = this._derivedBySource.get(event.topic);
    if (!derivedNames || !isRecord(event.message)) return [event];

    const frame = event.message as WholeBodyFrame;
    const out: MessageEvent[] = [];
    if (wanted.has(event.topic)) {
      out.push({
        ...event,
        message: {
          ...frame,
          colors: stripImagePayloads(frame.colors),
          depths: stripImagePayloads(frame.depths),
        },
      });
    }
    for (const name of derivedNames) {
      if (!wanted.has(name)) continue;
      const message = this._derive(this._derived.get(name)!.derive, frame, event.receiveTime);
      if (message == undefined) continue;
      out.push({ ...event, topic: name, message, schemaName: this._schemaNameFor(name, frame) });
    }
    return out;
  }

  private _derive(derive: DerivedKind, frame: WholeBodyFrame, time: Time): unknown {
    switch (derive.kind) {
      case 'image': {
        const image = frame[derive.group]?.[derive.key];
        return isRecord(image) ? imageMessage(image, time, derive.key) : undefined;
      }
      case 'jointStates':
        return jointStateMessage(frame, time);
      case 'basePose':
        return basePoseMessage(frame, time);
    }
  }

  private _schemaNameFor(topic: string, frame: WholeBodyFrame): string {
    const derive = this._derived.get(topic)!.derive;
    switch (derive.kind) {
      case 'image': {
        const image = frame[derive.group]?.[derive.key];
        return isRecord(image) && !isCompressedImage(image)
          ? 'sensor_msgs/msg/Image'
          : 'sensor_msgs/msg/CompressedImage';
      }
      case 'jointStates':
        return 'sensor_msgs/msg/JointState';
      case 'basePose':
        return 'geometry_msgs/msg/PoseStamped';
    }
  }
}
