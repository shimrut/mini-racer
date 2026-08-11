import { afterEach, describe, expect, it } from 'vitest';
import {
  isLocalEnvironment,
  shouldAutoRetryVerificationQueue,
  shouldExposeDebugHooks,
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
