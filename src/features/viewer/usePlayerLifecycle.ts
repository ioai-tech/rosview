import { useEffect, useRef, useState } from 'react';
import { isWorkerSourceCancelledError } from '@/infra/workers/WorkerSerializedSource';
import { CombinedSourceProxy, type CombinedSourceMember } from '@/infra/workers/CombinedSourceProxy';
import { IterablePlayer } from '@/core/players/IterablePlayer';
import { MinimalPlayer } from '@/core/players/MinimalPlayer';
import type { Player } from '@/core/types/player';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import { readPreferences } from '@/core/preferences/readWritePreferences';
import type { PreferencePersistence } from '@/core/preferences/types';
import { groupDatasets, type DatasetItem } from '@/shared/utils/datasetSources';
import { pushSpaUrlParam, serializeSourceLocator } from '@/shared/utils/sourceLocator';
import { fallbackIndexOrder, prepareSourceMember } from './sourceLoading';
import { UrlRenewal } from '@/infra/range/urlRenewal';
import { ConnectionMonitor } from '@/infra/range/connection';
import { datasetItemToSourceLocator } from './rosViewerUtils';
import type { RosViewerProps } from './RosViewer.types';
import type { createRosViewIntl } from '@/shared/intl/createRosViewIntl';

export interface UsePlayerLifecycleArgs {
  /** This viewer's layout reset (registered by its dock layout). */
  resetLayoutRef: React.RefObject<(() => boolean) | null>;
  requireSource: boolean;
  hasSource: boolean;
  /** Player-loading UI is suppressed once a prior attempt already reported an error. */
  lastLoadError: string | null;
  activeId: string | null;
  /** Members of the group the load effect targets; forces a rebuild when files are added to/removed from it. */
  activeGroupMembersKey: string;
  datasetsRef: React.RefObject<DatasetItem[]>;
  persistence: PreferencePersistence;
  urlState: 'spa' | 'off';
  offlineIntl: ReturnType<typeof createRosViewIntl>;
  clearOpenFeedback: () => void;
  showOpenError: (message: string) => void;
  setLastLoadError: (value: string | null) => void;
  setLoadedGroupId: (value: string | null) => void;
  /** When set, successful player init writes `sample://…` to the address bar instead of the resolved archive URL. */
  spaSampleLocatorParamRef: React.RefObject<string | null>;
}

/**
 * Owns the `Player` instance: a `MinimalPlayer` fallback when no source is
 * required, and otherwise the real load/fallback loop that turns the active
 * dataset group into a `WorkerSerializedSource` (or `CombinedSourceProxy`
 * for merged multi-file groups) wrapped in an `IterablePlayer`. Also fires
 * `props.onPlayerReady` / `props.onSourceLoadingChange`.
 *
 * The load effect's dependency array is intentionally narrow — `activeId` +
 * `activeGroupMembersKey` (not the full `datasets`/`groups` objects, which
 * are read fresh from `datasetsRef` inside the effect). Session state
 * (`useDatasetSession`) guarantees `activeId` only changes when there's a
 * real, live group to load; see that hook's docs for the production bug
 * this invariant fixes.
 */
export function usePlayerLifecycle(props: RosViewerProps, args: UsePlayerLifecycleArgs) {
  const {
    resetLayoutRef,
    requireSource,
    hasSource,
    lastLoadError,
    activeId,
    activeGroupMembersKey,
    datasetsRef,
    persistence,
    urlState,
    offlineIntl,
    clearOpenFeedback,
    showOpenError,
    setLastLoadError,
    setLoadedGroupId,
    spaSampleLocatorParamRef,
  } = args;

  const [player, setPlayer] = useState<Player | null>(null);
  const sourceLoading = hasSource && player == null && lastLoadError == null;

  // Presigned-URL renewal is configured per viewer and read live, so a later `urlExpiresAt` applies.
  const [renewal] = useState(() => new UrlRenewal());
  // The network state of this viewer's remote reads: a read the network dropped waits there, and the
  // player holds its deadlines and says it is reconnecting meanwhile.
  const [connection] = useState(() => new ConnectionMonitor());
  useEffect(() => {
    renewal.update({ refreshUrls: props.refreshUrls, urlExpiresAt: props.urlExpiresAt });
  }, [renewal, props.refreshUrls, props.urlExpiresAt]);
  const sourceKeyRef = useRef(props.sourceKey);
  useEffect(() => {
    sourceKeyRef.current = props.sourceKey;
  }, [props.sourceKey]);

  const onFatalErrorRef = useRef(props.onFatalError);
  useEffect(() => {
    onFatalErrorRef.current = props.onFatalError;
  }, [props.onFatalError]);

  const onPlayerReadyRef = useRef(props.onPlayerReady);
  useEffect(() => {
    onPlayerReadyRef.current = props.onPlayerReady;
  }, [props.onPlayerReady]);
  const playerReadyFiredRef = useRef(false);

  useEffect(() => {
    playerReadyFiredRef.current = false;
  }, [player]);

  useEffect(() => {
    if (!player) return;
    const fireIfReady = () => {
      if (playerReadyFiredRef.current) return;
      if (useMessagePipelineStore.getState().playerState.presence !== 'ready') return;
      playerReadyFiredRef.current = true;
      onPlayerReadyRef.current?.({ player, hasSource, resetLayout: () => resetLayoutRef.current?.() ?? false });
    };
    fireIfReady();
    return useMessagePipelineStore.subscribe(fireIfReady);
  }, [player, hasSource, resetLayoutRef]);

  const onSourceLoadingChangeRef = useRef(props.onSourceLoadingChange);
  useEffect(() => {
    onSourceLoadingChangeRef.current = props.onSourceLoadingChange;
  }, [props.onSourceLoadingChange]);

  useEffect(() => {
    onSourceLoadingChangeRef.current?.(sourceLoading);
  }, [sourceLoading]);

  useEffect(() => {
    if (requireSource || hasSource) return;
    const minimal = new MinimalPlayer();
    setPlayer(minimal);
    return () => {
      minimal.close();
      setPlayer(null);
    };
  }, [requireSource, hasSource]);

  useEffect(() => {
    if (!requireSource && !hasSource) {
      return;
    }
    if (!hasSource || !activeId) {
      setPlayer(null);
      return;
    }

    const groupsLive = groupDatasets(datasetsRef.current);
    if (!groupsLive.find((g) => g.groupId === activeId)) {
      setPlayer(null);
      return;
    }

    let cancelled = false;
    let createdPlayer: IterablePlayer | null = null;

    const run = async () => {
      setLastLoadError(null);
      const startIdx = groupsLive.findIndex((g) => g.groupId === activeId);
      const order = fallbackIndexOrder(groupsLive.length, startIdx >= 0 ? startIdx : 0);
      let lastErr: unknown = null;
      const autoDataQualityScan =
        persistence === 'localStorage' && readPreferences()?.autoDataQualityScan === true;

      for (const idx of order) {
        if (cancelled) return;
        const group = groupsLive[idx];

        let preparedMembers: CombinedSourceMember[];
        try {
          const prepared = await Promise.all(
            group.members.map((ds) =>
              prepareSourceMember(ds, autoDataQualityScan, {
                renewal,
                connection,
                persist: persistence !== 'off',
                // A source key names one recording: with several remote sources it would be ambiguous.
                sourceKey:
                  datasetsRef.current.filter((d) => d.kind === 'url').length === 1
                    ? sourceKeyRef.current
                    : undefined,
              }),
            ),
          );
          preparedMembers = prepared.map((p) => p.member);
        } catch (err) {
          if (cancelled) return;
          lastErr = err;
          continue;
        }
        if (cancelled) {
          for (const m of preparedMembers) m.source.terminate();
          return;
        }

        // A group of one uses `WorkerSerializedSource` directly, matching
        // today's single-file path byte-for-byte; only 2+ members go through
        // `CombinedSourceProxy`.
        const newPlayer =
          preparedMembers.length === 1
            ? new IterablePlayer(preparedMembers[0].source, { connection })
            : new IterablePlayer(new CombinedSourceProxy(preparedMembers), { connection });
        createdPlayer = newPlayer;
        if (!cancelled) setPlayer(newPlayer);

        try {
          const initArgs = preparedMembers.length === 1 ? preparedMembers[0].initArgs : {};
          await newPlayer.initialize(initArgs);
          if (cancelled) {
            newPlayer.close();
            createdPlayer = null;
            return;
          }
          // Do not call setActiveId here: it would re-run this effect's cleanup and close the player we just opened (multi-source fallback).
          setLoadedGroupId(group.groupId !== activeId ? group.groupId : null);
          clearOpenFeedback();
          if (urlState === 'spa') {
            const sampleParam = spaSampleLocatorParamRef.current;
            if (sampleParam) {
              pushSpaUrlParam(sampleParam);
              spaSampleLocatorParamRef.current = null;
            } else if (group.members.length === 1) {
              const loc = datasetItemToSourceLocator(group.members[0]);
              if (loc) {
                pushSpaUrlParam(serializeSourceLocator(loc));
              }
            }
            // Merged multi-file sessions have no single `?url=` locator to
            // round-trip; the address bar keeps whatever it last showed.
          }
          return;
        } catch (err) {
          if (cancelled || isWorkerSourceCancelledError(err)) {
            newPlayer.close();
            createdPlayer = null;
            return;
          }
          lastErr = err;
          newPlayer.close();
          createdPlayer = null;
          if (!cancelled) setPlayer(null);
        }
      }

      if (cancelled) return;
      const message =
        lastErr instanceof Error
          ? lastErr.message
          : typeof lastErr === 'string'
            ? lastErr
            : offlineIntl.formatMessage({ id: 'errors.loadFailed' });
      showOpenError(message);
      onFatalErrorRef.current?.(lastErr instanceof Error ? lastErr : new Error(message));
    };

    void run();

    return () => {
      cancelled = true;
      createdPlayer?.close();
      setPlayer(null);
    };
    // `renewal` and `connection` are stable for the viewer's lifetime. `activeGroupMembersKey` is not read directly but forces a rebuild when
    // files are added to (or removed from) the currently active group.
  }, [
    activeId,
    activeGroupMembersKey,
    clearOpenFeedback,
    connection,
    datasetsRef,
    hasSource,
    offlineIntl,
    persistence,
    renewal,
    requireSource,
    setLastLoadError,
    setLoadedGroupId,
    showOpenError,
    spaSampleLocatorParamRef,
    urlState,
  ]);

  return { player, sourceLoading };
}
