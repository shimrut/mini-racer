import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCarDecalStyleOptions, normalizeCarDecals, normalizeCarDecalStyle } from '../game/car/car-decals.js';
import { DRAWN_CAR_ASSET_NAMES, DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';
import {
    PLAYER_CAR_DECALS_STORAGE_KEY,
    applyPlayerCarDecals,
    readPlayerCarDecals,
    readPlayerCarDecalStyle,
    writePlayerCarDecalStyle,
} from '../game/car/player-car-decals.js';

const RED = 'drawn/formula-red';
const GOLD = 'drawn/formula-gold';
const LIME = 'drawn/formula-lime';
const CIRCUIT = 'drawn/mr_grip_circuit';
const CIRCUIT_BLUE = 'drawn/mr_grip_circuit-blue';

describe('compatible paired decal styles', () => {
    it.each(DRAWN_CAR_ASSET_NAMES)('reuses the existing same-model styles for %s', (asset) => {
        const options = getCarDecalStyleOptions(asset);
        expect(options).toEqual(DRAWN_CAR_ASSET_NAMES.filter((name) => DRAWN_CAR_SKINS[name].car === DRAWN_CAR_SKINS[asset].car)
            .map((name) => ({ id: name, label: DRAWN_CAR_SKINS[name].label })));
        expect(options).toHaveLength(DRAWN_CAR_SKINS[asset].car === 'formula' ? 4 : 5);
        for (const { id } of options) expect(normalizeCarDecalStyle(asset, id)).toBe(id);
    });

    it('rejects Legacy and cross-model choices and normalizes whitespace', () => {
        expect(getCarDecalStyleOptions('assets/cars/mr_mr_red.webp')).toEqual([]);
        expect(getCarDecalStyleOptions('__proto__')).toEqual([]);
        expect(normalizeCarDecalStyle(RED, ` ${GOLD} `)).toBe(GOLD);
        expect(normalizeCarDecalStyle(RED, CIRCUIT_BLUE)).toBeNull();
        expect(normalizeCarDecalStyle('assets/cars/mr_mr_red.webp', GOLD)).toBeNull();
        expect(normalizeCarDecalStyle(RED, { id: GOLD })).toBeNull();
    });

    it('bounds the map and preserves explicit original styles without admitting inherited or malformed choices', () => {
        const incoming = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`drawn/custom-${i}`, GOLD]));
        for (const name of DRAWN_CAR_ASSET_NAMES) incoming[name] = name;
        expect(Object.keys(normalizeCarDecals(incoming))).toEqual([...DRAWN_CAR_ASSET_NAMES]);
        expect(normalizeCarDecals({ [RED]: RED, [GOLD]: LIME, [CIRCUIT]: GOLD })).toEqual({ [RED]: RED, [GOLD]: LIME });
        expect(normalizeCarDecals(Object.create({ [RED]: GOLD }))).toEqual({});
        for (const malformed of [null, [], RED, 42, { [RED]: [] }, { [RED]: null }]) {
            expect(normalizeCarDecals(malformed)).toEqual({});
        }
    });
});

describe('per-skin decal preference cache', () => {
    let originalWindow;
    let values;

    beforeEach(() => {
        originalWindow = global.window;
        values = new Map();
        global.window = {
            localStorage: {
                getItem: (key) => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, String(value)),
                removeItem: (key) => values.delete(key),
            },
        };
    });

    afterEach(() => {
        global.window = originalWindow;
        vi.restoreAllMocks();
    });

    it('keeps independent choices through storage rereads, including explicit original styles', () => {
        expect(readPlayerCarDecalStyle(RED)).toBeNull();
        expect(writePlayerCarDecalStyle(RED, GOLD)).toBe(GOLD);
        expect(writePlayerCarDecalStyle(GOLD, GOLD)).toBe(GOLD);
        writePlayerCarDecalStyle(CIRCUIT, CIRCUIT_BLUE);
        expect(readPlayerCarDecals()).toEqual({ [RED]: GOLD, [GOLD]: GOLD, [CIRCUIT]: CIRCUIT_BLUE });
        expect(JSON.parse(values.get(PLAYER_CAR_DECALS_STORAGE_KEY))).toEqual(readPlayerCarDecals());
        expect(readPlayerCarDecalStyle(RED)).toBe(GOLD);
    });

    it('removes only the requested skin on reset and removes the empty storage key', () => {
        writePlayerCarDecalStyle(RED, GOLD);
        writePlayerCarDecalStyle(GOLD, LIME);
        expect(writePlayerCarDecalStyle(RED, null)).toBeNull();
        expect(readPlayerCarDecals()).toEqual({ [GOLD]: LIME });
        writePlayerCarDecalStyle(GOLD, null);
        expect(values.has(PLAYER_CAR_DECALS_STORAGE_KEY)).toBe(false);
    });

    it('preserves valid choices after incompatible or unknown edits', () => {
        writePlayerCarDecalStyle(RED, GOLD);
        const before = values.get(PLAYER_CAR_DECALS_STORAGE_KEY);
        expect(writePlayerCarDecalStyle(RED, CIRCUIT_BLUE)).toBe(GOLD);
        expect(writePlayerCarDecalStyle(RED, undefined)).toBe(GOLD);
        expect(writePlayerCarDecalStyle('__proto__', GOLD)).toBeNull();
        expect(readPlayerCarDecalStyle('assets/cars/mr_mr_red.webp')).toBeNull();
        expect(values.get(PLAYER_CAR_DECALS_STORAGE_KEY)).toBe(before);
    });

    it('replaces owner maps and clears stale choices for profiles without decals', () => {
        writePlayerCarDecalStyle(RED, GOLD);
        applyPlayerCarDecals({ [CIRCUIT]: CIRCUIT_BLUE });
        expect(readPlayerCarDecals()).toEqual({ [CIRCUIT]: CIRCUIT_BLUE });
        expect(readPlayerCarDecalStyle(RED)).toBeNull();
        applyPlayerCarDecals(undefined);
        expect(readPlayerCarDecals()).toEqual({});
        expect(values.has(PLAYER_CAR_DECALS_STORAGE_KEY)).toBe(false);
    });

    it('safely defaults with corrupt storage or outside the browser', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        values.set(PLAYER_CAR_DECALS_STORAGE_KEY, '{');
        expect(readPlayerCarDecals()).toEqual({});
        expect(error).toHaveBeenCalled();
        global.window = undefined;
        expect(readPlayerCarDecals()).toEqual({});
        expect(applyPlayerCarDecals({ [RED]: GOLD })).toEqual({ [RED]: GOLD });
    });
});
