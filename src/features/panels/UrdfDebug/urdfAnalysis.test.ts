/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import {
  extractUrdfJointDescriptors,
  extractUrdfMimicJoints,
  filterJointStateTopics,
  isJointStateTopicType,
  pickJointStateTopic,
} from './urdfAnalysis';

describe('extractUrdfJointDescriptors', () => {
  it('parses revolute limits and step granularity', () => {
    const urdf = `
      <robot name="test">
        <joint name="j1" type="revolute">
          <parent link="a"/><child link="b"/>
          <limit lower="-1.0" upper="1.0"/>
        </joint>
      </robot>`;
    const joints = extractUrdfJointDescriptors(urdf);
    expect(joints).toHaveLength(1);
    expect(joints[0].name).toBe('j1');
    expect(joints[0].jointType).toBe('revolute');
    expect(joints[0].lower).toBe(-1);
    expect(joints[0].upper).toBe(1);
    expect(joints[0].step).toBeCloseTo(0.02, 5);
    expect(joints[0].sliderEnabled).toBe(true);
  });

  it('uses default range for continuous joints', () => {
    const urdf = `
      <robot name="test">
        <joint name="wheel" type="continuous">
          <parent link="a"/><child link="b"/>
        </joint>
      </robot>`;
    const joints = extractUrdfJointDescriptors(urdf);
    expect(joints[0].sliderEnabled).toBe(true);
    expect(joints[0].lower).toBeCloseTo(-Math.PI, 5);
    expect(joints[0].upper).toBeCloseTo(Math.PI, 5);
  });

  it('disables slider for fixed joints', () => {
    const urdf = `
      <robot name="test">
        <joint name="base" type="fixed">
          <parent link="a"/><child link="b"/>
        </joint>
      </robot>`;
    const joints = extractUrdfJointDescriptors(urdf);
    expect(joints[0].sliderEnabled).toBe(false);
  });
});

describe('extractUrdfMimicJoints', () => {
  it('parses mimic tags from joint blocks', () => {
    const urdf = `
      <robot name="test">
        <joint name="drive_joint" type="revolute"><parent link="a"/><child link="b"/></joint>
        <joint name="left_finger_joint" type="revolute">
          <parent link="b"/><child link="c"/>
          <mimic joint="drive_joint" multiplier="1" offset="0"/>
        </joint>
      </robot>`;
    const mimics = extractUrdfMimicJoints(urdf);
    expect(mimics).toEqual([
      { jointName: 'left_finger_joint', sourceJoint: 'drive_joint', multiplier: 1, offset: 0 },
    ]);
  });
});

describe('joint state topic helpers', () => {
  const topics = [
    { name: '/camera/image', type: 'sensor_msgs/msg/Image' },
    { name: '/joint_states', type: 'sensor_msgs/msg/JointState' },
    { name: '/legacy_js', type: 'sensor_msgs/JointState' },
    { name: '/not_really_joint_states', type: 'sensor_msgs/msg/Image' },
  ];

  it('isJointStateTopicType matches JointState schemas only', () => {
    expect(isJointStateTopicType('sensor_msgs/msg/JointState')).toBe(true);
    expect(isJointStateTopicType('sensor_msgs/JointState')).toBe(true);
    expect(isJointStateTopicType('sensor_msgs/msg/Image')).toBe(false);
  });

  it('filterJointStateTopics excludes non-JointState topics', () => {
    expect(filterJointStateTopics(topics).map((t) => t.name)).toEqual([
      '/joint_states',
      '/legacy_js',
    ]);
  });

  it('pickJointStateTopic ignores preferred non-JointState topic', () => {
    expect(pickJointStateTopic(topics, '/camera/image')).toBe('/joint_states');
  });

  it('pickJointStateTopic prefers valid saved JointState topic', () => {
    expect(pickJointStateTopic(topics, '/legacy_js')).toBe('/legacy_js');
  });

  it('pickJointStateTopic does not match joint_states suffix on wrong type', () => {
    expect(pickJointStateTopic([topics[0], topics[3]])).toBe('');
  });
});
