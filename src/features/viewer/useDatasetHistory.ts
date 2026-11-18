import { useCallback, useEffect, useState } from 'react';
import {
  listDatasetHistory,
  upsertDatasetHistoryEntry,
  type DatasetHistoryListItem,
  type DatasetHistoryStoredEntry,
} from '@/shared/utils/datasetHistory';

/**
 * Owns the IndexedDB-backed "recently opened" list: loads it on mount and
 * exposes `recordHistoryEntry` to upsert + refresh in one step. Kept
 * separate from the dataset/session state (`useDatasetSession`) since it's
 * a simple, self-contained CRUD concern with no bearing on `activeId`.
 * Disabled (no reads, no writes, no database) when the host turned persistence off.
 */
export function useDatasetHistory(enabled = true) {
  const [historyItems, setHistoryItems] = useState<DatasetHistoryListItem[]>([]);

  const refreshHistory = useCallback(async () => {
    if (!enabled) return;
    const list = await listDatasetHistory();
    setHistoryItems(list);
  }, [enabled]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const recordHistoryEntry = useCallback(
    async (row: Omit<DatasetHistoryStoredEntry, 'id' | 'openedAt'>) => {
      // `preferencePersistence="off"` means the host owns persistence: nothing is written to IndexedDB.
      if (!enabled) return;
      try {
        await upsertDatasetHistoryEntry(row);
      } catch (e) {
        console.warn('[RosViewer] dataset history write failed', e);
      }
      await refreshHistory();
    },
    [enabled, refreshHistory],
  );

  return { historyItems, recordHistoryEntry };
}
