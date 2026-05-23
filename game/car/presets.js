import {
    DEFAULT_PHYSICS_TUNING,
    normalizePhysicsConfig
} from './handling.js';

/** Single stock visual preset. Physics lives in handling.js. */
export const STOCK_PHYSICS_PRESET = Object.freeze({
    key: 'stock',
    label: 'Open wheel'
});

export function getPhysicsPresetForConfig(_config = {}) {
    return STOCK_PHYSICS_PRESET;
}

export function resolvePhysicsConfig(config = {}) {
    return normalizePhysicsConfig(config, DEFAULT_PHYSICS_TUNING);
}
