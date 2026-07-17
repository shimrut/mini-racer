import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PB_GHOST_STORAGE_KEY,
  getPbGhostEnabled,
  setPbGhostEnabled,
} from '../game/settings/pb-ghost-preference.js';

describe('personal best ghost preference', () => {
  const store = new Map();

  beforeEach(() => {
    store.clear();
    globalThis.window = {
      localStorage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, String(value)),
      },
    };
  });

  afterEach(() => {
    delete globalThis.window;
  });

  it('defaults to enabled and persists both states', () => {
    expect(getPbGhostEnabled()).toBe(true);
    expect(setPbGhostEnabled(false)).toBe(false);
    expect(store.get(PB_GHOST_STORAGE_KEY)).toBe('0');
    expect(getPbGhostEnabled()).toBe(false);
    expect(setPbGhostEnabled(true)).toBe(true);
    expect(store.get(PB_GHOST_STORAGE_KEY)).toBe('1');
  });
});
