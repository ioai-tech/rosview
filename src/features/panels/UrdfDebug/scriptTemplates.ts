import type { UrdfDebugRecipe } from './recipe';
import fkEngineJs from './embedded/fkEngine.js?raw';
import { URDF_VISUAL_CORRECTION_JS } from './urdfVisualCorrection';

const MAPPING_CORE_JS = `
function clampValue(value, min, max) {
  let out = value;
  if (min != null && Number.isFinite(min)) out = Math.max(min, out);
  if (max != null && Number.isFinite(max)) out = Math.min(max, out);
  return out;
}

function applyLinear(value, scale, offset, min, max) {
  return clampValue(value * scale + offset, min, max);
}

function applyJointMapping(input, rules) {
  const inputMap = new Map();
  for (let i = 0; i < input.name.length; i += 1) {
    const jointName = input.name[i];
    if (typeof jointName !== 'string' || !jointName) continue;
    inputMap.set(jointName, input.position[i] ?? 0);
  }
  const ignored = new Set(rules.filter((r) => r.kind === 'ignore').map((r) => r.from));
  const consumedInputs = new Set();
  const output = new Map();
  for (const rule of rules) {
    switch (rule.kind) {
      case 'ignore':
        consumedInputs.add(rule.from);
        output.delete(rule.from);
        break;
      case 'rename':
        if (!inputMap.has(rule.from)) break;
        consumedInputs.add(rule.from);
        if (rule.from !== rule.to) output.delete(rule.from);
        output.set(rule.to, inputMap.get(rule.from));
        break;
      case 'linear':
        if (!inputMap.has(rule.from)) break;
        consumedInputs.add(rule.from);
        output.set(rule.to, applyLinear(inputMap.get(rule.from), rule.scale, rule.offset, rule.min, rule.max));
        break;
      case 'duplicate':
        if (!inputMap.has(rule.from)) break;
        consumedInputs.add(rule.from);
        output.delete(rule.from);
        for (const out of rule.outputs) {
          output.set(out.to, applyLinear(inputMap.get(rule.from), out.scale, out.offset, out.min, out.max));
        }
        break;
      case 'mimic':
        if (!inputMap.has(rule.source)) break;
        output.set(rule.to, applyLinear(inputMap.get(rule.source), rule.multiplier, rule.offset));
        break;
      case 'constant':
        output.set(rule.to, rule.value);
        break;
      default:
        break;
    }
  }
  for (const [name, value] of inputMap) {
    if (ignored.has(name) || consumedInputs.has(name)) continue;
    if (!output.has(name)) output.set(name, value);
  }
  const names = [...output.keys()];
  return { name: names, position: names.map((name) => output.get(name) ?? 0) };
}
`.trim();

const MAPPING_CORE_PY = `
def clamp_value(value, min_v=None, max_v=None):
    out = value
    if min_v is not None:
        out = max(min_v, out)
    if max_v is not None:
        out = min(max_v, out)
    return out

def apply_linear(value, scale, offset, min_v=None, max_v=None):
    return clamp_value(value * scale + offset, min_v, max_v)

def apply_joint_mapping(input_state, rules):
    input_map = {}
    for i, name in enumerate(input_state.get('name', [])):
        if not name:
            continue
        positions = input_state.get('position', [])
        input_map[name] = positions[i] if i < len(positions) else 0.0
    ignored = {r['from'] for r in rules if r.get('kind') == 'ignore'}
    consumed = set()
    output = {}
    for rule in rules:
        kind = rule.get('kind')
        if kind == 'ignore':
            consumed.add(rule['from'])
            output.pop(rule['from'], None)
        elif kind == 'rename':
            if rule['from'] not in input_map:
                continue
            consumed.add(rule['from'])
            output.pop(rule['from'], None)
            output[rule['to']] = input_map[rule['from']]
        elif kind == 'linear':
            if rule['from'] not in input_map:
                continue
            consumed.add(rule['from'])
            output[rule['to']] = apply_linear(
                input_map[rule['from']], rule['scale'], rule['offset'], rule.get('min'), rule.get('max')
            )
        elif kind == 'duplicate':
            if rule['from'] not in input_map:
                continue
            consumed.add(rule['from'])
            output.pop(rule['from'], None)
            for out in rule.get('outputs', []):
                output[out['to']] = apply_linear(
                    input_map[rule['from']], out['scale'], out['offset'], out.get('min'), out.get('max')
                )
        elif kind == 'mimic':
            if rule['source'] not in input_map:
                continue
            output[rule['to']] = apply_linear(
                input_map[rule['source']], rule['multiplier'], rule['offset']
            )
        elif kind == 'constant':
            output[rule['to']] = rule['value']
    for name, value in input_map.items():
        if name in ignored or name in consumed:
            continue
        output.setdefault(name, value)
    names = list(output.keys())
    return {'name': names, 'position': [output[name] for name in names]}
`.trim();

const FK_ENGINE_JS = fkEngineJs.replace(/^export class JointState2TF/, 'class JointState2TF');

const ROS2_DEFINITIONS_JS = `
const ROS2_DEFINITIONS = [
  { name: 'builtin_interfaces/msg/Time', definitions: [{ name: 'sec', type: 'int32' }, { name: 'nanosec', type: 'uint32' }] },
  { name: 'std_msgs/msg/Header', definitions: [{ name: 'stamp', type: 'builtin_interfaces/msg/Time', isComplex: true }, { name: 'frame_id', type: 'string' }] },
  { name: 'geometry_msgs/msg/Vector3', definitions: [{ name: 'x', type: 'float64' }, { name: 'y', type: 'float64' }, { name: 'z', type: 'float64' }] },
  { name: 'geometry_msgs/msg/Quaternion', definitions: [{ name: 'x', type: 'float64' }, { name: 'y', type: 'float64' }, { name: 'z', type: 'float64' }, { name: 'w', type: 'float64' }] },
  { name: 'geometry_msgs/msg/Transform', definitions: [{ name: 'translation', type: 'geometry_msgs/msg/Vector3', isComplex: true }, { name: 'rotation', type: 'geometry_msgs/msg/Quaternion', isComplex: true }] },
  { name: 'geometry_msgs/msg/TransformStamped', definitions: [{ name: 'header', type: 'std_msgs/msg/Header', isComplex: true }, { name: 'child_frame_id', type: 'string' }, { name: 'transform', type: 'geometry_msgs/msg/Transform', isComplex: true }] },
  { name: 'tf2_msgs/msg/TFMessage', definitions: [{ name: 'transforms', type: 'geometry_msgs/msg/TransformStamped', isArray: true, isComplex: true }] },
  { name: 'std_msgs/msg/String', definitions: [{ name: 'data', type: 'string' }] },
  { name: 'sensor_msgs/msg/JointState', definitions: [{ name: 'header', type: 'std_msgs/msg/Header', isComplex: true }, { name: 'name', type: 'string', isArray: true }, { name: 'position', type: 'float64', isArray: true }, { name: 'velocity', type: 'float64', isArray: true }, { name: 'effort', type: 'float64', isArray: true }] },
];
`.trim();

const MCAP_PROCESSOR_JS = `
class BufferReadable {
  constructor(buffer) {
    this.buffer = buffer;
  }
  size() {
    return BigInt(this.buffer.byteLength);
  }
  async read(offset, size) {
    const start = Number(offset);
    return this.buffer.subarray(start, start + Number(size));
  }
}

class BufferWritable {
  constructor() {
    this.#chunks = [];
    this.#pos = 0n;
  }
  #chunks;
  #pos;
  position() {
    return this.#pos;
  }
  async write(buffer) {
    this.#chunks.push(Buffer.from(buffer));
    this.#pos += BigInt(buffer.byteLength);
  }
  toBuffer() {
    return Buffer.concat(this.#chunks);
  }
}

${URDF_VISUAL_CORRECTION_JS}

function normalizeJointState(raw) {
  const name = Array.isArray(raw?.name) ? raw.name.map(String) : [];
  const position = Array.isArray(raw?.position) ? raw.position.map((v) => Number(v) || 0) : [];
  const header = raw?.header && typeof raw.header === 'object'
    ? raw.header
    : { stamp: { sec: 0, nanosec: 0 }, frame_id: '' };
  return { header, name, position };
}

function buildChannelDeserializer(channel, schema) {
  if (channel.messageEncoding === 'json') {
    const decoder = new TextDecoder();
    return (data) => JSON.parse(decoder.decode(data));
  }
  if (!schema?.data?.length) {
    throw new Error(\`Missing schema for \${channel.topic}\`);
  }
  const text = new TextDecoder().decode(schema.data);
  const reader = new MessageReader(parseMessageDefinition(text));
  return (data) => reader.readMessage(data);
}

function buildChannelSerializer(schemaName, writers) {
  const writer = writers[schemaName];
  if (!writer) throw new Error(\`Missing writer for \${schemaName}\`);
  return (msg) => writer.writeMessage(msg);
}

async function processMcap({ inputPath, outputPath, recipe, urdfXml, overwriteTopics }) {
  const tfTopic = recipe.outputTfTopic ?? '/tf';
  const robotDescTopic = recipe.outputRobotDescriptionTopic ?? '/robot_description';
  const jointTopic = recipe.jointStateTopic;
  if (!jointTopic) throw new Error('recipe.jointStateTopic is required');

  const inputBuffer = readFileSync(inputPath);
  const reader = await McapIndexedReader.Initialize({
    readable: new BufferReadable(inputBuffer),
  });

  let hasTf = false;
  let hasRobotDesc = false;
  let jointChannel = null;
  for (const channel of reader.channelsById.values()) {
    if (channel.topic === tfTopic) hasTf = true;
    if (channel.topic === robotDescTopic) hasRobotDesc = true;
    if (channel.topic === jointTopic) jointChannel = channel;
  }
  if (!jointChannel) throw new Error(\`JointState topic not found: \${jointTopic}\`);
  if (!overwriteTopics && (hasTf || hasRobotDesc)) {
    throw new Error('Input already contains /tf or /robot_description. Pass --overwrite-topics to replace them.');
  }

  const writable = new BufferWritable();
  const writer = new McapWriter({ writable });
  await writer.start({
    profile: reader.header?.profile ?? 'ros2',
    library: 'urdf-debug-processor',
  });

  const schemaMap = new Map();
  const channelMap = new Map();
  for (const schema of reader.schemasById.values()) {
    schemaMap.set(schema.id, await writer.registerSchema(schema));
  }
  for (const channel of reader.channelsById.values()) {
    if (overwriteTopics && (channel.topic === tfTopic || channel.topic === robotDescTopic)) continue;
    const mapped = { ...channel, schemaId: schemaMap.get(channel.schemaId) ?? 0 };
    channelMap.set(channel.id, await writer.registerChannel(mapped));
  }

  const outEncoding = jointChannel.messageEncoding ?? 'json';
  const preparedUrdf = prepareUrdfXml(urdfXml, recipe);
  const fkEngine = JointState2TF.fromXml({ xml: preparedUrdf });
  const jointSchema = reader.schemasById.get(jointChannel.schemaId);
  const deserializeJoint = buildChannelDeserializer(jointChannel, jointSchema);

  const writers = {
    'tf2_msgs/msg/TFMessage': new MessageWriter(ROS2_DEFINITIONS),
    'std_msgs/msg/String': new MessageWriter(ROS2_DEFINITIONS),
  };

  let tfChannelId;
  let robotDescChannelId;
  if (outEncoding === 'json') {
    const tfSchemaId = await writer.registerSchema({
      name: 'tf2_msgs/msg/TFMessage',
      encoding: 'jsonschema',
      data: new TextEncoder().encode('{"type":"object"}'),
    });
    const robotSchemaId = await writer.registerSchema({
      name: 'std_msgs/msg/String',
      encoding: 'jsonschema',
      data: new TextEncoder().encode('{"type":"object"}'),
    });
    tfChannelId = await writer.registerChannel({ schemaId: tfSchemaId, topic: tfTopic, messageEncoding: 'json', metadata: new Map() });
    robotDescChannelId = await writer.registerChannel({ schemaId: robotSchemaId, topic: robotDescTopic, messageEncoding: 'json', metadata: new Map() });
  } else {
    const tfSchemaId = await writer.registerSchema({
      name: 'tf2_msgs/msg/TFMessage',
      encoding: 'ros2msg',
      data: new TextEncoder().encode('geometry_msgs/TransformStamped[] transforms\\n'),
    });
    const robotSchemaId = await writer.registerSchema({
      name: 'std_msgs/msg/String',
      encoding: 'ros2msg',
      data: new TextEncoder().encode('string data\\n'),
    });
    tfChannelId = await writer.registerChannel({ schemaId: tfSchemaId, topic: tfTopic, messageEncoding: 'cdr', metadata: new Map() });
    robotDescChannelId = await writer.registerChannel({ schemaId: robotSchemaId, topic: robotDescTopic, messageEncoding: 'cdr', metadata: new Map() });
  }

  const serializeTf = outEncoding === 'json'
    ? (msg) => new TextEncoder().encode(JSON.stringify(msg))
    : buildChannelSerializer('tf2_msgs/msg/TFMessage', writers);
  const serializeString = outEncoding === 'json'
    ? (msg) => new TextEncoder().encode(JSON.stringify(msg))
    : buildChannelSerializer('std_msgs/msg/String', writers);

  let robotDescWritten = false;
  let tfSeq = 0;
  let processedJointStates = 0;

  for await (const message of reader.readMessages()) {
    const channel = reader.channelsById.get(message.channelId);
    if (!channel) continue;
    if (overwriteTopics && (channel.topic === tfTopic || channel.topic === robotDescTopic)) continue;

    const mappedChannelId = channelMap.get(message.channelId);
    if (mappedChannelId != null) {
      await writer.addMessage({ ...message, channelId: mappedChannelId });
    }

    if (channel.id !== jointChannel.id) continue;

    const rawJoint = normalizeJointState(deserializeJoint(message.data));
    const mapped = applyJointMapping(
      { name: rawJoint.name, position: rawJoint.position },
      recipe.rules ?? [],
    );
    const tfMsg = fkEngine.computeFromJointState(
      { header: rawJoint.header, name: mapped.name, position: mapped.position },
      { publishTimeNs: message.logTime },
    );

    if (!robotDescWritten) {
      await writer.addMessage({
        channelId: robotDescChannelId,
        sequence: 0,
        logTime: message.logTime,
        publishTime: message.publishTime,
        data: serializeString({ data: preparedUrdf }),
      });
      robotDescWritten = true;
    }

    tfSeq += 1;
    await writer.addMessage({
      channelId: tfChannelId,
      sequence: tfSeq,
      logTime: message.logTime,
      publishTime: message.publishTime,
      data: serializeTf(tfMsg),
    });
    processedJointStates += 1;
  }

  await writer.end();
  writeFileSync(outputPath, writable.toBuffer());
  return processedJointStates;
}
`.trim();

const FK_ENGINE_PY = `
import math
import re
from typing import Any

def _vec3(x=0.0, y=0.0, z=0.0):
    return {'x': x, 'y': y, 'z': z}

def _quat_identity():
    return {'x': 0.0, 'y': 0.0, 'z': 0.0, 'w': 1.0}

def _vec3_add(a, b):
    return {'x': a['x'] + b['x'], 'y': a['y'] + b['y'], 'z': a['z'] + b['z']}

def _vec3_scale(a, s):
    return {'x': a['x'] * s, 'y': a['y'] * s, 'z': a['z'] * s}

def _vec3_length(a):
    return math.hypot(a['x'], a['y'], a['z'])

def _vec3_normalize(a):
    length = _vec3_length(a) or 1.0
    return {'x': a['x'] / length, 'y': a['y'] / length, 'z': a['z'] / length}

def _quat_multiply(a, b):
    return {
        'w': a['w'] * b['w'] - a['x'] * b['x'] - a['y'] * b['y'] - a['z'] * b['z'],
        'x': a['w'] * b['x'] + a['x'] * b['w'] + a['y'] * b['z'] - a['z'] * b['y'],
        'y': a['w'] * b['y'] - a['x'] * b['z'] + a['y'] * b['w'] + a['z'] * b['x'],
        'z': a['w'] * b['z'] + a['x'] * b['y'] - a['y'] * b['x'] + a['z'] * b['w'],
    }

def _quat_from_axis_angle(axis, angle):
    n = _vec3_normalize(axis)
    h = angle * 0.5
    s = math.sin(h)
    return {'x': n['x'] * s, 'y': n['y'] * s, 'z': n['z'] * s, 'w': math.cos(h)}

def _quat_from_rpy(roll, pitch, yaw):
    cx, sx = math.cos(roll * 0.5), math.sin(roll * 0.5)
    cy, sy = math.cos(pitch * 0.5), math.sin(pitch * 0.5)
    cz, sz = math.cos(yaw * 0.5), math.sin(yaw * 0.5)
    return {
        'w': cz * cy * cx + sz * sy * sx,
        'x': cz * cy * sx - sz * sy * cx,
        'y': cz * sy * cx + sz * cy * sx,
        'z': sz * cy * cx - cz * sy * sx,
    }

def _vec3_rotate_by_quat(v, q):
    x, y, z = v['x'], v['y'], v['z']
    qx, qy, qz, qw = q['x'], q['y'], q['z'], q['w']
    uvx = qy * z - qz * y
    uvy = qz * x - qx * z
    uvz = qx * y - qy * x
    uuvx = qy * uvz - qz * uvy
    uuvy = qz * uvx - qx * uvz
    uuvz = qx * uvy - qy * uvx
    return {'x': x + 2 * (qw * uvx + uuvx), 'y': y + 2 * (qw * uvy + uuvy), 'z': z + 2 * (qw * uvz + uuvz)}

def _compose_tr(a, b):
    return {'r': _quat_multiply(a['r'], b['r']), 't': _vec3_add(a['t'], _vec3_rotate_by_quat(b['t'], a['r']))}

class JointState2TF:
    def __init__(self, model):
        self.model = model

    @classmethod
    def from_xml(cls, xml):
        return cls(_parse_urdf(xml))

    def set_joint_state(self, joint_state):
        name_to_pos = {name: joint_state['position'][i] if i < len(joint_state['position']) else 0.0 for i, name in enumerate(joint_state.get('name', []))}
        for name, pos in name_to_pos.items():
            joint = self.model['joints_by_name'].get(name)
            if joint is not None:
                joint['q'] = pos

    def compute(self, publish_time_ns=None):
        transforms = []
        sec = int(publish_time_ns // 1_000_000_000) if publish_time_ns else 0
        nanosec = int(publish_time_ns % 1_000_000_000) if publish_time_ns else 0
        for joint in self.model['joints_by_name'].values():
            motion = _joint_motion_tr(joint)
            rel = _compose_tr(joint['origin'], motion)
            transforms.append({
                'header': {'stamp': {'sec': sec, 'nanosec': nanosec}, 'frame_id': joint['parent']},
                'child_frame_id': joint['child'],
                'transform': {
                    'translation': {'x': rel['t']['x'], 'y': rel['t']['y'], 'z': rel['t']['z']},
                    'rotation': {'x': rel['r']['x'], 'y': rel['r']['y'], 'z': rel['r']['z'], 'w': rel['r']['w']},
                },
            })
        return {'transforms': transforms}

    def compute_from_joint_state(self, joint_state, publish_time_ns=None):
        self.set_joint_state(joint_state)
        return self.compute(publish_time_ns)

def _parse_attrs(text):
    return dict(re.findall(r'(\\w+)\\s*=\\s*"([^"]*)"', text))

def _parse_xyz(text):
    if not text:
        return _vec3()
    parts = [float(v or 0) for v in text.split()]
    while len(parts) < 3:
        parts.append(0.0)
    return _vec3(parts[0], parts[1], parts[2])

def _parse_rpy(text):
    if not text:
        return _quat_identity()
    parts = [float(v or 0) for v in text.split()]
    while len(parts) < 3:
        parts.append(0.0)
    return _quat_from_rpy(parts[0], parts[1], parts[2])

def _parse_joint_block(block):
    open_match = re.search(r'<joint\\b([^>]*)>', block)
    if not open_match:
        return None
    attrs = _parse_attrs(open_match.group(1))
    name = (attrs.get('name') or '').strip()
    joint_type = (attrs.get('type') or 'fixed').strip()
    parent_match = re.search(r'<parent\\b[^>]*link="([^"]+)"', block)
    child_match = re.search(r'<child\\b[^>]*link="([^"]+)"', block)
    if not name or not parent_match or not child_match:
        return None
    origin_match = re.search(r'<origin\\b([^/>]*)/?>', block)
    origin_attrs = _parse_attrs(origin_match.group(1)) if origin_match else {}
    axis_match = re.search(r'<axis\\b([^/>]*)/?>', block)
    axis_attrs = _parse_attrs(axis_match.group(1)) if axis_match else {}
    origin = {'r': _parse_rpy(origin_attrs.get('rpy')), 't': _parse_xyz(origin_attrs.get('xyz'))}
    axis = _vec3_normalize(_parse_xyz(axis_attrs.get('xyz', '1 0 0')))
    if joint_type not in {'revolute', 'continuous', 'prismatic', 'fixed'}:
        joint_type = 'fixed'
    return {'name': name, 'type': joint_type, 'parent': parent_match.group(1), 'child': child_match.group(1), 'origin': origin, 'axis': axis, 'q': 0.0}

def _parse_urdf(xml):
    joints = [j for j in (_parse_joint_block(block) for block in re.findall(r'<joint\\b[\\s\\S]*?</joint>', xml)) if j]
    joints_by_name = {j['name']: j for j in joints}
    return {'joints_by_name': joints_by_name}

def _joint_motion_tr(joint):
    if joint['type'] in {'revolute', 'continuous'}:
        return {'r': _quat_from_axis_angle(joint['axis'], joint['q']), 't': _vec3()}
    if joint['type'] == 'prismatic':
        return {'r': _quat_identity(), 't': _vec3_scale(joint['axis'], joint['q'])}
    return {'r': _quat_identity(), 't': _vec3()}
`.trim();

const MCAP_PROCESSOR_PY = `
def prepare_urdf_xml(xml, recipe):
    urdf = recipe.get('urdf') or {}
    rotate = bool(urdf.get('rotateMeshVisuals'))
    offset = urdf.get('visualRpyOffset') or [0, 0, 0]
    if not rotate and all(v == 0 for v in offset):
        return xml
    import math
    import re

    def rotation_matrix_from_rpy(roll, pitch, yaw):
        cx, sx = math.cos(roll), math.sin(roll)
        cy, sy = math.cos(pitch), math.sin(pitch)
        cz, sz = math.cos(yaw), math.sin(yaw)
        return [
            [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
            [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
            [-sy, cy * sx, cy * cx],
        ]

    def rpy_from_rotation_matrix(m):
        sy = -m[2][0]
        if abs(sy) < 1 - 1e-6:
            pitch = math.asin(sy)
            roll = math.atan2(m[2][1], m[2][2])
            yaw = math.atan2(m[1][0], m[0][0])
            return [roll, pitch, yaw]
        pitch = math.pi / 2 if sy > 0 else -math.pi / 2
        roll = math.atan2(-m[0][1], m[1][1])
        return [roll, pitch, 0.0]

    def multiply_mat3(a, b):
        out = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
        for i in range(3):
            for j in range(3):
                out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
        return out

    def transform_visual_origin_rpy(rpy):
        matrix = rotation_matrix_from_rpy(rpy[0], rpy[1], rpy[2])
        if rotate:
            matrix = multiply_mat3(matrix, rotation_matrix_from_rpy(-math.pi / 2, 0.0, 0.0))
        if not all(v == 0 for v in offset):
            matrix = multiply_mat3(matrix, rotation_matrix_from_rpy(offset[0], offset[1], offset[2]))
        return rpy_from_rotation_matrix(matrix)

    def repl(match):
        prefix, rpy_raw, suffix = match.group(1), match.group(2) or '0 0 0', match.group(3)
        parts = [float(v or 0) for v in rpy_raw.split()]
        while len(parts) < 3:
            parts.append(0.0)
        next_rpy = transform_visual_origin_rpy(parts[:3])
        return f'{prefix}{next_rpy[0]} {next_rpy[1]} {next_rpy[2]}{suffix}'

    return re.sub(r'(<visual\\s[\\s\\S]*?<origin\\b[^>]*\\brpy=")([^"]*)(")', repl, xml)

def normalize_joint_state(raw):
    if not isinstance(raw, dict):
        raw = {}
    name = [str(v) for v in raw.get('name', [])]
    position = [float(v or 0) for v in raw.get('position', [])]
    header = raw.get('header') if isinstance(raw.get('header'), dict) else {'stamp': {'sec': 0, 'nanosec': 0}, 'frame_id': ''}
    return {'header': header, 'name': name, 'position': position}

def process_mcap(input_path, output_path, recipe, urdf_xml, overwrite):
    from mcap.reader import make_reader
    from mcap.writer import Writer

    tf_topic = recipe.get('outputTfTopic') or '/tf'
    robot_desc_topic = recipe.get('outputRobotDescriptionTopic') or '/robot_description'
    joint_topic = recipe.get('jointStateTopic')
    if not joint_topic:
        raise SystemExit('recipe.jointStateTopic is required')

    decoder_factory = None
    try:
        from mcap_ros2.decoder import DecoderFactory
        decoder_factory = DecoderFactory()
    except ImportError:
        decoder_factory = None

    with open(input_path, 'rb') as input_file, open(output_path, 'wb') as output_file:
        reader = make_reader(input_file, decoder_factories=[decoder_factory] if decoder_factory else [])
        summary = reader.get_summary()
        if summary is None:
            raise SystemExit('Input MCAP must be indexed. Run: mcap recover input.mcap -o input.indexed.mcap')

        has_tf = any(ch.topic == tf_topic for ch in summary.channels.values())
        has_robot = any(ch.topic == robot_desc_topic for ch in summary.channels.values())
        joint_channel = next((ch for ch in summary.channels.values() if ch.topic == joint_topic), None)
        if joint_channel is None:
            raise SystemExit(f'JointState topic not found: {joint_topic}')
        if not overwrite and (has_tf or has_robot):
            raise SystemExit('Input already contains /tf or /robot_description. Pass --overwrite-topics.')

        writer = Writer(output_file)
        writer.start(profile='ros2', library='urdf-debug-processor')

        schema_map = {}
        for schema_id, schema in summary.schemas.items():
            schema_map[schema_id] = writer.register_schema(name=schema.name, encoding=schema.encoding, data=schema.data)

        channel_map = {}
        for channel_id, channel in summary.channels.items():
            if overwrite and channel.topic in {tf_topic, robot_desc_topic}:
                continue
            channel_map[channel_id] = writer.register_channel(
                topic=channel.topic,
                message_encoding=channel.message_encoding,
                schema_id=schema_map.get(channel.schema_id, 0),
                metadata=channel.metadata,
            )

        out_encoding = joint_channel.message_encoding or 'json'
        prepared_urdf = prepare_urdf_xml(urdf_xml, recipe)
        fk_engine = JointState2TF.from_xml(prepared_urdf)

        tf_schema_id = writer.register_schema(
            name='tf2_msgs/msg/TFMessage',
            encoding='jsonschema' if out_encoding == 'json' else 'ros2msg',
            data=b'{}' if out_encoding == 'json' else b'geometry_msgs/TransformStamped[] transforms\\n',
        )
        robot_schema_id = writer.register_schema(
            name='std_msgs/msg/String',
            encoding='jsonschema' if out_encoding == 'json' else 'ros2msg',
            data=b'{}' if out_encoding == 'json' else b'string data\\n',
        )
        tf_channel_id = writer.register_channel(topic=tf_topic, message_encoding=out_encoding, schema_id=tf_schema_id)
        robot_channel_id = writer.register_channel(topic=robot_desc_topic, message_encoding=out_encoding, schema_id=robot_schema_id)

        def serialize_payload(msg):
            return json.dumps(msg).encode('utf-8')

        robot_desc_written = False
        tf_seq = 0
        processed = 0

        message_iter = reader.iter_decoded_messages() if decoder_factory else reader.iter_messages()
        for item in message_iter:
            if decoder_factory:
                schema, channel, message, decoded = item
            else:
                schema, channel, message = item
                decoded = None

            if overwrite and channel.topic in {tf_topic, robot_desc_topic}:
                continue

            mapped = channel_map.get(channel.id)
            if mapped is not None:
                writer.add_message(
                    channel_id=mapped,
                    log_time=message.log_time,
                    data=message.data,
                    publish_time=message.publish_time,
                    sequence=message.sequence,
                )

            if channel.topic != joint_topic:
                continue

            if channel.message_encoding == 'json':
                raw_joint = normalize_joint_state(json.loads(message.data.decode('utf-8')))
            elif decoded is not None:
                raw_joint = normalize_joint_state({
                    'header': {
                        'stamp': {
                            'sec': int(getattr(decoded.header.stamp, 'sec', 0)),
                            'nanosec': int(getattr(decoded.header.stamp, 'nanosec', 0)),
                        },
                        'frame_id': str(getattr(decoded.header, 'frame_id', '')),
                    },
                    'name': list(getattr(decoded, 'name', [])),
                    'position': list(getattr(decoded, 'position', [])),
                })
            else:
                raise SystemExit('CDR joint_states requires: pip install mcap-ros2-support')

            mapped_js = apply_joint_mapping(
                {'name': raw_joint['name'], 'position': raw_joint['position']},
                recipe.get('rules', []),
            )
            tf_msg = fk_engine.compute_from_joint_state(
                {'header': raw_joint['header'], 'name': mapped_js['name'], 'position': mapped_js['position']},
                message.log_time,
            )

            if not robot_desc_written:
                writer.add_message(
                    channel_id=robot_channel_id,
                    log_time=message.log_time,
                    data=serialize_payload({'data': prepared_urdf}),
                    publish_time=message.publish_time,
                    sequence=0,
                )
                robot_desc_written = True

            tf_seq += 1
            writer.add_message(
                channel_id=tf_channel_id,
                log_time=message.log_time,
                data=serialize_payload(tf_msg),
                publish_time=message.publish_time,
                sequence=tf_seq,
            )
            processed += 1

        writer.finish()
    return processed
`.trim();

function recipeLiteral(recipe: UrdfDebugRecipe): string {
  return JSON.stringify(recipe, null, 2);
}

export function generateTypeScriptScript(recipe: UrdfDebugRecipe): string {
  const recipeJson = recipeLiteral(recipe);
  return `#!/usr/bin/env node
/**
 * URDF Debug MCAP processor (TypeScript)
 *
 * Usage:
 *   npm i @mcap/core @foxglove/rosmsg @foxglove/rosmsg2-serialization
 *   node process_mcap_tf.mjs input.mcap output.mcap recipe.json robot.urdf [--overwrite-topics]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { McapIndexedReader, McapWriter } from '@mcap/core';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';
import rosmsg from '@foxglove/rosmsg';
const { parseMessageDefinition } = rosmsg;

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: node process_mcap_tf.mjs input.mcap output.mcap recipe.json robot.urdf [--overwrite-topics]');
  process.exit(1);
}
const [inputPath, outputPath, recipePath, urdfPath, ...flags] = args;
const overwriteTopics = flags.includes('--overwrite-topics');
const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const urdfXml = readFileSync(urdfPath, 'utf8');

${MAPPING_CORE_JS}

${FK_ENGINE_JS}

${ROS2_DEFINITIONS_JS}

${MCAP_PROCESSOR_JS}

async function main() {
  const processed = await processMcap({ inputPath, outputPath, recipe, urdfXml, overwriteTopics });
  console.log('Wrote', outputPath, 'with', processed, 'joint state frame(s) expanded to /tf');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/*
Embedded recipe snapshot:
${recipeJson}
*/
`;
}

export function generatePythonScript(recipe: UrdfDebugRecipe): string {
  const recipeJson = recipeLiteral(recipe);
  return `#!/usr/bin/env python3
"""URDF Debug MCAP processor (Python)

Usage:
  pip install mcap mcap-ros2-support
  python process_mcap_tf.py input.mcap output.mcap recipe.json robot.urdf [--overwrite-topics]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

${MAPPING_CORE_PY}

${FK_ENGINE_PY}

${MCAP_PROCESSOR_PY}

def main() -> None:
    if len(sys.argv) < 5:
        print('Usage: python process_mcap_tf.py input.mcap output.mcap recipe.json robot.urdf [--overwrite-topics]', file=sys.stderr)
        sys.exit(1)
    input_path, output_path, recipe_path, urdf_path, *flags = sys.argv[1:]
    overwrite = '--overwrite-topics' in flags
    recipe = json.loads(Path(recipe_path).read_text(encoding='utf-8'))
    urdf_xml = Path(urdf_path).read_text(encoding='utf-8')
    processed = process_mcap(input_path, output_path, recipe, urdf_xml, overwrite)
    print('Wrote', output_path, 'with', processed, 'joint state frame(s) expanded to /tf')

if __name__ == '__main__':
    main()

# Embedded recipe snapshot:
# ${recipeJson.replace(/\n/g, '\n# ')}
`;
}

export function buildCliCommands(): { ts: string; py: string } {
  return {
    ts: 'node process_mcap_tf.mjs input.mcap output.mcap recipe.json robot.urdf',
    py: 'python process_mcap_tf.py input.mcap output.mcap recipe.json robot.urdf',
  };
}
