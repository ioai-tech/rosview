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
import { classifyCameraSide } from '@/features/layout/autoLayout/planRosImageGrid';

describe('buildDefaultRosFoxgloveLayoutData', () => {
  it('emits Foxglove column: color row, depth row, then Pose+3D row; decodes to eight panels', () => {
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

    const data = buildDefaultRosFoxgloveLayoutData(topics);
    expect(data.layout).toBeDefined();
    const layoutRoot = data.layout as FoxgloveMosaicNode;
    const ids = collectMosaicPanelIds(layoutRoot);
    expect(ids).toHaveLength(8);

    const imported = importFoxgloveLayout(data, { unavailableComponent: 'Unavailable' });
    expect(imported.restored).toBe(8);
    expect(imported.dockviewState?.panels).toBeDefined();
    expect(Object.keys(imported.panelStates)).toHaveLength(8);

    const imageSnapshots = Object.values(imported.panelStates).filter((s) => s.type === 'Image');
    expect(imageSnapshots).toHaveLength(6);
    const poseSnapshots = Object.values(imported.panelStates).filter((s) => s.type === 'Pose');
    expect(poseSnapshots).toHaveLength(1);
    const threeDSnapshots = Object.values(imported.panelStates).filter((s) => s.type === '3D');
    expect(threeDSnapshots).toHaveLength(1);
    const poseConfig = poseSnapshots[0]?.config as { topics?: Array<{ topic: string }> };
    expect(poseConfig.topics?.map((entry) => entry.topic)).toEqual(['/io/pose/left', '/io/pose/right']);
    for (const s of imageSnapshots) {
      const topic = (s.config as { topic: string }).topic;
      expect(classifyCameraSide(topic)).not.toBe('other');
    }

    const root = data.layout;
    expect(typeof root).toBe('object');
    if (typeof root === 'object' && root !== null && 'direction' in root) {
      expect(root.direction).toBe('column');
      expect(root.splitPercentage).toBeCloseTo(100 / 3, 5);
      const colorRow = root.first;
      expect(typeof colorRow).toBe('object');
      if (typeof colorRow === 'object' && colorRow !== null && 'direction' in colorRow) {
        expect(colorRow.direction).toBe('row');
        expect(colorRow.splitPercentage).toBeCloseTo(100 / 3, 5);
      }
    }

    const findPose3DRow = (node: FoxgloveMosaicNode): FoxgloveMosaicSplit | null => {
      if (typeof node === 'string') {
        return null;
      }
      if (
        node.direction === 'row' &&
        typeof node.first === 'string' &&
        typeof node.second === 'string'
      ) {
        const a = getPanelTypeFromId(node.first);
        const b = getPanelTypeFromId(node.second);
        if ((a === 'Pose' && b === '3D') || (a === '3D' && b === 'Pose')) {
          return node;
        }
      }
      const left = findPose3DRow(node.first);
      if (left) {
        return left;
      }
      return findPose3DRow(node.second);
    };
    const pose3d = findPose3DRow(layoutRoot);
    expect(pose3d).not.toBeNull();
    const pose3dRow = pose3d!;
    expect(pose3dRow.direction).toBe('row');
    expect(typeof pose3dRow.first).toBe('string');
    expect(typeof pose3dRow.second).toBe('string');
    expect(getPanelTypeFromId(pose3dRow.first as string)).toBe('Pose');
    expect(getPanelTypeFromId(pose3dRow.second as string)).toBe('3D');
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
  });

  it('builds two image rows for six CompressedVideo streams and binds one scene mesh topic', () => {
    const topics: TopicInfo[] = [
      { name: '/head/color/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/head/depth/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/left/color/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/left/depth/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/right/color/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/right/depth/image', type: 'foxglove_msgs/msg/CompressedVideo [ros2msg]' },
      { name: '/robot0/perception/mano/scene', type: 'foxglove.SceneUpdate' },
    ];
    const data = buildDefaultRosFoxgloveLayoutData(topics);
    const ids = collectMosaicPanelIds(data.layout);
    const panelTypes = ids.map((id) => getPanelTypeFromId(id));
    expect(panelTypes.filter((type) => type === 'Image')).toHaveLength(6);
    expect(panelTypes.filter((type) => type === '3D')).toHaveLength(0);
    expect(panelTypes.filter((type) => type === 'RawMessages')).toHaveLength(0);

    const imageTopics = Object.values(data.configById)
      .map((config) => (config as { topic?: string }).topic)
      .filter((topic): topic is string => Boolean(topic))
      .sort();
    expect(imageTopics).toEqual([
      '/head/color/image',
      '/head/depth/image',
      '/left/color/image',
      '/left/depth/image',
      '/right/color/image',
      '/right/depth/image',
    ]);

    const imageConfigs = Object.values(data.configById) as Array<{
      topic?: string;
      meshTopic?: string;
      meshVisible?: boolean;
    }>;
    expect(imageConfigs).toHaveLength(6);
    expect(imageConfigs.every((config) => config.meshTopic === '/robot0/perception/mano/scene')).toBe(
      true,
    );
    expect(imageConfigs.every((config) => config.meshVisible === true)).toBe(true);
  });

  it('BVH-only dataset: single 3D panel only; dockview root still wraps to branch for fromJSON', () => {
    const topics: TopicInfo[] = [
      { name: '/bvh/skeleton', type: 'embodiflow_msgs/msg/BvhSkeletonFrame' },
    ];
    const data = buildDefaultRosFoxgloveLayoutData(topics);
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

  it('lays out six NuScenes protobuf CompressedImage streams without RawMessages fallback', () => {
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
    expect(panelTypes.filter((type) => type === 'RawMessages')).toHaveLength(0);

    const imageTopics = Object.values(data.configById)
      .map((config) => (config as { topic?: string }).topic)
      .filter((topic): topic is string => Boolean(topic))
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
});
