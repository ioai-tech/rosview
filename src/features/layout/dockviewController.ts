import type { FoxgloveLayoutData } from '@/core/preferences/foxgloveLayout';
import type { PanelType } from '../panels/framework';

export interface OpenPanelInput {
  type: PanelType;
  id?: string;
  title?: string;
  config?: unknown;
  position?: {
    referencePanel?: string;
    direction: 'above' | 'below' | 'left' | 'right' | 'within';
  };
  activate?: boolean;
}

export interface DockviewController {
  openPanel: (input: OpenPanelInput) => string | null;
  duplicatePanel: (panelId: string) => string | null;
  exportLayout: () => FoxgloveLayoutData | null;
  importLayout: (value: unknown) => { restored: number; degraded: number; skipped: number };
  reapplyAutoLayout: () => boolean;
  /** Forgets the saved layout of this viewer and restores the host / auto layout. */
  resetLayout: () => boolean;
}

let controller: DockviewController | null = null;

export function setDockviewController(next: DockviewController | null): void {
  controller = next;
}

export function getDockviewController(): DockviewController | null {
  return controller;
}

export function openDockviewPanel(input: OpenPanelInput): string | null {
  return controller?.openPanel(input) ?? null;
}

export function exportDockviewLayout(): FoxgloveLayoutData | null {
  return controller?.exportLayout() ?? null;
}

export function importDockviewLayout(
  value: unknown,
): { restored: number; degraded: number; skipped: number } {
  return controller?.importLayout(value) ?? { restored: 0, degraded: 0, skipped: 0 };
}

export function reapplyAutoDockviewLayout(): boolean {
  return controller?.reapplyAutoLayout() ?? false;
}

/** Forgets the saved layout and restores the layout the host or the topics define. */
export function resetDockviewLayout(): boolean {
  return controller?.resetLayout() ?? false;
}
