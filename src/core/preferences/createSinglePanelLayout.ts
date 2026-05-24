import type { OpenPanelInput } from '@/features/layout/dockviewController';
import { createPanelInstanceId } from '@/features/panels/framework';
import { getFoxgloveAdapter, getPanelDefinition } from '@/features/panels/registry';
import type { FoxgloveLayoutData } from './foxgloveLayout';

/**
 * Build a Foxglove-compatible layout JSON with a single panel.
 * Host apps use this instead of hand-authoring `layout` / `configById`.
 */
export function createSinglePanelLayout(input: OpenPanelInput): FoxgloveLayoutData {
  const definition = getPanelDefinition(input.type);
  const panelId = input.id ?? createPanelInstanceId(input.type);
  const config = definition.configSchema.parse(input.config ?? definition.createDefaultConfig());
  const title = input.title ?? definition.defaultTitle;
  const adapter = getFoxgloveAdapter(input.type);
  const foxgloveConfig = adapter.toConfig({
    config,
    extras: {},
    title,
  });

  return {
    layout: panelId,
    configById: {
      [panelId]: foxgloveConfig,
    },
    globalVariables: {},
    userNodes: {},
  };
}
