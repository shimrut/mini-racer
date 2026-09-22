import { buildTrackCanvas } from './canvas.js';
import { buildCollisionRuntime, buildTrackGeometry } from './runtime.js';

const geometryCache = new Map();
const runtimeCache = new Map();
const canvasCache = new Map();
const GEOMETRY_CACHE_LIMIT = 16;
const RUNTIME_CACHE_LIMIT = 8;
const CANVAS_CACHE_LIMIT = 7;

function getGeometryCacheKey(trackKey, { qualityLevel = 0, frameSkip = 0 } = {}) {
    return `${trackKey}:${qualityLevel}:${frameSkip}`;
}

function getCanvasCacheKey(trackKey, {
    qualityLevel = 0,
    frameSkip = 0,
    presentation = null
} = {}) {
    return `${trackKey}:${qualityLevel}:${frameSkip}:${presentation?.key || 'default'}`;
}

function getCachedValue(cache, key) {
    if (!cache.has(key)) return null;

    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function trimCache(cache, limit) {
    while (cache.size > limit) {
        cache.delete(cache.keys().next().value);
    }
}

function cacheValue(cache, key, value, limit) {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.set(key, value);
    trimCache(cache, limit);
    return value;
}

export function getTrackPreviewGeometry(trackKey, track, options = {}) {
    const key = getGeometryCacheKey(trackKey, options);
    let geometry = getCachedValue(geometryCache, key);
    if (!geometry) {
        geometry = buildTrackGeometry(track, options);
        cacheValue(geometryCache, key, geometry, GEOMETRY_CACHE_LIMIT);
    }
    return geometry;
}

export function getTrackRuntimeAsset(trackKey, track, options = {}) {
    const key = getGeometryCacheKey(trackKey, options);
    let runtime = getCachedValue(runtimeCache, key);
    if (!runtime) {
        const geometry = getTrackPreviewGeometry(trackKey, track, options);
        runtime = {
            ...geometry,
            ...buildCollisionRuntime(geometry)
        };
        cacheValue(runtimeCache, key, runtime, RUNTIME_CACHE_LIMIT);
    }
    return runtime;
}

export function getTrackCanvasAsset(trackKey, track, options = {}) {
    const key = getCanvasCacheKey(trackKey, options);
    let canvasAsset = getCachedValue(canvasCache, key);
    if (!canvasAsset) {
        const geometry = getTrackPreviewGeometry(trackKey, track, options);
        canvasAsset = buildTrackCanvas(track, geometry, options.presentation || null);
        // Do not resize; active races draw it.
        cacheValue(canvasCache, key, canvasAsset, CANVAS_CACHE_LIMIT);
    }
    return canvasAsset;
}
