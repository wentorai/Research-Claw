/**
 * Synchronous, store-independent authority for config.get response ownership.
 *
 * Both the gateway transport and config store depend on this tiny module. That
 * keeps transport invalidation synchronous without creating a gateway ↔ config
 * module cycle. A response may publish state only while its generation remains
 * current.
 */
let generation = 0;
const invalidationListeners = new Set<(nextGeneration: number) => void>();

export function beginConfigRequest(): number {
  generation += 1;
  return generation;
}

export function invalidateConfigRequests(): number {
  generation += 1;
  for (const listener of invalidationListeners) listener(generation);
  return generation;
}

export function isCurrentConfigRequest(requestGeneration: number): boolean {
  return generation === requestGeneration;
}

export function onConfigRequestsInvalidated(
  listener: (nextGeneration: number) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}
