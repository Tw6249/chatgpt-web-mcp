// Bound individual control requests, never an entire mutating workflow. A late
// result cannot resume its caller after cancellation and replay browser actions.
export function controlRequest(request, { timeout = 20000, signal, onInterrupt, code = 'CONTROL_TIMEOUT' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const interrupt = reason => {
      if (settled) return;
      finish(reject, reason);
      Promise.resolve().then(onInterrupt).catch(() => {});
    };
    const abort = () => interrupt(signal.reason || new Error('Operation aborted'));
    Promise.resolve(request).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (timeout != null) timer = setTimeout(() => interrupt(Object.assign(new Error('Browser control request timed out; the dedicated browser and pending task were preserved.'), { code })), timeout);
  });
}
