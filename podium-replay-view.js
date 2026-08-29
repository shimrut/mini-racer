import { EXTRA_CAR_ASSETS } from './game/car/car-unlock-policy.js';
import { CarSpriteLoader, sanitizeCarSpriteAsset } from './game/car/sprite.js';
import { interpolatePbGhostPose, normalizePbGhostRecord } from './game/ghost/pb-ghost.js';
import { isLocalEnvironment } from './game/track/environment.js';
import { buildTrackGeometry } from './game/track/runtime.js';
import { TRACKS } from './game/track/tracks.js';
import { renderTrackPreviewCanvas } from './game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from './game/track/presentation.js';

export const PODIUM_REPLAY_RATES = Object.freeze([0.5, 1, 2]);
export const PODIUM_REPLAY_CAR_ASSETS = Object.freeze({
    1: EXTRA_CAR_ASSETS.gold,
    2: EXTRA_CAR_ASSETS.arctic,
    3: EXTRA_CAR_ASSETS.blaze,
});

const carLoader = new CarSpriteLoader();
const carImages = new Map();
let carLoadPromise = null;

export function formatPodiumReplayClock(timeMs) {
    const totalMilliseconds = Math.max(0, Math.round(Number(timeMs) || 0));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function loadReplayCars() {
    if (carLoadPromise) return carLoadPromise;
    if (typeof Image === 'undefined') {
        carLoadPromise = Promise.resolve([]);
        return carLoadPromise;
    }
    carLoadPromise = Promise.all([1, 2, 3].map((rank) => {
        const assetName = PODIUM_REPLAY_CAR_ASSETS[rank];
        const record = carLoader.prefetch(assetName);
        if (!record?.promise) return null;
        return record.promise
            .then((image) => {
                const sprite = sanitizeCarSpriteAsset(image);
                carImages.set(rank, sprite);
                return sprite;
            })
            .catch(() => null);
    }));
    return carLoadPromise;
}

export function normalizePodiumReplayGhosts(payload) {
    const slots = Array.isArray(payload?.ghosts) ? payload.ghosts : [];
    const byRank = new Map();
    for (const slot of slots) {
        const rank = Number(slot?.rank);
        if (rank !== 1 && rank !== 2 && rank !== 3) continue;
        const record = normalizePbGhostRecord({ ghost: slot.ghost });
        if (record) byRank.set(rank, record);
    }
    return {
        trackKey: typeof payload?.trackKey === 'string' ? payload.trackKey : null,
        records: byRank,
        durationMs: Math.max(0, ...Array.from(byRank.values(), (record) => record.finishTimeMs)),
    };
}

export function shouldUseLocalPodiumPreview(root = globalThis) {
    if (!isLocalEnvironment()) return false;
    const search = root?.location?.search || '';
    return new URLSearchParams(search).get('preview') === '1';
}

const PREVIEW_FINISH_MS = Object.freeze({ 1: 10193, 2: 10199, 3: 10227 });
const PREVIEW_LANE_OFFSET = Object.freeze({ 1: 0, 2: 0.32, 3: -0.32 });

function shortestAngleDeltaMilli(next, previous) {
    const halfTurn = Math.round(Math.PI * 1000);
    const fullTurn = halfTurn * 2;
    let delta = next - previous;
    while (delta > halfTurn) delta -= fullTurn;
    while (delta < -halfTurn) delta += fullTurn;
    return delta;
}

function encodeGhostFromSamples(samples) {
    if (!Array.isArray(samples) || samples.length < 2) return null;
    const origin = [
        Math.round(samples[0].x * 100),
        Math.round(samples[0].y * 100),
        Math.round(samples[0].angle * 1000),
    ];
    let xCm = origin[0];
    let yCm = origin[1];
    let angleMilli = origin[2];
    const deltas = [];
    for (let i = 1; i < samples.length; i += 1) {
        const nextX = Math.round(samples[i].x * 100);
        const nextY = Math.round(samples[i].y * 100);
        const nextAngle = Math.round(samples[i].angle * 1000);
        const dAngle = shortestAngleDeltaMilli(nextAngle, angleMilli);
        deltas.push(nextX - xCm, nextY - yCm, dAngle);
        xCm = nextX;
        yCm = nextY;
        angleMilli += dAngle;
    }
    return {
        schemaVersion: 2,
        sampleIntervalMs: 50,
        finishTimeMs: samples[samples.length - 1].timeMs,
        origin,
        deltas,
    };
}

function trackMidline(track) {
    const geometry = buildTrackGeometry({
        outer: track.outer,
        inner: track.inner,
        cornerRadius: track.cornerRadius ?? 3,
    });
    const count = Math.min(geometry.outer.length, geometry.inner.length);
    const points = [];
    for (let i = 0; i < count; i += 1) {
        points.push({
            x: (geometry.outer[i].x + geometry.inner[i].x) / 2,
            y: (geometry.outer[i].y + geometry.inner[i].y) / 2,
        });
    }
    return points;
}

function sampleClosedPath(points, distance) {
    if (!points.length) return { x: 0, y: 0, angle: 0 };
    const total = pathLength(points);
    if (total <= 0) {
        return { x: points[0].x, y: points[0].y, angle: 0 };
    }
    let remaining = ((distance % total) + total) % total;
    for (let i = 0; i < points.length; i += 1) {
        const from = points[i];
        const to = points[(i + 1) % points.length];
        const span = Math.hypot(to.x - from.x, to.y - from.y);
        if (span <= 0.0001) continue;
        if (remaining <= span) {
            const t = remaining / span;
            return {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t,
                angle: Math.atan2(to.y - from.y, to.x - from.x),
            };
        }
        remaining -= span;
    }
    const last = points[0];
    const next = points[1] || points[0];
    return { x: last.x, y: last.y, angle: Math.atan2(next.y - last.y, next.x - last.x) };
}

function pathLength(points) {
    let total = 0;
    for (let i = 0; i < points.length; i += 1) {
        const from = points[i];
        const to = points[(i + 1) % points.length];
        total += Math.hypot(to.x - from.x, to.y - from.y);
    }
    return total;
}

function startDistanceOnPath(points, startPos) {
    if (!startPos || !points.length) return 0;
    let bestDistance = 0;
    let bestScore = Infinity;
    let traveled = 0;
    for (let i = 0; i < points.length; i += 1) {
        const from = points[i];
        const score = Math.hypot(from.x - startPos.x, from.y - startPos.y);
        if (score < bestScore) {
            bestScore = score;
            bestDistance = traveled;
        }
        const to = points[(i + 1) % points.length];
        traveled += Math.hypot(to.x - from.x, to.y - from.y);
    }
    return bestDistance;
}

function createTrackFollowingGhost(track, finishTimeMs, laneOffset) {
    const midline = trackMidline(track);
    const length = pathLength(midline);
    if (length <= 0 || finishTimeMs <= 0) return null;
    const startAt = startDistanceOnPath(midline, track.startPos);
    const sampleCount = Math.ceil(finishTimeMs / 50) + 1;
    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
        const timeMs = i === sampleCount - 1 ? finishTimeMs : i * 50;
        const pose = sampleClosedPath(midline, startAt + length * (timeMs / finishTimeMs));
        const normalX = -Math.sin(pose.angle);
        const normalY = Math.cos(pose.angle);
        samples.push({
            timeMs,
            x: pose.x + normalX * laneOffset,
            y: pose.y + normalY * laneOffset,
            angle: pose.angle,
        });
    }
    return encodeGhostFromSamples(samples);
}

export function createLocalPodiumPreview() {
    const track = TRACKS.circuit;
    return {
        podium: {
            trackName: track.name,
            challengeDate: '2026-08-21',
            lapCount: 1,
            positions: [
                { rank: 1, displayName: 'velvet_wombat', identityType: 'reddit', formattedTime: '0:10.193' },
                { rank: 2, displayName: 'Neon Viper 45', identityType: 'private', formattedTime: '0:10.199' },
                { rank: 3, displayName: 'shimroot', identityType: 'reddit', formattedTime: '0:10.227' },
            ],
        },
        replays: {
            trackKey: 'circuit',
            ghosts: [1, 2, 3].map((rank) => ({
                rank,
                ghost: createTrackFollowingGhost(track, PREVIEW_FINISH_MS[rank], PREVIEW_LANE_OFFSET[rank]),
            })),
        },
    };
}

export async function fetchPodiumReplays(root = globalThis) {
    try {
        const response = await root.fetch('/api/podium/replays');
        if (!response?.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

function resolveTrack(trackKey, trackName) {
    if (typeof trackKey === 'string' && TRACKS[trackKey]) {
        return { trackKey, track: TRACKS[trackKey] };
    }
    if (typeof trackName === 'string') {
        const target = trackName.trim().toLowerCase();
        for (const [key, track] of Object.entries(TRACKS)) {
            if (track && typeof track.name === 'string' && track.name.trim().toLowerCase() === target) {
                return { trackKey: key, track };
            }
        }
    }
    return { trackKey: 'circuit', track: TRACKS.circuit };
}

export function createPodiumReplayController({
    documentRef,
    canvas,
    getTrackName,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    requestFrame = (callback) => (
        typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame(callback)
            : 0
    ),
    cancelFrame = (id) => {
        if (typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(id);
        }
    },
} = {}) {
    const state = {
        mode: 'podium',
        playing: false,
        rate: 1,
        timeMs: 0,
        durationMs: 0,
        records: new Map(),
        visible: new Set([1, 2, 3]),
        trackKey: null,
        trackName: '',
        frameId: 0,
        lastTs: 0,
    };

    function syncChrome() {
        const shell = documentRef?.getElementById('podium-shell');
        const results = documentRef?.getElementById('podium-results');
        const replay = documentRef?.getElementById('podium-replay');
        const playNow = documentRef?.getElementById('podium-play');
        const viewReplays = documentRef?.getElementById('podium-view-replays');
        const back = documentRef?.getElementById('podium-replay-back');
        const clock = documentRef?.getElementById('podium-replay-time');
        const toggle = documentRef?.getElementById('podium-replay-toggle');
        const seek = documentRef?.getElementById('podium-replay-seek');
        const inReplay = state.mode === 'replay';
        if (shell) shell.dataset.mode = state.mode;
        results?.toggleAttribute('inert', inReplay);
        replay?.toggleAttribute('hidden', !inReplay);
        playNow?.toggleAttribute('hidden', inReplay);
        viewReplays?.toggleAttribute('hidden', inReplay || state.records.size === 0);
        back?.toggleAttribute('hidden', !inReplay);
        if (clock) clock.textContent = formatPodiumReplayClock(state.timeMs);
        if (toggle) {
            toggle.disabled = state.durationMs <= 0;
            toggle.dataset.playing = String(state.playing);
            toggle.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
        }
        if (seek) {
            seek.disabled = state.durationMs <= 0;
            seek.max = String(Math.max(1, Math.round(state.durationMs)));
            if (seek.dataset.scrubbing !== '1') {
                seek.value = String(Math.round(state.timeMs));
            }
            const max = Number(seek.max) || 1;
            const value = Number(seek.value) || 0;
            const progress = value / max;
            seek.style.setProperty('--progress', `${progress * 100}%`);
            seek.parentElement?.style.setProperty('--progress-n', String(progress));
        }
        documentRef?.querySelectorAll('.podium-replay__speed').forEach((button) => {
            button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === state.rate));
        });
        documentRef?.querySelectorAll('.podium-replay__car').forEach((button) => {
            const rank = Number(button.dataset.rank);
            const available = state.records.has(rank);
            button.hidden = !available;
            button.disabled = !available;
            button.setAttribute('aria-pressed', String(available && state.visible.has(rank)));
        });
    }

    function paint() {
        if (!canvas || state.mode !== 'replay') return;
        const resolved = resolveTrack(state.trackKey, typeof getTrackName === 'function' ? getTrackName() : '');
        const { trackKey, track } = resolved;
        if (!track) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = globalThis.devicePixelRatio || 1;
        canvas.width = Math.max(100, Math.round(rect.width * dpr));
        canvas.height = Math.max(100, Math.round(rect.height * dpr));

        const schematicCars = [];
        for (const rank of [3, 2, 1]) {
            if (!state.visible.has(rank)) continue;
            const record = state.records.get(rank);
            const image = carImages.get(rank);
            if (!record || !image) continue;
            const pose = interpolatePbGhostPose(record.samples, state.timeMs);
            if (!pose) continue;
            schematicCars.push({
                image,
                x: pose.x,
                y: pose.y,
                angle: pose.angle,
            });
        }

        renderTrackPreviewCanvas(canvas, {
            trackGeometry: { outer: track.outer, inner: track.inner },
            presentation: resolveTrackPresentation(trackKey, {
                surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
            }),
            startLine: track.startLine,
            startPos: track.startPos,
            startAngle: track.startAngle ?? 0,
            transparentBackground: true,
            previewRenderMode: 'schematic',
            hideSchematicStartArrow: true,
            schematicCars,
        });
    }

    function tick(ts) {
        if (state.playing) {
            const elapsed = state.lastTs ? ts - state.lastTs : 0;
            state.timeMs = Math.min(state.durationMs, state.timeMs + elapsed * state.rate);
            if (state.timeMs >= state.durationMs) {
                state.playing = false;
                state.timeMs = state.durationMs;
            }
        }
        state.lastTs = ts;
        paint();
        syncChrome();
        if (state.playing) {
            state.frameId = requestFrame(tick);
        } else {
            state.frameId = 0;
        }
    }

    function startLoop() {
        if (state.frameId || !state.playing) return;
        state.lastTs = 0;
        state.frameId = requestFrame(tick) || 0;
    }

    function stopLoop() {
        if (!state.frameId) return;
        cancelFrame(state.frameId);
        state.frameId = 0;
        state.lastTs = 0;
    }

    return {
        get mode() { return state.mode; },
        get playing() { return state.playing; },
        get rate() { return state.rate; },
        get timeMs() { return state.timeMs; },
        hasGhosts() { return state.records.size > 0; },
        hasGhost(rank) { return state.records.has(Number(rank)); },
        async prepare(payload, trackName) {
            const normalized = normalizePodiumReplayGhosts(payload);
            state.records = normalized.records;
            state.durationMs = normalized.durationMs;
            state.visible = new Set(normalized.records.keys());
            state.trackKey = normalized.trackKey;
            state.trackName = trackName || '';
            await loadReplayCars();
            return normalized.records.size > 0;
        },
        enter() {
            if (state.records.size === 0) return false;
            state.mode = 'replay';
            state.playing = false;
            state.timeMs = 0;
            syncChrome();
            paint();
            requestFrame(() => paint());
            documentRef?.getElementById('podium-replay-toggle')?.focus({ preventScroll: true });
            return true;
        },
        exit() {
            state.mode = 'podium';
            state.playing = false;
            state.timeMs = 0;
            stopLoop();
            syncChrome();
        },
        play() {
            if (state.mode !== 'replay' || state.durationMs <= 0) return;
            if (state.timeMs >= state.durationMs) state.timeMs = 0;
            state.playing = true;
            startLoop();
            syncChrome();
        },
        pause() {
            state.playing = false;
            stopLoop();
            syncChrome();
        },
        togglePlay() {
            if (state.playing) this.pause();
            else this.play();
        },
        seek(timeMs) {
            if (state.mode !== 'replay' || state.durationMs <= 0) return;
            const next = Math.min(state.durationMs, Math.max(0, Number(timeMs) || 0));
            state.timeMs = next;
            if (next >= state.durationMs) state.playing = false;
            if (!state.playing) stopLoop();
            paint();
            syncChrome();
        },
        setVisible(rank, visible) {
            const nextRank = Number(rank);
            if (!state.records.has(nextRank)) return;
            if (visible) state.visible.add(nextRank);
            else state.visible.delete(nextRank);
            paint();
            syncChrome();
        },
        isVisible(rank) {
            return state.visible.has(Number(rank));
        },
        setRate(rate) {
            const next = Number(rate);
            if (!PODIUM_REPLAY_RATES.includes(next)) return;
            state.rate = next;
            syncChrome();
        },
        advance(ms) {
            tick((state.lastTs || now()) + Number(ms) || 0);
        },
        paint,
        syncChrome,
    };
}
