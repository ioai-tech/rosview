import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { FileDropZone } from '@/shared/ui/file-drop-zone';
import type { UrdfDebugConfig } from './defaults';
import { pickMeshFiles } from './fileDropUtils';
import type { UrdfAnalysis } from './urdfAnalysis';
import {
  buildMeshReferenceStatuses,
  extractPackageNameFromUrdf,
  normalizeRemoteBaseUrl,
  summarizeMeshStatuses,
  type MeshProbeStatus,
  type MeshReferenceStatus,
} from './meshBaseStatus';

type MeshBaseSectionProps = {
  config: UrdfDebugConfig;
  setConfig: (next: UrdfDebugConfig | ((prev: UrdfDebugConfig) => UrdfDebugConfig)) => void;
  urdfAnalysis: UrdfAnalysis | null;
  urdfFileContent: string;
  meshFiles: File[];
  setMeshFiles: (files: File[]) => void;
  resolveMeshUrl: (rawPath: string) => string;
  formatMessage: IntlShape['formatMessage'];
};

const STATUS_CLASS: Record<MeshProbeStatus, string> = {
  pending: 'text-muted-foreground',
  ok: 'text-emerald-600',
  local: 'text-emerald-600',
  missing: 'text-amber-600',
  error: 'text-red-500',
  cors: 'text-amber-600',
  unchecked: 'text-muted-foreground',
};

function statusLabel(status: MeshProbeStatus, formatMessage: IntlShape['formatMessage']): string {
  return formatMessage({ id: `urdfDebug.meshStatus.${status}` });
}

function folderLabelFromFiles(files: File[]): string | null {
  if (files.length === 0) return null;
  const relative = files[0]?.webkitRelativePath;
  if (!relative) return null;
  const slash = relative.indexOf('/');
  return slash >= 0 ? relative.slice(0, slash) : relative;
}

export const MeshBaseSection: React.FC<MeshBaseSectionProps> = ({
  config,
  setConfig,
  urdfAnalysis,
  urdfFileContent,
  meshFiles,
  setMeshFiles,
  resolveMeshUrl,
  formatMessage,
}) => {
  const [remoteDraft, setRemoteDraft] = useState(config.packageBaseUrl);
  const [remoteApplyError, setRemoteApplyError] = useState<string | null>(null);
  const [meshUploadError, setMeshUploadError] = useState<string | null>(null);
  const [meshStatuses, setMeshStatuses] = useState<MeshReferenceStatus[]>([]);
  const [meshStatusLoading, setMeshStatusLoading] = useState(false);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  useEffect(() => {
    setRemoteDraft(config.packageBaseUrl);
  }, [config.packageBaseUrl]);

  const folderLabel = useMemo(() => folderLabelFromFiles(meshFiles), [meshFiles]);
  const meshSummary = useMemo(() => summarizeMeshStatuses(meshStatuses), [meshStatuses]);

  const refreshMeshStatuses = useCallback(async () => {
    if (!urdfAnalysis?.meshReferences.length) {
      setMeshStatuses([]);
      return;
    }
    setMeshStatusLoading(true);
    try {
      const statuses = await buildMeshReferenceStatuses({
        meshReferences: urdfAnalysis.meshReferences,
        resolveMeshUrl,
        strategy: config.meshStrategy,
      });
      setMeshStatuses(statuses);
    } finally {
      setMeshStatusLoading(false);
    }
  }, [urdfAnalysis, resolveMeshUrl, config.meshStrategy]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!urdfAnalysis?.meshReferences.length) {
        if (!cancelled) setMeshStatuses([]);
        return;
      }
      if (!cancelled) setMeshStatusLoading(true);
      try {
        const statuses = await buildMeshReferenceStatuses({
          meshReferences: urdfAnalysis.meshReferences,
          resolveMeshUrl,
          strategy: config.meshStrategy,
        });
        if (!cancelled) setMeshStatuses(statuses);
      } finally {
        if (!cancelled) setMeshStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    urdfAnalysis,
    resolveMeshUrl,
    config.meshStrategy,
    config.packageBaseUrl,
    meshFiles,
    statusRefreshKey,
  ]);

  const handleStrategyChange = (strategy: UrdfDebugConfig['meshStrategy']) => {
    setRemoteApplyError(null);
    setConfig((prev) => ({ ...prev, meshStrategy: strategy }));
  };

  const applyMeshFiles = useCallback(
    (files: File[]) => {
      const meshes = pickMeshFiles(files);
      if (meshes.length === 0) {
        setMeshUploadError(formatMessage({ id: 'urdfDebug.upload.invalidMesh' }));
        return;
      }
      setMeshUploadError(null);
      setMeshFiles(meshes);
      setRemoteApplyError(null);
      setConfig((prev) => ({ ...prev, meshStrategy: 'localUpload' }));
    },
    [formatMessage, setConfig, setMeshFiles],
  );

  const handleApplyRemoteBase = () => {
    const normalized = normalizeRemoteBaseUrl(remoteDraft);
    if (!normalized) {
      setRemoteApplyError(formatMessage({ id: 'urdfDebug.meshBase.remoteInvalid' }));
      return;
    }
    setRemoteApplyError(null);
    setConfig((prev) => ({
      ...prev,
      meshStrategy: 'packageBaseUrl',
      packageBaseUrl: normalized,
    }));
    setStatusRefreshKey((key) => key + 1);
  };

  const handleAutoPackageName = () => {
    const detected = extractPackageNameFromUrdf(urdfFileContent);
    if (!detected) return;
    setConfig((prev) => ({ ...prev, packageName: detected }));
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground leading-relaxed">
        {formatMessage({ id: 'urdfDebug.meshBase.hint' })}
      </div>

      <div className="space-y-1">
        {(
          [
            ['localUpload', 'urdfDebug.meshBase.mode.localFolder'],
            ['packageBaseUrl', 'urdfDebug.meshBase.mode.remoteUrl'],
            ['leaveAsIs', 'urdfDebug.meshStrategy.leaveAsIs'],
          ] as const
        ).map(([value, labelId]) => (
          <label key={value} className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              name="mesh-base-mode"
              checked={config.meshStrategy === value}
              onChange={() => handleStrategyChange(value)}
            />
            {formatMessage({ id: labelId })}
          </label>
        ))}
      </div>

      {config.meshStrategy === 'localUpload' && (
        <FileDropZone
          directory
          multiple
          title={formatMessage({ id: 'urdfDebug.upload.dropMeshTitle' })}
          hint={formatMessage({ id: 'urdfDebug.upload.dropMeshHint' })}
          browseLabel={formatMessage({ id: 'urdfDebug.upload.browse' })}
          selectedLabel={
            meshFiles.length > 0
              ? formatMessage(
                  { id: 'urdfDebug.meshBase.folderSelected' },
                  { folder: folderLabel ?? '-', count: meshFiles.length },
                )
              : undefined
          }
          error={meshUploadError}
          testId="urdf-debug-mesh-upload"
          onFiles={applyMeshFiles}
        />
      )}

      {config.meshStrategy === 'packageBaseUrl' && (
        <div className="space-y-1 rounded border px-2 py-2 bg-muted/20">
          <div className="flex gap-1">
            <input
              className="flex-1 min-w-0 text-xs border rounded px-2 py-1 bg-background"
              value={remoteDraft}
              onChange={(event) => {
                setRemoteDraft(event.target.value);
                setRemoteApplyError(null);
              }}
              placeholder={formatMessage({ id: 'urdfDebug.meshBase.remotePlaceholder' })}
            />
            <button
              type="button"
              className="shrink-0 text-xs px-2 py-1 rounded border bg-background hover:bg-muted/40"
              onClick={handleApplyRemoteBase}
            >
              {formatMessage({ id: 'urdfDebug.meshBase.apply' })}
            </button>
          </div>
          {remoteApplyError && <div className="text-[10px] text-red-500">{remoteApplyError}</div>}
          {config.packageBaseUrl ? (
            <div className="text-[10px] break-all">
              <span className="text-muted-foreground">
                {formatMessage({ id: 'urdfDebug.meshBase.applied' })}:{' '}
              </span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400">{config.packageBaseUrl}</span>
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground italic">
              {formatMessage({ id: 'urdfDebug.meshBase.remoteNotApplied' })}
            </div>
          )}
        </div>
      )}

      <label className="block space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {formatMessage({ id: 'urdfDebug.field.packageName' })}
          </span>
          <button
            type="button"
            className="text-[10px] text-primary hover:underline"
            onClick={handleAutoPackageName}
            disabled={!urdfFileContent}
          >
            {formatMessage({ id: 'urdfDebug.meshBase.detectPackage' })}
          </button>
        </div>
        <input
          className="w-full text-xs border rounded px-2 py-1 bg-background"
          value={config.packageName}
          onChange={(event) => setConfig((prev) => ({ ...prev, packageName: event.target.value }))}
          placeholder="xArm7"
        />
      </label>

      {urdfAnalysis && urdfAnalysis.meshReferences.length > 0 && (
        <div className="space-y-1 border rounded px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold">
              {formatMessage({ id: 'urdfDebug.meshBase.resolvedTitle' })}
            </div>
            <button
              type="button"
              className="text-[10px] text-primary hover:underline disabled:opacity-50"
              disabled={meshStatusLoading}
              onClick={() => {
                setStatusRefreshKey((key) => key + 1);
                void refreshMeshStatuses();
              }}
            >
              {formatMessage({ id: 'urdfDebug.meshBase.refresh' })}
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground">
            {meshStatusLoading
              ? formatMessage({ id: 'urdfDebug.meshBase.checking' })
              : formatMessage(
                  { id: 'urdfDebug.meshBase.summary' },
                  {
                    ok: meshSummary.ok,
                    failed: meshSummary.failed,
                    total: meshSummary.total,
                  },
                )}
          </div>
          <div className="max-h-44 overflow-auto space-y-1">
            {meshStatuses.map((entry) => (
              <div key={entry.rawPath} className="text-[10px] border rounded px-2 py-1 space-y-0.5">
                <div className="font-mono truncate" title={entry.rawPath}>
                  {entry.rawPath}
                </div>
                <div className="font-mono break-all text-muted-foreground" title={entry.resolvedUrl}>
                  → {entry.resolvedUrl}
                </div>
                <div className={`font-medium ${STATUS_CLASS[entry.status]}`}>
                  {statusLabel(entry.status, formatMessage)}
                  {entry.error ? `: ${entry.error}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
