import { useCallback, useEffect, useReducer } from 'react';
import { ThreeCanvasHarness } from '@/features/panels/common/threeCanvas/ThreeCanvasHarness';
import { RosViewer } from '@/features/viewer/RosViewer';
import type { RosViewerProps } from '@/features/viewer/RosViewer.types';

function useLocationSearchSync() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const syncLocationSearch = useCallback(() => bump(), []);
  useEffect(() => {
    const onPopState = () => syncLocationSearch();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [syncLocationSearch]);
  return syncLocationSearch;
}

/** Single `?url=` locator (remote path / https, or `file://` / `folder://` for local replay). */
function readSpaUrlFromQuery(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = new URLSearchParams(window.location.search).get('url')?.trim();
  return v || undefined;
}

/** Optional `?sourceKey=` names the recording for the in-tab byte cache (used by performance tests). */
function readSourceKeyFromQuery(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get('sourceKey')?.trim() || undefined;
}

/**
 * Test seam: Playwright sets `window.__rosviewHostProps` before load to drive embedding props
 * (refreshUrls, sourceKey, messages) through the standalone shell, as a host app would.
 */
function readHostPropsOverride(): Partial<RosViewerProps> {
  if (typeof window === 'undefined') return {};
  return (window as unknown as { __rosviewHostProps?: Partial<RosViewerProps> }).__rosviewHostProps ?? {};
}

function App() {
  const syncLocationSearch = useLocationSearchSync();
  const url = readSpaUrlFromQuery();
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('threeCanvasHarness')) {
    return <ThreeCanvasHarness />;
  }
  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <RosViewer
        url={url}
        sourceKey={readSourceKeyFromQuery()}
        urlState="spa"
        preferencePersistence="localStorage"
        onSpaUrlQuerySync={syncLocationSearch}
        {...readHostPropsOverride()}
      />
    </main>
  );
}

export default App;
