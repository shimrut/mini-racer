import { afterEach, describe, expect, it } from 'vitest';
import {
  isLocalEnvironment,
  shouldAutoRetryVerificationQueue,
  shouldExposeDebugHooks,
  shouldMergeGameCanvases,
} from '../game/track/environment.js';

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
});

function setLocation(hostname, protocol = 'http:') {
  globalThis.window = {
    location: { hostname, protocol },
  };
}

describe('runtime environment detection', () => {
  it('treats the local development hostname alias as local', () => {
    setLocation('shimrut.local');

    expect(isLocalEnvironment()).toBe(true);
    expect(shouldExposeDebugHooks()).toBe(true);
    expect(shouldAutoRetryVerificationQueue()).toBe(false);
  });

  it('does not treat hosted domains as local', () => {
    setLocation('mini-racer.example.com');

    expect(isLocalEnvironment()).toBe(false);
    expect(shouldExposeDebugHooks()).toBe(false);
    expect(shouldAutoRetryVerificationQueue()).toBe(true);
  });
});

describe('merged game canvas mode', () => {
  it('keeps the stacked pair unless the merge flag is explicitly set', () => {
    expect(shouldMergeGameCanvases('')).toBe(false);
    expect(shouldMergeGameCanvases('?canvas=2')).toBe(false);
    expect(shouldMergeGameCanvases('?other=1')).toBe(false);
  });

  it('merges for either accepted spelling of the flag', () => {
    expect(shouldMergeGameCanvases('?canvas=1')).toBe(true);
    expect(shouldMergeGameCanvases('?canvas=merged')).toBe(true);
    expect(shouldMergeGameCanvases('?debug=1&canvas=1')).toBe(true);
  });
});
