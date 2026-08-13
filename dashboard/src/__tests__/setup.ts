import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { useProductPolicyStore } from '../stores/product-policy';

// Mock localStorage for tests
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    get length() { return storage.size; },
    key: (index: number) => [...storage.keys()][index] ?? null,
  },
});

// Mock crypto.randomUUID
if (!globalThis.crypto?.randomUUID) {
  let counter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...globalThis.crypto,
      randomUUID: () => `mock-uuid-${++counter}`,
    },
  });
}

// Existing Dashboard tests predate product profiles and model the legacy
// installation, whose absent productPolicy must remain all-enabled. Focused
// policy tests explicitly reset/override this state after this global hook.
beforeEach(() => {
  useProductPolicyStore.getState().loadFromConfig({});
});
