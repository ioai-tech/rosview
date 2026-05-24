import React, { createContext, useContext } from 'react';
import type { PreferencePersistence } from '@/core/preferences/types';
import { ROS_VIEW_LAYOUT_STORAGE_KEY } from '@/core/preferences/storageKeys';

export interface RosViewerLayoutContextValue {
  layoutPersistence: PreferencePersistence;
  layoutStorageKey: string;
}

const RosViewerLayoutContext = createContext<RosViewerLayoutContextValue>({
  layoutPersistence: 'localStorage',
  layoutStorageKey: ROS_VIEW_LAYOUT_STORAGE_KEY,
});

export function RosViewerLayoutProvider({
  layoutPersistence,
  layoutStorageKey,
  children,
}: {
  layoutPersistence: PreferencePersistence;
  layoutStorageKey: string;
  children: React.ReactNode;
}) {
  return (
    <RosViewerLayoutContext.Provider value={{ layoutPersistence, layoutStorageKey }}>
      {children}
    </RosViewerLayoutContext.Provider>
  );
}

export function useRosViewerLayoutContext(): RosViewerLayoutContextValue {
  return useContext(RosViewerLayoutContext);
}
