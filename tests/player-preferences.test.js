import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAYER_CAR_SKINS } from '../game/car/player-car-skin.js';
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
            crashAutoRestartEnabled: false,
            crashRestartDelaySec: 0.8,
        };

        expect(applyPlayerPreferences(expected)).toBe(true);
        expect(readPlayerPreferences()).toEqual(expected);
    });
});
