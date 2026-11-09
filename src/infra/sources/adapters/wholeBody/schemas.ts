/**
 * Layout of the IO-AI whole-body teleop recorder (`ioai.wbc.*` MCAP profile),
 * e.g. Unitree G1 + Dex3 hands. Each `whole_body.frame` JSON message bundles
 * every camera (base64 JPEG), the robot state and the teleop action for one
 * sample; the source splits it into standard ROS topics.
 */

import type { MessageDefinition } from '@foxglove/message-definition';
import type { RosDatatypes } from '@/core/types/ros';
import { buildHdf5DatatypesMap } from '../../hdf5/schemas';

export const WHOLE_BODY_FRAME_SCHEMA = 'whole_body.frame';
export const WHOLE_BODY_META_SCHEMA = 'whole_body.meta';
export const DEX3_FRAME_SCHEMA = 'unitree.dex3.frame';

/** Dex3 hand joints, left hand then right hand, as published by the recorder. */
export const DEX3_JOINT_NAMES: readonly string[] = ['left', 'right'].flatMap((side) =>
  ['thumb_0', 'thumb_1', 'thumb_2', 'middle_0', 'middle_1', 'index_0', 'index_1'].map(
    (joint) => `${side}_hand_${joint}_joint`,
  ),
);

/**
 * `states.robot_q_current` is a MuJoCo-style qpos: floating base
 * `[x, y, z, qw, qx, qy, qz]` followed by the 29 G1 body joints in Unitree
 * motor order. Names match the official G1 29-DoF URDF.
 */
export const FLOATING_BASE_DOF = 7;
export { G1_29DOF_JOINT_NAMES } from '@/shared/robots/unitreeG1';

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
