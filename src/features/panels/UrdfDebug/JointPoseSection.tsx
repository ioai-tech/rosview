import React, { useMemo, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { Slider } from '@/shared/ui/slider';
import type { UrdfDebugConfig } from './defaults';
import { getDisplayedJointValue } from './jointPose';
import type { JointStateLike } from './jointStateMapping';
import {
  createDefaultManualPositions,
  filterJointStateTopics,
  pickJointStateTopic,
  type UrdfJointDescriptor,
} from './urdfAnalysis';

type JointPoseSectionProps = {
  descriptors: UrdfJointDescriptor[];
  config: UrdfDebugConfig;
  setConfig: (next: UrdfDebugConfig | ((prev: UrdfDebugConfig) => UrdfDebugConfig)) => void;
  topics: ReadonlyArray<{ name: string; type: string }>;
  jointStateTopic: string;
  liveJointState: JointStateLike | null;
  formatMessage: IntlShape['formatMessage'];
};

const UNSUPPORTED_TYPES = new Set(['planar', 'floating']);

function jointTypeLabel(
  jointType: UrdfJointDescriptor['jointType'],
  formatMessage: IntlShape['formatMessage'],
): string {
  const id = `urdfDebug.jointType.${jointType}`;
  return formatMessage({ id, defaultMessage: jointType });
}

const JointSliderRow: React.FC<{
  descriptor: UrdfJointDescriptor;
  value: number;
  disabled: boolean;
  formatMessage: IntlShape['formatMessage'];
  onChange: (value: number) => void;
}> = ({ descriptor, value, disabled, formatMessage, onChange }) => {
  const unsupported = UNSUPPORTED_TYPES.has(descriptor.jointType);

  return (
    <div className="space-y-1 py-1 border-b border-border/50 last:border-b-0">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-[10px] font-mono truncate" title={descriptor.name}>
          {descriptor.name}
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
          {jointTypeLabel(descriptor.jointType, formatMessage)}
        </span>
      </div>
      {descriptor.sliderEnabled ? (
        <div className="flex items-center gap-2">
          <Slider
            className="flex-1"
            min={descriptor.lower}
            max={descriptor.upper}
            step={descriptor.step > 0 ? descriptor.step : 0.01}
            value={value}
            disabled={disabled}
            onChange={onChange}
          />
          <span className="text-[10px] font-mono tabular-nums w-20 text-right shrink-0">
            {value.toFixed(3)} {descriptor.valueUnit}
          </span>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground italic">
          {unsupported
            ? formatMessage({ id: 'urdfDebug.joints.manualUnsupported' })
            : formatMessage({ id: 'urdfDebug.joints.fixedJoint' })}
        </p>
      )}
    </div>
  );
};

export const JointPoseSection: React.FC<JointPoseSectionProps> = ({
  descriptors,
  config,
  setConfig,
  topics,
  jointStateTopic,
  liveJointState,
  formatMessage,
}) => {
  const [filter, setFilter] = useState('');

  const jointStateTopics = useMemo(() => filterJointStateTopics(topics), [topics]);

  const selectedJointStateTopic = useMemo(() => {
    if (jointStateTopics.some((topic) => topic.name === config.jointStateTopic)) {
      return config.jointStateTopic;
    }
    return jointStateTopic;
  }, [config.jointStateTopic, jointStateTopic, jointStateTopics]);

  const filteredDescriptors = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return descriptors;
    return descriptors.filter((d) => d.name.toLowerCase().includes(query));
  }, [descriptors, filter]);

  const handleJointChange = (jointName: string, value: number) => {
    setConfig((prev) => ({
      ...prev,
      manualJointPositions: { ...prev.manualJointPositions, [jointName]: value },
    }));
  };

  const handleResetAll = () => {
    setConfig((prev) => ({
      ...prev,
      manualJointPositions: createDefaultManualPositions(descriptors),
    }));
  };

  const handleFollowLiveChange = (followLive: boolean) => {
    setConfig((prev) => {
      if (!followLive) {
        return { ...prev, followLiveJointState: false };
      }
      const resolved = pickJointStateTopic(topics, prev.jointStateTopic);
      return {
        ...prev,
        followLiveJointState: true,
        jointStateTopic: resolved || prev.jointStateTopic,
      };
    });
  };

  if (descriptors.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground italic">
        {formatMessage({ id: 'urdfDebug.joints.uploadUrdfHint' })}
      </p>
    );
  }

  const slidersDisabled = config.followLiveJointState;
  const followLiveActive = config.followLiveJointState;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={config.followLiveJointState}
            onChange={(event) => handleFollowLiveChange(event.target.checked)}
          />
          {formatMessage({ id: 'urdfDebug.joints.followLive' })}
        </label>
        <select
          className="flex-1 min-w-[140px] text-xs border rounded px-2 py-1 bg-background disabled:opacity-50"
          value={selectedJointStateTopic}
          disabled={!followLiveActive || jointStateTopics.length === 0}
          onChange={(event) =>
            setConfig((prev) => ({ ...prev, jointStateTopic: event.target.value }))
          }
        >
          <option value="">{formatMessage({ id: 'urdfDebug.selectJointStateTopic' })}</option>
          {jointStateTopics.map((topic) => (
            <option key={topic.name} value={topic.name}>
              {topic.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="text-[10px] px-2 py-1 rounded border bg-muted hover:bg-muted/80 disabled:opacity-50"
          disabled={slidersDisabled}
          onClick={handleResetAll}
        >
          {formatMessage({ id: 'urdfDebug.joints.resetAll' })}
        </button>
      </div>

      {followLiveActive && jointStateTopics.length === 0 && (
        <p className="text-[10px] text-amber-600">
          {formatMessage({ id: 'urdfDebug.joints.noJointStateTopics' })}
        </p>
      )}
      {followLiveActive && jointStateTopics.length > 0 && !selectedJointStateTopic && (
        <p className="text-[10px] text-muted-foreground">
          {formatMessage({ id: 'urdfDebug.joints.selectJointStateTopicHint' })}
        </p>
      )}
      {followLiveActive && selectedJointStateTopic && !liveJointState && (
        <p className="text-[10px] text-muted-foreground">
          {formatMessage(
            { id: 'urdfDebug.joints.waitingForJointState' },
            { topic: selectedJointStateTopic },
          )}
        </p>
      )}

      <input
        type="search"
        className="w-full text-xs border rounded px-2 py-1 bg-background"
        placeholder={formatMessage({ id: 'urdfDebug.joints.filter' })}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />

      <div className="max-h-64 overflow-y-auto space-y-0 pr-1">
        {filteredDescriptors.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">
            {formatMessage({ id: 'urdfDebug.joints.noMatch' })}
          </p>
        ) : (
          filteredDescriptors.map((descriptor) => {
            const value = getDisplayedJointValue(
              descriptor,
              config.manualJointPositions,
              liveJointState,
              config.followLiveJointState,
            );
            return (
              <JointSliderRow
                key={descriptor.name}
                descriptor={descriptor}
                value={value}
                disabled={slidersDisabled || !descriptor.sliderEnabled}
                formatMessage={formatMessage}
                onChange={(next) => handleJointChange(descriptor.name, next)}
              />
            );
          })
        )}
      </div>
    </div>
  );
};
