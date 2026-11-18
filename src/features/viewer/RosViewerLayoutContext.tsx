import React, { createContext, useContext } from 'react';
import type { PreferencePersistence } from '@/core/preferences/types';
import { ROS_VIEW_LAYOUT_STORAGE_KEY } from '@/core/preferences/storageKeys';

export interface RosViewerLayoutContextValue {
  layoutPersistence: PreferencePersistence;
  layoutStorageKey: string;
  /** This viewer's own layout reset, registered by its dock layout (never a page-global). */
  resetLayoutRef: React.RefObject<(() => boolean) | null>;
}

const RosViewerLayoutContext = createContext<RosViewerLayoutContextValue>({
  layoutPersistence: 'localStorage',
  layoutStorageKey: ROS_VIEW_LAYOUT_STORAGE_KEY,
  resetLayoutRef: { current: null },
});

export function RosViewerLayoutProvider({
  layoutPersistence,
  layoutStorageKey,
  resetLayoutRef,
  children,
}: {
  layoutPersistence: PreferencePersistence;
  layoutStorageKey: string;
  resetLayoutRef: React.RefObject<(() => boolean) | null>;
  children: React.ReactNode;
}) {
  return (
    <RosViewerLayoutContext.Provider value={{ layoutPersistence, layoutStorageKey, resetLayoutRef }}>
      {children}
    </RosViewerLayoutContext.Provider>
  );
}

export function useRosViewerLayoutContext(): RosViewerLayoutContextValue {
  return useContext(RosViewerLayoutContext);
}
