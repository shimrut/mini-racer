import { describe, expect, it } from 'vitest';
import { replayPose, resolveDestination } from '../LP/v2.js';

describe('landing preview race destinations', () => {
  it('keeps the race fallback when only Community is configured', () => {
    const race = 'https://www.reddit.com/r/MiniRacerGame/comments/daily/';
    expect(resolveDestination('daily', race, { daily: '', community: 'https://www.reddit.com/r/MiniRacerGame/' })).toBe(race);
    expect(resolveDestination('daily', race, { daily: '  ' })).toBe(race);
  });
  it('uses only the named mode override', () => {
    expect(resolveDestination('daily', '/fallback', { daily: ' https://example.com/daily ', campaign: 'https://example.com/campaign' })).toBe('https://example.com/daily');
    expect(resolveDestination('campaign', '/fallback', { daily: 'https://example.com/daily' })).toBe('/fallback');
  });
});

describe('landing preview recorded lap playback', () => {
  const frames = [{ t: 0, x: 10, y: 20, angle: Math.PI - .1 }, { t: 100, x: 30, y: 40, angle: -Math.PI + .1 }];
  it('holds the true start and finish outside the recorded interval', () => {
    expect(replayPose(frames, -100)).toBe(frames[0]);
    expect(replayPose(frames, 200)).toBe(frames[1]);
  });
  it('interpolates through a wrapped heading without spinning the car', () => {
    const pose = replayPose(frames, 50);
    expect(pose.x).toBe(20);
    expect(pose.y).toBe(30);
    expect(pose.angle).toBeCloseTo(Math.PI);
  });
});
