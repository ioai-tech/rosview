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

  it('hands an error that comes after the timeout to onLateError instead of dropping it', async () => {
    vi.useFakeTimers();
    try {
      let rejectLate!: (error: Error) => void;
      const onLateError = vi.fn();
      const pending = withTimeout(
        new Promise<string>((_, reject) => {
          rejectLate = reject;
        }),
        100,
        'read timed out',
        undefined,
        onLateError,
      );
      const assertion = expect(pending).rejects.toThrow('read timed out');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      const stall = Object.assign(new Error('No data arrived from the server for 20 s'), { name: 'RangeStallError' });
      rejectLate(stall);
      await vi.runAllTimersAsync();

      expect(onLateError).toHaveBeenCalledWith(stall);
    } finally {
      vi.useRealTimers();
    }
  });
});
