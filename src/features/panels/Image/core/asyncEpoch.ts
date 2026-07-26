export interface ClosableAsyncResult {
  close(): void;
}

/**
 * Disposes an async result that completed after its owning runtime was reset.
 * Returns true when the caller must stop processing the stale result.
 */
export function discardStaleAsyncResult<T extends ClosableAsyncResult>(
  result: T,
  startedEpoch: number,
  currentEpoch: number,
): boolean {
  if (startedEpoch === currentEpoch) {
    return false;
  }
  result.close();
  return true;
}
