import { describe, expect, it } from 'vitest';
import { createSinglePanelLayout } from './createSinglePanelLayout';
import { importFoxgloveLayout } from './foxgloveLayout';

describe('createSinglePanelLayout', () => {
  it('builds a restorable UrdfDebug layout', () => {
    const layout = createSinglePanelLayout({ type: 'UrdfDebug', id: 'UrdfDebug!embed' });
    expect(layout.layout).toBe('UrdfDebug!embed');
    expect(layout.configById['UrdfDebug!embed']).toBeDefined();

    const imported = importFoxgloveLayout(layout);
    expect(imported.restored).toBe(1);
    expect(imported.panelStates['UrdfDebug!embed']?.type).toBe('UrdfDebug');
    expect(imported.dockviewState).toBeDefined();
  });
});
