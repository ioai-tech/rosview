import React, { lazy, useCallback, useEffect, useState } from 'react';
import { usePanelTopicReadError } from '@/features/panels/framework/panelReadErrors';
import { ChevronDown, Check } from 'lucide-react';
import { useIntl } from 'react-intl';
import { PanelSuspense } from '../framework/panelSuspense';
import type { PanelDefinition } from '../framework/types';
import {
  collectExtras,
  FOXGLOVE_PANEL_TITLE_KEY,
  mergeWithExtras,
  type FoxgloveAdapterDecoded,
  type FoxgloveAdapterState,
  type FoxgloveConfig,
  type PanelFoxgloveAdapter,
} from '../framework/foxgloveAdapter';
import { TopicQuickPicker } from '../framework/TopicQuickPicker';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { messageBus } from '@/core/pipeline/messageBus';
import { useTopicSeq } from '@/core/pipeline/useMessageBus';
import { isJointStateSchema } from '@/shared/ros/rosMessageTypes';
import type { Player } from '@/core/types/player';
import {
  defaultJointStatePlotConfig,
  JOINT_FIELDS,
  type JointField,
  type JointStatePlotConfig,
} from './defaults';
import { parseJointStatePlotConfig } from './schema';
import { JointStatePlotPanelSettings } from './JointStatePlotPanelSettings';

const JointStatePlotComponent = lazy(async () => {
  const m = await import('./JointStatePlotPanel');
  return { default: m.JointStatePlotComponent };
});

// ---------- Joint name utilities ----------

function readJointNamesFromTopic(topic: string): string[] {
  const last = messageBus.getLastMessage(topic);
  if (!last?.message || typeof last.message !== 'object') return [];
  const msg = last.message as Record<string, unknown>;
  const names = msg.name;
  if (!names || typeof names !== 'object' || !('length' in names)) return [];
  const len = (names as ArrayLike<unknown>).length;
  if (typeof len !== 'number' || len === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const n = (names as ArrayLike<unknown>)[i];
    out.push(typeof n === 'string' ? n : `joint_${i}`);
  }
  return out;
}

// ---------- Field toggle button ----------

interface FieldToggleProps {
  current: JointField;
  onChange: (f: JointField) => void;
}

/** Derived from `JOINT_FIELDS` so adding a new field only requires updating defaults.ts. */
const FIELDS: readonly JointField[] = JOINT_FIELDS;

const FieldToggle: React.FC<FieldToggleProps> = ({ current, onChange }) => {
  const { formatMessage } = useIntl();
  const labels: Record<JointField, string> = {
    position: formatMessage({ id: 'panels.jointStatePlot.toolbar.field.position' }),
    velocity: formatMessage({ id: 'panels.jointStatePlot.toolbar.field.velocity' }),
    effort: formatMessage({ id: 'panels.jointStatePlot.toolbar.field.effort' }),
  };
  return (
    <div className="flex shrink-0 rounded border border-border overflow-hidden">
      {FIELDS.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={[
            'px-1.5 py-0.5 text-[10px] font-mono transition-colors',
            f === current
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:bg-accent',
            f !== 'position' ? 'border-l border-border' : '',
          ].join(' ')}
        >
          {labels[f]}
        </button>
      ))}
    </div>
  );
};

// ---------- Joint filter popover ----------

interface JointFilterProps {
  knownJoints: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

const JointFilter: React.FC<JointFilterProps> = ({ knownJoints, selected, onChange }) => {
  const { formatMessage } = useIntl();
  const allSelected = selected.length === 0;
  const label =
    allSelected || selected.length === knownJoints.length
      ? formatMessage({ id: 'panels.jointStatePlot.filter.allJoints' })
      : formatMessage(
          { id: 'panels.jointStatePlot.filter.partial' },
          { current: selected.length, total: knownJoints.length },
        );

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      const next = selected.filter((n) => n !== name);
      onChange(next.length === knownJoints.length ? [] : next);
    } else {
      const next = [...selected, name];
      onChange(next.length === knownJoints.length ? [] : next);
    }
  };

  if (knownJoints.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-[22px] shrink-0 items-center gap-1 rounded border border-border bg-background px-1.5 text-[10px] hover:bg-accent"
        >
          <span className="font-mono">{label}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange([])}
            className="flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-accent"
          >
            <span className={`flex h-3 w-3 items-center justify-center rounded-sm border ${allSelected ? 'border-primary bg-primary' : 'border-input'}`}>
              {allSelected && <Check className="h-2 w-2 text-primary-foreground" />}
            </span>
            <span>{formatMessage({ id: 'panels.jointStatePlot.filter.allJoints' })}</span>
          </button>
          {knownJoints.map((name) => {
            const checked = !allSelected && selected.includes(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                className="flex items-center gap-2 rounded px-2 py-1 text-[10px] hover:bg-accent"
              >
                <span className={`flex h-3 w-3 items-center justify-center rounded-sm border ${checked ? 'border-primary bg-primary' : 'border-input'}`}>
                  {checked && <Check className="h-2 w-2 text-primary-foreground" />}
                </span>
                <span className="truncate font-mono">{name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};

// ---------- Main panel wrapper ----------

interface JointStatePanelProps {
  player: Player;
  panelId: string;
  config: JointStatePlotConfig;
  setConfig: (next: JointStatePlotConfig | ((prev: JointStatePlotConfig) => JointStatePlotConfig)) => void;
}

const JointStatePanelWrapper: React.FC<JointStatePanelProps> = ({
  player,
  panelId,
  config,
  setConfig,
}) => {
  const { formatMessage } = useIntl();
  // Track available joint names from the latest message on the current topic
  const topicSeq = useTopicSeq(config.topic);
  const readError = usePanelTopicReadError(config.topic);
  const [knownJoints, setKnownJoints] = useState<string[]>(() =>
    readJointNamesFromTopic(config.topic),
  );

  // Reset immediately when the topic changes (including to empty)
  useEffect(() => {
    setKnownJoints(readJointNamesFromTopic(config.topic));
  }, [config.topic]);

  // Update as new messages arrive for the current topic
  useEffect(() => {
    const names = readJointNamesFromTopic(config.topic);
    if (names.length > 0) setKnownJoints(names);
  }, [config.topic, topicSeq]);

  const setField = useCallback(
    (field: JointField) => setConfig((prev) => ({ ...prev, field })),
    [setConfig],
  );
  const setTopic = useCallback(
    (topic: string) => setConfig((prev) => ({ ...prev, topic, selectedJoints: [] })),
    [setConfig],
  );
  const setSelectedJoints = useCallback(
    (selectedJoints: string[]) => setConfig((prev) => ({ ...prev, selectedJoints })),
    [setConfig],
  );

  const noTopic = !config.topic;
  const noData = !noTopic && knownJoints.length === 0;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted px-1.5 py-0.5 min-w-0">
        {/* Left: Topic picker */}
        <div className="min-w-0 flex-1 max-w-[200px]">
          <TopicQuickPicker
            value={config.topic}
            onChange={setTopic}
            topicTypeMatches={isJointStateSchema}
            placeholder="/joint_states"
            triggerClassName="h-[22px] text-[10px] px-1.5"
          />
        </div>
        {/* Spacer */}
        <div className="flex-1" />
        {/* Right: Field toggle + joint filter */}
        <FieldToggle current={config.field} onChange={setField} />
        <JointFilter
          knownJoints={knownJoints}
          selected={config.selectedJoints}
          onChange={setSelectedJoints}
        />
      </div>

      {/* Chart area */}
      {noTopic ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground px-4 text-center">
          {formatMessage({ id: 'panels.jointStatePlot.empty.selectTopic' })}
        </div>
      ) : noData ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground px-4 text-center">
          {/* The panel shell says why the topic could not be read. */}
          {readError ? null : formatMessage({ id: 'panels.jointStatePlot.empty.waitingData' })}
        </div>
      ) : (
        <PanelSuspense>
          <JointStatePlotComponent
            player={player}
            panelId={panelId}
            topic={config.topic}
            field={config.field}
            selectedJoints={config.selectedJoints}
            timestampMode={config.timestampMode}
            maxPointsPerJoint={config.maxPointsPerJoint}
          />
        </PanelSuspense>
      )}
    </div>
  );
};

// ---------- Panel Definition ----------

export const jointStatePlotDefinition: PanelDefinition<JointStatePlotConfig> = {
  type: 'JointStatePlot',
  hideFromPanelPicker: true,
  defaultTitle: 'JointState Plot',
  createDefaultConfig: defaultJointStatePlotConfig,
  configSchema: { version: 1, parse: parseJointStatePlotConfig },
  schemaSupport: { supportedSchemas: ['sensor_msgs/msg/JointState'] },
  render: ({ player, panelId, config, setConfig }) => (
    <JointStatePanelWrapper
      player={player}
      panelId={panelId}
      config={config}
      setConfig={setConfig}
    />
  ),
  renderSettings: (ctx) => <JointStatePlotPanelSettings {...ctx} />,
};

// ---------- Foxglove adapter (backward compat for Plot + Joints layouts) ----------

const KNOWN_KEYS_PLOT = ['topic', 'field', 'selectedJoints', 'timestampMode', 'maxPointsPerJoint', 'paths'] as const;
const KNOWN_KEYS_JOINTS = ['topic', 'topicPath', 'compact'] as const;

function fromPlotConfig(config: FoxgloveConfig): FoxgloveAdapterDecoded<JointStatePlotConfig> {
  // Try to extract topic from Foxglove Plot `paths` if present
  let topic = typeof config.topic === 'string' ? config.topic : '';
  if (!topic && Array.isArray(config.paths)) {
    for (const entry of config.paths) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).value === 'string') {
        const raw = (entry as Record<string, unknown>).value as string;
        if (raw.startsWith('/')) {
          const dot = raw.indexOf('.');
          topic = dot > 0 ? raw.slice(0, dot) : raw;
          break;
        }
      }
    }
  }
  const title = typeof config[FOXGLOVE_PANEL_TITLE_KEY] === 'string'
    ? (config[FOXGLOVE_PANEL_TITLE_KEY])
    : undefined;
  return {
    config: parseJointStatePlotConfig({ ...config, topic }),
    extras: collectExtras(config, KNOWN_KEYS_PLOT),
    title,
  };
}

function fromJointsConfig(config: FoxgloveConfig): FoxgloveAdapterDecoded<JointStatePlotConfig> {
  const topic = typeof config.topic === 'string'
    ? config.topic
    : typeof config.topicPath === 'string'
      ? config.topicPath
      : '';
  const title = typeof config[FOXGLOVE_PANEL_TITLE_KEY] === 'string'
    ? (config[FOXGLOVE_PANEL_TITLE_KEY])
    : undefined;
  return {
    config: parseJointStatePlotConfig({ topic }),
    extras: collectExtras(config, KNOWN_KEYS_JOINTS),
    title,
  };
}

function toConfig(state: FoxgloveAdapterState<JointStatePlotConfig>): FoxgloveConfig {
  const known: FoxgloveConfig = {
    topic: state.config.topic,
    field: state.config.field,
    selectedJoints: state.config.selectedJoints,
    timestampMode: state.config.timestampMode,
    maxPointsPerJoint: state.config.maxPointsPerJoint,
  };
  if (state.title && state.title.length > 0) {
    known[FOXGLOVE_PANEL_TITLE_KEY] = state.title;
  }
  return mergeWithExtras(state.extras, known);
}

/** Handles our native `JointStatePlot` type. */
export const jointStatePlotFoxgloveAdapter: PanelFoxgloveAdapter<JointStatePlotConfig> = {
  internalType: 'JointStatePlot',
  foxgloveTypes: ['JointStatePlot'],
  defaultFoxgloveType: 'JointStatePlot',
  fromConfig: fromPlotConfig,
  toConfig,
};

/** Maps old Foxglove `Plot` layouts to the new JointStatePlot panel. */
export const legacyPlotFoxgloveAdapter: PanelFoxgloveAdapter<JointStatePlotConfig> = {
  internalType: 'JointStatePlot',
  foxgloveTypes: ['Plot'],
  defaultFoxgloveType: 'Plot',
  fromConfig: fromPlotConfig,
  toConfig,
};

/** Maps old `Joints` layouts to the new JointStatePlot panel. */
export const legacyJointsFoxgloveAdapter: PanelFoxgloveAdapter<JointStatePlotConfig> = {
  internalType: 'JointStatePlot',
  foxgloveTypes: ['Joints'],
  defaultFoxgloveType: 'Joints',
  fromConfig: fromJointsConfig,
  toConfig,
};
