import type { TopicInfo } from '@/core/types/ros';
import type { JointStateLike } from './jointStateMapping';
import type { JointMappingRule } from './recipe';
import type { UrdfAnalysis } from './urdfAnalysis';
import { topicExists } from './urdfAnalysis';

export type UrdfDebugDiagnostics = {
  hasJointStateTopic: boolean;
  hasExistingTf: boolean;
  hasExistingRobotDescription: boolean;
  urdfLoaded: boolean;
  robotName: string;
  linkCount: number;
  jointCount: number;
  meshReferenceCount: number;
  matchCoverage: string;
  matchedCount: number;
  movableJointCount: number;
  unmatchedInputJoints: string[];
  missingUrdfJoints: string[];
  generatedTfCount: number;
  meshLoadIssues: string[];
  playbackHealthy: boolean;
  lastError: string | null;
};

export function computeDiagnostics(args: {
  topics: ReadonlyArray<TopicInfo>;
  jointStateTopic: string;
  urdfAnalysis: UrdfAnalysis | null;
  rawJointState: JointStateLike | null;
  mappedJointState: JointStateLike | null;
  rules: JointMappingRule[];
  generatedTfCount: number;
  meshLoadIssues: string[];
  lastError: string | null;
}): UrdfDebugDiagnostics {
  const {
    topics,
    jointStateTopic,
    urdfAnalysis,
    rawJointState,
    mappedJointState,
    generatedTfCount,
    meshLoadIssues,
    lastError,
  } = args;

  const hasJointStateTopic =
    jointStateTopic.length > 0 && topics.some((topic) => topic.name === jointStateTopic);
  const hasExistingTf = topicExists(
    topics,
    (_name, type) => type.includes('TFMessage') || type.includes('tf2_msgs') || type.includes('tf/tfMessage'),
  );
  const hasExistingRobotDescription = topicExists(
    topics,
    (name) => name.includes('robot_description'),
  );

  const movable = urdfAnalysis?.movableJointNames ?? [];
  const mappedNames = new Set(mappedJointState?.name ?? []);
  const matchedCount = movable.filter((name) => mappedNames.has(name)).length;
  const rawNames = rawJointState?.name ?? [];
  const unmatchedInputJoints = rawNames.filter((name) => !mappedNames.has(name));
  const missingUrdfJoints = movable.filter((name) => !mappedNames.has(name));

  return {
    hasJointStateTopic,
    hasExistingTf,
    hasExistingRobotDescription,
    urdfLoaded: urdfAnalysis != null,
    robotName: urdfAnalysis?.robotName ?? '-',
    linkCount: urdfAnalysis?.linkCount ?? 0,
    jointCount: urdfAnalysis?.jointCount ?? 0,
    meshReferenceCount: urdfAnalysis?.meshReferences.length ?? 0,
    matchCoverage:
      movable.length > 0 ? `${matchedCount} / ${movable.length}` : mappedNames.size > 0 ? `${mappedNames.size}` : '0 / 0',
    matchedCount,
    movableJointCount: movable.length,
    unmatchedInputJoints,
    missingUrdfJoints,
    generatedTfCount,
    meshLoadIssues,
    playbackHealthy: hasJointStateTopic && mappedJointState != null && mappedJointState.name.length > 0,
    lastError,
  };
}
