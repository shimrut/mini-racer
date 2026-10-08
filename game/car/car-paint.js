import { DRAWN_CAR_ASSET_NAMES } from './drawn-car-skins.js';
import { isHexColor } from './drawn-car/paint.js';

export const CAR_PAINT_COLORS = Object.freeze([
    Object.freeze({ id: 'white', label: 'White', value: '#f4f6ff' }),
    Object.freeze({ id: 'orange', label: 'Orange', value: '#ff851b' }),
    Object.freeze({ id: 'blue', label: 'Blue', value: '#246bff' }),
    Object.freeze({ id: 'red', label: 'Red', value: '#ff303e' }),
    Object.freeze({ id: 'yellow', label: 'Yellow', value: '#ffe34a' }),
    Object.freeze({ id: 'lime', label: 'Lime', value: '#a8ed35' }),
    Object.freeze({ id: 'black', label: 'Black', value: '#252936' }),
]);

export const CAR_PAINT_CHANNELS = Object.freeze([
    Object.freeze({ id: 'main', label: 'Body color' }),
    Object.freeze({ id: 'accent', label: 'Accent color' }),
    Object.freeze({ id: 'tertiary', label: 'Tertiary color' }),
]);

function normalizePaintColor(value) {
    if (typeof value !== 'string') return null;
    const color = value.trim().toLowerCase();
    if (!isHexColor(color)) return null;
    return color.length === 4 ? `#${color.slice(1).replace(/./g, '$&$&')}` : color;
}

// Seven choices with the preset and saved color, each in its nearest palette slot.
export function getCarPaintOptions(preset, current = preset) {
    const options = CAR_PAINT_COLORS.map((color) => ({ ...color }));
    const rgb = (color) => [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
    const include = (value, label, preservePreset) => {
        value = normalizePaintColor(value);
        if (!value || options.some((color) => color.value === value)) return;
        const wanted = rgb(value);
        const distances = options.map((color) => preservePreset && color.value === normalizePaintColor(preset)
            ? Infinity : rgb(color.value).reduce((sum, component, i) => sum + (component - wanted[i]) ** 2, 0));
        const index = distances.indexOf(Math.min(...distances));
        options[index] = { id: label === 'Preset' ? 'preset' : 'saved', label, value };
    };
    include(preset, 'Preset', false);
    include(current, 'Saved color', true);
    return options.map((color) => color.value === normalizePaintColor(preset)
        ? { ...color, id: 'preset', label: 'Preset' } : color);
}

// The catalog limits stored entries and keys; paint never adds assets or changes the car.
export function normalizeCarPaints(value) {
    const paints = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return paints;

    for (const assetName of DRAWN_CAR_ASSET_NAMES) {
        if (!Object.hasOwn(value, assetName)) continue;
        const candidate = value[assetName];
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const channels = {};
        for (const { id } of CAR_PAINT_CHANNELS) {
            if (!Object.hasOwn(candidate, id)) continue;
            const color = normalizePaintColor(candidate[id]);
            if (color) channels[id] = color;
        }
        if (Object.keys(channels).length > 0) paints[assetName] = channels;
    }
    return paints;
}
