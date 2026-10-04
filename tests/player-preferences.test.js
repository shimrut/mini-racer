import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAYER_CAR_SKINS } from '../game/car/player-car-skin.js';
import { writePlayerCarPaint } from '../game/car/player-car-paint.js';
import { writePlayerCarDecalStyle } from '../game/car/player-car-decals.js';
import { readPlayerTrailId, writePlayerTrailId } from '../game/car/player-trail.js';
import {
    applyPlayerPreferences,
    readPlayerPreferences,
} from '../game/player/preferences.js';

describe('durable player preferences', () => {
    let originalWindow;

    beforeEach(() => {
        originalWindow = global.window;
        const values = new Map();
        global.window = {
            location: { hostname: 'localhost' },
            localStorage: {
                getItem: (key) => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, String(value)),
                removeItem: (key) => values.delete(key),
            },
        };
    });

    afterEach(() => {
        global.window = originalWindow;
    });

    it('applies a server profile to the browser preference cache', () => {
        const expected = {
            carSkin: PLAYER_CAR_SKINS[1].assetName,
            trailId: 'gold',
            musicEnabled: false,
            carAudioEnabled: true,
            pbGhostEnabled: false,
            pausePlacement: 'separate',
            pauseOnTimerEnabled: false,
            hideHudEnabled: false,
            crashAutoRestartEnabled: false,
            crashRestartDelaySec: 0.8,
            quickRestartEnabled: true,
        };

        expect(applyPlayerPreferences(expected)).toBe(true);
        expect(readPlayerPreferences()).toEqual(expected);
    });

    it('defaults old server profiles to an enabled PB ghost', () => {
        expect(applyPlayerPreferences({
            carSkin: PLAYER_CAR_SKINS[0].assetName,
            trailId: 'cyan',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: false,
            crashRestartDelaySec: 0.5,
        })).toBe(true);
        expect(readPlayerPreferences().pbGhostEnabled).toBe(true);
        expect(readPlayerPreferences().pauseOnTimerEnabled).toBe(true);
        expect(readPlayerPreferences().pausePlacement).toBe('timer');
        expect(readPlayerPreferences().hideHudEnabled).toBe(false);
        expect(readPlayerPreferences().quickRestartEnabled).toBe(false);
    });

    it('sends paint in preferences and replaces it when another owner profile is applied', () => {
        const car = 'drawn/mr_grip_circuit';
        writePlayerCarPaint(car, 'main', '#246bff');
        expect(readPlayerPreferences().carPaints).toEqual({ [car]: { main: '#246bff' } });
        const next = {
            ...readPlayerPreferences(),
            carPaints: { 'drawn/mr_dirt_rally': { accent: '#ffe34a' } },
        };
        applyPlayerPreferences(next);
        expect(readPlayerPreferences().carPaints).toEqual(next.carPaints);
        delete next.carPaints;
        applyPlayerPreferences(next);
        expect(readPlayerPreferences()).not.toHaveProperty('carPaints');
    });

    it('sends per-skin trails and replaces them without leaking another owner choices', () => {
        const car = 'drawn/formula-red';
        writePlayerTrailId('gold');
        writePlayerTrailId('none', car);
        expect(readPlayerPreferences()).toMatchObject({ trailId: 'gold', carTrails: { [car]: 'none' } });
        const next = { ...readPlayerPreferences(), carTrails: { 'drawn/formula-gold': 'coral' } };
        applyPlayerPreferences(next);
        expect(readPlayerPreferences().carTrails).toEqual(next.carTrails);
        expect(readPlayerTrailId(car)).toBe('gold');
        delete next.carTrails;
        applyPlayerPreferences(next);
        expect(readPlayerPreferences()).not.toHaveProperty('carTrails');
        expect(readPlayerTrailId('drawn/formula-gold')).toBe('gold');
    });

    it('sends independent decal styles and replaces owner maps while leaving null profiles alone', () => {
        const car = 'drawn/formula-red';
        writePlayerCarDecalStyle(car, car);
        writePlayerCarDecalStyle('drawn/formula-gold', 'drawn/formula-lime');
        const original = readPlayerPreferences();
        expect(original.carDecals).toEqual({ [car]: car, 'drawn/formula-gold': 'drawn/formula-lime' });
        expect(applyPlayerPreferences(null)).toBe(false);
        expect(readPlayerPreferences()).toEqual(original);
        const next = { ...original, carDecals: { 'drawn/mr_grip_circuit': 'drawn/mr_grip_circuit-blue' } };
        expect(applyPlayerPreferences(next)).toBe(true);
        expect(readPlayerPreferences().carDecals).toEqual(next.carDecals);
        delete next.carDecals;
        applyPlayerPreferences(next);
        expect(readPlayerPreferences()).not.toHaveProperty('carDecals');
    });
});
