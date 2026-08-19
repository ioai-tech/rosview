import { describe, expect, it } from 'vitest';
import { extractPrimaryTopicFromConfig } from './extractPrimaryTopicFromConfig';

describe('extractPrimaryTopicFromConfig', () => {
  it('reads a top-level topic used by Image/Audio/Raw/JointStatePlot', () => {
    expect(extractPrimaryTopicFromConfig({ topic: '/joint_command' })).toBe('/joint_command');
  });

  it('ignores blank top-level topics', () => {
    expect(extractPrimaryTopicFromConfig({ topic: '   ' })).toBeUndefined();
    expect(extractPrimaryTopicFromConfig({ topic: '' })).toBeUndefined();
    expect(extractPrimaryTopicFromConfig(undefined)).toBeUndefined();
    expect(extractPrimaryTopicFromConfig(null)).toBeUndefined();
  });

  it('reads the first non-empty Plot series topic', () => {
    expect(
      extractPrimaryTopicFromConfig({
        series: [{ topic: '' }, { topic: '/imu' }, { topic: '/later' }],
      }),
    ).toBe('/imu');
  });

  it('reads the first enabled 3D topicSetting and ignores urdf.topic', () => {
    expect(
      extractPrimaryTopicFromConfig({
        urdf: { topic: '/robot_description' },
        topicSettings: [
          { topic: '/disabled_scan', enabled: false },
          { topic: '/points', enabled: true },
        ],
      }),
    ).toBe('/points');
  });

  it('does not fall back to urdf.topic when 3D has no enabled topicSettings', () => {
    expect(
      extractPrimaryTopicFromConfig({
        urdf: { topic: '/robot_description' },
        topicSettings: [{ topic: '/cloud', enabled: false }],
      }),
    ).toBeUndefined();
  });

  it('reads Pose topics[].topic', () => {
    expect(
      extractPrimaryTopicFromConfig({
        topics: [{ topic: '', enabled: true }, { topic: '/odom' }],
      }),
    ).toBe('/odom');
  });

  it('reads Align topics[] strings', () => {
    expect(extractPrimaryTopicFromConfig({ topics: ['/cam_left', '/cam_right'] })).toBe('/cam_left');
  });
});
