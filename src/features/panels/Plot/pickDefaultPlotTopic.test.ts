import { describe, expect, it } from 'vitest';
import { pickDefaultPlotTopic } from './pickDefaultPlotTopic';

describe('pickDefaultPlotTopic', () => {
  it('prefers measured joint states over alphabetically earlier command topics', () => {
    expect(
      pickDefaultPlotTopic([
        { name: '/dex3/command', type: 'sensor_msgs/msg/JointState' },
        { name: '/whole_body/joint_states', type: 'sensor_msgs/msg/JointState' },
        { name: '/whole_body/colors/color_0', type: 'sensor_msgs/msg/CompressedImage' },
      ]),
    ).toBe('/whole_body/joint_states');
  });

  it('returns an empty string when nothing is plottable', () => {
    expect(pickDefaultPlotTopic([{ name: '/cam', type: 'sensor_msgs/msg/CompressedImage' }])).toBe('');
  });
});
