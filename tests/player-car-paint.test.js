import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAR_PAINT_COLORS, getCarPaintOptions, normalizeCarPaints } from '../game/car/car-paint.js';
import { getCarPaintColors } from '../game/car/sprite.js';
import { DRAWN_CAR_ASSET_NAMES } from '../game/car/drawn-car-skins.js';
import {
    applyPlayerCarPaints,
    PLAYER_CAR_PAINT_STORAGE_KEY,
    readPlayerCarPaint,
    readPlayerCarPaints,
    writePlayerCarPaint,
} from '../game/car/player-car-paint.js';

const CAR = 'drawn/mr_grip_circuit';
const OTHER_CAR = 'drawn/mr_dirt_rally';

describe('bounded custom car paint', () => {
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
    });

    it('keeps only known drawn assets, paint channels and valid hex colors, including preset values', () => {
        expect(CAR_PAINT_COLORS).toHaveLength(7);
        expect(normalizeCarPaints({
            [CAR]: { main: '#FF303E', accent: '#ffffff', tertiary: '#252936', custom: '#246bff' },
            [OTHER_CAR]: { main: 'red', accent: 'url(evil)' },
            'assets/cars/mr_mr_red.webp': { main: '#246bff' },
            'drawn/custom-red': { main: '#246bff' },
        })).toEqual({ [CAR]: { main: '#ff303e', accent: '#ffffff', tertiary: '#252936' } });
    });

    it('bounds the profile by the fixed catalog and ignores inherited entries or channels', () => {
        const incoming = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [
            `drawn/custom-${i}`, { main: '#246bff' },
        ]));
        for (const name of DRAWN_CAR_ASSET_NAMES) incoming[name] = { main: '#246bff' };
        expect(Object.keys(normalizeCarPaints(incoming))).toEqual([...DRAWN_CAR_ASSET_NAMES]);
        expect(normalizeCarPaints(Object.create({ [CAR]: { main: '#246bff' } }))).toEqual({});
        expect(normalizeCarPaints({ [CAR]: Object.create({ main: '#246bff' }) })).toEqual({});
        for (const malformed of [null, 'red', [], 42, { [CAR]: [] }, { [CAR]: null }]) {
            expect(normalizeCarPaints(malformed)).toEqual({});
        }
    });

    it('preserves the other channels and cars when changing paint, including after a storage reread', () => {
        expect(writePlayerCarPaint(CAR, 'main', '#ff303e')).toEqual({ main: '#ff303e' });
        writePlayerCarPaint(CAR, 'accent', '#f4f6ff');
        writePlayerCarPaint(OTHER_CAR, 'tertiary', '#252936');
        expect(readPlayerCarPaints()).toEqual({
            [CAR]: { main: '#ff303e', accent: '#f4f6ff' },
            [OTHER_CAR]: { tertiary: '#252936' },
        });
        writePlayerCarPaint(CAR, 'main', '#246bff');
        expect(JSON.parse(values.get(PLAYER_CAR_PAINT_STORAGE_KEY))[CAR]).toEqual({
            main: '#246bff', accent: '#f4f6ff',
        });
        expect(readPlayerCarPaint(OTHER_CAR)).toEqual({ tertiary: '#252936' });
    });

    it('leaves valid paint intact after invalid edits and returns no paint for arbitrary names', () => {
        writePlayerCarPaint(CAR, 'main', '#ff303e');
        const before = values.get(PLAYER_CAR_PAINT_STORAGE_KEY);
        expect(writePlayerCarPaint(CAR, 'wheel', '#246bff')).toEqual({ main: '#ff303e' });
        expect(writePlayerCarPaint(CAR, 'main', '#invalid')).toEqual({ main: '#ff303e' });
        expect(writePlayerCarPaint('__proto__', 'main', '#246bff')).toEqual({});
        expect(readPlayerCarPaint('__proto__')).toEqual({});
        expect(values.get(PLAYER_CAR_PAINT_STORAGE_KEY)).toBe(before);
    });

    it('restores a preset channel without dropping the other colors or cars', () => {
        writePlayerCarPaint(CAR, 'main', '#246bff');
        writePlayerCarPaint(CAR, 'accent', '#ffe34a');
        writePlayerCarPaint(OTHER_CAR, 'main', '#ff303e');
        expect(writePlayerCarPaint(CAR, 'main', null)).toEqual({ accent: '#ffe34a' });
        expect(readPlayerCarPaint(OTHER_CAR)).toEqual({ main: '#ff303e' });
        writePlayerCarPaint(CAR, 'accent', null);
        expect(readPlayerCarPaints()).toEqual({ [OTHER_CAR]: { main: '#ff303e' } });
        writePlayerCarPaint(OTHER_CAR, 'main', null);
        expect(values.has(PLAYER_CAR_PAINT_STORAGE_KEY)).toBe(false);
    });

    it('replaces paint with the new owner profile and clears stale paint for absent old profiles', () => {
        writePlayerCarPaint(CAR, 'main', '#ff303e');
        applyPlayerCarPaints({ [OTHER_CAR]: { accent: '#ffe34a' } });
        expect(readPlayerCarPaints()).toEqual({ [OTHER_CAR]: { accent: '#ffe34a' } });
        applyPlayerCarPaints(undefined);
        expect(readPlayerCarPaints()).toEqual({});
        expect(values.has(PLAYER_CAR_PAINT_STORAGE_KEY)).toBe(false);
    });

    it('falls back to no overrides with corrupt storage or outside the browser', () => {
        values.set(PLAYER_CAR_PAINT_STORAGE_KEY, 'null');
        expect(readPlayerCarPaints()).toEqual({});
        global.window = undefined;
        expect(readPlayerCarPaints()).toEqual({});
        expect(applyPlayerCarPaints({ [CAR]: { main: '#246bff' } })).toEqual({
            [CAR]: { main: '#246bff' },
        });
    });
});

describe('truthful seven-color paint choices', () => {
    it.each(DRAWN_CAR_ASSET_NAMES)('includes every actual preset color for %s', (asset) => {
        for (const preset of Object.values(getCarPaintColors(asset))) {
            for (const current of [preset, ...CAR_PAINT_COLORS.map(({ value }) => value), '#123456']) {
                const options = getCarPaintOptions(preset, current);
                expect(options).toHaveLength(7);
                expect(new Set(options.map(({ value }) => value)).size).toBe(7);
                expect(options.filter(({ value }) => value === current)).toHaveLength(1);
                expect(options.some(({ value }) => value === preset)).toBe(true);
                expect(normalizeCarPaints({ [asset]: { main: current } })[asset].main).toBe(current);
            }
        }
    });
});
