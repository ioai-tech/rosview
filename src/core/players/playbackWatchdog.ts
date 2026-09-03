/** Production RPC/bootstrap deadlines. Tests inject shorter values. */
export const PLAYBACK_RPC_TIMEOUT_MS = 15_000;
export const PLAYBACK_CURSOR_CLOSE_TIMEOUT_MS = 2_000;
export const PLAYBACK_SOURCE_FAILURE_THRESHOLD = 3;
export const PLAYBACK_BUFFER_PREPARE_AHEAD_MS = 5_000;

export type IterablePlayerWatchdogOptions = {
  rpcTimeoutMs?: number;
  cursorCloseTimeoutMs?: number;
  sourceFailureThreshold?: number;
};
