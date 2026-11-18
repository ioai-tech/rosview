import { describe, expect, it } from 'vitest';
import type { TopicInfo } from '@/core/types/ros';
import {
  collectMosaicPanelIds,
  importFoxgloveLayout,
  type FoxgloveMosaicDirection,
  type FoxgloveMosaicNode,
} from '@/core/preferences/foxgloveLayout';

/** Mosaic split node: two children + direction (panel ids as leaf strings). */
type FoxgloveMosaicSplit = {
  first: FoxgloveMosaicNode;
  second: FoxgloveMosaicNode;
  direction: FoxgloveMosaicDirection;
  splitPercentage?: number;
};
import { getPanelTypeFromId } from '@/features/panels/framework';
import { buildDefaultRosFoxgloveLayoutData } from '@/features/layout/autoLayout/applyDefaultRosDockLayout';

describe('buildDefaultRosFoxgloveLayoutData', () => {
  it('lays out six cameras as 3x2, then Pose + 3D + a Plot per JointState topic, then a thin Raw Messages strip', () => {
    const topics: TopicInfo[] = [
      { name: '/camera/left/color/a/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/left/depth/z/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/right/color/a/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/right/depth/z/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/top/color/a/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/top/depth/z/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/io/pose/left', type: 'geometry_msgs/msg/PoseStamped [ros2msg]' },
      { name: '/io/pose/right', type: 'geometry_msgs/msg/PoseStamped [jsonschema]' },
      { name: '/joint_states', type: 'sensor_msgs/msg/JointState' },
    ];

    const data = buildDefaultRosFoxgloveLayoutData(topics, { webgl: true });
    const root = data.layout as FoxgloveMosaicSplit;
    // Raw Messages is a thin strip under everything else.
    expect(root.direction).toBe('column');
    expect(root.splitPercentage).toBeGreaterThan(80);
    expect(getPanelTypeFromId(root.second as string)).toBe('RawMessages');

    const imported = importFoxgloveLayout(data, { unavailableComponent: 'Unavailable' });
    const byType = (type: string) => Object.values(imported.panelStates).filter((snap) => snap.type === type);
    expect(byType('Image')).toHaveLength(6);
    expect(byType('Pose')).toHaveLength(1);
    expect(byType('3D')).toHaveLength(1);
    expect(byType('Plot')).toHaveLength(1);
    expect(byType('RawMessages')).toHaveLength(1);
    const poseConfig = byType('Pose')[0]?.config as { topics?: Array<{ topic: string }> };
    expect(poseConfig.topics?.map((entry) => entry.topic)).toEqual(['/io/pose/left', '/io/pose/right']);

    // 3 x 2 camera grid: two rows of three, colour streams before depth.
    const main = root.first as FoxgloveMosaicSplit;
    const firstRow = main.first;
    const secondRow = (main.second as FoxgloveMosaicSplit).first;
    const rowTypes = (node: FoxgloveMosaicNode) => collectMosaicPanelIds(node).map((id) => getPanelTypeFromId(id));
    expect(rowTypes(firstRow)).toEqual(['Image', 'Image', 'Image']);
    expect(rowTypes(secondRow)).toEqual(['Image', 'Image', 'Image']);
    const imageTopics = (node: FoxgloveMosaicNode) =>
      collectMosaicPanelIds(node).map((id) => (data.configById[id] as { topic: string }).topic);
    expect(imageTopics(firstRow).every((topic) => topic.includes('/color/'))).toBe(true);
    expect(imageTopics(secondRow).every((topic) => topic.includes('/depth/'))).toBe(true);
  });

  it('dual-arm teleop rig with generic names: cameras, joint and IMU plots, 3D only with TF and WebGL', () => {
    const topics: TopicInfo[] = [
      { name: '/camera/head/image_raw/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/left_wrist/image_raw/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/right_wrist/image_raw/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/joint_states', type: 'sensor_msgs/msg/JointState' },
      { name: '/joint_cmd', type: 'sensor_msgs/msg/JointState' },
      { name: '/gripper/joint_states', type: 'sensor_msgs/msg/JointState' },
      { name: '/imu/data', type: 'sensor_msgs/msg/Imu' },
      { name: '/tf', type: 'tf2_msgs/msg/TFMessage' },
    ];
    const types = (data: ReturnType<typeof buildDefaultRosFoxgloveLayoutData>) =>
      collectMosaicPanelIds(data.layout).map((id) => getPanelTypeFromId(id));

    const withGl = buildDefaultRosFoxgloveLayoutData(topics, { webgl: true });
    expect(types(withGl).filter((t) => t === 'Image')).toHaveLength(3);
    expect(types(withGl).filter((t) => t === '3D')).toHaveLength(1);
    // joint_states, gripper/joint_states, joint_cmd + one IMU plot.
    expect(types(withGl).filter((t) => t === 'Plot')).toHaveLength(4);

    const plotConfigs = Object.entries(withGl.configById)
      .filter(([id]) => getPanelTypeFromId(id) === 'Plot')
      .map(([, config]) => config as { series: Array<{ topic: string; path: string }> });
    const joint = plotConfigs.find((c) => c.series[0].topic === '/joint_states');
    expect(joint?.series.map((entry) => entry.path)).toEqual(['position[:]']);
    const imu = plotConfigs.find((c) => c.series[0].topic === '/imu/data');
    expect(imu?.series.map((entry) => entry.path)).toEqual([
      'angular_velocity.x',
      'angular_velocity.y',
      'angular_velocity.z',
      'linear_acceleration.x',
      'linear_acceleration.y',
      'linear_acceleration.z',
    ]);

    const withoutGl = buildDefaultRosFoxgloveLayoutData(topics, { webgl: false });
    expect(types(withoutGl)).not.toContain('3D');
  });

  it('no 3D grid for joint states alone, even with WebGL', () => {
    const data = buildDefaultRosFoxgloveLayoutData(
      [
        { name: '/camera/front/image_raw/compressed', type: 'sensor_msgs/msg/CompressedImage' },
        { name: '/joint_states', type: 'sensor_msgs/msg/JointState' },
      ],
      { webgl: true },
    );
    const types = collectMosaicPanelIds(data.layout).map((id) => getPanelTypeFromId(id));
    expect(types).not.toContain('3D');
    expect(types).toContain('Plot');
  });

  it('omits 3D when only image topics are present', () => {
    const topics: TopicInfo[] = [
      { name: '/camera/left/color/a/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/right/color/a/compressed', type: 'sensor_msgs/msg/CompressedImage' },
      { name: '/camera/top/color/a/compressed', type: 'sensor_msgs/msg/CompressedImage' },
    ];
    const data = buildDefaultRosFoxgloveLayoutData(topics);
    const root = data.layout as FoxgloveMosaicNode;
    const ids = collectMosaicPanelIds(root);
    const panelTypes = ids.map((id) => getPanelTypeFromId(id));
    expect(panelTypes.filter((type) => type === 'Pose')).toHaveLength(0);
    expect(panelTypes.filter((type) => type === '3D')).toHaveLength(0);
    expect(panelTypes.filter((type) => type === 'Image')).toHaveLength(3);
    expect(panelTypes.filter((type) => type === 'RawMessages')).toHaveLength(1);
  });

  it('builds a 3x2 grid for six CompressedVideo streams without 3D', () => {
    const topics: TopicInfo[] = [
      { name: '/head/color/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/head/depth/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/left/color/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/left/depth/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/right/color/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/right/depth/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
    ];
    const data = buildDefaultRosFoxgloveLayoutData(topics);
    const ids = collectMosaicPanelIds(data.layout);
    const panelTypes = ids.map((id) => getPanelTypeFromId(id));
    expect(panelTypes.filter((type) => type === 'Image')).toHaveLength(6);
    expect(panelTypes.filter((type) => type === '3D')).toHaveLength(0);
    expect(panelTypes.filter((type) => type === 'RawMessages')).toHaveLength(1);

    const imageTopics = Object.entries(data.configById)
      .filter(([id]) => getPanelTypeFromId(id) === 'Image')
      .map(([, config]) => (config as { topic: string }).topic)
      .sort();
    expect(imageTopics).toEqual([
      '/head/color/image',
      '/head/depth/image',
      '/left/color/image',
      '/left/depth/image',
      '/right/color/image',
      '/right/depth/image',
    ]);
  });

  it('BVH-only dataset: single 3D panel only; dockview root still wraps to branch for fromJSON', () => {
    const topics: TopicInfo[] = [
      { name: '/bvh/skeleton', type: 'embodiflow_msgs/msg/BvhSkeletonFrame' },
    ];
    const data = buildDefaultRosFoxgloveLayoutData(topics, { webgl: true });
    const root = data.layout as FoxgloveMosaicNode;
    const ids = collectMosaicPanelIds(root);
    expect(ids).toHaveLength(1);
    expect(getPanelTypeFromId(ids[0])).toBe('3D');

    const imported = importFoxgloveLayout(data, { unavailableComponent: 'Unavailable' });
    expect(imported.restored).toBe(1);
    const rawSnapshots = Object.values(imported.panelStates).filter((s) => s.type === 'RawMessages');
    expect(rawSnapshots).toHaveLength(0);
    const unavailableSnapshots = Object.values(imported.panelStates).filter((s) => s.type === 'Unavailable');
    expect(unavailableSnapshots).toHaveLength(0);
    expect(imported.dockviewState?.grid.root.type).toBe('branch');
  });

  it('non-BVH single-stack layout still appends RawMessages when no panels are eligible', () => {
    const topics: TopicInfo[] = [{ name: '/scan', type: 'sensor_msgs/msg/LaserScan' }];
    const data = buildDefaultRosFoxgloveLayoutData(topics);
    const root = data.layout as FoxgloveMosaicNode;
    const ids = collectMosaicPanelIds(root);
    const panelTypes = ids.map((id) => getPanelTypeFromId(id));
    expect(panelTypes).not.toContain('3D');
    expect(panelTypes).toContain('RawMessages');

    const imported = importFoxgloveLayout(data, { unavailableComponent: 'Unavailable' });
    expect(imported.restored).toBe(1);
    const rawSnapshots = Object.values(imported.panelStates).filter((s) => s.type === 'RawMessages');
    expect(rawSnapshots).toHaveLength(1);
    expect((rawSnapshots[0]?.config as { topic?: string }).topic).toBe('/scan');
  });

  it('hdf5 dataset replaces 3D with RawMessages and auto-selects a default topic', () => {
    const topics: TopicInfo[] = [
      { name: '/observations/images/ext1', type: 'sensor_msgs/msg/Image' },
      { name: '/observations/images/ext2', type: 'sensor_msgs/msg/Image' },
      { name: '/observations/joint_states', type: 'sensor_msgs/msg/JointState' },
      { name: '/action', type: 'std_msgs/msg/Float32MultiArray' },
    ];
    const publishersByTopic = new Map<string, Set<string>>(
      topics.map((topic) => [topic.name, new Set<string>(['hdf5'])]),
    );

    const data = buildDefaultRosFoxgloveLayoutData(topics, { publishersByTopic });
    const ids = collectMosaicPanelIds(data.layout);
    const panelTypes = ids.map((id) => getPanelTypeFromId(id));
    expect(panelTypes).not.toContain('3D');
    expect(panelTypes).toContain('RawMessages');

    const imported = importFoxgloveLayout(data, { unavailableComponent: 'Unavailable' });
    const rawSnapshots = Object.values(imported.panelStates).filter((s) => s.type === 'RawMessages');
    expect(rawSnapshots).toHaveLength(1);
    expect((rawSnapshots[0]?.config as { topic?: string }).topic).toBe('/observations/joint_states');
  });

  it('lays out six NuScenes protobuf CompressedImage streams as a 3x2 grid', () => {
    const topics: TopicInfo[] = [
      { name: '/CAM_FRONT/image_rect_compressed', type: 'foxglove.CompressedImage' },
      { name: '/CAM_FRONT_LEFT/image_rect_compressed', type: 'foxglove.CompressedImage' },
      { name: '/CAM_FRONT_RIGHT/image_rect_compressed', type: 'foxglove.CompressedImage' },
      { name: '/CAM_BACK/image_rect_compressed', type: 'foxglove.CompressedImage' },
      { name: '/CAM_BACK_LEFT/image_rect_compressed', type: 'foxglove.CompressedImage' },
      { name: '/CAM_BACK_RIGHT/image_rect_compressed', type: 'foxglove.CompressedImage' },
      { name: '/imu', type: 'IMU' },
    ];

    const data = buildDefaultRosFoxgloveLayoutData(topics);
    const ids = collectMosaicPanelIds(data.layout);
    const panelTypes = ids.map((id) => getPanelTypeFromId(id));
    expect(panelTypes.filter((type) => type === 'Image')).toHaveLength(6);

    const imageTopics = Object.entries(data.configById)
      .filter(([id]) => getPanelTypeFromId(id) === 'Image')
      .map(([, config]) => (config as { topic: string }).topic)
      .sort();
    expect(imageTopics).toEqual([
      '/CAM_BACK/image_rect_compressed',
      '/CAM_BACK_LEFT/image_rect_compressed',
      '/CAM_BACK_RIGHT/image_rect_compressed',
      '/CAM_FRONT/image_rect_compressed',
      '/CAM_FRONT_LEFT/image_rect_compressed',
      '/CAM_FRONT_RIGHT/image_rect_compressed',
    ]);
  });

  it('teleop RGB-D recording: one camera row, then Plots for LowState and the hand, no 3D without TF or pose', () => {
    const topics: TopicInfo[] = [
      { name: '/record/camera/head/rgb', type: 'sensor_msgs/msg/Image' },
      { name: '/record/camera/head/depth', type: 'sensor_msgs/msg/Image' },
      { name: '/record/camera/head/rgb/camera_info', type: 'sensor_msgs/msg/CameraInfo' },
      { name: '/record/human/body', type: 'std_msgs/msg/ByteMultiArray' },
      { name: '/record/revo2_hand/hand_left/joint_states', type: 'sensor_msgs/msg/JointState' },
      { name: '/record/robot/state', type: 'booster_interface/msg/LowState' },
      { name: '/record/robot/command', type: 'booster_interface/msg/LowCmd' },
    ];
    const root = buildDefaultRosFoxgloveLayoutData(topics, { webgl: true }).layout as FoxgloveMosaicSplit;
    expect(root.direction).toBe('column');

    const rowTypes = (node: FoxgloveMosaicNode) =>
      collectMosaicPanelIds(node).map((id) => getPanelTypeFromId(id));
    const main = root.first as FoxgloveMosaicSplit;
    expect(main.direction).toBe('column');
    expect(rowTypes(main.first)).toEqual(['Image', 'Image']);
    expect(rowTypes(main.second)).toEqual(['Plot', 'Plot']);
    expect(rowTypes(root.second)).toEqual(['RawMessages']);
  });
});
