import type { FoxgloveLayoutData } from './foxgloveLayout';
import { parseFoxgloveLayout } from './foxgloveLayout';
import { ROS_VIEW_LAYOUT_STORAGE_KEY } from './storageKeys';

/**
 * localStorage persistence for the current user's layout. The wire format
 * is Foxglove-compatible `LayoutData`, so sessions can be migrated freely
 * between this product and Foxglove Studio.
 *
 * Legacy (pre-Foxglove) V1 payloads (`{ schemaVersion: 1, dockview, panels }`)
 * are hard-dropped on read: the key is removed and `null` returned so the
 * user starts from a clean default. This is intentional per the refactor
 * plan (Q5 `hard_cut`).
 */

function isLegacyV1Payload(value: unknown): boolean {
  if (typeof value !== 'object' || value == null) return false;
  const typed = value as Record<string, unknown>;
  return typed.schemaVersion === 1 && 'dockview' in typed;
}

/** Load the saved Foxglove layout, or `null` when absent/corrupt/legacy. */
export function readSavedDockviewLayout(
  storageKey: string = ROS_VIEW_LAYOUT_STORAGE_KEY,
): FoxgloveLayoutData | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw == null || raw === '') {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (isLegacyV1Payload(parsed)) {
      globalThis.localStorage.removeItem(storageKey);
      return null;
    }
    return parseFoxgloveLayout(parsed);
  } catch {
    return null;
  }
}

/** Persist a Foxglove-compatible layout payload. */
export function saveDockviewLayoutToStorage(
  payload: FoxgloveLayoutData,
  storageKey: string = ROS_VIEW_LAYOUT_STORAGE_KEY,
): void {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return;
  }
  try {
    globalThis.localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch (e) {
    console.warn('[layoutStorage] Failed to save layout', e);
  }
}

/** Clear the persisted layout so the next mount falls back to auto-layout. */
export function clearSavedDockviewLayout(storageKey: string = ROS_VIEW_LAYOUT_STORAGE_KEY): void {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return;
  }
  try {
    globalThis.localStorage.removeItem(storageKey);
  } catch (e) {
    console.warn('[layoutStorage] Failed to clear layout', e);
  }
}
