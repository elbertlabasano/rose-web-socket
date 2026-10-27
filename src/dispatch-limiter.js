// Space dispatches instead of allowing a burst at a minute boundary.
// A startup cooldown preserves the minimum gap even after a process restart.
export function createDispatchLimiter({ now = () => performance.now() } = {}) {
  const intervalMs = 3000; // At most 20 dispatches per minute per device.
  const startupReadyAt = now() + intervalMs;
  const nextDispatchAt = new Map();
  return {
    ready(id) { return now() >= Math.max(startupReadyAt, nextDispatchAt.get(id) ?? 0); },
    dispatched(id) { nextDispatchAt.set(id, now() + intervalMs); }
  };
}
