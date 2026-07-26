import { describe, expect, it, vi } from 'vitest';
import { discardStaleAsyncResult } from './asyncEpoch';

describe('discardStaleAsyncResult', () => {
  it('retains a result from the current epoch', () => {
    const result = { close: vi.fn() };

    expect(discardStaleAsyncResult(result, 3, 3)).toBe(false);
    expect(result.close).not.toHaveBeenCalled();
  });

  it('disposes a result from an invalidated epoch', () => {
    const result = { close: vi.fn() };

    expect(discardStaleAsyncResult(result, 3, 4)).toBe(true);
    expect(result.close).toHaveBeenCalledOnce();
  });
});
