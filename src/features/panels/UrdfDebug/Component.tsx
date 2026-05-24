import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Player } from '@/core/types/player';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import { messageBus } from '@/core/pipeline/messageBus';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import { FileDropZone } from '@/shared/ui/file-drop-zone';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/ui/resizable';
import type { UrdfDebugConfig } from './defaults';
import {
  MAX_SETTINGS_PANEL_PERCENT,
  MIN_SETTINGS_PANEL_PERCENT,
} from './defaults';
import { UrdfDebugPreview } from './Preview';
import { MeshBaseSection } from './MeshBaseSection';
import { JointPoseSection } from './JointPoseSection';
import { pickUrdfFile } from './fileDropUtils';
import { extractPackageNameFromUrdf } from './meshBaseStatus';
import type { JointStateLike } from './jointStateMapping';
import { buildPreviewJointState } from './jointPose';
import {
  buildLocalMeshUrlMap,
  createMeshResolver,
  revokeMeshUrlMap,
} from './meshResolver';
import { configToRecipe, downloadJson, downloadText } from './recipe';
import {
  analyzeUrdfText,
  createDefaultManualPositions,
  extractUrdfJointDescriptors,
  pickJointStateTopic,
  prepareUrdfForPreview,
} from './urdfAnalysis';
import { buildCliCommands, generatePythonScript, generateTypeScriptScript } from './scriptTemplates';

export interface UrdfDebugPanelProps {
  player: Player;
  panelId: string;
  config: UrdfDebugConfig;
  setConfig: (next: UrdfDebugConfig | ((prev: UrdfDebugConfig) => UrdfDebugConfig)) => void;
}

function readJointStateFromTopic(topic: string): JointStateLike | null {
  const last = messageBus.getLastMessage(topic);
  if (!last?.message || typeof last.message !== 'object') return null;
  const msg = last.message as Record<string, unknown>;
  const name = msg.name;
  const position = msg.position;
  if (!Array.isArray(name) || !Array.isArray(position)) return null;
  if (!name.every((entry) => typeof entry === 'string')) return null;
  return {
    name,
    position: Array.from(position as ArrayLike<number>, (v) => Number(v) || 0),
  };
}

function clampSettingsPanelPercent(value: number): number {
  return Math.min(MAX_SETTINGS_PANEL_PERCENT, Math.max(MIN_SETTINGS_PANEL_PERCENT, value));
}

export const UrdfDebugPanel: React.FC<UrdfDebugPanelProps> = ({
  player,
  panelId,
  config,
  setConfig,
}) => {
  const { formatMessage } = useIntl();
  const topics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const [meshFiles, setMeshFiles] = useState<File[]>([]);
  const [localMeshUrls, setLocalMeshUrls] = useState<Map<string, string>>(() => new Map());
  const [lastError, setLastError] = useState<string | null>(null);
  const [urdfUploadError, setUrdfUploadError] = useState<string | null>(null);
  const [rawJointState, setRawJointState] = useState<JointStateLike | null>(null);
  const meshUrlMapRef = useRef<Map<string, string>>(new Map());
  const layoutWriteTimerRef = useRef<number | null>(null);

  const settingsPanelPercent = clampSettingsPanelPercent(config.settingsPanelPercent);

  const jointStateTopic = useMemo(() => {
    return pickJointStateTopic(topics, config.jointStateTopic);
  }, [topics, config.jointStateTopic]);

  useEffect(() => {
    if (!config.followLiveJointState || !jointStateTopic) {
      player.unregisterSubscriptions(panelId);
      return;
    }
    player.registerSubscriptions(panelId, [{ topic: jointStateTopic, subscriberId: panelId }]);
    return () => player.unregisterSubscriptions(panelId);
  }, [player, panelId, jointStateTopic, config.followLiveJointState]);

  useEffect(() => {
    if (!config.followLiveJointState || !jointStateTopic) {
      setRawJointState(null);
      return;
    }
    const applyLatest = () => {
      setRawJointState(readJointStateFromTopic(jointStateTopic));
    };
    applyLatest();
    let cancelPending: (() => void) | null = null;
    const unsubscribe = messageBus.subscribeTopic(jointStateTopic, () => {
      if (cancelPending) return;
      cancelPending = scheduleFrame(() => {
        cancelPending = null;
        applyLatest();
      });
    });
    return () => {
      unsubscribe();
      cancelPending?.();
    };
  }, [jointStateTopic, config.followLiveJointState]);

  useEffect(() => {
    revokeMeshUrlMap(meshUrlMapRef.current);
    const map = buildLocalMeshUrlMap(meshFiles);
    meshUrlMapRef.current = map;
    setLocalMeshUrls(map);
    return () => revokeMeshUrlMap(meshUrlMapRef.current);
  }, [meshFiles]);

  useEffect(
    () => () => {
      if (layoutWriteTimerRef.current != null) {
        window.clearTimeout(layoutWriteTimerRef.current);
      }
    },
    [],
  );

  const preparedUrdfResult = useMemo(() => {
    if (!config.urdfFileContent) return { urdf: '', error: null as string | null };
    try {
      return {
        urdf: prepareUrdfForPreview(
          config.urdfFileContent,
          config.rotateMeshVisuals,
          config.visualRpyOffset,
        ),
        error: null,
      };
    } catch (error) {
      return {
        urdf: config.urdfFileContent,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [config.urdfFileContent, config.rotateMeshVisuals, config.visualRpyOffset]);

  const preparedUrdf = preparedUrdfResult.urdf;

  useEffect(() => {
    if (preparedUrdfResult.error) setLastError(preparedUrdfResult.error);
  }, [preparedUrdfResult.error]);

  const urdfAnalysis = useMemo(() => {
    if (!preparedUrdf) return null;
    return analyzeUrdfText(preparedUrdf);
  }, [preparedUrdf]);

  const jointDescriptorsResult = useMemo(() => {
    if (!preparedUrdf) return { descriptors: [] as ReturnType<typeof extractUrdfJointDescriptors>, error: null as string | null };
    try {
      return { descriptors: extractUrdfJointDescriptors(preparedUrdf), error: null };
    } catch (error) {
      return {
        descriptors: [] as ReturnType<typeof extractUrdfJointDescriptors>,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [preparedUrdf]);

  const jointDescriptors = jointDescriptorsResult.descriptors;

  useEffect(() => {
    if (jointDescriptorsResult.error) setLastError(jointDescriptorsResult.error);
  }, [jointDescriptorsResult.error]);

  const resolveMeshUrl = useMemo(
    () =>
      createMeshResolver({
        strategy: config.meshStrategy,
        packageName: config.packageName,
        packageBaseUrl: config.packageBaseUrl,
        localUrls: localMeshUrls,
      }),
    [config.meshStrategy, config.packageName, config.packageBaseUrl, localMeshUrls],
  );

  const handleUrdfUpload = useCallback(
    (text: string, fileName: string) => {
      setLastError(null);
      setUrdfUploadError(null);
      const detectedPackage = extractPackageNameFromUrdf(text);
      let descriptors: ReturnType<typeof extractUrdfJointDescriptors> = [];
      try {
        const prepared = prepareUrdfForPreview(
          text,
          config.rotateMeshVisuals,
          config.visualRpyOffset,
        );
        descriptors = extractUrdfJointDescriptors(prepared);
      } catch {
        descriptors = [];
      }
      setConfig((prev) => ({
        ...prev,
        urdfFileName: fileName,
        urdfFileContent: text,
        packageName: prev.packageName || detectedPackage || '',
        manualJointPositions: createDefaultManualPositions(descriptors),
      }));
    },
    [setConfig, config.rotateMeshVisuals, config.visualRpyOffset],
  );

  const handleUrdfFiles = useCallback(
    (files: File[]) => {
      const urdfFile = pickUrdfFile(files);
      if (!urdfFile) {
        setUrdfUploadError(formatMessage({ id: 'urdfDebug.upload.invalidUrdf' }));
        return;
      }
      void urdfFile.text().then((text) => handleUrdfUpload(text, urdfFile.name));
    },
    [formatMessage, handleUrdfUpload],
  );

  const handleSettingsLayoutChanged = useCallback(
    (layout: Record<string, number>) => {
      const nextPercent = layout['urdf-settings'];
      if (typeof nextPercent !== 'number' || !Number.isFinite(nextPercent)) return;
      const clamped = clampSettingsPanelPercent(nextPercent);
      if (layoutWriteTimerRef.current != null) {
        window.clearTimeout(layoutWriteTimerRef.current);
      }
      layoutWriteTimerRef.current = window.setTimeout(() => {
        layoutWriteTimerRef.current = null;
        setConfig((prev) =>
          prev.settingsPanelPercent === clamped ? prev : { ...prev, settingsPanelPercent: clamped },
        );
      }, 120);
    },
    [setConfig],
  );

  const handleMeshIssue = useCallback((_meshUrl: string, _reason: string) => {
    // Mesh issues are surfaced in the 3D preview overlay only.
  }, []);

  const jointStateForPreview = useMemo(
    () =>
      buildPreviewJointState({
        descriptors: jointDescriptors,
        manualPositions: config.manualJointPositions,
        liveJointState: rawJointState,
        followLive: config.followLiveJointState,
        mimicJoints: urdfAnalysis?.mimicJoints ?? [],
      }),
    [
      jointDescriptors,
      config.manualJointPositions,
      config.followLiveJointState,
      rawJointState,
      urdfAnalysis?.mimicJoints,
    ],
  );

  const recipe = useMemo(
    () => configToRecipe(config, urdfAnalysis?.robotName),
    [config, urdfAnalysis?.robotName],
  );

  const cli = buildCliCommands();

  const settingsPanel = (
    <aside className="h-full min-h-0 overflow-y-auto overscroll-y-contain bg-background p-3 space-y-3">
      <Section title={formatMessage({ id: 'urdfDebug.section.input' })}>
        <FileDropZone
          accept=".urdf,.xml,application/xml,text/xml"
          title={formatMessage({ id: 'urdfDebug.upload.dropUrdfTitle' })}
          hint={formatMessage({ id: 'urdfDebug.upload.dropUrdfHint' })}
          browseLabel={formatMessage({ id: 'urdfDebug.upload.browse' })}
          selectedLabel={config.urdfFileName || undefined}
          error={urdfUploadError ?? lastError}
          testId="urdf-debug-urdf-upload"
          onFiles={handleUrdfFiles}
        />
      </Section>

      <Section title={formatMessage({ id: 'urdfDebug.section.meshResources' })}>
        <MeshBaseSection
          config={config}
          setConfig={setConfig}
          urdfAnalysis={urdfAnalysis}
          urdfFileContent={config.urdfFileContent}
          meshFiles={meshFiles}
          setMeshFiles={setMeshFiles}
          resolveMeshUrl={resolveMeshUrl}
          formatMessage={formatMessage}
        />
      </Section>

      <Section title={formatMessage({ id: 'urdfDebug.section.appearance' })}>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={config.rotateMeshVisuals}
            onChange={(event) =>
              setConfig((prev) => ({ ...prev, rotateMeshVisuals: event.target.checked }))
            }
          />
          {formatMessage({ id: 'urdfDebug.rotateMeshVisuals' })}
        </label>
        <p className="text-[10px] text-muted-foreground leading-relaxed pl-5">
          {formatMessage({ id: 'urdfDebug.rotateMeshVisualsHint' })}
        </p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={config.showGrid}
            onChange={(event) => setConfig((prev) => ({ ...prev, showGrid: event.target.checked }))}
          />
          {formatMessage({ id: 'urdfDebug.showGrid' })}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={config.showAxes}
            onChange={(event) => setConfig((prev) => ({ ...prev, showAxes: event.target.checked }))}
          />
          {formatMessage({ id: 'urdfDebug.showAxes' })}
        </label>
        <Field label={formatMessage({ id: 'urdfDebug.field.visualRpyOffset' })}>
          <div className="grid grid-cols-3 gap-1">
            {(['Roll', 'Pitch', 'Yaw'] as const).map((label, index) => (
              <input
                key={label}
                type="number"
                step="0.01"
                className="text-xs border rounded px-1 py-1 bg-background"
                value={config.visualRpyOffset[index]}
                onChange={(event) => {
                  const next = [...config.visualRpyOffset] as [number, number, number];
                  next[index] = Number(event.target.value) || 0;
                  setConfig((prev) => ({ ...prev, visualRpyOffset: next }));
                }}
              />
            ))}
          </div>
        </Field>
      </Section>

      <Section title={formatMessage({ id: 'urdfDebug.section.joints' })}>
        <JointPoseSection
          descriptors={jointDescriptors}
          config={config}
          setConfig={setConfig}
          topics={topics}
          jointStateTopic={jointStateTopic}
          liveJointState={rawJointState}
          formatMessage={formatMessage}
        />
      </Section>

      <Section title={formatMessage({ id: 'urdfDebug.section.export' })}>
        <div className="flex flex-wrap gap-1">
          <ActionButton onClick={() => downloadJson('recipe.json', recipe)}>recipe.json</ActionButton>
          <ActionButton onClick={() => downloadText('process_mcap_tf.mjs', generateTypeScriptScript(recipe))}>
            TypeScript
          </ActionButton>
          <ActionButton onClick={() => downloadText('process_mcap_tf.py', generatePythonScript(recipe))}>
            Python
          </ActionButton>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground break-all mt-2">{cli.ts}</div>
        <div className="text-[10px] font-mono text-muted-foreground break-all">{cli.py}</div>
      </Section>
    </aside>
  );

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0 min-w-0"
      onLayoutChanged={handleSettingsLayoutChanged}
    >
      <ResizablePanel
        id="urdf-settings"
        className="min-h-0 min-w-0"
        defaultSize={`${settingsPanelPercent}%`}
        minSize={`${MIN_SETTINGS_PANEL_PERCENT}%`}
        maxSize={`${MAX_SETTINGS_PANEL_PERCENT}%`}
      >
        {settingsPanel}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        className="block shrink-0"
        aria-label={formatMessage({ id: 'urdfDebug.resizeSettings' })}
      />
      <ResizablePanel id="urdf-preview" className="min-h-0 min-w-0" minSize="30%">
        <div className="h-full min-h-0 overflow-hidden">
          <UrdfDebugPreview
            player={player}
            urdfText={preparedUrdf}
            jointState={jointStateForPreview}
            resolveMeshUrl={resolveMeshUrl}
            fallbackMeshColor={config.fallbackMeshColor}
            showGrid={config.showGrid}
            showAxes={config.showAxes}
            rotateMeshVisuals={config.rotateMeshVisuals}
            onMeshIssue={handleMeshIssue}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="border rounded-md p-2 space-y-2">
    <div className="text-xs font-semibold">{title}</div>
    {children}
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block space-y-1">
    <div className="text-[10px] text-muted-foreground">{label}</div>
    {children}
  </label>
);

const ActionButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button
    type="button"
    className="text-[10px] px-2 py-1 rounded border bg-muted hover:bg-muted/80"
    onClick={onClick}
  >
    {children}
  </button>
);
