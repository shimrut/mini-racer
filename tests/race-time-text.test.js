import { describe, expect, it } from 'vitest';
import { formatRaceTime } from '../src/server/shared/format-race-time.ts';
import { formatLobbyTime } from '../game/lobby/service.js';

describe('m:ss.mmm race time text', () => {
    it('keeps the podium post time text', () => {
        expect(formatRaceTime(0)).toBe('0:00.000');
        expect(formatRaceTime(7100)).toBe('0:07.100');
        expect(formatRaceTime(65432.4)).toBe('1:05.432');
        expect(formatRaceTime(65432.5)).toBe('1:05.433');
        expect(formatRaceTime(600000)).toBe('10:00.000');
        expect(formatRaceTime(-5)).toBe('0:00.000');
    });

    it('keeps the lobby time text', () => {
        expect(formatLobbyTime(7100)).toBe('0:07.100');
        expect(formatLobbyTime(65432.5)).toBe('1:05.433');
        expect(formatLobbyTime('7100')).toBe('0:07.100');
        expect(formatLobbyTime(null)).toBe('--:--.---');
        expect(formatLobbyTime(undefined)).toBe('--:--.---');
        expect(formatLobbyTime('')).toBe('--:--.---');
        expect(formatLobbyTime(-5)).toBe('--:--.---');
        expect(formatLobbyTime(Number.NaN)).toBe('--:--.---');
    });
});
