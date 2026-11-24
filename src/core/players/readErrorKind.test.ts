import { describe, expect, it } from 'vitest';
import { readErrorKind } from './readErrorKind';

describe('readErrorKind', () => {
  it('names the range reader errors by their name, also after a worker boundary', () => {
    // Comlink rebuilds a thrown error as a plain Error carrying the original name.
    const crossed = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(readErrorKind(crossed('RangeNetworkError', 'Could not reach the server while reading x (Failed to fetch).'))).toBe('network');
    expect(readErrorKind(crossed('RangeStallError', 'No data arrived'))).toBe('stalled');
    expect(readErrorKind(crossed('RangeHttpError', 'Failed to read bytes 0-1: 404 Not Found'))).toBe('refused');
    expect(readErrorKind({ name: 'RangeStallError', message: 'per-topic error object' })).toBe('stalled');
  });

  it("knows each browser's words for a request without a response", () => {
    for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'network error']) {
      expect(readErrorKind(new TypeError(message))).toBe('network');
    }
  });

  it('leaves every other error to its own message', () => {
    expect(readErrorKind(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBeUndefined();
    expect(readErrorKind(new Error('Corrupt chunk'))).toBeUndefined();
    expect(readErrorKind('Failed to fetch')).toBeUndefined();
    expect(readErrorKind(undefined)).toBeUndefined();
  });
});
