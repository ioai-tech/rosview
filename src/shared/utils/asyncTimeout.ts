export class TimeoutError extends Error {
  override name = 'TimeoutError';

  constructor(message: string) {
    super(message);
  }
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError || (error instanceof Error && error.name === 'TimeoutError');
}

export interface WithTimeoutOptions {
  /**
   * While this returns true when the deadline comes, the wait is explained (for example the network
   * is down and the read waits for it): the deadline starts again instead of rejecting.
   */
  holdWhile?: () => boolean;
}

/**
 * Rejects with a `TimeoutError` when `promise` takes longer than `timeoutMs`. What the promise
 * settles with after that is not dropped silently: a value goes to `onLateValue`, an error to
 * `onLateError` (a deadline is a guess about a hung callee; a later real error is the truth).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onLateValue?: (value: T) => void,
  onLateError?: (error: Error) => void,
  options: WithTimeoutOptions = {},
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    const expire = (): void => {
      if (options.holdWhile?.()) {
        timer = setTimeout(expire, timeoutMs);
        return;
      }
      timedOut = true;
      timer = null;
      reject(new TimeoutError(message));
    };
    timer = setTimeout(expire, timeoutMs);

    promise.then(
      (value) => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        if (timedOut) {
          onLateValue?.(value);
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        if (!timedOut) {
          reject(err);
        } else {
          onLateError?.(err);
        }
      },
    );
  });
}
