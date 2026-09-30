/** A pending wait on a Clock; `cancel` makes `elapsed` never resolve. */
export interface Timer {
  elapsed: Promise<void>;
  cancel(): void;
}

export abstract class Clock {
  abstract now(): Date;
  /** A Timer that elapses once `ms` have passed on this clock. */
  abstract timer(ms: number): Timer;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }

  timer(ms: number): Timer {
    const due = Date.now() + ms;
    let handle: NodeJS.Timeout | undefined;
    const elapsed = new Promise<void>((resolve) => {
      // setTimeout fires at once for delays above MAX_TIMEOUT_MS, so long waits re-arm.
      const arm = () => {
        const left = due - Date.now();
        if (left <= 0) return resolve();
        handle = setTimeout(arm, Math.min(left, MAX_TIMEOUT_MS));
        handle.unref();
      };
      arm();
    });
    return { elapsed, cancel: () => clearTimeout(handle) };
  }
}
