import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const circuitFixture = {
    circuit: { gold: 5.44, silver: 6.07, bronze: 6.37, author: 4.0 }
};

describe('author medal', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unmock('../game/medals/medal-times.json');
        vi.resetModules();
    });

    it('awards author when lap is within author ceiling', async () => {
        vi.doMock('../game/medals/medal-times.json', () => ({
            default: circuitFixture
        }));
        const tm = await import('../game/medals/medals.js?v=2.03');
        expect(tm.getMedalForLapTime('circuit', 3.99)).toBe('author');
        expect(tm.getMedalForLapTime('circuit', 4.5)).toBe('gold');
    });

    it('ignores author time that is not stricter than gold', async () => {
        vi.doMock('../game/medals/medal-times.json', () => ({
            default: {
                circuit: { gold: 5.44, silver: 6.07, bronze: 6.37, author: 99.0 }
            }
        }));
        const tm = await import('../game/medals/medals.js?v=2.03');
        const t = tm.getTrackMedalThresholds('circuit');
        expect(tm.getMedalForLapTime('circuit', t.gold - 0.1)).toBe('gold');
        expect(tm.getNextMedalTarget('circuit', 'gold')).toBe(null);
    });

    it('next tier after gold is author when configured', async () => {
        vi.doMock('../game/medals/medal-times.json', () => ({
            default: circuitFixture
        }));
        const tm = await import('../game/medals/medals.js?v=2.03');
        expect(tm.getNextMedalTarget('circuit', 'gold')).toEqual({ tier: 'author', maxSeconds: 4 });
        expect(tm.getNextMedalTarget('circuit', 'author')).toBe(null);
    });

    it('time to beat after gold targets author; at author stays on author ceiling', async () => {
        vi.doMock('../game/medals/medal-times.json', () => ({
            default: circuitFixture
        }));
        const tm = await import('../game/medals/medals.js?v=2.03');
        expect(tm.getTimeToBeatSeconds('circuit', 'gold')).toBe(4);
        expect(tm.getTimeToBeatSeconds('circuit', 'author')).toBe(4);
    });

    it('includes author in targets line when active', async () => {
        vi.doMock('../game/medals/medal-times.json', () => ({
            default: circuitFixture
        }));
        const tm = await import('../game/medals/medals.js?v=2.03');
        const line = tm.formatMedalTargetsLine('circuit');
        expect(line).toContain('Author');
        expect(line).toContain('Gold');
    });
});
