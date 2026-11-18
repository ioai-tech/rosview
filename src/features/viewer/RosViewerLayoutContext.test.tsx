/**
 * @vitest-environment happy-dom
 */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { RosViewerLayoutProvider, useRosViewerLayoutContext } from './RosViewerLayoutContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Registers({ name, log }: { name: string; log: string[] }) {
  const { resetLayoutRef } = useRosViewerLayoutContext();
  useEffect(() => {
    resetLayoutRef.current = () => {
      log.push(name);
      return true;
    };
  }, [resetLayoutRef, name, log]);
  return null;
}

describe('per-viewer layout reset', () => {
  it('two viewers on one page each reset their own layout', () => {
    const log: string[] = [];
    const a = { current: null as (() => boolean) | null };
    const b = { current: null as (() => boolean) | null };
    const root = createRoot(document.createElement('div'));
    act(() => {
      root.render(
        <>
          <RosViewerLayoutProvider layoutPersistence="off" layoutStorageKey="a" resetLayoutRef={a}>
            <Registers name="A" log={log} />
          </RosViewerLayoutProvider>
          <RosViewerLayoutProvider layoutPersistence="off" layoutStorageKey="b" resetLayoutRef={b}>
            <Registers name="B" log={log} />
          </RosViewerLayoutProvider>
        </>,
      );
    });
    expect(a.current).not.toBe(b.current);
    a.current?.();
    expect(log).toEqual(['A']);
    b.current?.();
    expect(log).toEqual(['A', 'B']);
  });
});
