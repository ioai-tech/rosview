import { useCallback, useEffect, useReducer } from 'react';
import { RosViewer } from '@/features/viewer/RosViewer';

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

function App() {
  const syncLocationSearch = useLocationSearchSync();
  const url = readSpaUrlFromQuery();
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <RosViewer
        url={url}
        urlState="spa"
        preferencePersistence="localStorage"
        onSpaUrlQuerySync={syncLocationSearch}
      />
    </div>
  );
}

export default App;
