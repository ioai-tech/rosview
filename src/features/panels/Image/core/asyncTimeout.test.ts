import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from '@/shared/utils/asyncTimeout';

describe('withTimeout', () => {
  it('resolves when the wrapped promise finishes before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ready'), 100, 'timed out')).resolves.toBe('ready');
  });

  it('rejects when the wrapped promise does not finish before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<string>(() => undefined), 100, 'decode timed out');
      const assertion = expect(pending).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(100);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes late values after a timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveLate!: (value: string) => void;
      const onLateValue = vi.fn();
      const pending = withTimeout(
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
        100,
        'decode timed out',
        onLateValue,
      );
      const assertion = expect(pending).rejects.toThrow('decode timed out');

      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      resolveLate('late-result');
      await vi.runAllTimersAsync();

      expect(onLateValue).toHaveBeenCalledWith('late-result');
    } finally {
      vi.useRealTimers();
    }
  });
});
