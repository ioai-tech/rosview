/** Canonical ROS 2 schema names used across layout, panels, and tests. */

export const ROS_MSG_SENSOR_IMAGE = 'sensor_msgs/msg/Image' as const;
export const ROS_MSG_SENSOR_COMPRESSED_IMAGE = 'sensor_msgs/msg/CompressedImage' as const;
export const ROS_MSG_FOXGLOVE_COMPRESSED_VIDEO = 'foxglove_msgs/msg/CompressedVideo' as const;
export const ROS_MSG_JOINT_STATE = 'sensor_msgs/msg/JointState' as const;
export const ROS_MSG_POSE_STAMPED = 'geometry_msgs/msg/PoseStamped' as const;
export const ROS_MSG_FOXGLOVE_RAW_AUDIO = 'foxglove_msgs/msg/RawAudio' as const;
export const ROS_MSG_AUDIO_COMMON_AUDIO_DATA = 'audio_common_msgs/msg/AudioData' as const;
export const ROS_MSG_AUDIO_COMMON_AUDIO_DATA_STAMPED = 'audio_common_msgs/msg/AudioDataStamped' as const;
export const ROS_MSG_AUDIO_COMMON_AUDIO_INFO = 'audio_common_msgs/msg/AudioInfo' as const;

/**
 * Normalize schema labels from different sources, e.g.:
 * - `sensor_msgs/msg/CompressedImage`
 * - `sensor_msgs/msg/CompressedImage [ros2msg]`
 * - `sensor_msgs/msg/CompressedImage [jsonschema]`
 */
export function normalizeRosSchemaName(type: string): string {
  const trimmed = type.trim();
  const withoutSourceTag = trimmed.replace(/\s*\[[^\]]+\]\s*$/u, '');
  const lower = withoutSourceTag.toLowerCase();
  // Some pipelines emit ROS-style schema names without the explicit `/msg/` segment,
  // e.g. `sensor_msgs/CompressedImage`. Normalize both shapes so matching logic is stable.
  return lower.replace(/^([^/]+)\/msg\/(.+)$/u, '$1/$2');
}

export function matchesRosSchema(type: string, canonical: string): boolean {
  return normalizeRosSchemaName(type) === normalizeRosSchemaName(canonical);
}

export function isJointStateSchema(type: string): boolean {
  return matchesRosSchema(type, ROS_MSG_JOINT_STATE);
}

/**
 * Preference when several topics of the same kind compete for a default
 * (lower is better): measured `.../joint_states` first, commanded or target
 * streams last, so e.g. `/whole_body/joint_states` beats `/dex3/command`.
 */
export function measuredTopicRank(topicName: string): number {
  if (/(^|\/)joint_states$/u.test(topicName)) return 0;
  if (/(command|cmd|target|desired|action|goal)/iu.test(topicName)) return 2;
  return 1;
}

/** Default JointState topic for panels that drive a robot model. */
export function pickPrimaryJointStateTopic(topics: ReadonlyArray<{ name: string; type: string }>): string | undefined {
  return topics
    .filter((topic) => isJointStateSchema(topic.type))
    .sort((a, b) => measuredTopicRank(a.name) - measuredTopicRank(b.name))[0]?.name;
}

export function isRosImageSchema(type: string): boolean {
  if (
    matchesRosSchema(type, ROS_MSG_SENSOR_IMAGE) ||
    matchesRosSchema(type, ROS_MSG_SENSOR_COMPRESSED_IMAGE) ||
    matchesRosSchema(type, ROS_MSG_FOXGLOVE_COMPRESSED_VIDEO)
  ) {
    return true;
  }

  const normalized = normalizeRosSchemaName(type);
  if (normalized.includes('compressedimage')) {
    return true;
  }
  if (normalized.includes('compressedvideo')) {
    return true;
  }
  if (
    /\/image$/i.test(normalized) &&
    !normalized.includes('camerainfo') &&
    !normalized.includes('annotations')
  ) {
    return true;
  }
  return false;
}

export function isPoseStampedSchema(type: string): boolean {
  return matchesRosSchema(type, ROS_MSG_POSE_STAMPED);
}

export function isRawAudioSchema(type: string): boolean {
  return (
    matchesRosSchema(type, ROS_MSG_FOXGLOVE_RAW_AUDIO) ||
    matchesRosSchema(type, 'foxglove_msgs/RawAudio') ||
    matchesRosSchema(type, 'foxglove/RawAudio')
  );
}

export function isAudioCommonDataSchema(type: string): boolean {
  return matchesRosSchema(type, ROS_MSG_AUDIO_COMMON_AUDIO_DATA);
}

export function isAudioCommonDataStampedSchema(type: string): boolean {
  return matchesRosSchema(type, ROS_MSG_AUDIO_COMMON_AUDIO_DATA_STAMPED);
}

export function isAudioCommonInfoSchema(type: string): boolean {
  return matchesRosSchema(type, ROS_MSG_AUDIO_COMMON_AUDIO_INFO);
}

/** True if this topic type can be selected as the main stream in the Audio panel. */
export function isAudioPanelMainTopicSchema(type: string): boolean {
  return (
    isRawAudioSchema(type) ||
    isAudioCommonDataSchema(type) ||
    isAudioCommonDataStampedSchema(type)
  );
}
