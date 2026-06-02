import { buildTrackCanvas } from './canvas.js?v=2.09';
import { buildCollisionRuntime, buildTrackGeometry } from './runtime.js?v=2.09';

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

function trimCache(cache, limit, onEvict = null) {
    while (cache.size > limit) {
        const oldestKey = cache.keys().next().value;
        const oldestValue = cache.get(oldestKey);
        cache.delete(oldestKey);
        onEvict?.(oldestValue, oldestKey);
    }
}

function cacheValue(cache, key, value, limit, onEvict = null) {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.set(key, value);
    trimCache(cache, limit, onEvict);
    return value;
}

function releaseCanvasAsset(canvasAsset) {
    if (!canvasAsset?.canvas) return;

    canvasAsset.canvas.width = 0;
    canvasAsset.canvas.height = 0;
    canvasAsset.canvas = null;
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
        cacheValue(canvasCache, key, canvasAsset, CANVAS_CACHE_LIMIT, releaseCanvasAsset);
    }
    return canvasAsset;
}
