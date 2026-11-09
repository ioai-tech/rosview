/**
 * Layout of the IO-AI whole-body teleop recorder (`ioai.wbc.*` MCAP profile),
 * e.g. Unitree G1 + Dex3 hands. Each `whole_body.frame` JSON message bundles
 * every camera (base64 JPEG), the robot state and the teleop action for one
 * sample; the source splits it into standard ROS topics.
 */

import type { MessageDefinition } from '@foxglove/message-definition';
import type { RosDatatypes } from '@/core/types/ros';
import { buildHdf5DatatypesMap } from '../hdf5/schemas';

export const WHOLE_BODY_FRAME_SCHEMA = 'whole_body.frame';

/**
 * `states.robot_q_current` is a MuJoCo-style qpos: floating base
 * `[x, y, z, qw, qx, qy, qz]` followed by the 29 G1 body joints in Unitree
 * motor order. Names match the official G1 29-DoF URDF.
 */
export const FLOATING_BASE_DOF = 7;
export const G1_29DOF_JOINT_NAMES: readonly string[] = [
  'left_hip_pitch_joint',
  'left_hip_roll_joint',
  'left_hip_yaw_joint',
  'left_knee_joint',
  'left_ankle_pitch_joint',
  'left_ankle_roll_joint',
  'right_hip_pitch_joint',
  'right_hip_roll_joint',
  'right_hip_yaw_joint',
  'right_knee_joint',
  'right_ankle_pitch_joint',
  'right_ankle_roll_joint',
  'waist_yaw_joint',
  'waist_roll_joint',
  'waist_pitch_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_roll_joint',
  'left_wrist_pitch_joint',
  'left_wrist_yaw_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_roll_joint',
  'right_wrist_pitch_joint',
  'right_wrist_yaw_joint',
];

const COMPRESSED_IMAGE_DEF: MessageDefinition = {
  name: 'sensor_msgs/msg/CompressedImage',
  definitions: [
    { name: 'header', type: 'std_msgs/msg/Header', isComplex: true },
    { name: 'format', type: 'string' },
    { name: 'data', type: 'uint8', isArray: true },
  ],
};

export function buildWholeBodyDatatypes(): RosDatatypes {
  return {
    ...buildHdf5DatatypesMap(),
    [COMPRESSED_IMAGE_DEF.name!]: COMPRESSED_IMAGE_DEF,
  };
}
