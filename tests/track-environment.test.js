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
  it('merges by default', () => {
    expect(shouldMergeGameCanvases('')).toBe(true);
    expect(shouldMergeGameCanvases('?other=1')).toBe(true);
    expect(shouldMergeGameCanvases('?canvas=1')).toBe(true);
  });

  it('restores the stacked pair for either accepted spelling of the flag', () => {
    expect(shouldMergeGameCanvases('?canvas=2')).toBe(false);
    expect(shouldMergeGameCanvases('?canvas=stacked')).toBe(false);
    expect(shouldMergeGameCanvases('?debug=1&canvas=2')).toBe(false);
  });
});
