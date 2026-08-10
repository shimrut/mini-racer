import { CONFIG } from '../game/config.js';
import { DEFAULT_TRACK_KEY } from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import { getTrackCanvasAsset, getTrackRuntimeAsset } from '../game/track/assets.js';
import { updateSimulation } from '../game/race/simulation.js';
import { RingBuffer } from '../game/race/ring-buffer.js';

const MP4_MUXER_CDN = 'https://esm.sh/mp4-muxer@5.2.3';

const ROUTE_SAMPLE_COUNT = 240;
const EXPORT_FPS = 60;
const CLIP_MIN_DURATION_SEC = 4;
const CLIP_MAX_DURATION_SEC = 20;
const SEAMLESS_BLEND_SEC = 0.35;

const ASPECT_RATIOS = [
    {
        id: '9-16',
        name: '9:16 Vertical (TikTok / Reels / Shorts)',
        width: 1080,
        height: 1920,
        layout: 'vertical',
        safeZones: { top: 220, right: 260, bottom: 480, left: 60 }
    },
    {
        id: '4-5',
        name: '4:5 Portrait (Instagram Feed)',
        width: 1080,
        height: 1350,
        layout: 'vertical',
        safeZones: { top: 100, right: 60, bottom: 200, left: 60 }
    },
    {
        id: '1-1',
        name: '1:1 Square (Feed / Ads)',
        width: 1080,
        height: 1080,
        layout: 'vertical',
        safeZones: { top: 80, right: 60, bottom: 120, left: 60 }
    },
    {
        id: '16-9',
        name: '16:9 Landscape (YouTube / Google Ads)',
        width: 1920,
        height: 1080,
        layout: 'horizontal',
        safeZones: { top: 80, right: 80, bottom: 120, left: 80 }
    }
];

const DISPLAY_BANNERS = [
    { id: 'medium-rectangle', name: 'Medium Rectangle', width: 300, height: 250 },
    { id: 'large-rectangle', name: 'Large Rectangle', width: 336, height: 280 },
    { id: 'leaderboard', name: 'Leaderboard', width: 728, height: 90 },
    { id: 'large-mobile-banner', name: 'Large Mobile Banner', width: 320, height: 100 },
    { id: 'mobile-banner', name: 'Mobile Banner', width: 320, height: 50 },
    { id: 'wide-skyscraper', name: 'Wide Skyscraper', width: 300, height: 600 },
    { id: 'half-page', name: 'Half Page', width: 300, height: 600 },
    { id: 'billboard', name: 'Billboard', width: 970, height: 250 }
];

function getAspectRatio(id) {
    return ASPECT_RATIOS.find((candidate) => candidate.id === id) ?? ASPECT_RATIOS[0];
}
const REPLAY_SIM_DT = 1 / 60;
const REPLAY_MIN_DURATION_SEC = 8;
const REPLAY_MAX_DURATION_SEC = 210;
const REPLAY_SIM_BUFFER_SEC = 2;
const REPLAY_CONTROLLER_SAMPLE_COUNT = 360;
const CAMERA_SMOOTH_OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
const CAMERA_SMOOTH_WEIGHTS = [1, 2, 3, 4, 3, 2, 1];
const CAMERA_LOOK_AHEAD_SEC = 0.18;
const CAMERA_LOOK_AHEAD_BLEND = 0.38;
const REPLAY_CONTROLLER_CANDIDATES = [
    { baseLA: 1, speedLA: 0.1, minLA: 1, maxLA: 8, baseTh: 0.03, speedTh: 0, scanAhead: 24, scanBack: 4 },
    { baseLA: 1, speedLA: 0.15, minLA: 1, maxLA: 10, baseTh: 0.04, speedTh: 0.002, scanAhead: 24, scanBack: 4 },
    { baseLA: 2, speedLA: 0.2, minLA: 1, maxLA: 10, baseTh: 0.04, speedTh: 0.003, scanAhead: 28, scanBack: 4 },
    { baseLA: 2, speedLA: 0.25, minLA: 1, maxLA: 12, baseTh: 0.05, speedTh: 0.004, scanAhead: 32, scanBack: 4 },
    { baseLA: 2, speedLA: 0.3, minLA: 2, maxLA: 12, baseTh: 0.06, speedTh: 0.006, scanAhead: 36, scanBack: 4 },
    { baseLA: 3, speedLA: 0.2, minLA: 2, maxLA: 12, baseTh: 0.05, speedTh: 0.004, scanAhead: 32, scanBack: 8 },
    { baseLA: 3, speedLA: 0.3, minLA: 2, maxLA: 14, baseTh: 0.07, speedTh: 0.006, scanAhead: 40, scanBack: 8 },
    { baseLA: 4, speedLA: 0.15, minLA: 2, maxLA: 10, baseTh: 0.05, speedTh: 0.002, scanAhead: 24, scanBack: 8 },
    { baseLA: 4, speedLA: 0.25, minLA: 2, maxLA: 14, baseTh: 0.08, speedTh: 0.008, scanAhead: 40, scanBack: 8 },
    { baseLA: 5, speedLA: 0.35, minLA: 2, maxLA: 16, baseTh: 0.09, speedTh: 0.01, scanAhead: 48, scanBack: 8 },
    { baseLA: 4, speedLA: 0.19717457811682634, minLA: 4, maxLA: 8, baseTh: 0.03554344064359932, speedTh: 0.011682808159145967, scanAhead: 44, scanBack: 10 }
];
const REPLAY_PATH_VARIANTS = [
    { sampleCount: REPLAY_CONTROLLER_SAMPLE_COUNT, iterations: 0, lateralBias: 0 },
    { sampleCount: REPLAY_CONTROLLER_SAMPLE_COUNT, iterations: 20, lateralBias: 0 },
    { sampleCount: REPLAY_CONTROLLER_SAMPLE_COUNT, iterations: 60, lateralBias: 0 },
    { sampleCount: REPLAY_CONTROLLER_SAMPLE_COUNT, iterations: 80, lateralBias: 0 },
    { sampleCount: 420, iterations: 20, lateralBias: -0.08462273286221889 }
];
const REPLAY_TRACK_PRESETS = {
    circuit: [{
        path: { sampleCount: 360, iterations: 80, lateralBias: 0 },
        controller: { baseLA: 4, speedLA: 0.15, minLA: 2, maxLA: 10, baseTh: 0.05, speedTh: 0.002, scanAhead: 24, scanBack: 8 }
    }],
    harborParkLoop: [{
        path: { sampleCount: 360, iterations: 80, lateralBias: 0 },
        controller: { baseLA: 4, speedLA: 0.15, minLA: 2, maxLA: 10, baseTh: 0.05, speedTh: 0.002, scanAhead: 24, scanBack: 8 }
    }],
    jadeSpiralCircuit: [{
        path: { sampleCount: 420, iterations: 20, lateralBias: -0.08462273286221889 },
        controller: { baseLA: 4, speedLA: 0.19717457811682634, minLA: 4, maxLA: 8, baseTh: 0.03554344064359932, speedTh: 0.011682808159145967, scanAhead: 44, scanBack: 10 }
    }],
    cedarRidgeCircuit: [{
        path: { sampleCount: 360, iterations: 80, lateralBias: 0 },
        controller: { baseLA: 1, speedLA: 0.1, minLA: 1, maxLA: 8, baseTh: 0.03, speedTh: 0, scanAhead: 24, scanBack: 4 }
    }],
    sakuraWeave: [{
        path: { sampleCount: 360, iterations: 60, lateralBias: 0 },
        controller: { baseLA: 1, speedLA: 0.15, minLA: 1, maxLA: 10, baseTh: 0.04, speedTh: 0.002, scanAhead: 24, scanBack: 4 }
    }]
};

const PROMO_PRESETS = [
    {
        id: 'skill-check',
        name: 'Skill Check',
        headline: 'THIS CORNER RUINS FAST LAPS',
        keyword: 'RUINS',
        subhead: 'Mini Racer hides one braking zone that wrecks clean runs.',
        cta: 'Can you beat this line?',
        mood: 'warning'
    },
    {
        id: 'late-brake',
        name: 'Late Brake',
        headline: 'BRAKE LATE OR BIN IT',
        keyword: 'BIN IT',
        subhead: 'One tiny miss and the whole lap is gone.',
        cta: 'Drop your best time.',
        mood: 'danger'
    },
    {
        id: 'quali-night',
        name: 'Quali Night',
        headline: 'MIDNIGHT QUALI ENERGY',
        keyword: 'MIDNIGHT',
        subhead: 'No assists. No excuses. Just one clean lap.',
        cta: 'Race it at vectorgp.run',
        mood: 'cool'
    },
    {
        id: 'rival-callout',
        name: 'Rival Callout',
        headline: 'YOUR FRIEND THINKS THIS IS EASY',
        keyword: 'EASY',
        subhead: 'Send them this clip and let the stopwatch settle it.',
        cta: 'Tag the driver who folds here.',
        mood: 'mock'
    },
    {
        id: 'pb-attempt',
        name: 'PB Attempt',
        headline: 'NEW PERSONAL BEST',
        keyword: 'BEST',
        subhead: 'Chased the apex for three laps. Found it on the fourth.',
        cta: 'Beat this time.',
        mood: 'victory'
    },
    {
        id: 'one-mistake',
        name: 'One Mistake',
        headline: 'ONE FRAME RUINED EVERYTHING',
        keyword: 'RUINED',
        subhead: 'Everything was fine until turn 3.',
        cta: 'Think you can do better?',
        mood: 'warning'
    },
    {
        id: 'no-mercy',
        name: 'No Mercy',
        headline: 'THE TRACK DOES NOT FORGIVE',
        keyword: 'FORGIVE',
        subhead: 'Every apex asks for commitment. Every mistake takes it back.',
        cta: 'Step up. Or step off.',
        mood: 'danger'
    },
    {
        id: 'daily-grind',
        name: 'Daily Grind',
        headline: "TODAY'S DAILY IS BRUTAL",
        keyword: 'BRUTAL',
        subhead: 'One track. One lap. One leaderboard.',
        cta: 'Claim the top spot.',
        mood: 'warning'
    }
];

function getActivePreset() {
    return PROMO_PRESETS.find((candidate) => candidate.id === state.presetId) ?? PROMO_PRESETS[0];
}

function getHeadlineKeyword() {
    const preset = getActivePreset();
    if (preset?.keyword) {
        const key = preset.keyword.trim().toUpperCase();
        if (key && state.headline.toUpperCase().includes(key)) {
            return key;
        }
    }
    const words = state.headline.toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    return words.reduce((best, word) => (word.length > best.length ? word : best), '');
}

const MOOD_ACCENTS = {
    warning: { color: '#fbbf24', glow: 'rgba(251, 191, 36, 0.55)' },
    danger: { color: '#ef4444', glow: 'rgba(239, 68, 68, 0.6)' },
    cool: { color: '#38bdf8', glow: 'rgba(56, 189, 248, 0.55)' },
    mock: { color: '#f472b6', glow: 'rgba(244, 114, 182, 0.55)' },
    victory: { color: '#22c55e', glow: 'rgba(34, 197, 94, 0.55)' }
};

function getMoodAccent() {
    const preset = getActivePreset();
    return MOOD_ACCENTS[preset?.mood] ?? MOOD_ACCENTS.warning;
}

const THEMES = [
    {
        id: 'neon-apex',
        name: 'Neon Apex',
        skyTop: '#050d16',
        skyBottom: '#111827',
        glowA: 'rgba(34, 197, 94, 0.22)',
        glowB: 'rgba(56, 189, 248, 0.18)',
        panel: '#07131f',
        trackOuter: '#cbd5e1',
        trackInner: '#081018',
        route: '#ff6b6b',
        routeGlow: 'rgba(255, 107, 107, 0.6)',
        accent: '#22c55e',
        accentSoft: 'rgba(34, 197, 94, 0.22)',
        text: '#f8fafc',
        muted: '#9db2c7'
    },
    {
        id: 'sunset-grid',
        name: 'Sunset Grid',
        skyTop: '#18080c',
        skyBottom: '#1b2436',
        glowA: 'rgba(249, 115, 22, 0.2)',
        glowB: 'rgba(250, 204, 21, 0.14)',
        panel: '#18111a',
        trackOuter: '#f5f5f4',
        trackInner: '#100d12',
        route: '#fb7185',
        routeGlow: 'rgba(251, 113, 133, 0.62)',
        accent: '#f59e0b',
        accentSoft: 'rgba(245, 158, 11, 0.22)',
        text: '#fff7ed',
        muted: '#fcd7aa'
    },
    {
        id: 'ice-run',
        name: 'Ice Run',
        skyTop: '#061018',
        skyBottom: '#162030',
        glowA: 'rgba(14, 165, 233, 0.2)',
        glowB: 'rgba(125, 211, 252, 0.18)',
        panel: '#091520',
        trackOuter: '#e2e8f0',
        trackInner: '#08131b',
        route: '#38bdf8',
        routeGlow: 'rgba(56, 189, 248, 0.58)',
        accent: '#06b6d4',
        accentSoft: 'rgba(6, 182, 212, 0.22)',
        text: '#eff6ff',
        muted: '#c7d2fe'
    }
];

const RENDER_MODES = [
    { id: 'trace-preview', name: 'Trace Preview' },
    { id: 'gameplay-replay', name: 'Gameplay Replay' }
];

const TEMPLATE_STYLES = [
    { id: 'classic', name: 'Classic (Trace or Gameplay)' },
    { id: 'arcade-crt', name: 'A · Arcade CRT' },
    { id: 'magazine', name: 'B · Magazine Editorial' },
    { id: 'sticker', name: 'C · Sticker Collage' },
    { id: 'telemetry', name: 'D · Telemetry Printout' },
    { id: 'trading-card', name: 'E · Trading Card' },
    { id: 'cockpit', name: 'F · Cockpit POV' }
];

const el = {
    trackSelect: document.getElementById('track-select'),
    renderModeSelect: document.getElementById('render-mode-select'),
    templateStyleSelect: document.getElementById('template-style-select'),
    presetSelect: document.getElementById('preset-select'),
    themeSelect: document.getElementById('theme-select'),
    aspectSelect: document.getElementById('aspect-select'),
    headlineInput: document.getElementById('headline-input'),
    subheadInput: document.getElementById('subhead-input'),
    ctaInput: document.getElementById('cta-input'),
    lapTimeInput: document.getElementById('lap-time-input'),
    durationInput: document.getElementById('duration-input'),
    handleInput: document.getElementById('handle-input'),
    showGridToggle: document.getElementById('show-grid-toggle'),
    showTimerToggle: document.getElementById('show-timer-toggle'),
    showSafeZonesToggle: document.getElementById('show-safe-zones-toggle'),
    seamlessLoopToggle: document.getElementById('seamless-loop-toggle'),
    shuffleCopyBtn: document.getElementById('shuffle-copy-btn'),
    restartBtn: document.getElementById('restart-btn'),
    playToggleBtn: document.getElementById('play-toggle-btn'),
    exportVideoBtn: document.getElementById('export-video-btn'),
    exportAllAspectsBtn: document.getElementById('export-all-aspects-btn'),
    exportPosterBtn: document.getElementById('export-poster-btn'),
    exportThumbnailPackBtn: document.getElementById('export-thumbnail-pack-btn'),
    exportDisplayPackBtn: document.getElementById('export-display-pack-btn'),
    exportFormatSelect: document.getElementById('export-format-select'),
    exportContentSelect: document.getElementById('export-content-select'),
    promoStatusPill: document.getElementById('promo-status-pill'),
    playbackPill: document.getElementById('playback-pill'),
    statusText: document.getElementById('status-text'),
    trackNameMetric: document.getElementById('track-name-metric'),
    playheadMetric: document.getElementById('playhead-metric'),
    resolutionMetric: document.getElementById('resolution-metric'),
    stageShell: document.getElementById('stage-shell'),
    canvas: document.getElementById('promo-canvas'),
    exportCanvas: document.getElementById('export-canvas')
};

const previewCtx = el.canvas.getContext('2d');
const exportCtx = el.exportCanvas.getContext('2d');
const trackGeometryCache = new Map();
const trackAssetCache = new Map();
const replaySimulationCache = new Map();
const replayPathCache = new Map();

const state = {
    trackKey: DEFAULT_TRACK_KEY,
    renderMode: RENDER_MODES[0].id,
    templateStyle: 'classic',
    presetId: PROMO_PRESETS[0].id,
    themeId: THEMES[0].id,
    aspectId: ASPECT_RATIOS[0].id,
    headline: PROMO_PRESETS[0].headline,
    subhead: PROMO_PRESETS[0].subhead,
    cta: PROMO_PRESETS[0].cta,
    lapTime: 27.48,
    durationSec: 7,
    handle: '@vectorgp.run',
    showGrid: true,
    showTimer: true,
    showSafeZones: false,
    seamlessLoop: true,
    exportFormat: 'auto',
    exportContent: 'promo-clip',
    isPlaying: true,
    playheadMs: 0,
    lastFrameAt: performance.now(),
    exportInProgress: false,
    statusMessage: ''
};

const promoCarSprite = createPromoCarSprite();

function createPromoCarSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.translate(32, 16);

    ctx.fillStyle = CONFIG.tireColor;
    ctx.fillRect(6, -12, 10, 6);
    ctx.fillRect(6, 6, 10, 6);
    ctx.fillRect(-16, -13, 11, 7);
    ctx.fillRect(-16, 6, 11, 7);

    ctx.fillStyle = '#333';
    ctx.fillRect(8, -11, 4, 2);
    ctx.fillRect(8, 7, 4, 2);
    ctx.fillRect(-14, -12, 6, 2);
    ctx.fillRect(-14, 7, 6, 2);

    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(18, -10);
    ctx.lineTo(18, 10);
    ctx.lineTo(14, 8);
    ctx.lineTo(14, -8);
    ctx.fill();

    ctx.fillStyle = CONFIG.carColor;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(6, -3);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-12, -6);
    ctx.lineTo(-14, -2);
    ctx.lineTo(-14, 2);
    ctx.lineTo(-12, 6);
    ctx.lineTo(-6, 6);
    ctx.lineTo(6, 3);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(-4, -6);
    ctx.lineTo(0, -6);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.lineTo(-4, 6);
    ctx.lineTo(0, 6);
    ctx.fill();

    ctx.fillStyle = CONFIG.tireColor;
    ctx.fillRect(-18, -10, 4, 20);
    ctx.fillStyle = CONFIG.carColor;
    ctx.fillRect(-18, -10, 5, 2);
    ctx.fillRect(-18, 8, 5, 2);

    ctx.fillStyle = CONFIG.carAccent;
    ctx.beginPath();
    ctx.arc(-4, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-10, -1, 12, 2);

    return canvas;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - clamp(t, 0, 1), 3);
}

function easeInOutCubic(t) {
    const clamped = clamp(t, 0, 1);
    return clamped < 0.5
        ? 4 * clamped * clamped * clamped
        : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

function pseudoRand(seed) {
    const s = Math.sin(seed * 127.1) * 43758.5453;
    return s - Math.floor(s);
}

function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const clamped = clamp(t, 0, 1);
    return 1 + c3 * Math.pow(clamped - 1, 3) + c1 * Math.pow(clamped - 1, 2);
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function wrapText(ctx, text, maxWidth) {
    const words = String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const lines = [];
    let line = '';

    words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width > maxWidth && line) {
            lines.push(line);
            line = word;
            return;
        }
        line = candidate;
    });

    if (line) {
        lines.push(line);
    }

    return lines;
}

function roundRectPath(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
    ctx.closePath();
}

function tracePath(ctx, points, closePath = false) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    if (closePath) {
        ctx.closePath();
    }
}

function resampleClosedPolygon(points, sampleCount) {
    if (!points?.length) {
        return [];
    }
    if (points.length === 1) {
        return Array.from({ length: sampleCount }, () => ({ ...points[0] }));
    }

    const lengths = [];
    let totalLength = 0;
    for (let i = 0; i < points.length; i += 1) {
        const segmentLength = distance(points[i], points[(i + 1) % points.length]);
        lengths.push(segmentLength);
        totalLength += segmentLength;
    }

    const result = [];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const target = (sampleIndex / sampleCount) * totalLength;
        let walked = 0;
        for (let segmentIndex = 0; segmentIndex < points.length; segmentIndex += 1) {
            const segmentLength = lengths[segmentIndex];
            const nextWalked = walked + segmentLength;
            if (target <= nextWalked || segmentIndex === points.length - 1) {
                const start = points[segmentIndex];
                const end = points[(segmentIndex + 1) % points.length];
                const t = segmentLength === 0 ? 0 : (target - walked) / segmentLength;
                result.push({
                    x: lerp(start.x, end.x, t),
                    y: lerp(start.y, end.y, t)
                });
                break;
            }
            walked = nextWalked;
        }
    }
    return result;
}

function rotateToNearest(points, target) {
    if (!points.length) {
        return [];
    }
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < points.length; i += 1) {
        const candidateDistance = distanceSq(points[i], target);
        if (candidateDistance < bestDistance) {
            bestDistance = candidateDistance;
            bestIndex = i;
        }
    }
    return points.slice(bestIndex).concat(points.slice(0, bestIndex));
}

function orientReplayPath(points, track) {
    const rotated = rotateToNearest(points, track.startPos);
    if (rotated.length < 2) {
        return rotated;
    }

    const forwardAngle = Math.atan2(rotated[1].y - rotated[0].y, rotated[1].x - rotated[0].x);
    const backwardAngle = Math.atan2(
        rotated[rotated.length - 1].y - rotated[0].y,
        rotated[rotated.length - 1].x - rotated[0].x
    );
    const forwardDiff = Math.abs(normalizeAngle(forwardAngle - track.startAngle));
    const backwardDiff = Math.abs(normalizeAngle(backwardAngle - track.startAngle));
    if (backwardDiff + 1e-6 < forwardDiff) {
        return [rotated[0], ...rotated.slice(1).reverse()];
    }
    return rotated;
}

function getProgressPoint(points, progress) {
    if (!points.length) {
        return { x: 0, y: 0 };
    }
    if (points.length === 1) {
        return points[0];
    }
    const scaledIndex = clamp(progress, 0, 1) * (points.length - 1);
    const baseIndex = Math.floor(scaledIndex);
    const nextIndex = Math.min(points.length - 1, baseIndex + 1);
    const t = scaledIndex - baseIndex;
    const start = points[baseIndex];
    const end = points[nextIndex];
    return {
        x: lerp(start.x, end.x, t),
        y: lerp(start.y, end.y, t)
    };
}

function getProgressPath(points, progress) {
    if (!points.length) {
        return [];
    }
    if (progress <= 0) {
        return [points[0]];
    }
    const scaledIndex = clamp(progress, 0, 1) * (points.length - 1);
    const baseIndex = Math.floor(scaledIndex);
    const nextIndex = Math.min(points.length - 1, baseIndex + 1);
    const partial = points.slice(0, baseIndex + 1).map((point) => ({ ...point }));
    if (nextIndex !== baseIndex) {
        partial.push(getProgressPoint(points, progress));
    }
    return partial;
}

function getTrackGeometry(trackKey) {
    if (trackGeometryCache.has(trackKey)) {
        return trackGeometryCache.get(trackKey);
    }

    const track = TRACKS[trackKey];
    const outer = track.outer.map((point) => ({ x: point.x, y: point.y }));
    const inner = track.inner.map((point) => ({ x: point.x, y: point.y }));
    const sampledOuter = resampleClosedPolygon(outer, ROUTE_SAMPLE_COUNT);
    const sampledInner = resampleClosedPolygon(inner, ROUTE_SAMPLE_COUNT);
    const centerline = sampledOuter.map((point, index) => ({
        x: (point.x + sampledInner[index].x) / 2,
        y: (point.y + sampledInner[index].y) / 2
    }));
    const rotatedCenterline = rotateToNearest(centerline, track.startPos);
    const loopedCenterline = rotatedCenterline.concat([{ ...rotatedCenterline[0] }]);
    const boundsPoints = [...outer, ...inner];
    const xs = boundsPoints.map((point) => point.x);
    const ys = boundsPoints.map((point) => point.y);
    const geometry = {
        outer,
        inner,
        centerline: loopedCenterline,
        startLine: {
            p1: { x: track.startLine.p1.x, y: track.startLine.p1.y },
            p2: { x: track.startLine.p2.x, y: track.startLine.p2.y }
        },
        startPos: { x: track.startPos.x, y: track.startPos.y },
        bounds: {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys)
        }
    };
    trackGeometryCache.set(trackKey, geometry);
    return geometry;
}

function getTrackAssets(trackKey) {
    if (trackAssetCache.has(trackKey)) {
        return trackAssetCache.get(trackKey);
    }

    const track = TRACKS[trackKey];
    const geometry = getTrackGeometry(trackKey);
    const runtime = getTrackRuntimeAsset(trackKey, track);
    const trackCanvasAsset = getTrackCanvasAsset(trackKey, track);
    const assets = {
        geometry,
        runtime,
        trackCanvas: trackCanvasAsset.canvas,
        trackCanvasOrigin: trackCanvasAsset.origin
    };

    trackAssetCache.set(trackKey, assets);
    return assets;
}

function mapTrackToRect(trackKey, rect) {
    const geometry = getTrackGeometry(trackKey);
    const { bounds } = geometry;
    const width = bounds.maxX - bounds.minX || 1;
    const height = bounds.maxY - bounds.minY || 1;
    const padding = Math.max(4, Math.min(56, Math.round(Math.min(rect.width, rect.height) * 0.08)));
    const usableWidth = rect.width - padding * 2;
    const usableHeight = rect.height - padding * 2;
    const scale = Math.min(usableWidth / width, usableHeight / height);
    const offsetX = rect.x + padding + (usableWidth - width * scale) / 2;
    const offsetY = rect.y + padding + (usableHeight - height * scale) / 2;
    const mapPoint = (point) => ({
        x: offsetX + (point.x - bounds.minX) * scale,
        y: offsetY + (point.y - bounds.minY) * scale
    });

    return {
        outer: geometry.outer.map(mapPoint),
        inner: geometry.inner.map(mapPoint),
        centerline: geometry.centerline.map(mapPoint),
        startLine: {
            p1: mapPoint(geometry.startLine.p1),
            p2: mapPoint(geometry.startLine.p2)
        }
    };
}

function normalizeAngle(angle) {
    let result = angle;
    while (result > Math.PI) result -= Math.PI * 2;
    while (result < -Math.PI) result += Math.PI * 2;
    return result;
}

function projectPointToLaneFactor(point, outerPoint, innerPoint) {
    const dx = innerPoint.x - outerPoint.x;
    const dy = innerPoint.y - outerPoint.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return 0.5;
    }
    return clamp(
        ((point.x - outerPoint.x) * dx + (point.y - outerPoint.y) * dy) / lenSq,
        0.12,
        0.88
    );
}

function getReplayPathCacheKey(trackKey, pathProfile) {
    const sampleCount = pathProfile.sampleCount ?? REPLAY_CONTROLLER_SAMPLE_COUNT;
    const iterations = pathProfile.iterations ?? 0;
    const lateralBias = pathProfile.lateralBias ?? 0;
    return `${trackKey}:${sampleCount}:${iterations}:${lateralBias.toFixed(6)}`;
}

function buildReplayControllerPath(trackKey, pathProfile = {}) {
    const cacheKey = getReplayPathCacheKey(trackKey, pathProfile);
    if (replayPathCache.has(cacheKey)) {
        return replayPathCache.get(cacheKey);
    }

    const track = TRACKS[trackKey];
    const assets = getTrackAssets(trackKey);
    const outer = assets.runtime?.outer ?? [];
    const inner = assets.runtime?.inner ?? [];
    const pointCount = Math.max(
        pathProfile.sampleCount ?? REPLAY_CONTROLLER_SAMPLE_COUNT,
        outer.length,
        inner.length
    );
    if (!pointCount) {
        const fallbackPath = orientReplayPath(assets.geometry.centerline.slice(0, -1), track);
        replayPathCache.set(cacheKey, fallbackPath);
        return fallbackPath;
    }

    const sampledOuter = resampleClosedPolygon(outer, pointCount);
    const sampledInner = resampleClosedPolygon(inner, pointCount);
    let path = sampledOuter.map((point, index) => ({
        x: lerp(point.x, sampledInner[index].x, 0.5 + (pathProfile.lateralBias ?? 0)),
        y: lerp(point.y, sampledInner[index].y, 0.5 + (pathProfile.lateralBias ?? 0))
    }));

    for (let iteration = 0; iteration < (pathProfile.iterations ?? 0); iteration += 1) {
        path = path.map((point, index) => {
            const prev = path[(index - 1 + path.length) % path.length];
            const next = path[(index + 1) % path.length];
            const desired = {
                x: (prev.x + next.x) / 2,
                y: (prev.y + next.y) / 2
            };
            const laneFactor = projectPointToLaneFactor(desired, sampledOuter[index], sampledInner[index]);
            return {
                x: lerp(sampledOuter[index].x, sampledInner[index].x, laneFactor),
                y: lerp(sampledOuter[index].y, sampledInner[index].y, laneFactor)
            };
        });
    }

    const orientedPath = orientReplayPath(path, track);
    replayPathCache.set(cacheKey, orientedPath);
    return orientedPath;
}

function getReplaySearchCandidates(trackKey) {
    const presetCandidates = REPLAY_TRACK_PRESETS[trackKey] ?? [];
    const fallbackCandidates = [];
    REPLAY_PATH_VARIANTS.forEach((path) => {
        REPLAY_CONTROLLER_CANDIDATES.forEach((controller) => {
            fallbackCandidates.push({ path, controller });
        });
    });
    return [...presetCandidates, ...fallbackCandidates];
}

function interpolateReplaySample(samples, timeSec) {
    if (!samples.length) {
        return {
            x: TRACKS[state.trackKey].startPos.x,
            y: TRACKS[state.trackKey].startPos.y,
            angle: TRACKS[state.trackKey].startAngle,
            speed: 0,
            time: 0
        };
    }
    if (samples.length === 1) {
        return samples[0];
    }

    const clampedTime = clamp(timeSec, 0, samples[samples.length - 1].time);
    const scaledIndex = clampedTime / REPLAY_SIM_DT;
    const baseIndex = Math.min(samples.length - 1, Math.floor(scaledIndex));
    const nextIndex = Math.min(samples.length - 1, baseIndex + 1);
    const t = clamp(scaledIndex - baseIndex, 0, 1);
    const start = samples[baseIndex];
    const end = samples[nextIndex];
    return {
        x: lerp(start.x, end.x, t),
        y: lerp(start.y, end.y, t),
        angle: normalizeAngle(start.angle + normalizeAngle(end.angle - start.angle) * t),
        speed: lerp(start.speed, end.speed, t),
        time: clampedTime
    };
}

function getReplayPathUntilTime(samples, timeSec) {
    if (!samples.length) {
        return [];
    }
    const clampedTime = clamp(timeSec, 0, samples[samples.length - 1].time);
    const scaledIndex = clampedTime / REPLAY_SIM_DT;
    const baseIndex = Math.min(samples.length - 1, Math.floor(scaledIndex));
    const nextIndex = Math.min(samples.length - 1, baseIndex + 1);
    const path = samples.slice(0, baseIndex + 1).map((sample) => ({ x: sample.x, y: sample.y }));
    if (nextIndex !== baseIndex) {
        const interpolated = interpolateReplaySample(samples, clampedTime);
        path.push({ x: interpolated.x, y: interpolated.y });
    }
    return path;
}

function simulateReplayCandidate(trackKey, durationSec, candidate) {
    const track = TRACKS[trackKey];
    const assets = getTrackAssets(trackKey);
    const controller = candidate.controller;
    const path = buildReplayControllerPath(trackKey, candidate.path);
    let nearestIndex = 0;
    let simState = {
        status: 'playing',
        currentTime: 0,
        angle: track.startAngle,
        pos: { ...track.startPos },
        velocity: { x: 0, y: 0 },
        cachedSpeed: 0,
        nextCheckpointIndex: 0,
        skidMarks: new RingBuffer(160, () => ({ x: 0, y: 0, cos: 0, sin: 0 })),
        routeTrace: new RingBuffer(480, () => ({ x: 0, y: 0 })),
        particles: [],
        trailTimer: 0,
        runHistory: new RingBuffer(1400, () => ({ x: 0, y: 0 })),
        runHistoryTimer: 0,
        keys: { left: false, right: false },
        frameSkip: 0,
        qualityLevel: 0,
        collisionHash: null,
        currentTrackKey: trackKey,
        currentModeKey: 'standard',
        relaunchDelayRemaining: 0,
        practiceEndOnCrash: false,
        activeRunId: 0
    };
    const samples = [{
        x: simState.pos.x,
        y: simState.pos.y,
        angle: simState.angle,
        speed: 0,
        time: 0
    }];
    let lapCompletionTimeSec = null;
    const maxSteps = Math.ceil(durationSec / REPLAY_SIM_DT) + 240;

    for (let step = 0; step < maxSteps && simState.status === 'playing'; step += 1) {
        let bestIndex = nearestIndex;
        let bestDistance = Infinity;
        for (let offset = -controller.scanBack; offset < controller.scanAhead; offset += 1) {
            const candidateIndex = (nearestIndex + offset + path.length) % path.length;
            const candidateDistance = distanceSq(simState.pos, path[candidateIndex]);
            if (candidateDistance < bestDistance) {
                bestDistance = candidateDistance;
                bestIndex = candidateIndex;
            }
        }
        nearestIndex = bestIndex;

        const lookAhead = clamp(
            Math.round(controller.baseLA + simState.cachedSpeed * controller.speedLA),
            controller.minLA,
            controller.maxLA
        );
        const targetPoint = path[(nearestIndex + lookAhead) % path.length];
        const desiredAngle = Math.atan2(targetPoint.y - simState.pos.y, targetPoint.x - simState.pos.x);
        const angleDiff = normalizeAngle(desiredAngle - simState.angle);
        const threshold = controller.baseTh + simState.cachedSpeed * controller.speedTh;
        const keys = {
            left: angleDiff < -threshold,
            right: angleDiff > threshold
        };

        simState.keys = keys;
        updateSimulation(simState, REPLAY_SIM_DT, CONFIG, track, assets.runtime.collisionSegments);
        samples.push({
            x: simState.pos.x,
            y: simState.pos.y,
            angle: simState.angle,
            speed: simState.cachedSpeed,
            time: simState.currentTime
        });

        if (simState.status === 'won' && lapCompletionTimeSec === null) {
            lapCompletionTimeSec = simState.currentTime;
        }

        if (simState.status === 'won' && simState.currentTime < durationSec) {
            simState.status = 'playing';
        }

        if (simState.currentTime >= durationSec) {
            break;
        }
    }

    return {
        status: simState.status,
        survivedSec: simState.currentTime,
        lapCompletionTimeSec,
        samples
    };
}

function getReplaySimulation(trackKey, requestedLapTimeSec) {
    const minimumDurationSec = clamp(
        requestedLapTimeSec + REPLAY_SIM_BUFFER_SEC,
        REPLAY_MIN_DURATION_SEC,
        REPLAY_MAX_DURATION_SEC
    );
    const cached = replaySimulationCache.get(trackKey);
    if (cached && cached.generatedForSec >= minimumDurationSec && cached.lapCompletionTimeSec !== null) {
        return cached;
    }

    let targetDurationSec = cached
        ? Math.max(minimumDurationSec, cached.generatedForSec)
        : minimumDurationSec;
    let replay = cached ?? null;

    while (targetDurationSec <= REPLAY_MAX_DURATION_SEC) {
        let bestAttempt = null;
        for (const candidate of getReplaySearchCandidates(trackKey)) {
            const attempt = simulateReplayCandidate(trackKey, targetDurationSec, candidate);
            const completedLap = attempt.lapCompletionTimeSec !== null;
            const bestCompletedLap = bestAttempt?.lapCompletionTimeSec !== null;

            if (!bestAttempt) {
                bestAttempt = { ...attempt, controller: candidate.controller, path: candidate.path };
            }
            else if (completedLap && (!bestCompletedLap || attempt.lapCompletionTimeSec < bestAttempt.lapCompletionTimeSec)) {
                bestAttempt = { ...attempt, controller: candidate.controller, path: candidate.path };
            }
            else if (!completedLap && !bestCompletedLap && attempt.survivedSec > bestAttempt.survivedSec) {
                bestAttempt = { ...attempt, controller: candidate.controller, path: candidate.path };
            }
        }

        replay = {
            ...bestAttempt,
            generatedForSec: targetDurationSec,
            lapCompletionTimeSec: bestAttempt?.lapCompletionTimeSec ?? null,
            availableSec: Math.max(
                REPLAY_SIM_DT,
                bestAttempt?.samples?.[bestAttempt.samples.length - 1]?.time ?? 0
            ),
            lapSamples: bestAttempt?.lapCompletionTimeSec
                ? bestAttempt.samples.filter((sample) => sample.time <= bestAttempt.lapCompletionTimeSec + REPLAY_SIM_DT * 0.5)
                : bestAttempt?.samples ?? []
        };

        if (replay.lapCompletionTimeSec !== null || targetDurationSec >= REPLAY_MAX_DURATION_SEC) {
            break;
        }

        const nextDurationSec = Math.min(
            REPLAY_MAX_DURATION_SEC,
            Math.max(targetDurationSec + REPLAY_SIM_BUFFER_SEC, Math.ceil(targetDurationSec * 1.35))
        );
        if (nextDurationSec <= targetDurationSec) {
            break;
        }
        targetDurationSec = nextDurationSec;
    }

    replaySimulationCache.set(trackKey, replay);
    return replay;
}

function getGameplayReplayFrame(trackKey, clipTimeMs, clipDurationSec, displayLapTimeSec) {
    const replay = getReplaySimulation(trackKey, displayLapTimeSec);
    const lapSamples = replay.lapSamples?.length ? replay.lapSamples : replay.samples;
    const sourceLapDurationSec = Math.max(
        REPLAY_SIM_DT,
        replay.lapCompletionTimeSec ?? lapSamples[lapSamples.length - 1]?.time ?? 0
    );
    const replayProgress = clamp(
        clipTimeMs / Math.max(1, clipDurationSec * 1000),
        0,
        1
    );
    const sourceReplayTimeSec = sourceLapDurationSec * replayProgress;
    const currentSample = interpolateReplaySample(lapSamples, sourceReplayTimeSec);
    const routePoints = getReplayPathUntilTime(lapSamples, sourceReplayTimeSec);
    const displayLapElapsedSec = displayLapTimeSec * replayProgress;
    const lapRate = sourceLapDurationSec / Math.max(displayLapTimeSec, REPLAY_SIM_DT);
    const clipRate = sourceLapDurationSec / Math.max(clipDurationSec, REPLAY_SIM_DT);
    const cameraSample = getSmoothedReplaySample(lapSamples, sourceReplayTimeSec);
    const cameraLookAheadSample = getSmoothedReplaySample(
        lapSamples,
        sourceReplayTimeSec + CAMERA_LOOK_AHEAD_SEC
    );

    return {
        replay,
        replayProgress,
        currentSample,
        cameraSample,
        cameraLookAheadSample,
        routePoints,
        displayLapElapsedSec,
        displaySpeed: Math.round(currentSample.speed * lapRate * 20),
        clipVelocityScale: clipRate
    };
}

function getSmoothedReplaySample(samples, timeSec) {
    if (!samples.length) {
        return interpolateReplaySample(samples, timeSec);
    }

    let totalWeight = 0;
    let sumX = 0;
    let sumY = 0;
    let sumSpeed = 0;
    let sumSin = 0;
    let sumCos = 0;

    for (let index = 0; index < CAMERA_SMOOTH_OFFSETS.length; index += 1) {
        const offset = CAMERA_SMOOTH_OFFSETS[index];
        const weight = CAMERA_SMOOTH_WEIGHTS[index];
        const sample = interpolateReplaySample(samples, timeSec + offset * REPLAY_SIM_DT);
        totalWeight += weight;
        sumX += sample.x * weight;
        sumY += sample.y * weight;
        sumSpeed += sample.speed * weight;
        sumSin += Math.sin(sample.angle) * weight;
        sumCos += Math.cos(sample.angle) * weight;
    }

    return {
        x: sumX / totalWeight,
        y: sumY / totalWeight,
        angle: Math.atan2(sumSin, sumCos),
        speed: sumSpeed / totalWeight,
        time: clamp(timeSec, 0, samples[samples.length - 1].time)
    };
}

const trackApexCache = new Map();

function getTrackApexProgress(trackKey) {
    if (trackApexCache.has(trackKey)) return trackApexCache.get(trackKey);
    const geometry = getTrackGeometry(trackKey);
    const points = geometry.centerline;
    let sharpestIdx = 0;
    let sharpestCurv = 0;
    const N = points.length;
    const minGap = Math.max(3, Math.floor(N * 0.05));
    for (let i = minGap; i < N - minGap; i += 1) {
        const a = points[i - minGap];
        const b = points[i];
        const c = points[i + minGap];
        const ab = Math.atan2(b.y - a.y, b.x - a.x);
        const bc = Math.atan2(c.y - b.y, c.x - b.x);
        const curv = Math.abs(normalizeAngle(bc - ab));
        if (curv > sharpestCurv) {
            sharpestCurv = curv;
            sharpestIdx = i;
        }
    }
    const progress = N > 1 ? sharpestIdx / (N - 1) : 0;
    trackApexCache.set(trackKey, progress);
    return progress;
}

function drawPerspectiveGrid(ctx, theme, width, height, timeMs) {
    const horizonY = height * 0.58;
    const travel = (timeMs * 0.08) % 120;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 2;
    for (let i = -5; i <= 5; i += 1) {
        ctx.beginPath();
        ctx.moveTo(width / 2, horizonY);
        ctx.lineTo(width / 2 + i * 220, height);
        ctx.stroke();
    }

    for (let y = horizonY; y < height + 140; y += 76) {
        const curve = (y - horizonY) / (height - horizonY);
        const lineY = y + travel * curve;
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        ctx.lineTo(width, lineY);
        ctx.stroke();
    }

    const beam = ctx.createLinearGradient(0, horizonY, width, height);
    beam.addColorStop(0, 'rgba(255,255,255,0)');
    beam.addColorStop(0.5, theme.glowA);
    beam.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = beam;
    ctx.translate(width / 2, height * 0.76);
    ctx.rotate(-0.24);
    ctx.fillRect(-120, -420, 240, 920);
    ctx.restore();
}

function drawBackground(ctx, theme, width, height, timeMs, showGrid) {
    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, theme.skyTop);
    background.addColorStop(1, theme.skyBottom);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const glowLeft = ctx.createRadialGradient(width * 0.18, height * 0.18, 30, width * 0.18, height * 0.18, 420);
    glowLeft.addColorStop(0, theme.glowA);
    glowLeft.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glowLeft;
    ctx.fillRect(0, 0, width, height);

    const glowRight = ctx.createRadialGradient(width * 0.84, height * 0.22, 50, width * 0.84, height * 0.22, 380);
    glowRight.addColorStop(0, theme.glowB);
    glowRight.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glowRight;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    for (let index = 0; index < 18; index += 1) {
        const x = (index * 120 + timeMs * 0.02) % (width + 180) - 90;
        ctx.fillRect(x, 0, 1.5, height);
    }
    ctx.restore();

    if (showGrid) {
        drawPerspectiveGrid(ctx, theme, width, height, timeMs);
    }
}

function drawChip(ctx, { x, y, w, h, label, value, fill, stroke, textColor, valueFontSize = 34 }) {
    ctx.save();
    roundRectPath(ctx, x, y, w, h, 24);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 20px outfit, system-ui, sans-serif';
    ctx.fillText(label, x + 24, y + 30);
    ctx.font = `900 ${valueFontSize}px "JetBrains Mono", monospace`;
    ctx.fillText(value, x + 24, y + 70);
    ctx.restore();
}

function drawTag(ctx, {
    x,
    y,
    text,
    fill = 'rgba(255,255,255,0.08)',
    stroke = 'rgba(255,255,255,0.12)',
    textColor = '#f8fafc',
    fontSize = 22,
    height = 44,
    paddingX = 17,
    radius = 22
}) {
    ctx.save();
    ctx.font = `800 ${fontSize}px outfit, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(text).width + paddingX * 2;
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    ctx.fillStyle = textColor;
    ctx.fillText(text, x + paddingX, y + height / 2);
    ctx.restore();
    return width;
}

function drawCheckeredLine(ctx, p1, p2, width) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;

    const tx = dx / length;
    const ty = dy / length;
    const nx = -ty;
    const ny = tx;
    const rows = 2;
    const columns = Math.max(3, Math.ceil(length / Math.max(10, width * 1.2)));
    const cellLength = length / columns;
    const rowHeight = width / rows;

    ctx.save();
    for (let row = 0; row < rows; row += 1) {
        const innerOffset = -width / 2 + row * rowHeight;
        const outerOffset = innerOffset + rowHeight;

        for (let col = 0; col < columns; col += 1) {
            const startDist = col * cellLength;
            const endDist = (col + 1) * cellLength;
            const sx = p1.x + tx * startDist;
            const sy = p1.y + ty * startDist;
            const ex = p1.x + tx * endDist;
            const ey = p1.y + ty * endDist;

            ctx.fillStyle = (row + col) % 2 === 0 ? '#f8fafc' : '#020617';
            ctx.beginPath();
            ctx.moveTo(sx + nx * innerOffset, sy + ny * innerOffset);
            ctx.lineTo(ex + nx * innerOffset, ey + ny * innerOffset);
            ctx.lineTo(ex + nx * outerOffset, ey + ny * outerOffset);
            ctx.lineTo(sx + nx * outerOffset, sy + ny * outerOffset);
            ctx.closePath();
            ctx.fill();
        }
    }
    ctx.restore();
}

function getSafeZonePadding(aspect) {
    if (!state.showSafeZones || !aspect?.safeZones) {
        return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    return aspect.safeZones;
}

function computeTraceLayout(ctx, width, height, aspect) {
    if (aspect?.layout === 'horizontal') {
        return computeTraceLayoutHorizontal(ctx, width, height, aspect);
    }
    return computeTraceLayoutVertical(ctx, width, height, aspect);
}

function computeTraceLayoutVertical(ctx, width, height, aspect) {
    const yScale = height / 1920;
    const sidePad = getSafeZonePadding(aspect);
    const safeLeft = Math.max(72, sidePad.left);
    const safeRight = Math.max(72, sidePad.right);
    const safeTop = Math.max(86, sidePad.top + 12);
    const safeBottomReserve = Math.max(240 * yScale, sidePad.bottom + 40);

    const headlineFontSizes = [108, 100, 92, 84, 76];
    const headlineWidth = width - safeLeft - safeRight;
    const headlineY = Math.max(safeTop + 80, Math.round(168 * yScale));
    let headlineFontSize = headlineFontSizes[headlineFontSizes.length - 1];
    let headlineLines = [];
    let headlineLineHeight = Math.round(headlineFontSize * 0.92);

    for (const size of headlineFontSizes) {
        ctx.font = `900 ${size}px "JetBrains Mono", monospace`;
        const candidateLines = wrapText(ctx, state.headline.toUpperCase(), headlineWidth);
        const candidateLineHeight = Math.round(size * 0.92);
        const candidateHeight = candidateLines.length * candidateLineHeight;
        if (candidateLines.length <= 3 && candidateHeight <= 288) {
            headlineFontSize = size;
            headlineLines = candidateLines;
            headlineLineHeight = candidateLineHeight;
            break;
        }
        headlineFontSize = size;
        headlineLines = candidateLines;
        headlineLineHeight = candidateLineHeight;
    }

    const headlineHeight = headlineLines.length * headlineLineHeight;
    const subheadFontSize = headlineLines.length >= 3 ? 30 : 34;
    const subheadLineHeight = headlineLines.length >= 3 ? 38 : 42;
    const subheadY = headlineY + headlineHeight + 18;
    ctx.font = `600 ${subheadFontSize}px outfit, system-ui, sans-serif`;
    const subheadLines = wrapText(ctx, state.subhead, width - safeLeft - safeRight - 80);
    const subheadHeight = subheadLines.length * subheadLineHeight;
    const ctaHeight = Math.round(192 * Math.max(0.75, yScale));
    const ctaY = height - safeBottomReserve - ctaHeight;
    const trackTop = Math.max(Math.round(430 * yScale), subheadY + subheadHeight + 40);
    const trackBottom = ctaY - 32;
    const trackRect = {
        x: safeLeft,
        y: trackTop,
        width: width - safeLeft - safeRight,
        height: Math.max(Math.round(420 * yScale), trackBottom - trackTop)
    };

    return {
        headlineFontSize,
        headlineLines,
        headlineLineHeight,
        headlineY,
        subheadFontSize,
        subheadLines,
        subheadLineHeight,
        subheadY,
        trackRect,
        statY: trackRect.y + trackRect.height + 20,
        ctaY,
        ctaHeight,
        safeLeft,
        safeRight,
        safeTop
    };
}

function computeTraceLayoutHorizontal(ctx, width, height, aspect) {
    const sidePad = getSafeZonePadding(aspect);
    const safeLeft = Math.max(80, sidePad.left);
    const safeRight = Math.max(80, sidePad.right);
    const safeTop = Math.max(80, sidePad.top);
    const safeBottom = Math.max(80, sidePad.bottom);
    const textColumnWidth = Math.round((width - safeLeft - safeRight) * 0.52);
    const gutter = 48;
    const trackRect = {
        x: safeLeft + textColumnWidth + gutter,
        y: safeTop,
        width: width - safeLeft - safeRight - textColumnWidth - gutter,
        height: height - safeTop - safeBottom
    };

    const headlineFontSizes = [96, 84, 74, 64, 56];
    let headlineFontSize = headlineFontSizes[headlineFontSizes.length - 1];
    let headlineLines = [];
    let headlineLineHeight = Math.round(headlineFontSize * 0.92);

    for (const size of headlineFontSizes) {
        ctx.font = `900 ${size}px "JetBrains Mono", monospace`;
        const candidateLines = wrapText(ctx, state.headline.toUpperCase(), textColumnWidth);
        const candidateLineHeight = Math.round(size * 0.92);
        const candidateHeight = candidateLines.length * candidateLineHeight;
        if (candidateLines.length <= 3 && candidateHeight <= height * 0.36) {
            headlineFontSize = size;
            headlineLines = candidateLines;
            headlineLineHeight = candidateLineHeight;
            break;
        }
        headlineFontSize = size;
        headlineLines = candidateLines;
        headlineLineHeight = candidateLineHeight;
    }

    const headlineY = safeTop + 110;
    const headlineHeight = headlineLines.length * headlineLineHeight;
    const subheadFontSize = 30;
    const subheadLineHeight = 38;
    const subheadY = headlineY + headlineHeight + 22;
    ctx.font = `600 ${subheadFontSize}px outfit, system-ui, sans-serif`;
    const subheadLines = wrapText(ctx, state.subhead, textColumnWidth);
    const ctaHeight = 168;
    const ctaY = height - safeBottom - ctaHeight;

    return {
        horizontal: true,
        headlineFontSize,
        headlineLines,
        headlineLineHeight,
        headlineY,
        subheadFontSize,
        subheadLines,
        subheadLineHeight,
        subheadY,
        trackRect,
        statY: trackRect.y + trackRect.height - 112,
        ctaY,
        ctaHeight,
        ctaWidth: textColumnWidth,
        safeLeft,
        safeRight,
        safeTop,
        textColumnWidth
    };
}

function computeGameplayLayout(ctx, width, height, aspect) {
    if (aspect?.layout === 'horizontal') {
        return computeGameplayLayoutHorizontal(ctx, width, height, aspect);
    }
    return computeGameplayLayoutVertical(ctx, width, height, aspect);
}

function computeGameplayLayoutVertical(ctx, width, height, aspect) {
    const yScale = height / 1920;
    const sidePad = getSafeZonePadding(aspect);
    const safeLeft = Math.max(72, sidePad.left);
    const safeRight = Math.max(72, sidePad.right);
    const safeTop = Math.max(92, sidePad.top + 12);
    const safeBottomReserve = Math.max(184 * yScale, sidePad.bottom + 24);

    const headlineFontSizes = [74, 68, 62, 56, 50];
    const headlineWidth = width - safeLeft - safeRight - 36;
    const headlineY = Math.max(safeTop + 78, Math.round(170 * yScale));
    let headlineFontSize = headlineFontSizes[headlineFontSizes.length - 1];
    let headlineLines = [];
    let headlineLineHeight = Math.round(headlineFontSize * 0.92);

    for (const size of headlineFontSizes) {
        ctx.font = `900 ${size}px "JetBrains Mono", monospace`;
        const candidateLines = wrapText(ctx, state.headline.toUpperCase(), headlineWidth);
        const candidateLineHeight = Math.round(size * 0.92);
        const candidateHeight = candidateLines.length * candidateLineHeight;
        if (candidateLines.length <= 2 && candidateHeight <= 156) {
            headlineFontSize = size;
            headlineLines = candidateLines;
            headlineLineHeight = candidateLineHeight;
            break;
        }
        headlineFontSize = size;
        headlineLines = candidateLines;
        headlineLineHeight = candidateLineHeight;
    }

    const headlineHeight = headlineLines.length * headlineLineHeight;
    const subheadFontSize = headlineLines.length > 1 ? 32 : 36;
    const subheadLineHeight = headlineLines.length > 1 ? 34 : 36;
    const subheadY = headlineY + headlineHeight + 18;
    ctx.font = `600 ${subheadFontSize}px outfit, system-ui, sans-serif`;
    const subheadLines = wrapText(ctx, state.subhead, width - safeLeft - safeRight - 30);
    const subheadHeight = subheadLines.length * subheadLineHeight;
    const footerHeight = 94;
    const footerY = height - safeBottomReserve - footerHeight;
    const viewportTop = Math.max(Math.round(400 * yScale), subheadY + subheadHeight + 44);
    const viewportRect = {
        x: Math.max(44, safeLeft - 28),
        y: viewportTop,
        width: width - Math.max(88, (safeLeft - 28) * 2),
        height: Math.max(Math.round(420 * yScale), footerY - viewportTop - 36)
    };

    return {
        headlineFontSize,
        headlineLines,
        headlineLineHeight,
        headlineY,
        subheadFontSize,
        subheadLines,
        subheadLineHeight,
        subheadY,
        viewportRect,
        footerY,
        safeLeft,
        safeRight,
        safeTop
    };
}

function computeGameplayLayoutHorizontal(ctx, width, height, aspect) {
    const sidePad = getSafeZonePadding(aspect);
    const safeLeft = Math.max(80, sidePad.left);
    const safeRight = Math.max(80, sidePad.right);
    const safeTop = Math.max(80, sidePad.top);
    const safeBottom = Math.max(80, sidePad.bottom);
    const textColumnWidth = Math.round((width - safeLeft - safeRight) * 0.48);
    const gutter = 48;
    const viewportRect = {
        x: safeLeft + textColumnWidth + gutter,
        y: safeTop,
        width: width - safeLeft - safeRight - textColumnWidth - gutter,
        height: height - safeTop - safeBottom
    };

    const headlineFontSizes = [80, 72, 64, 56, 50];
    let headlineFontSize = headlineFontSizes[headlineFontSizes.length - 1];
    let headlineLines = [];
    let headlineLineHeight = Math.round(headlineFontSize * 0.92);

    for (const size of headlineFontSizes) {
        ctx.font = `900 ${size}px "JetBrains Mono", monospace`;
        const candidateLines = wrapText(ctx, state.headline.toUpperCase(), textColumnWidth);
        const candidateLineHeight = Math.round(size * 0.92);
        const candidateHeight = candidateLines.length * candidateLineHeight;
        if (candidateLines.length <= 2 && candidateHeight <= height * 0.3) {
            headlineFontSize = size;
            headlineLines = candidateLines;
            headlineLineHeight = candidateLineHeight;
            break;
        }
        headlineFontSize = size;
        headlineLines = candidateLines;
        headlineLineHeight = candidateLineHeight;
    }

    const headlineY = safeTop + 110;
    const subheadFontSize = 28;
    const subheadLineHeight = 34;
    const subheadY = headlineY + headlineLines.length * headlineLineHeight + 20;
    ctx.font = `600 ${subheadFontSize}px outfit, system-ui, sans-serif`;
    const subheadLines = wrapText(ctx, state.subhead, textColumnWidth);
    const footerHeight = 94;
    const footerY = height - safeBottom - footerHeight;

    return {
        horizontal: true,
        headlineFontSize,
        headlineLines,
        headlineLineHeight,
        headlineY,
        subheadFontSize,
        subheadLines,
        subheadLineHeight,
        subheadY,
        viewportRect,
        footerY,
        footerX: safeLeft,
        footerWidth: textColumnWidth,
        safeLeft,
        safeRight,
        safeTop,
        textColumnWidth
    };
}

function drawTrackScene(ctx, width, height, theme, scene, timeMs, layout) {
    const { trackRect, statY } = layout;
    const intro = easeOutBack(scene.introProgress);
    const action = easeInOutCubic(scene.actionProgress);
    const mapped = mapTrackToRect(state.trackKey, trackRect);
    const routeProgress = easeInOutCubic(scene.routeProgress);
    const routePoints = getProgressPath(mapped.centerline, routeProgress);
    const marker = getProgressPoint(mapped.centerline, routeProgress);
    const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.012);

    ctx.save();
    ctx.translate(width / 2, trackRect.y + trackRect.height / 2);
    const scale = lerp(0.92, 1, intro);
    ctx.scale(scale, scale);
    ctx.translate(-width / 2, -(trackRect.y + trackRect.height / 2));

    roundRectPath(ctx, trackRect.x, trackRect.y, trackRect.width, trackRect.height, 46);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.clip();
    const sweep = ctx.createLinearGradient(trackRect.x, trackRect.y, trackRect.x + trackRect.width, trackRect.y + trackRect.height);
    sweep.addColorStop(0, 'rgba(255,255,255,0.02)');
    sweep.addColorStop(0.5, theme.glowB);
    sweep.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.32;
    ctx.translate(trackRect.x + (timeMs * 0.22) % (trackRect.width + 320) - 160, trackRect.y);
    ctx.rotate(-0.35);
    ctx.fillStyle = sweep;
    ctx.fillRect(-120, -80, 220, trackRect.height + 180);
    ctx.restore();

    tracePath(ctx, mapped.outer, true);
    ctx.fillStyle = theme.trackOuter;
    ctx.globalAlpha = 0.16;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.84)';
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(ctx, mapped.inner, true);
    ctx.fillStyle = theme.trackInner;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.stroke();

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    tracePath(ctx, mapped.centerline, false);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 12;
    ctx.stroke();

    if (routePoints.length > 1) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        tracePath(ctx, routePoints, false);
        ctx.strokeStyle = theme.route;
        ctx.lineWidth = 18;
        ctx.stroke();

        ctx.shadowBlur = 0;
        tracePath(ctx, routePoints, false);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5;
        ctx.stroke();
    }
    ctx.restore();

    drawCheckeredLine(ctx, mapped.startLine.p1, mapped.startLine.p2, 18);

    if (scene.routeProgress > 0.02) {
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, 12 + pulse * 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.35 + pulse * 0.3;
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, 28 + pulse * 16, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    ctx.restore();

    const chipX = layout.safeLeft ?? 72;
    const chipRight = layout.safeRight ?? 72;
    const statBaseY = statY + (1 - action) * 40;
    const moodAccent = getMoodAccent();
    const statReveal = clamp((scene.reveal - 0.2) / 0.7, 0, 1);
    drawChip(ctx, {
        x: chipX,
        y: statBaseY + (1 - statReveal) * 24,
        w: 268,
        h: 96,
        label: 'TOP SPEED',
        value: `${Math.round(184 + routeProgress * 31)} KPH`,
        fill: 'rgba(255,255,255,0.06)',
        stroke: 'rgba(255,255,255,0.1)',
        textColor: theme.text
    });
    if (state.showTimer) {
        drawChip(ctx, {
            x: width - chipRight - 268,
            y: statBaseY + (1 - statReveal) * 24,
            w: 268,
            h: 96,
            label: 'LAP TIME',
            value: `${(state.lapTime * routeProgress).toFixed(2)}s`,
            fill: 'rgba(0, 0, 0, 0.35)',
            stroke: moodAccent.color,
            textColor: moodAccent.color,
            valueFontSize: 30
        });
    }
}

function drawGameplayScene(ctx, width, height, theme, scene, timeMs, layout, options = {}) {
    const { viewportRect } = layout;
    const intro = easeOutBack(scene.introProgress);
    const action = easeInOutCubic(scene.actionProgress);
    const moodAccent = getMoodAccent();
    const assets = getTrackAssets(state.trackKey);

    if (!assets.trackCanvas) {
        const fallbackLayout = {
            trackRect: viewportRect,
            statY: viewportRect.y + viewportRect.height + 20
        };
        drawTrackScene(ctx, width, height, theme, scene, timeMs, fallbackLayout);
        return;
    }

    const replayFrame = getGameplayReplayFrame(state.trackKey, timeMs, state.durationSec, state.lapTime);
    const currentSample = replayFrame.currentSample;
    const px = currentSample.x * CONFIG.gridSize;
    const py = currentSample.y * CONFIG.gridSize;
    const routePoints = replayFrame.routePoints;
    const speed = replayFrame.displaySpeed;
    const lapTimeText = `${replayFrame.displayLapElapsedSec.toFixed(2)}s`;
    const zoom = lerp(0.9, options.poster ? 1.02 : 0.98, action);
    const cameraSample = replayFrame.cameraSample;
    const cameraLookAheadSample = replayFrame.cameraLookAheadSample;
    const cameraFocusX = lerp(cameraSample.x, cameraLookAheadSample.x, CAMERA_LOOK_AHEAD_BLEND) * CONFIG.gridSize;
    const cameraFocusY = lerp(cameraSample.y, cameraLookAheadSample.y, CAMERA_LOOK_AHEAD_BLEND) * CONFIG.gridSize;
    const cameraX = cameraFocusX - viewportRect.width / (2 * zoom);
    const cameraY = cameraFocusY - viewportRect.height / (2 * zoom);

    ctx.save();
    ctx.translate(width / 2, viewportRect.y + viewportRect.height / 2);
    const introScale = lerp(0.94, 1, intro);
    ctx.scale(introScale, introScale);
    ctx.translate(-width / 2, -(viewportRect.y + viewportRect.height / 2));

    roundRectPath(ctx, viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height, 46);
    ctx.fillStyle = CONFIG.offTrackColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.16)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.clip();
    const viewportBackground = ctx.createLinearGradient(viewportRect.x, viewportRect.y, viewportRect.x, viewportRect.y + viewportRect.height);
    viewportBackground.addColorStop(0, CONFIG.offTrackColor);
    viewportBackground.addColorStop(1, '#111827');
    ctx.fillStyle = viewportBackground;
    ctx.fillRect(viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height);

    ctx.save();
    ctx.translate(viewportRect.x, viewportRect.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-cameraX, -cameraY);
    ctx.drawImage(assets.trackCanvas, assets.trackCanvasOrigin.x, assets.trackCanvasOrigin.y);

    if (routePoints.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(routePoints[0].x * CONFIG.gridSize, routePoints[0].y * CONFIG.gridSize);
        for (let index = 1; index < routePoints.length; index += 1) {
            ctx.lineTo(routePoints[index].x * CONFIG.gridSize, routePoints[index].y * CONFIG.gridSize);
        }
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();
    }

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(currentSample.angle);
    if (!options.poster && speed > 4) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        for (let index = 0; index < 5; index += 1) {
            const trailOffset = 26 + index * 18 + ((timeMs * 0.12) % 18);
            ctx.beginPath();
            ctx.moveTo(-trailOffset, -8 + index * 4);
            ctx.lineTo(-trailOffset - 26, -8 + index * 4);
            ctx.stroke();
        }
    }
    ctx.drawImage(promoCarSprite, -32, -16, 64, 32);
    ctx.restore();

    if (!options.poster && speed > 4) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        const clipVelocity = currentSample.speed * replayFrame.clipVelocityScale;
        const velocityLineX = -Math.cos(currentSample.angle) * clipVelocity * 2;
        const velocityLineY = -Math.sin(currentSample.angle) * clipVelocity * 2;
        for (let index = 0; index < 5; index += 1) {
            const rx = px + (Math.sin(timeMs * 0.003 + index * 1.2) * 90);
            const ry = py + (Math.cos(timeMs * 0.0027 + index * 1.7) * 90);
            ctx.beginPath();
            ctx.moveTo(rx, ry);
            ctx.lineTo(rx + velocityLineX, ry + velocityLineY);
            ctx.stroke();
        }
        ctx.restore();
    }
    ctx.restore();

    const overlayGradient = ctx.createLinearGradient(viewportRect.x, viewportRect.y, viewportRect.x, viewportRect.y + viewportRect.height);
    overlayGradient.addColorStop(0, 'rgba(2, 6, 23, 0.32)');
    overlayGradient.addColorStop(0.55, 'rgba(2, 6, 23, 0)');
    overlayGradient.addColorStop(1, 'rgba(2, 6, 23, 0.35)');
    ctx.fillStyle = overlayGradient;
    ctx.fillRect(viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height);

    const topTagW = 208;
    roundRectPath(ctx, viewportRect.x + 22, viewportRect.y + 20, topTagW, 50, 10);
    ctx.fillStyle = 'rgba(4, 9, 15, 0.82)';
    ctx.fill();
    ctx.strokeStyle = moodAccent.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = '800 18px outfit, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const liveDot = 0.6 + 0.4 * Math.sin(timeMs * 0.012);
    ctx.save();
    ctx.fillStyle = moodAccent.color;
    ctx.globalAlpha = liveDot;
    ctx.beginPath();
    ctx.arc(viewportRect.x + 40, viewportRect.y + 45, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(options.poster ? 'REPLAY' : 'LIVE REPLAY', viewportRect.x + 58, viewportRect.y + 45);

    const lapPillX = viewportRect.x + viewportRect.width - 208;
    const lapPillY = viewportRect.y + 20;
    roundRectPath(ctx, lapPillX, lapPillY, 186, 62, 10);
    const lapBg = ctx.createLinearGradient(lapPillX, lapPillY, lapPillX, lapPillY + 62);
    lapBg.addColorStop(0, moodAccent.color);
    lapBg.addColorStop(1, 'rgba(4, 9, 15, 0.92)');
    ctx.fillStyle = lapBg;
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '800 12px outfit, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('LAP TIME', lapPillX + 16, lapPillY + 8);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 32px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(lapTimeText, lapPillX + 186 - 16, lapPillY + 40);

    if (!options.poster) {
        const speedPillW = 150;
        const speedPillH = 68;
        const speedPillX = viewportRect.x + viewportRect.width - speedPillW - 22;
        const speedPillY = viewportRect.y + viewportRect.height - speedPillH - 22;
        roundRectPath(ctx, speedPillX, speedPillY, speedPillW, speedPillH, 10);
        ctx.fillStyle = 'rgba(4, 9, 15, 0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '800 12px outfit, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('SPEED · KPH', speedPillX + 14, speedPillY + 8);
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 32px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${speed}`, speedPillX + speedPillW - 14, speedPillY + 44);

        const throttleW = viewportRect.width * 0.4;
        const throttleX = viewportRect.x + 22;
        const throttleY = viewportRect.y + viewportRect.height - 78;
        const throttleH = 14;
        const maxSpeedRef = 220;
        const throttleFill = clamp(speed / maxSpeedRef, 0, 1);
        roundRectPath(ctx, throttleX, throttleY, throttleW, throttleH, 7);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        roundRectPath(ctx, throttleX, throttleY, throttleW * throttleFill, throttleH, 7);
        const throttleGrad = ctx.createLinearGradient(throttleX, throttleY, throttleX + throttleW, throttleY);
        throttleGrad.addColorStop(0, '#22c55e');
        throttleGrad.addColorStop(0.7, '#facc15');
        throttleGrad.addColorStop(1, '#ef4444');
        ctx.fillStyle = throttleGrad;
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = '800 11px outfit, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('THROTTLE', throttleX, throttleY - 4);
    }

    roundRectPath(ctx, viewportRect.x + 22, viewportRect.y + viewportRect.height - 40, viewportRect.width - 44, 8, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    const progressBarGrad = ctx.createLinearGradient(
        viewportRect.x + 22, 0,
        viewportRect.x + viewportRect.width - 22, 0
    );
    progressBarGrad.addColorStop(0, moodAccent.color);
    progressBarGrad.addColorStop(1, '#ffffff');
    roundRectPath(ctx, viewportRect.x + 22, viewportRect.y + viewportRect.height - 40, (viewportRect.width - 44) * replayFrame.replayProgress, 8, 4);
    ctx.fillStyle = progressBarGrad;
    ctx.fill();
    ctx.restore();
}

function drawKineticHeadline(ctx, opts) {
    const {
        lines,
        fontSize,
        lineHeight,
        x,
        y,
        color,
        theme,
        beats,
        alignment = 'left',
        maxWidth
    } = opts;
    const keyword = getHeadlineKeyword();
    const moodAccent = getMoodAccent();
    const hookProgress = beats.hook ?? 1;
    const font = `900 ${fontSize}px "JetBrains Mono", monospace`;

    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const isPhraseKeyword = keyword && keyword.includes(' ');
    let wordCounter = 0;
    lines.forEach((line, lineIndex) => {
        const words = line.split(/(\s+)/).filter((token) => token.length > 0);
        const widths = words.map((token) => ctx.measureText(token).width);
        const totalWidth = widths.reduce((acc, w) => acc + w, 0);
        let startX = x;
        if (alignment === 'center' && maxWidth) {
            startX = x + (maxWidth - totalWidth) / 2;
        } else if (alignment === 'right' && maxWidth) {
            startX = x + (maxWidth - totalWidth);
        }
        let cursorX = startX;
        const lineY = y + lineIndex * lineHeight;

        const upperLine = line.toUpperCase();
        const phraseIdx = isPhraseKeyword ? upperLine.indexOf(keyword) : -1;
        const phraseEnd = phraseIdx >= 0 ? phraseIdx + keyword.length : -1;

        let charCursor = 0;
        words.forEach((token, tokenIndex) => {
            const tokenWidth = widths[tokenIndex];
            const isSpace = /^\s+$/.test(token);
            const tokenStart = charCursor;
            charCursor += token.length;
            if (isSpace) {
                cursorX += tokenWidth;
                return;
            }

            const inPhrase = isPhraseKeyword && phraseIdx >= 0
                && tokenStart >= phraseIdx && tokenStart < phraseEnd;
            if (inPhrase) {
                cursorX += tokenWidth;
                return;
            }

            const stagger = 0.08;
            const delay = wordCounter * stagger;
            wordCounter += 1;
            const localT = clamp((hookProgress - delay) / (1 - delay + 0.001), 0, 1);
            const eased = easeOutCubic(localT);
            const yOffset = (1 - eased) * fontSize * 0.55;
            const alpha = eased;
            if (alpha <= 0.02) { cursorX += tokenWidth; return; }

            const isKeyword = keyword && !isPhraseKeyword && token.toUpperCase() === keyword;

            ctx.save();
            ctx.globalAlpha = alpha;
            if (isKeyword) {
                ctx.save();
                ctx.fillStyle = moodAccent.color;
                ctx.globalAlpha = alpha * 0.95;
                roundRectPath(ctx, cursorX - 4, lineY + yOffset + fontSize * 0.08, tokenWidth + 8, fontSize * 0.95, 6);
                ctx.fill();
                ctx.restore();
                ctx.fillStyle = '#07131f';
                ctx.shadowColor = "transparent";
                ctx.shadowBlur = 0;
                ctx.fillText(token, cursorX, lineY + yOffset);
            } else {
                ctx.fillStyle = color;
                ctx.shadowColor = "transparent";
                ctx.shadowBlur = 0;
                ctx.fillText(token, cursorX, lineY + yOffset);
            }
            ctx.restore();
            cursorX += tokenWidth;
        });

        if (isPhraseKeyword && phraseIdx >= 0) {
            let preWidth = 0;
            for (let i = 0; i < phraseIdx; i += 1) {
                preWidth += ctx.measureText(line.charAt(i)).width;
            }
            const phraseText = line.substring(phraseIdx, phraseEnd);
            const phraseWidth = ctx.measureText(phraseText).width;
            const delay = 0.15;
            const localT = clamp((hookProgress - delay) / (1 - delay + 0.001), 0, 1);
            const eased = easeOutCubic(localT);
            const yOffset = (1 - eased) * fontSize * 0.55;
            if (eased > 0.02) {
                ctx.save();
                ctx.globalAlpha = eased * 0.95;
                ctx.fillStyle = moodAccent.color;
                roundRectPath(ctx, startX + preWidth - 4, lineY + yOffset + fontSize * 0.08, phraseWidth + 8, fontSize * 0.95, 6);
                ctx.fill();
                ctx.globalAlpha = eased;
                ctx.fillStyle = '#07131f';
                ctx.shadowColor = "transparent";
                ctx.shadowBlur = 0;
                ctx.fillText(phraseText, startX + preWidth, lineY + yOffset);
                ctx.restore();
            }
        }
    });

    ctx.restore();
}

function drawTraceTextBlocks(ctx, width, height, theme, scene, layout) {
    const {
        headlineFontSize,
        headlineLines,
        headlineLineHeight,
        headlineY,
        subheadFontSize,
        subheadLines,
        subheadLineHeight,
        subheadY,
        ctaY,
        ctaHeight,
        ctaWidth: ctaWidthOverride,
        safeLeft,
        safeRight,
        safeTop,
        horizontal
    } = layout;
    const intro = easeOutBack(scene.introProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const animatedHeadlineY = lerp(headlineY + 34, headlineY, intro);
    const animatedSubheadY = lerp(subheadY + 14, subheadY, intro);
    const leftX = safeLeft;
    const kickerY = Math.max(56, safeTop - 20);

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.fillStyle = theme.accent;
    ctx.font = '700 28px outfit, system-ui, sans-serif';
    ctx.fillText('MINI RACER', leftX + 2, kickerY);

    ctx.fillStyle = theme.text;
    ctx.font = `900 ${headlineFontSize}px "JetBrains Mono", monospace`;
    headlineLines.forEach((line, index) => {
        ctx.globalAlpha = clamp(intro + index * 0.08, 0, 1);
        ctx.fillText(line, leftX, animatedHeadlineY + index * headlineLineHeight);
    });

    ctx.globalAlpha = 0.92;
    ctx.fillStyle = theme.muted;
    ctx.font = `600 ${subheadFontSize}px outfit, system-ui, sans-serif`;
    subheadLines.forEach((line, index) => {
        ctx.fillText(line, leftX + 4, animatedSubheadY + index * subheadLineHeight);
    });
    ctx.restore();

    const ctaWidth = ctaWidthOverride ?? (width - safeLeft - safeRight);
    const animatedCtaY = lerp(ctaY + 36, ctaY - 14, outro);
    ctx.save();
    roundRectPath(ctx, leftX, animatedCtaY, ctaWidth, ctaHeight, 38);
    ctx.fillStyle = 'rgba(4, 9, 15, 0.84)';
    ctx.fill();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.4 + outro * 0.6;
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = theme.text;
    const ctaFontSize = horizontal ? 46 : Math.max(42, Math.min(58, Math.round(ctaWidth / 12)));
    ctx.font = `900 ${ctaFontSize}px "JetBrains Mono", monospace`;
    ctx.fillText(state.cta.toUpperCase(), leftX + 36, animatedCtaY + Math.round(ctaHeight * 0.2));

    ctx.fillStyle = theme.muted;
    ctx.font = '600 26px outfit, system-ui, sans-serif';
    ctx.fillText(`${state.handle}  •  ${TRACKS[state.trackKey].name}`, leftX + 38, animatedCtaY + Math.round(ctaHeight * 0.62));

    ctx.textAlign = 'right';
    ctx.fillStyle = theme.accent;
    ctx.font = '900 40px "JetBrains Mono", monospace';
    ctx.fillText(`${state.lapTime.toFixed(2)}s`, leftX + ctaWidth - 36, animatedCtaY + Math.round(ctaHeight * 0.42));
    ctx.restore();
}

function drawGameplayTextBlocks(ctx, width, height, theme, scene, layout, options = {}) {
    const {
        headlineFontSize,
        headlineLines,
        headlineLineHeight,
        headlineY,
        subheadFontSize,
        subheadLines,
        subheadLineHeight,
        subheadY,
        footerY,
        footerX: footerXOverride,
        footerWidth: footerWidthOverride,
        safeLeft,
        safeRight,
        safeTop
    } = layout;
    const moodAccent = getMoodAccent();
    const footerProgress = options.poster ? 1 : easeOutCubic(scene.payoff);
    const animatedSubheadY = lerp(subheadY + 18, subheadY, scene.hook);
    const leftX = safeLeft;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    drawTag(ctx, {
        x: leftX,
        y: Math.max(60, safeTop - 8),
        text: `▌ ${TRACKS[state.trackKey].name.toUpperCase()}`,
        fill: 'rgba(255,255,255,0.08)',
        stroke: moodAccent.color,
        textColor: theme.text,
        fontSize: 20,
        height: 42,
        paddingX: 16,
        radius: 10
    });

    ctx.restore();

    drawKineticHeadline(ctx, {
        lines: headlineLines,
        fontSize: headlineFontSize,
        lineHeight: headlineLineHeight,
        x: leftX,
        y: headlineY,
        color: theme.text,
        theme,
        beats: scene,
        alignment: 'left',
        maxWidth: width - safeLeft - (layout.safeRight ?? safeLeft)
    });

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const subheadAlpha = clamp((scene.hook - 0.35) / 0.55, 0, 1);
    ctx.globalAlpha = 0.96 * subheadAlpha;
    ctx.fillStyle = theme.muted;
    ctx.font = `600 ${subheadFontSize}px outfit, system-ui, sans-serif`;
    subheadLines.forEach((line, index) => {
        ctx.fillText(line, leftX + 2, animatedSubheadY + index * subheadLineHeight);
    });
    ctx.restore();

    const footerX = footerXOverride ?? leftX;
    const footerWidth = footerWidthOverride ?? (width - safeLeft - safeRight);
    const footerHeight = 94;
    const footerScale = 1 + scene.payoffPop * 0.05;
    const animatedFooterY = lerp(footerY + 28, footerY, footerProgress);
    ctx.save();
    ctx.translate(footerX + footerWidth / 2, animatedFooterY + footerHeight / 2);
    ctx.scale(footerScale, footerScale);
    ctx.translate(-(footerX + footerWidth / 2), -(animatedFooterY + footerHeight / 2));

    roundRectPath(ctx, footerX, animatedFooterY, footerWidth, footerHeight, 30);
    const footerBg = ctx.createLinearGradient(footerX, animatedFooterY, footerX, animatedFooterY + footerHeight);
    footerBg.addColorStop(0, 'rgba(12, 20, 28, 0.92)');
    footerBg.addColorStop(1, 'rgba(4, 9, 15, 0.92)');
    ctx.fillStyle = footerBg;
    ctx.fill();
    ctx.strokeStyle = moodAccent.color;
    ctx.lineWidth = 2 + scene.payoffPop * 3;
    ctx.globalAlpha = 0.5 + footerProgress * 0.5;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.globalAlpha = clamp(scene.payoff * 1.5, 0, 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.text;
    ctx.font = '900 30px outfit, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.cta.toUpperCase(), footerX + 28, animatedFooterY + footerHeight / 2);
    ctx.fillStyle = moodAccent.color;
    ctx.textAlign = 'right';
    ctx.font = '800 22px outfit, system-ui, sans-serif';
    ctx.fillText(state.handle, footerX + footerWidth - 28, animatedFooterY + footerHeight / 2);

    ctx.restore();
}

function drawSafeZoneOverlay(ctx, width, height, aspect) {
    const zones = aspect.safeZones;
    if (!zones) return;
    ctx.save();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
    ctx.fillRect(0, 0, width, zones.top);
    ctx.fillRect(0, height - zones.bottom, width, zones.bottom);
    ctx.fillRect(0, 0, zones.left, height);
    ctx.fillRect(width - zones.right, 0, zones.right, height);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.strokeRect(zones.left, zones.top, width - zones.left - zones.right, height - zones.top - zones.bottom);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.font = '800 20px outfit, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`SAFE ZONES · ${aspect.name.split(' ')[0]}`, zones.left + 12, zones.top + 12);
    ctx.restore();
}

function getTemplateRenderer(styleId) {
    switch (styleId) {
        case 'arcade-crt': return renderArcadeCRT;
        case 'magazine': return renderMagazine;
        case 'sticker': return renderStickerCollage;
        case 'telemetry': return renderTelemetry;
        case 'trading-card': return renderTradingCard;
        case 'cockpit': return renderCockpitPOV;
        default: return null;
    }
}

function getTemplateTrackOutline() {
    const geometry = getTrackGeometry(state.trackKey);
    return geometry.centerline.map((p) => ({ x: p.x, y: p.y }));
}

function fitPointsToRect(points, rect, padding = 0) {
    if (!points.length) return [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    });
    const srcW = maxX - minX || 1;
    const srcH = maxY - minY || 1;
    const dstW = rect.width - padding * 2;
    const dstH = rect.height - padding * 2;
    const scale = Math.min(dstW / srcW, dstH / srcH);
    const offsetX = rect.x + padding + (dstW - srcW * scale) / 2;
    const offsetY = rect.y + padding + (dstH - srcH * scale) / 2;
    return points.map((p) => ({
        x: offsetX + (p.x - minX) * scale,
        y: offsetY + (p.y - minY) * scale
    }));
}

function drawPolyline(ctx, points, close = true) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    if (close) ctx.closePath();
}

function renderArcadeCRT(ctx, width, height, timeMs, scene, options) {
    const intro = easeOutCubic(scene.introProgress);
    const action = easeOutCubic(scene.actionProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const preset = getActivePreset();
    const track = TRACKS[state.trackKey];

    ctx.fillStyle = '#070012';
    ctx.fillRect(0, 0, width, height);

    const horizonY = height * 0.48;
    const scroll = (timeMs * 0.16) % 60;
    ctx.save();
    ctx.strokeStyle = '#ff3df0';
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 3;
    for (let i = -12; i <= 12; i += 1) {
        ctx.beginPath();
        ctx.moveTo(width / 2, horizonY);
        ctx.lineTo(width / 2 + i * (width * 0.08), height);
        ctx.stroke();
    }
    ctx.strokeStyle = '#00f6ff';
    for (let y = 0; y < 24; y += 1) {
        const t = (y * 40 + scroll) / 960;
        const lineY = horizonY + (height - horizonY) * (t * t);
        if (lineY > height) continue;
        ctx.globalAlpha = 0.9 - t * 0.5;
        ctx.lineWidth = 2 + t * 4;
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        ctx.lineTo(width, lineY);
        ctx.stroke();
    }
    ctx.restore();

    const sunR = Math.min(width, height) * 0.22;
    const sunGrad = ctx.createLinearGradient(0, horizonY - sunR, 0, horizonY + sunR * 0.2);
    sunGrad.addColorStop(0, '#ffe66d');
    sunGrad.addColorStop(0.5, '#ff5bb0');
    sunGrad.addColorStop(1, '#ff2d86');
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, horizonY + 4);
    ctx.clip();
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(width / 2, horizonY + sunR * 0.25, sunR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#070012';
    for (let i = 0; i < 8; i += 1) {
        const y = horizonY - sunR * 0.1 - i * 14;
        ctx.fillRect(width / 2 - sunR, y, sunR * 2, 6);
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 60; i += 1) {
        const sx = (pseudoRand(i * 2.3) * width) | 0;
        const sy = (pseudoRand(i * 5.1) * horizonY * 0.92) | 0;
        const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(timeMs * 0.002 + i));
        ctx.globalAlpha = twinkle;
        ctx.fillRect(sx, sy, 2, 2);
    }
    ctx.restore();

    const plateY = 40;
    const plateH = 110;
    ctx.save();
    const plateAlpha = Math.min(1, intro * 1.3);
    ctx.globalAlpha = plateAlpha;
    ctx.fillStyle = '#00f6ff';
    ctx.font = '700 30px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('►►  HIGH  SCORE  ◄◄', width / 2, plateY);

    const lapStr = state.lapTime.toFixed(2);
    ctx.fillStyle = '#ffe66d';
    ctx.font = `900 ${Math.min(width * 0.22, height * 0.13)}px "JetBrains Mono", monospace`;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.fillText(lapStr, width / 2, plateY + 42);
    ctx.shadowBlur = 0;
    ctx.restore();

    const trackRectY = horizonY + 40;
    const trackRectH = height * 0.32;
    const outlinePoints = fitPointsToRect(
        getTemplateTrackOutline(),
        { x: width * 0.12, y: trackRectY, width: width * 0.76, height: trackRectH },
        12
    );
    const grid = Math.max(10, Math.round(width / 110));
    ctx.save();
    const pixCount = Math.floor(outlinePoints.length * clamp(action * 1.2, 0.05, 1));
    for (let i = 0; i < pixCount; i += 1) {
        const p = outlinePoints[i];
        const gx = Math.round(p.x / grid) * grid;
        const gy = Math.round(p.y / grid) * grid;
        ctx.fillStyle = i % 2 === 0 ? '#00f6ff' : '#ff3df0';
        ctx.fillRect(gx - grid / 2, gy - grid / 2, grid, grid);
    }
    ctx.restore();

    if (pixCount > 4) {
        const carIdx = (pixCount - 1) % outlinePoints.length;
        const carP = outlinePoints[carIdx];
        ctx.save();
        ctx.translate(carP.x, carP.y);
        const carSize = grid * 2.4;
        ctx.fillStyle = '#ffe66d';
        ctx.fillRect(-carSize / 2, -carSize * 0.35, carSize, carSize * 0.7);
        ctx.fillStyle = '#070012';
        ctx.fillRect(-carSize * 0.35, -carSize * 0.25, carSize * 0.2, carSize * 0.15);
        ctx.fillRect(carSize * 0.1, -carSize * 0.25, carSize * 0.2, carSize * 0.15);
        ctx.restore();
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ff3df0';
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.font = `900 ${Math.min(width * 0.06, 72)}px "JetBrains Mono", monospace`;
    const headlineY = height * 0.75;
    const hl = (state.headline || preset.headline).toUpperCase();
    const lines = wrapText(ctx, hl, width * 0.88);
    lines.slice(0, 3).forEach((line, i) => {
        ctx.fillText(line, width / 2, headlineY + i * (Math.min(width * 0.06, 72) * 1.1));
    });
    ctx.restore();

    ctx.save();
    const flash = (Math.floor(timeMs / 400) % 2) === 0 ? 1 : 0.25;
    ctx.globalAlpha = flash * Math.min(1, outro * 1.2 + 0.5);
    ctx.fillStyle = '#ffe66d';
    ctx.font = `700 ${Math.min(width * 0.045, 46)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`►  ${state.cta.toUpperCase()}  ◄`, width / 2, height - 120);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#00f6ff';
    ctx.font = `700 ${Math.min(width * 0.028, 28)}px "JetBrains Mono", monospace`;
    ctx.fillText(`${state.handle.toUpperCase()}  ·  ${track.name.toUpperCase()}`, width / 2, height - 70);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    for (let y = 0; y < height; y += 4) {
        ctx.fillRect(0, y, width, 2);
    }
    ctx.restore();

    const vig = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.4, width / 2, height / 2, Math.max(width, height) * 0.7);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 246, 255, 0.25)';
    ctx.lineWidth = 6;
    roundRectPath(ctx, 10, 10, width - 20, height - 20, 40);
    ctx.stroke();
    ctx.restore();
}

function renderMagazine(ctx, width, height, timeMs, scene, options) {
    const intro = easeOutCubic(scene.introProgress);
    const action = easeOutCubic(scene.actionProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const preset = getActivePreset();
    const track = TRACKS[state.trackKey];
    const red = '#b91c1c';
    const ink = '#18120b';
    const cream = '#f3ecd9';

    ctx.fillStyle = cream;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalAlpha = 0.04;
    ctx.fillStyle = '#000';
    for (let i = 0; i < 1400; i += 1) {
        const x = pseudoRand(i * 1.7) * width;
        const y = pseudoRand(i * 3.3) * height;
        ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();

    const mL = width * 0.08;
    const mR = width * 0.08;
    const mT = height * 0.06;
    const contentW = width - mL - mR;

    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mL, mT - 12);
    ctx.lineTo(width - mR, mT - 12);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.min(width * 0.032, 30)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('MINI RACER', mL, mT);
    ctx.textAlign = 'right';
    ctx.font = `italic 400 ${Math.min(width * 0.022, 22)}px Georgia, serif`;
    ctx.fillText(`CIRCUIT · SPEC · Nº ${String(Math.abs(hashStr(state.trackKey)) % 36 + 1).padStart(2, '0')}`, width - mR, mT + 6);
    ctx.font = `400 ${Math.min(width * 0.02, 20)}px Georgia, serif`;
    ctx.textAlign = 'left';
    ctx.fillText(track.name.toUpperCase(), mL, mT + 30);
    ctx.textAlign = 'right';
    ctx.fillText(`APRIL 2026`, width - mR, mT + 30);

    ctx.beginPath();
    ctx.moveTo(mL, mT + 58);
    ctx.lineTo(width - mR, mT + 58);
    ctx.stroke();
    ctx.restore();

    const lapStr = state.lapTime.toFixed(2);
    const numTop = mT + 100;
    ctx.save();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `italic 900 ${Math.min(width * 0.072, 92)}px Georgia, serif`;
    ctx.fillText('Fastest lap.', mL, numTop);
    const lapFont = Math.min(width * 0.38, height * 0.24);
    ctx.font = `900 ${lapFont}px Georgia, "Times New Roman", serif`;
    ctx.globalAlpha = Math.min(1, intro * 1.4);
    ctx.fillText(lapStr, mL - 8, numTop + 60);
    ctx.font = `italic 400 ${Math.min(width * 0.028, 28)}px Georgia, serif`;
    ctx.fillStyle = red;
    const lapWidth = ctx.measureText(lapStr).width;
    ctx.globalAlpha = 1;
    ctx.font = `italic 400 ${Math.min(width * 0.028, 28)}px Georgia, serif`;
    ctx.fillText('seconds', mL + lapWidth * 0.3 + 16, numTop + 60 + lapFont * 0.88);
    ctx.restore();

    const illuX = mL + contentW * 0.55;
    const illuY = numTop + 80;
    const illuW = contentW * 0.45;
    const illuH = height * 0.22;
    const outline = getTemplateTrackOutline();
    const fitted = fitPointsToRect(outline, { x: illuX, y: illuY, width: illuW, height: illuH }, 8);
    ctx.save();
    ctx.beginPath();
    drawPolyline(ctx, fitted, true);
    ctx.lineWidth = Math.max(6, width * 0.008);
    ctx.strokeStyle = ink;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    drawPolyline(ctx, fitted, true);
    ctx.clip();
    ctx.strokeStyle = 'rgba(24, 18, 11, 0.35)';
    ctx.lineWidth = 1;
    for (let d = -illuH; d < illuW + illuH; d += 8) {
        ctx.beginPath();
        ctx.moveTo(illuX + d, illuY);
        ctx.lineTo(illuX + d - illuH, illuY + illuH);
        ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = ink;
    ctx.font = `italic 400 ${Math.min(width * 0.022, 22)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`fig. 1 — ${track.name.toLowerCase()}`, illuX + illuW / 2, illuY + illuH + 6);
    ctx.restore();

    const tableY = numTop + Math.min(width * 0.38, height * 0.24) + 120;
    const stats = [
        ['Top speed', '214 km/h'],
        ['Avg speed', '162 km/h'],
        ['Sector 1', '09.12s'],
        ['Sector 2', '09.87s'],
        ['Sector 3', '08.49s'],
        ['Driver', state.handle]
    ];
    ctx.save();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${Math.min(width * 0.024, 24)}px Georgia, serif`;
    ctx.fillText('SPECIFICATIONS', mL, tableY);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mL, tableY + 32);
    ctx.lineTo(mL + contentW * 0.5, tableY + 32);
    ctx.stroke();

    const rowH = Math.min(width * 0.036, 36);
    const visible = Math.floor(clamp(action * 1.3, 0, 1) * stats.length);
    for (let i = 0; i < visible; i += 1) {
        const [key, val] = stats[i];
        const rowY = tableY + 44 + i * rowH;
        ctx.font = `italic 400 ${Math.min(width * 0.024, 24)}px Georgia, serif`;
        ctx.fillText(key, mL, rowY);
        ctx.textAlign = 'right';
        ctx.font = `700 ${Math.min(width * 0.024, 24)}px Georgia, serif`;
        ctx.fillText(val, mL + contentW * 0.5, rowY);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(24,18,11,0.4)';
        ctx.font = `400 ${Math.min(width * 0.024, 24)}px Georgia, serif`;
        let dotsX = mL + ctx.measureText(key).width + 8;
        while (dotsX < mL + contentW * 0.5 - ctx.measureText(val).width - 8) {
            ctx.fillText('.', dotsX, rowY);
            dotsX += 8;
        }
        ctx.fillStyle = ink;
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = ink;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const subheadText = state.subhead || preset.subhead;
    const paraX = illuX;
    const paraY = illuY + illuH + 72;
    const firstChar = subheadText.charAt(0);
    ctx.font = `900 ${Math.min(width * 0.09, 110)}px Georgia, serif`;
    ctx.fillStyle = red;
    ctx.fillText(firstChar, paraX, paraY - 8);
    const capW = ctx.measureText(firstChar).width;
    ctx.fillStyle = ink;
    ctx.font = `400 ${Math.min(width * 0.024, 24)}px Georgia, serif`;
    const rest = subheadText.slice(1).trim();
    const wrapped = wrapText(ctx, rest, illuW - capW - 14);
    wrapped.slice(0, 5).forEach((line, i) => {
        ctx.fillText(line, paraX + capW + 14, paraY + i * 32);
    });
    ctx.restore();

    const barH = 72;
    const barY = height - barH - mT * 0.4;
    ctx.save();
    ctx.globalAlpha = Math.min(1, outro * 1.4 + 0.15);
    ctx.fillStyle = red;
    ctx.fillRect(mL, barY, contentW, barH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.min(width * 0.03, 30)}px Georgia, serif`;
    ctx.fillText(`→  ${state.cta.toUpperCase()}`, mL + 24, barY + barH / 2);
    ctx.textAlign = 'right';
    ctx.font = `italic 400 ${Math.min(width * 0.024, 24)}px Georgia, serif`;
    ctx.fillText(`${state.handle}`, mL + contentW - 24, barY + barH / 2);
    ctx.restore();
}

function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
    return h | 0;
}

function renderStickerCollage(ctx, width, height, timeMs, scene, options) {
    const intro = easeOutBack(scene.introProgress);
    const action = easeOutCubic(scene.actionProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const preset = getActivePreset();
    const track = TRACKS[state.trackKey];
    const moods = {
        'skill-check': '#ffd94d',
        'warning': '#ffd94d',
        'speed': '#ff3da8',
        'danger': '#ff3b3b',
        'cool': '#64ecff',
        'neutral': '#9cff64',
        'victory': '#c3ff4d'
    };
    const bgColor = moods[preset.mood] || '#ff3da8';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#000';
    for (let i = -8; i < 40; i += 1) {
        ctx.save();
        ctx.translate(i * 80 + (timeMs * 0.02) % 80, 0);
        ctx.rotate(-0.5);
        ctx.fillRect(0, -50, 26, height + 100);
        ctx.restore();
    }
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hl = (state.headline || preset.headline).toUpperCase();
    const hlFont = Math.min(width * 0.12, 130);
    ctx.font = `900 ${hlFont}px Impact, "Oswald", "Outfit", system-ui, sans-serif`;
    const lines = wrapText(ctx, hl, width * 0.88);
    const firstLineY = height * 0.22;
    lines.slice(0, 3).forEach((line, i) => {
        const y = firstLineY + i * hlFont * 0.92;
        const rotation = ((i % 2) === 0 ? -0.03 : 0.025) * (0.5 + 0.5 * intro);
        ctx.save();
        ctx.translate(width / 2, y);
        ctx.rotate(rotation);
        ctx.globalAlpha = Math.min(1, intro * 1.2);
        ctx.fillStyle = '#000';
        ctx.fillText(line, 6, 8);
        ctx.lineWidth = Math.max(8, hlFont * 0.07);
        ctx.strokeStyle = '#000';
        ctx.lineJoin = 'round';
        ctx.strokeText(line, 0, 0);
        ctx.fillStyle = '#fff';
        ctx.fillText(line, 0, 0);
        ctx.restore();
    });
    ctx.restore();

    const polW = Math.min(width * 0.55, 420);
    const polH = polW * 1.08;
    const polX = width / 2 - polW / 2;
    const polY = height * 0.48;
    ctx.save();
    ctx.translate(polX + polW / 2, polY + polH / 2);
    ctx.rotate(-0.08);
    ctx.translate(-(polX + polW / 2), -(polY + polH / 2));
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(polX + 8, polY + 14, polW, polH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(polX, polY, polW, polH);
    const imgPadding = 18;
    const imgRect = { x: polX + imgPadding, y: polY + imgPadding, width: polW - imgPadding * 2, height: polH - imgPadding * 2 - 70 };
    ctx.fillStyle = '#f0ede4';
    ctx.fillRect(imgRect.x, imgRect.y, imgRect.width, imgRect.height);
    const fitted = fitPointsToRect(getTemplateTrackOutline(), imgRect, 18);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    drawPolyline(ctx, fitted, true);
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `italic 700 ${Math.min(width * 0.028, 28)}px "Caveat", "Shadows Into Light", cursive, Georgia, serif`;
    ctx.fillText(`${track.name} ♡`, polX + polW / 2, polY + polH - 36);
    ctx.restore();

    const tape = (cx, cy, angle) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = '#f0f0e0';
        ctx.fillRect(-40, -12, 80, 24);
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.strokeRect(-40, -12, 80, 24);
        ctx.restore();
    };
    tape(polX + 16, polY + 10, -0.4);
    tape(polX + polW - 16, polY + 10, 0.35);

    const starX = width - Math.min(width * 0.22, 180);
    const starY = Math.min(height * 0.25, 220);
    const starR = Math.min(width * 0.13, 130);
    ctx.save();
    const starPulse = 1 + 0.04 * Math.sin(timeMs * 0.006);
    ctx.translate(starX, starY);
    ctx.rotate(0.3 + (1 - intro) * 0.8);
    ctx.scale(starPulse * Math.min(1, intro * 1.6), starPulse * Math.min(1, intro * 1.6));
    ctx.beginPath();
    const points = 20;
    for (let i = 0; i < points; i += 1) {
        const r = i % 2 === 0 ? starR : starR * 0.6;
        const a = (i / points) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${starR * 0.28}px Impact, "Outfit", system-ui, sans-serif`;
    ctx.fillText('NEW', 0, -starR * 0.18);
    ctx.fillStyle = '#ff3b3b';
    ctx.font = `900 ${starR * 0.45}px Impact, "Outfit", system-ui, sans-serif`;
    ctx.fillText(`${state.lapTime.toFixed(2)}s`, 0, starR * 0.12);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.globalAlpha = Math.min(1, action * 1.4);
    ctx.beginPath();
    ctx.moveTo(starX - starR * 1.1, starY + starR * 1.1);
    ctx.quadraticCurveTo(starX - starR * 2, starY + starR * 2.5, starX - starR * 2.2, starY + starR * 3.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(starX - starR * 2.2, starY + starR * 3.2);
    ctx.lineTo(starX - starR * 1.95, starY + starR * 2.9);
    ctx.moveTo(starX - starR * 2.2, starY + starR * 3.2);
    ctx.lineTo(starX - starR * 2.55, starY + starR * 3.0);
    ctx.stroke();
    ctx.restore();

    const ctaY = height - 150;
    const ctaH = 100;
    ctx.save();
    ctx.globalAlpha = Math.min(1, outro * 1.3 + 0.3);
    ctx.translate(width / 2, ctaY + ctaH / 2);
    ctx.rotate(-0.015);
    ctx.translate(-width / 2, -(ctaY + ctaH / 2));
    ctx.fillStyle = '#000';
    ctx.fillRect(width * 0.08 + 6, ctaY + 8, width * 0.84, ctaH);
    ctx.fillStyle = '#fff';
    ctx.fillRect(width * 0.08, ctaY, width * 0.84, ctaH);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.strokeRect(width * 0.08, ctaY, width * 0.84, ctaH);
    const flagX = width * 0.12;
    const flagSize = 40;
    const cells = 4;
    const cell = flagSize / cells;
    for (let cx = 0; cx < cells; cx += 1) {
        for (let cy = 0; cy < cells; cy += 1) {
            ctx.fillStyle = (cx + cy) % 2 === 0 ? '#000' : '#fff';
            ctx.fillRect(flagX + cx * cell, ctaY + ctaH / 2 - flagSize / 2 + cy * cell, cell, cell);
        }
    }
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.min(width * 0.044, 44)}px Impact, "Outfit", system-ui, sans-serif`;
    ctx.fillText(state.cta.toUpperCase(), flagX + flagSize + 20, ctaY + ctaH / 2 - 4);
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.min(width * 0.024, 22)}px "Outfit", system-ui, sans-serif`;
    ctx.fillText(state.handle, width * 0.92 - 16, ctaY + ctaH / 2 + 18);
    ctx.restore();
}

function renderTelemetry(ctx, width, height, timeMs, scene, options) {
    const intro = easeOutCubic(scene.introProgress);
    const action = easeOutCubic(scene.actionProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const preset = getActivePreset();
    const track = TRACKS[state.trackKey];
    const red = '#c01d1d';
    const ink = '#111';

    ctx.fillStyle = '#fbfaf4';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#000';
    for (let i = 0; i < 1200; i += 1) {
        ctx.fillRect(pseudoRand(i * 2.1) * width, pseudoRand(i * 3.7) * height, 1, 1);
    }
    ctx.restore();

    const mL = width * 0.12;
    const mR = width * 0.12;
    const mT = height * 0.06;
    const contentW = width - mL - mR;

    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(mL - 18, mT - 18, contentW + 36, height - mT * 1.5 + 20);
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${Math.min(width * 0.03, 28)}px "JetBrains Mono", monospace`;
    ctx.fillText('MINI RACER // PIT LANE', mL, mT);
    ctx.textAlign = 'right';
    ctx.font = `400 ${Math.min(width * 0.022, 20)}px "JetBrains Mono", monospace`;
    const seed = Math.abs(hashStr(state.trackKey + state.presetId)) % 99999;
    ctx.fillText(`TX #${String(seed).padStart(5, '0')}`, width - mR, mT);
    ctx.textAlign = 'left';
    ctx.font = `400 ${Math.min(width * 0.022, 20)}px "JetBrains Mono", monospace`;
    ctx.fillText(`DATE ........ 22.APR.2026`, mL, mT + 34);
    ctx.fillText(`SESSION .... TIME TRIAL`, mL, mT + 60);
    ctx.fillText(`DRIVER ..... ${state.handle}`, mL, mT + 86);
    ctx.fillText(`CIRCUIT .... ${track.name.toUpperCase()}`, mL, mT + 112);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mL, mT + 144);
    ctx.lineTo(width - mR, mT + 144);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const tableY = mT + 170;
    const rows = [
        ['SECTOR 01', '09.12s', '+0.00'],
        ['SECTOR 02', '09.87s', '-0.14'],
        ['SECTOR 03', '08.49s', '-0.41'],
        ['', '', ''],
        ['LAP TOTAL', `${state.lapTime.toFixed(2)}s`, 'BEST'],
        ['TOP SPEED', '214 km/h', ''],
        ['AVG SPEED', '162 km/h', ''],
        ['THROTTLE', '94%', '']
    ];
    ctx.save();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const rowH = Math.min(width * 0.034, 34);
    const visible = Math.floor(clamp(action * 1.3, 0, 1) * rows.length);
    for (let i = 0; i < visible; i += 1) {
        const [k, v, n] = rows[i];
        const y = tableY + i * rowH;
        if (!k) continue;
        ctx.font = `400 ${Math.min(width * 0.026, 24)}px "JetBrains Mono", monospace`;
        ctx.fillText(k, mL, y);
        ctx.textAlign = 'right';
        ctx.font = `700 ${Math.min(width * 0.028, 26)}px "JetBrains Mono", monospace`;
        if (k === 'LAP TOTAL') {
            ctx.fillStyle = red;
            ctx.fillText(v, width - mR - 140, y);
            ctx.fillStyle = ink;
        } else {
            ctx.fillText(v, width - mR - 140, y);
        }
        ctx.font = `400 ${Math.min(width * 0.022, 20)}px "JetBrains Mono", monospace`;
        ctx.fillStyle = n === 'BEST' ? red : (n.startsWith('-') ? '#256a2b' : (n.startsWith('+') ? red : 'rgba(0,0,0,0.6)'));
        ctx.fillText(n, width - mR, y);
        ctx.fillStyle = ink;
        ctx.textAlign = 'left';
    }
    ctx.restore();

    const trackRect = { x: mL, y: tableY + 8 * rowH + 24, width: contentW * 0.55, height: height * 0.18 };
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    const fitted = fitPointsToRect(getTemplateTrackOutline(), trackRect, 6);
    drawPolyline(ctx, fitted, true);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.font = `400 ${Math.min(width * 0.02, 18)}px "JetBrains Mono", monospace`;
    ctx.fillText(`┌─ CIRCUIT MAP`, trackRect.x, trackRect.y - 22);
    ctx.restore();

    ctx.save();
    const stampX = width - mR - 60;
    const stampY = tableY + 3 * rowH + 20;
    ctx.translate(stampX, stampY);
    ctx.rotate(-0.12);
    ctx.globalAlpha = Math.min(1, outro * 1.2 + 0.3);
    ctx.strokeStyle = red;
    ctx.fillStyle = red;
    ctx.lineWidth = 4;
    ctx.strokeRect(-130, -50, 260, 100);
    ctx.strokeRect(-120, -42, 240, 84);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.min(width * 0.045, 42)}px Georgia, serif`;
    ctx.fillText('NEW RECORD', 0, 0);
    ctx.restore();

    ctx.save();
    const barY = height - 120;
    const barH = 50;
    let x = mL;
    const barcodeSeed = seed;
    while (x < width - mR) {
        const w = 1 + (Math.floor(pseudoRand((barcodeSeed + x) * 0.31) * 4));
        ctx.fillStyle = (Math.floor(pseudoRand((barcodeSeed + x) * 0.17) * 2) === 0) ? ink : 'transparent';
        ctx.fillRect(x, barY, w, barH);
        x += w + 1;
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.font = `400 ${Math.min(width * 0.022, 20)}px "JetBrains Mono", monospace`;
    ctx.fillText(`*VECTOR-GP-${String(seed).padStart(5, '0')}*`, width / 2, barY + 56);
    ctx.font = `700 ${Math.min(width * 0.025, 24)}px "JetBrains Mono", monospace`;
    ctx.fillText(`>> ${state.cta.toUpperCase()} <<`, width / 2, height - 48);
    ctx.restore();
}

function renderTradingCard(ctx, width, height, timeMs, scene, options) {
    const intro = easeOutBack(scene.introProgress);
    const action = easeOutCubic(scene.actionProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const preset = getActivePreset();
    const track = TRACKS[state.trackKey];

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#0a0420');
    bg.addColorStop(0.5, '#1a0a3a');
    bg.addColorStop(1, '#0a0420');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const cardPad = Math.min(width * 0.07, 54);
    const cardW = width - cardPad * 2;
    const cardH = height - cardPad * 2;
    const cardX = cardPad;
    const cardY = cardPad;

    ctx.save();
    const foil = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
    foil.addColorStop(0, '#b78a2a');
    foil.addColorStop(0.25, '#ffd97a');
    foil.addColorStop(0.5, '#f0c246');
    foil.addColorStop(0.75, '#fff3b0');
    foil.addColorStop(1, '#9a6e18');
    roundRectPath(ctx, cardX, cardY, cardW, cardH, 32);
    ctx.fillStyle = foil;
    ctx.fill();
    ctx.restore();

    const innerX = cardX + 18;
    const innerY = cardY + 18;
    const innerW = cardW - 36;
    const innerH = cardH - 36;
    ctx.save();
    roundRectPath(ctx, innerX, innerY, innerW, innerH, 22);
    const inner = ctx.createLinearGradient(0, innerY, 0, innerY + innerH);
    inner.addColorStop(0, '#1b0f3a');
    inner.addColorStop(1, '#05031a');
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.restore();

    const plateY = innerY + 22;
    const plateH = 76;
    ctx.save();
    const holo = ctx.createLinearGradient(innerX, plateY, innerX + innerW, plateY);
    const shift = (timeMs * 0.0006) % 1;
    const colors = ['#ff3df0', '#8a33ff', '#33a7ff', '#33ffa7', '#ffe03d', '#ff3df0'];
    colors.forEach((c, i) => holo.addColorStop(((i / (colors.length - 1)) + shift) % 1, c));
    roundRectPath(ctx, innerX + 16, plateY, innerW - 32, plateH, 12);
    ctx.fillStyle = holo;
    ctx.fill();
    ctx.fillStyle = '#0a0420';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.min(width * 0.045, 40)}px "Outfit", system-ui, sans-serif`;
    ctx.fillText(track.name.toUpperCase(), width / 2, plateY + plateH / 2);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#ffd97a';
    ctx.strokeStyle = '#5a3d0c';
    ctx.lineWidth = 2;
    const starCount = 5;
    const starY = plateY + plateH + 22;
    const starSize = 18;
    const totalW = starCount * starSize * 2.4;
    for (let i = 0; i < starCount; i += 1) {
        const sx = width / 2 - totalW / 2 + i * starSize * 2.4 + starSize;
        drawStar(ctx, sx, starY, starSize, 5);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();

    const winPad = 36;
    const winX = innerX + winPad;
    const winY = starY + 44;
    const winW = innerW - winPad * 2;
    const winH = innerH * 0.38;
    ctx.save();
    ctx.strokeStyle = '#e6c35e';
    ctx.lineWidth = 5;
    roundRectPath(ctx, winX, winY, winW, winH, 12);
    ctx.stroke();
    roundRectPath(ctx, winX + 3, winY + 3, winW - 6, winH - 6, 10);
    ctx.fillStyle = '#0d0624';
    ctx.fill();
    const fitted = fitPointsToRect(getTemplateTrackOutline(), { x: winX + 12, y: winY + 12, width: winW - 24, height: winH - 24 }, 8);
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    drawPolyline(ctx, fitted, true);
    ctx.stroke();
    ctx.restore();
    const orn = (ox, oy) => {
        ctx.save();
        ctx.translate(ox, oy);
        ctx.fillStyle = '#e6c35e';
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };
    orn(winX + 10, winY + 10);
    orn(winX + winW - 10, winY + 10);
    orn(winX + 10, winY + winH - 10);
    orn(winX + winW - 10, winY + winH - 10);
    ctx.restore();

    const statsY = winY + winH + 28;
    const statRowH = 38;
    const stats = [
        { label: 'SPEED', value: 4 },
        { label: 'GRIP', value: 3 },
        { label: 'DIFFICULTY', value: 5 },
        { label: 'FLOW', value: 4 }
    ];
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const statRevealCount = Math.floor(clamp(action * 1.3, 0, 1) * stats.length);
    stats.forEach((stat, i) => {
        const y = statsY + i * statRowH;
        if (i >= statRevealCount) return;
        ctx.fillStyle = '#e6c35e';
        ctx.font = `700 ${Math.min(width * 0.024, 22)}px "Outfit", system-ui, sans-serif`;
        ctx.fillText(stat.label, innerX + 28, y);
        const barX = innerX + 180;
        const barW = innerW - 220;
        const blocks = 5;
        const gap = 4;
        const blockW = (barW - gap * (blocks - 1)) / blocks;
        for (let b = 0; b < blocks; b += 1) {
            ctx.fillStyle = b < stat.value ? '#ffd97a' : 'rgba(255, 217, 122, 0.2)';
            ctx.fillRect(barX + b * (blockW + gap), y - 10, blockW, 20);
        }
    });
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lapY = innerY + innerH - 120;
    ctx.fillStyle = '#e6c35e';
    ctx.font = `700 ${Math.min(width * 0.024, 22)}px "Outfit", system-ui, sans-serif`;
    ctx.fillText('LAP RECORD', width / 2, lapY - 46);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = Math.min(1, intro * 1.3);
    ctx.font = `900 ${Math.min(width * 0.14, 120)}px "JetBrains Mono", monospace`;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.fillText(`${state.lapTime.toFixed(2)}s`, width / 2, lapY);
    ctx.shadowBlur = 0;
    ctx.restore();

    const footY = innerY + innerH - 54;
    ctx.save();
    ctx.fillStyle = 'rgba(230, 195, 94, 0.14)';
    ctx.fillRect(innerX + 20, footY, innerW - 40, 34);
    ctx.fillStyle = '#e6c35e';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.min(width * 0.022, 20)}px "Outfit", system-ui, sans-serif`;
    ctx.fillText(`LEGENDARY · ${state.handle}`, innerX + 32, footY + 17);
    ctx.textAlign = 'right';
    ctx.fillText(`01 / ∞`, innerX + innerW - 32, footY + 17);
    ctx.restore();
}

function drawStar(ctx, cx, cy, outerR, points) {
    const innerR = outerR * 0.45;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

function renderCockpitPOV(ctx, width, height, timeMs, scene, options) {
    const intro = easeOutCubic(scene.introProgress);
    const action = easeOutCubic(scene.actionProgress);
    const outro = easeOutCubic(scene.outroProgress);
    const preset = getActivePreset();
    const track = TRACKS[state.trackKey];

    const horizonY = height * 0.42;
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, '#1b1047');
    sky.addColorStop(0.6, '#ff4d7a');
    sky.addColorStop(1, '#ffb36d');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, horizonY);

    const ground = ctx.createLinearGradient(0, horizonY, 0, height);
    ground.addColorStop(0, '#2a1c4a');
    ground.addColorStop(1, '#06030f');
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizonY, width, height - horizonY);

    ctx.save();
    ctx.fillStyle = 'rgba(10, 4, 32, 0.72)';
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    for (let x = 0; x <= width; x += 40) {
        const bump = Math.sin(x * 0.006) * 26 + Math.sin(x * 0.013 + 1) * 18 + Math.sin(x * 0.024) * 10;
        ctx.lineTo(x, horizonY - 30 - bump);
    }
    ctx.lineTo(width, horizonY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(255, 210, 110, 0.9)';
    ctx.beginPath();
    ctx.arc(width * 0.58, horizonY - 20, Math.min(width, height) * 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const roadCenterX = width / 2;
    const roadFarW = width * 0.1;
    const roadNearW = width * 1.1;
    ctx.save();
    ctx.fillStyle = '#1a1220';
    ctx.beginPath();
    ctx.moveTo(roadCenterX - roadFarW / 2, horizonY);
    ctx.lineTo(roadCenterX + roadFarW / 2, horizonY);
    ctx.lineTo(roadCenterX + roadNearW / 2, height);
    ctx.lineTo(roadCenterX - roadNearW / 2, height);
    ctx.closePath();
    ctx.fill();

    const rumbleCount = 18;
    const scroll = (timeMs * 0.0014) % 1;
    for (let i = 0; i < rumbleCount; i += 1) {
        const t0 = ((i / rumbleCount) + scroll) % 1;
        const t1 = Math.min(1, t0 + 1 / rumbleCount);
        const ty0 = horizonY + (height - horizonY) * (t0 * t0);
        const ty1 = horizonY + (height - horizonY) * (t1 * t1);
        const fx0 = roadCenterX - (roadFarW + (roadNearW - roadFarW) * (t0 * t0)) / 2;
        const fx1 = roadCenterX - (roadFarW + (roadNearW - roadFarW) * (t1 * t1)) / 2;
        const nx0 = roadCenterX + (roadFarW + (roadNearW - roadFarW) * (t0 * t0)) / 2;
        const nx1 = roadCenterX + (roadFarW + (roadNearW - roadFarW) * (t1 * t1)) / 2;
        ctx.fillStyle = i % 2 === 0 ? '#dc2626' : '#f5f5f5';
        ctx.beginPath();
        ctx.moveTo(fx0, ty0);
        ctx.lineTo(fx0 - 18, ty0);
        ctx.lineTo(fx1 - 26, ty1);
        ctx.lineTo(fx1, ty1);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(nx0, ty0);
        ctx.lineTo(nx0 + 18, ty0);
        ctx.lineTo(nx1 + 26, ty1);
        ctx.lineTo(nx1, ty1);
        ctx.closePath();
        ctx.fill();
        if (i % 2 === 0) {
            ctx.fillStyle = '#f5f5f5';
            const cx0 = roadCenterX;
            const cw0 = (roadFarW + (roadNearW - roadFarW) * (t0 * t0)) * 0.015;
            const cw1 = (roadFarW + (roadNearW - roadFarW) * (t1 * t1)) * 0.015;
            ctx.beginPath();
            ctx.moveTo(cx0 - cw0, ty0);
            ctx.lineTo(cx0 + cw0, ty0);
            ctx.lineTo(cx0 + cw1, ty1);
            ctx.lineTo(cx0 - cw1, ty1);
            ctx.closePath();
            ctx.fill();
        }
    }
    ctx.restore();

    const mirrorW = width * 0.3;
    const mirrorH = height * 0.08;
    const mirrorX = width / 2 - mirrorW / 2;
    const mirrorY = height * 0.02;
    ctx.save();
    roundRectPath(ctx, mirrorX, mirrorY, mirrorW, mirrorH, 18);
    ctx.fillStyle = '#0a0a12';
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 4;
    ctx.stroke();
    const mirrorFitted = fitPointsToRect(getTemplateTrackOutline(), { x: mirrorX + 10, y: mirrorY + 6, width: mirrorW - 20, height: mirrorH - 12 }, 4);
    ctx.strokeStyle = '#9ae6b4';
    ctx.lineWidth = 2;
    drawPolyline(ctx, mirrorFitted, true);
    ctx.stroke();
    ctx.fillStyle = '#9ae6b4';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.min(width * 0.018, 16)}px "JetBrains Mono", monospace`;
    ctx.fillText(track.name.toUpperCase(), mirrorX + mirrorW - 14, mirrorY + mirrorH / 2);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(width * 0.04, height * 0.04, width * 0.2, height * 0.08);
    ctx.strokeStyle = '#ffe066';
    ctx.lineWidth = 2;
    ctx.strokeRect(width * 0.04, height * 0.04, width * 0.2, height * 0.08);
    ctx.fillStyle = '#ffe066';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${Math.min(width * 0.018, 16)}px "JetBrains Mono", monospace`;
    ctx.fillText('LAP', width * 0.055, height * 0.055);
    ctx.font = `900 ${Math.min(width * 0.04, 40)}px "JetBrains Mono", monospace`;
    ctx.fillText(`${state.lapTime.toFixed(2)}s`, width * 0.055, height * 0.075);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(200, 220, 255, 0.5)';
    for (let i = 0; i < 36; i += 1) {
        const rx = pseudoRand(i * 1.7) * width;
        const ry = ((pseudoRand(i * 3.3) * height * 0.7) + (timeMs * (0.02 + pseudoRand(i * 5.1) * 0.04))) % (height * 0.8);
        ctx.beginPath();
        ctx.ellipse(rx, ry, 2.5, 6, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();

    const dashY = height * 0.78;
    const dashGrad = ctx.createLinearGradient(0, dashY - 20, 0, height);
    dashGrad.addColorStop(0, 'rgba(0,0,0,0)');
    dashGrad.addColorStop(0.4, 'rgba(0,0,0,0.9)');
    dashGrad.addColorStop(1, '#000');
    ctx.fillStyle = dashGrad;
    ctx.fillRect(0, dashY - 20, width, height - dashY + 20);

    const wheelCx = width / 2;
    const wheelCy = height + height * 0.12;
    const wheelR = Math.min(width * 0.45, height * 0.36);
    ctx.save();
    ctx.strokeStyle = '#2a2a2e';
    ctx.lineWidth = 42;
    ctx.beginPath();
    ctx.arc(wheelCx, wheelCy, wheelR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 36;
    ctx.beginPath();
    ctx.arc(wheelCx, wheelCy, wheelR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#1a1a20';
    ctx.lineWidth = 22;
    const spokeAngles = [-2.1, -1, Math.PI / 2];
    spokeAngles.forEach((a) => {
        ctx.beginPath();
        ctx.moveTo(wheelCx, wheelCy);
        ctx.lineTo(wheelCx + Math.cos(a) * wheelR, wheelCy + Math.sin(a) * wheelR);
        ctx.stroke();
    });
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(wheelCx, wheelCy, 72, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffe066';
    ctx.font = `900 ${Math.min(width * 0.022, 20)}px "Outfit", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VGP', wheelCx, wheelCy - 4);
    const leds = 12;
    const speedPct = 0.5 + 0.45 * Math.sin(timeMs * 0.004);
    for (let i = 0; i < leds; i += 1) {
        const t = i / (leds - 1);
        const ang = -Math.PI * 0.75 + t * Math.PI * 0.5;
        const x = wheelCx + Math.cos(ang) * 52;
        const y = wheelCy + Math.sin(ang) * 52;
        const on = t <= speedPct;
        ctx.fillStyle = on ? (t < 0.5 ? '#22c55e' : (t < 0.8 ? '#ffb020' : '#ef4444')) : 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();

    const gaugeY = height - 120;
    const drawGauge = (cx, cy, r, pct, label, color) => {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 0.25, false);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * pct, false);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${Math.min(width * 0.018, 16)}px "JetBrains Mono", monospace`;
        ctx.fillText(label, cx, cy + r - 4);
        ctx.restore();
    };
    drawGauge(width * 0.15, gaugeY, 54, speedPct, `${Math.round(speedPct * 360)} km/h`, '#38bdf8');
    drawGauge(width * 0.85, gaugeY, 54, 0.8 + 0.1 * Math.sin(timeMs * 0.003), '9850 RPM', '#ef4444');

    ctx.save();
    ctx.globalAlpha = Math.min(1, outro * 1.3 + 0.3);
    const ctaY = height - 76;
    ctx.fillStyle = 'rgba(255, 224, 102, 0.92)';
    ctx.fillRect(width * 0.12, ctaY, width * 0.76, 38);
    ctx.fillStyle = '#0a0a0a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.min(width * 0.026, 24)}px "Outfit", system-ui, sans-serif`;
    ctx.fillText(`${state.cta.toUpperCase()}   ·   ${state.handle}`, width / 2, ctaY + 19);
    ctx.restore();

    ctx.save();
    const hl = (state.headline || preset.headline).toUpperCase();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `900 ${Math.min(width * 0.05, 52)}px "Outfit", system-ui, sans-serif`;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    const hlLines = wrapText(ctx, hl, width * 0.82);
    hlLines.slice(0, 2).forEach((line, i) => {
        ctx.fillText(line, width / 2, height * 0.15 + i * Math.min(width * 0.05, 52) * 1.05);
    });
    ctx.restore();
}

function renderFrame(ctx, timeMs, options = {}) {
    const canvas = ctx.canvas;
    const width = canvas.width;
    const height = canvas.height;
    const aspectId = options.aspectId ?? state.aspectId;
    const aspect = getAspectRatio(aspectId);
    const theme = THEMES.find((candidate) => candidate.id === state.themeId) ?? THEMES[0];
    const replayOnly = options.captureMode === 'replay-only';
    const durationMs = state.durationSec * 1000;

    const seamlessLoop = options.seamlessLoop ?? state.seamlessLoop;
    const blendMs = Math.min(SEAMLESS_BLEND_SEC * 1000, durationMs * 0.25);
    const applyBlend = seamlessLoop && !options.poster && blendMs > 0 && timeMs > durationMs - blendMs;

    const progress = clamp(timeMs / durationMs, 0, 1);
    const introProgress = clamp(progress / 0.18, 0, 1);
    const actionProgress = clamp((progress - 0.1) / 0.62, 0, 1);
    const routeProgress = clamp((progress - 0.16) / 0.54, 0, 1);
    const outroProgress = clamp((progress - 0.76) / 0.24, 0, 1);
    const scene = {
        introProgress,
        actionProgress,
        routeProgress,
        outroProgress,
        progress,
        hook: introProgress,
        reveal: actionProgress,
        apex: 0,
        payoff: outroProgress,
        payoffPop: 0,
        hookPunch: 0,
        apexHit: 0,
        shake: 0,
        flash: 0
    };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, width, height);

    const templateRenderer = getTemplateRenderer(state.templateStyle);
    if (templateRenderer) {
        templateRenderer(ctx, width, height, timeMs, scene, { ...options, theme, aspect });
        if (applyBlend) {
            const startTimeMs = timeMs - (durationMs - blendMs) - blendMs;
            const blendAlpha = clamp((timeMs - (durationMs - blendMs)) / blendMs, 0, 1);
            const offscreen = getLoopBlendCanvas(width, height);
            const blendCtx = offscreen.getContext('2d');
            blendCtx.setTransform(1, 0, 0, 1, 0, 0);
            blendCtx.clearRect(0, 0, width, height);
            renderFrame(blendCtx, Math.max(0, startTimeMs + blendMs), {
                ...options,
                captureMode: options.captureMode,
                aspectId,
                seamlessLoop: false,
                _inBlend: true
            });
            ctx.save();
            ctx.globalAlpha = blendAlpha;
            ctx.drawImage(offscreen, 0, 0);
            ctx.restore();
        }
        if (state.showSafeZones && !options.exporting && !options.poster && !options._inBlend) {
            drawSafeZoneOverlay(ctx, width, height, aspect);
        }
        if (!options.exporting && !options.poster && !options._inBlend) {
            ctx.save();
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(255,255,255,0.16)';
            ctx.font = '700 24px outfit, system-ui, sans-serif';
            ctx.fillText('PREVIEW LOOP', width / 2, 40);
            ctx.restore();
        }
        return;
    }

    drawBackground(ctx, theme, width, height, timeMs, state.showGrid);

    if (state.renderMode === 'gameplay-replay') {
        const layout = replayOnly
            ? {
                ...computeGameplayLayout(ctx, width, height, aspect),
                viewportRect: {
                    x: 36,
                    y: 36,
                    width: width - 72,
                    height: height - 72
                }
            }
            : computeGameplayLayout(ctx, width, height, aspect);
        if (!replayOnly) {
            drawGameplayTextBlocks(ctx, width, height, theme, scene, layout, options);
        }
        drawGameplayScene(ctx, width, height, theme, scene, timeMs, layout, options);
    } else {
        const layout = replayOnly
            ? {
                ...computeTraceLayout(ctx, width, height, aspect),
                trackRect: {
                    x: 44,
                    y: 44,
                    width: width - 88,
                    height: height - 228
                },
                statY: height - 156
            }
            : computeTraceLayout(ctx, width, height, aspect);
        if (!replayOnly) {
            drawTraceTextBlocks(ctx, width, height, theme, scene, layout);
        }
        drawTrackScene(ctx, width, height, theme, scene, timeMs, layout);
    }

    if (applyBlend) {
        const startTimeMs = timeMs - (durationMs - blendMs) - blendMs;
        const blendAlpha = clamp((timeMs - (durationMs - blendMs)) / blendMs, 0, 1);
        const offscreen = getLoopBlendCanvas(width, height);
        const blendCtx = offscreen.getContext('2d');
        blendCtx.setTransform(1, 0, 0, 1, 0, 0);
        blendCtx.clearRect(0, 0, width, height);
        renderFrame(blendCtx, Math.max(0, startTimeMs + blendMs), {
            ...options,
            captureMode: options.captureMode,
            aspectId,
            seamlessLoop: false,
            _inBlend: true
        });
        ctx.save();
        ctx.globalAlpha = blendAlpha;
        ctx.drawImage(offscreen, 0, 0);
        ctx.restore();
    }

    if (state.showSafeZones && !options.exporting && !options.poster && !options._inBlend) {
        drawSafeZoneOverlay(ctx, width, height, aspect);
    }

    if (!options.exporting && !options.poster && !options._inBlend) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.font = '700 24px outfit, system-ui, sans-serif';
        ctx.fillText('PREVIEW LOOP', width / 2, 54);
        ctx.restore();
    }
}

let loopBlendCanvas = null;
function getLoopBlendCanvas(width, height) {
    if (!loopBlendCanvas) {
        loopBlendCanvas = document.createElement('canvas');
    }
    if (loopBlendCanvas.width !== width || loopBlendCanvas.height !== height) {
        loopBlendCanvas.width = width;
        loopBlendCanvas.height = height;
    }
    return loopBlendCanvas;
}

function populateSelect(select, items) {
    select.innerHTML = '';
    items.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.appendChild(option);
    });
}

function populateTrackSelect() {
    el.trackSelect.innerHTML = '';
    Object.entries(TRACKS).forEach(([trackKey, track]) => {
        const option = document.createElement('option');
        option.value = trackKey;
        option.textContent = track.name;
        el.trackSelect.appendChild(option);
    });
}

function syncFormFromState() {
    el.trackSelect.value = state.trackKey;
    el.renderModeSelect.value = state.renderMode;
    if (el.templateStyleSelect) el.templateStyleSelect.value = state.templateStyle;
    el.presetSelect.value = state.presetId;
    el.themeSelect.value = state.themeId;
    if (el.aspectSelect) el.aspectSelect.value = state.aspectId;
    el.headlineInput.value = state.headline;
    el.subheadInput.value = state.subhead;
    el.ctaInput.value = state.cta;
    el.lapTimeInput.value = String(state.lapTime);
    el.durationInput.value = String(state.durationSec);
    el.handleInput.value = state.handle;
    el.showGridToggle.checked = state.showGrid;
    el.showTimerToggle.checked = state.showTimer;
    if (el.showSafeZonesToggle) el.showSafeZonesToggle.checked = state.showSafeZones;
    if (el.seamlessLoopToggle) el.seamlessLoopToggle.checked = state.seamlessLoop;
    el.exportFormatSelect.value = state.exportFormat;
    el.exportContentSelect.value = state.exportContent;
    resizeCanvasesForState();
    updateStatusUi();
}

function resizeCanvasesForState() {
    const aspect = getAspectRatio(state.aspectId);
    if (el.canvas.width !== aspect.width) el.canvas.width = aspect.width;
    if (el.canvas.height !== aspect.height) el.canvas.height = aspect.height;
    el.canvas.style.aspectRatio = `${aspect.width} / ${aspect.height}`;
    el.canvas.style.maxWidth = aspect.layout === 'horizontal' ? 'min(100%, 720px)' : 'min(100%, 420px)';
    sizeExportCanvas(aspect.width, aspect.height);
    if (el.resolutionMetric) {
        el.resolutionMetric.textContent = `${aspect.width} × ${aspect.height}`;
    }
}

function updateStatusUi(message) {
    if (typeof message === 'string') {
        state.statusMessage = message;
    }
    const idleMessage = state.renderMode === 'gameplay-replay'
        ? 'Gameplay replay now uses one timed lap model: clip length retimes the replay, and lap time drives the stopwatch.'
        : 'Trace preview keeps the map-first route reveal for teaser-style promo clips.';
    el.trackNameMetric.textContent = TRACKS[state.trackKey].name;
    el.playheadMetric.textContent = `${(state.playheadMs / 1000).toFixed(1)}s`;
    el.playToggleBtn.textContent = state.isPlaying ? 'Pause Preview' : 'Play Preview';
    el.promoStatusPill.textContent = state.exportInProgress ? 'Exporting' : 'Ready';
    el.playbackPill.textContent = state.exportInProgress ? 'Recording' : state.isPlaying ? 'Looping' : 'Paused';
    el.statusText.textContent = state.statusMessage || (state.exportInProgress
        ? 'Recording the vertical clip. Keep this tab visible until the download starts.'
        : idleMessage);
}

function setPreset(presetId) {
    const preset = PROMO_PRESETS.find((candidate) => candidate.id === presetId) ?? PROMO_PRESETS[0];
    state.presetId = preset.id;
    state.headline = preset.headline;
    state.subhead = preset.subhead;
    state.cta = preset.cta;
    syncFormFromState();
    renderPreview();
}

function restartPreview() {
    state.playheadMs = 0;
    state.lastFrameAt = performance.now();
    renderPreview();
    updateStatusUi('Preview restarted from frame one.');
}

function renderPreview() {
    renderFrame(previewCtx, state.playheadMs);
    updateStatusUi();
}

function readFormIntoState() {
    state.statusMessage = '';
    state.trackKey = el.trackSelect.value;
    state.renderMode = el.renderModeSelect.value;
    if (el.templateStyleSelect) state.templateStyle = el.templateStyleSelect.value;
    state.themeId = el.themeSelect.value;
    if (el.aspectSelect) state.aspectId = el.aspectSelect.value;
    state.headline = el.headlineInput.value.trim() || PROMO_PRESETS[0].headline;
    state.subhead = el.subheadInput.value.trim() || PROMO_PRESETS[0].subhead;
    state.cta = el.ctaInput.value.trim() || PROMO_PRESETS[0].cta;
    state.lapTime = clamp(Number(el.lapTimeInput.value) || 27.48, 8, 180);
    state.durationSec = clamp(Number(el.durationInput.value) || 7, CLIP_MIN_DURATION_SEC, CLIP_MAX_DURATION_SEC);
    state.handle = el.handleInput.value.trim() || '@vectorgp.run';
    state.showGrid = el.showGridToggle.checked;
    state.showTimer = el.showTimerToggle.checked;
    state.showSafeZones = el.showSafeZonesToggle ? el.showSafeZonesToggle.checked : state.showSafeZones;
    state.seamlessLoop = el.seamlessLoopToggle ? el.seamlessLoopToggle.checked : state.seamlessLoop;
    state.exportFormat = el.exportFormatSelect.value;
    state.exportContent = el.exportContentSelect.value;
    resizeCanvasesForState();
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getRenderModeSlug() {
    return state.renderMode === 'gameplay-replay' ? 'gameplay' : 'trace';
}

function getExportCaptureSlug() {
    return state.exportContent === 'replay-only' ? 'replay' : 'promo';
}

function getSafeTrackSlug() {
    return state.trackKey.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function wait(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

function sizeExportCanvas(width, height) {
    if (el.exportCanvas.width !== width) el.exportCanvas.width = width;
    if (el.exportCanvas.height !== height) el.exportCanvas.height = height;
}

function chooseRecorderFormat(preferredFormat) {
    const formatCandidates = {
        mov: [
            { mimeType: 'video/quicktime;codecs=h264', extension: 'mov', label: 'MOV' },
            { mimeType: 'video/quicktime', extension: 'mov', label: 'MOV' }
        ],
        webm: [
            { mimeType: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM' },
            { mimeType: 'video/webm;codecs=vp8', extension: 'webm', label: 'WebM' },
            { mimeType: 'video/webm', extension: 'webm', label: 'WebM' }
        ]
    };
    const orderedCandidates = preferredFormat === 'mov'
        ? formatCandidates.mov
        : preferredFormat === 'webm'
            ? formatCandidates.webm
            : [...formatCandidates.mov, ...formatCandidates.webm];

    const supported = orderedCandidates.find((candidate) => (
        typeof MediaRecorder !== 'undefined'
        && MediaRecorder.isTypeSupported(candidate.mimeType)
    ));
    if (supported) {
        return supported;
    }
    return preferredFormat === 'mov' ? null : { mimeType: '', extension: 'webm', label: 'WebM' };
}

function supportsMp4Codecs() {
    return (
        typeof window !== 'undefined'
        && 'VideoEncoder' in window
        && 'AudioEncoder' in window
        && 'VideoFrame' in window
        && 'AudioData' in window
    );
}

let cachedMuxerModule = null;
async function loadMp4Muxer() {
    if (cachedMuxerModule) return cachedMuxerModule;
    cachedMuxerModule = await import(/* @vite-ignore */ MP4_MUXER_CDN);
    return cachedMuxerModule;
}

function pickH264Codec() {
    const candidates = ['avc1.640028', 'avc1.640029', 'avc1.42E01F', 'avc1.4D401F'];
    return candidates[0];
}

async function encodeMp4Clip({
    width,
    height,
    durationSec,
    aspectId,
    captureMode,
    seamlessLoop,
    onProgress
}) {
    const { Muxer, ArrayBufferTarget } = await loadMp4Muxer();
    const totalFrames = Math.max(1, Math.round(durationSec * EXPORT_FPS));
    const videoCodec = pickH264Codec();
    const videoBitrate = Math.round(
        width * height >= 1920 * 1080
            ? 10_000_000
            : width * height >= 1080 * 1080
                ? 8_000_000
                : 5_000_000
    );

    const videoEncoderConfig = {
        codec: videoCodec,
        width,
        height,
        bitrate: videoBitrate,
        framerate: EXPORT_FPS,
        avc: { format: 'avc' }
    };
    const videoSupport = await VideoEncoder.isConfigSupported(videoEncoderConfig);
    if (!videoSupport?.supported) {
        throw new Error(`H.264 ${width}x${height} is not supported by this browser.`);
    }

    const audioEncoderConfig = {
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 128_000
    };
    const audioSupport = await AudioEncoder.isConfigSupported(audioEncoderConfig);

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
        target,
        video: {
            codec: 'avc',
            width,
            height,
            frameRate: EXPORT_FPS
        },
        audio: audioSupport?.supported ? {
            codec: 'aac',
            sampleRate: 48_000,
            numberOfChannels: 2
        } : undefined,
        fastStart: 'in-memory'
    });

    const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (err) => { throw err; }
    });
    videoEncoder.configure(videoEncoderConfig);

    sizeExportCanvas(width, height);
    const frameDurationUs = Math.round(1_000_000 / EXPORT_FPS);
    const keyFrameInterval = EXPORT_FPS * 2;

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        const timeMs = (frameIndex / Math.max(1, totalFrames - 1)) * durationSec * 1000;
        renderFrame(exportCtx, timeMs, {
            exporting: true,
            captureMode,
            aspectId,
            seamlessLoop
        });
        const timestamp = Math.round(frameIndex * frameDurationUs);
        const frame = new VideoFrame(el.exportCanvas, { timestamp, duration: frameDurationUs });
        videoEncoder.encode(frame, { keyFrame: frameIndex % keyFrameInterval === 0 });
        frame.close();
        if (frameIndex % 4 === 0) {
            await wait(0);
            onProgress?.(frameIndex / totalFrames);
        }
    }
    await videoEncoder.flush();
    videoEncoder.close();

    if (audioSupport?.supported) {
        const audioEncoder = new AudioEncoder({
            output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
            error: (err) => { throw err; }
        });
        audioEncoder.configure(audioEncoderConfig);
        const sampleRate = 48_000;
        const channels = 2;
        const framesPerBlock = 1024;
        const totalSamples = Math.ceil(durationSec * sampleRate);
        const silenceBuffer = new Float32Array(framesPerBlock * channels);
        for (let offset = 0; offset < totalSamples; offset += framesPerBlock) {
            const numberOfFrames = Math.min(framesPerBlock, totalSamples - offset);
            const data = numberOfFrames === framesPerBlock
                ? silenceBuffer
                : new Float32Array(numberOfFrames * channels);
            const audioData = new AudioData({
                format: 'f32',
                sampleRate,
                numberOfFrames,
                numberOfChannels: channels,
                timestamp: Math.round((offset / sampleRate) * 1_000_000),
                data
            });
            audioEncoder.encode(audioData);
            audioData.close();
        }
        await audioEncoder.flush();
        audioEncoder.close();
    }

    muxer.finalize();
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), extension: 'mp4', label: 'MP4' };
}

async function encodeWithMediaRecorder({
    width,
    height,
    durationSec,
    aspectId,
    captureMode,
    seamlessLoop,
    preferredFormat,
    onProgress
}) {
    if (!window.MediaRecorder || typeof el.exportCanvas.captureStream !== 'function') {
        throw new Error('MediaRecorder is not available in this browser.');
    }
    const recorderFormat = chooseRecorderFormat(preferredFormat);
    if (!recorderFormat) {
        throw new Error('No supported video codec for the selected format.');
    }

    sizeExportCanvas(width, height);
    const stream = el.exportCanvas.captureStream(EXPORT_FPS);
    const track = stream.getVideoTracks()[0];
    const canRequestFrame = typeof track?.requestFrame === 'function';
    const chunks = [];
    const recorder = new MediaRecorder(stream, {
        mimeType: recorderFormat.mimeType || undefined,
        videoBitsPerSecond: Math.min(12_000_000, Math.round((width * height / (1080 * 1920)) * 10_000_000))
    });
    const done = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => reject(new Error('MediaRecorder failed.'));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorderFormat.mimeType || 'video/webm' }));
    });
    recorder.start(250);

    const totalFrames = Math.max(1, Math.round(durationSec * EXPORT_FPS));
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        const timeMs = (frameIndex / Math.max(1, totalFrames - 1)) * durationSec * 1000;
        renderFrame(exportCtx, timeMs, { exporting: true, captureMode, aspectId, seamlessLoop });
        if (canRequestFrame) {
            track.requestFrame();
        }
        await wait(1000 / EXPORT_FPS);
        if (frameIndex % 4 === 0) onProgress?.(frameIndex / totalFrames);
    }

    await wait(180);
    recorder.stop();
    const blob = await done;
    return { blob, extension: recorderFormat.extension, label: recorderFormat.label };
}

async function encodeClip(options) {
    const preferMp4 = options.preferredFormat === 'auto' || options.preferredFormat === 'mp4';
    if (preferMp4 && supportsMp4Codecs()) {
        try {
            return await encodeMp4Clip(options);
        }
        catch (error) {
            console.warn('MP4 encode failed, falling back.', error);
        }
    }
    const fallbackFormat = options.preferredFormat === 'mp4' ? 'auto' : options.preferredFormat;
    return encodeWithMediaRecorder({ ...options, preferredFormat: fallbackFormat });
}

async function exportVideo() {
    if (state.exportInProgress) return;
    state.exportInProgress = true;
    const wasPlaying = state.isPlaying;
    state.isPlaying = false;
    updateStatusUi('Rendering export frames…');

    const aspect = getAspectRatio(state.aspectId);
    try {
        const result = await encodeClip({
            width: aspect.width,
            height: aspect.height,
            durationSec: state.durationSec,
            aspectId: aspect.id,
            captureMode: state.exportContent,
            seamlessLoop: state.seamlessLoop,
            preferredFormat: state.exportFormat,
            onProgress: (progress) => {
                updateStatusUi(`Encoding ${aspect.id} · ${Math.round(progress * 100)}%`);
            }
        });
        downloadBlob(
            result.blob,
            `vectorgp-${getSafeTrackSlug()}-${getRenderModeSlug()}-${getExportCaptureSlug()}-${aspect.id}.${result.extension}`
        );
        updateStatusUi(`${result.label} clip exported (${aspect.width}×${aspect.height}).`);
    }
    catch (error) {
        console.error(error);
        updateStatusUi(error?.message || 'Clip export failed.');
    }
    finally {
        state.exportInProgress = false;
        state.isPlaying = wasPlaying;
        resizeCanvasesForState();
        renderPreview();
    }
}

async function exportAllAspectVideos() {
    if (state.exportInProgress) return;
    state.exportInProgress = true;
    const wasPlaying = state.isPlaying;
    state.isPlaying = false;

    try {
        for (let index = 0; index < ASPECT_RATIOS.length; index += 1) {
            const aspect = ASPECT_RATIOS[index];
            updateStatusUi(`Encoding ${aspect.id} (${index + 1}/${ASPECT_RATIOS.length})…`);
            const result = await encodeClip({
                width: aspect.width,
                height: aspect.height,
                durationSec: state.durationSec,
                aspectId: aspect.id,
                captureMode: state.exportContent,
                seamlessLoop: state.seamlessLoop,
                preferredFormat: state.exportFormat,
                onProgress: (progress) => {
                    updateStatusUi(`Encoding ${aspect.id} · ${Math.round(progress * 100)}% (${index + 1}/${ASPECT_RATIOS.length})`);
                }
            });
            downloadBlob(
                result.blob,
                `vectorgp-${getSafeTrackSlug()}-${getRenderModeSlug()}-${getExportCaptureSlug()}-${aspect.id}.${result.extension}`
            );
            await wait(250);
        }
        updateStatusUi(`All ${ASPECT_RATIOS.length} aspect ratios exported.`);
    }
    catch (error) {
        console.error(error);
        updateStatusUi(error?.message || 'Batch export failed.');
    }
    finally {
        state.exportInProgress = false;
        state.isPlaying = wasPlaying;
        resizeCanvasesForState();
        renderPreview();
    }
}

function drawThumbnailBackground(ctx, width, height, theme, accent) {
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, theme.skyTop);
    bg.addColorStop(1, theme.skyBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createRadialGradient(width * 0.22, height * 0.2, 30, width * 0.22, height * 0.2, Math.max(width, height) * 0.6);
    glow.addColorStop(0, accent.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    const glow2 = ctx.createRadialGradient(width * 0.78, height * 0.85, 30, width * 0.78, height * 0.85, Math.max(width, height) * 0.6);
    glow2.addColorStop(0, theme.glowB);
    glow2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 30; i += 1) {
        const x = pseudoRand(i * 3.1) * width;
        const y = pseudoRand(i * 5.7) * height;
        const r = 1 + pseudoRand(i * 7.3) * 2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

function drawThumbnailTrackSilhouette(ctx, width, height, theme, rect, opts = {}) {
    const mapped = mapTrackToRect(state.trackKey, rect);
    ctx.save();
    tracePath(ctx, mapped.outer, true);
    ctx.fillStyle = opts.faded ? 'rgba(8, 14, 22, 0.45)' : theme.panel;
    ctx.fill();
    ctx.strokeStyle = opts.faded ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(2, Math.min(width, height) / 200);
    ctx.stroke();
    tracePath(ctx, mapped.inner, true);
    ctx.fillStyle = opts.faded ? 'rgba(4, 8, 13, 0.4)' : theme.trackInner;
    ctx.fill();
    tracePath(ctx, mapped.centerline, false);
    ctx.strokeStyle = opts.routeColor ?? theme.route;
    ctx.lineWidth = Math.max(2, Math.min(width, height) / 260);
    ctx.stroke();
    ctx.restore();
    return mapped;
}

function renderThumbnailRecord(ctx, width, height, theme) {
    const accent = getMoodAccent();
    drawThumbnailBackground(ctx, width, height, theme, accent);

    const silhouetteRect = { x: width * 0.08, y: height * 0.12, width: width * 0.84, height: height * 0.76 };
    ctx.save();
    ctx.globalAlpha = 0.28;
    drawThumbnailTrackSilhouette(ctx, width, height, theme, silhouetteRect, { faded: true, routeColor: 'rgba(255,255,255,0.3)' });
    ctx.restore();

    const pad = Math.max(28, Math.min(width, height) * 0.05);
    const isHorizontal = width > height * 1.2;
    const topKickerSize = Math.max(16, Math.round(Math.min(width, height) * 0.028));

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = accent.color;
    ctx.font = `800 ${topKickerSize}px outfit, system-ui, sans-serif`;
    ctx.fillText('▌ MINI RACER · NEW RECORD', pad, pad);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `700 ${Math.round(topKickerSize * 0.9)}px outfit, system-ui, sans-serif`;
    ctx.fillText(TRACKS[state.trackKey].name.toUpperCase(), pad, pad + topKickerSize * 1.5);
    ctx.restore();

    const lapText = `${state.lapTime.toFixed(2)}`;
    const lapFontSize = isHorizontal
        ? Math.round(height * 0.48)
        : Math.round(Math.min(width * 0.42, height * 0.3));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${lapFontSize}px "JetBrains Mono", monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    const centerX = width / 2;
    const centerY = height * 0.52;
    ctx.fillText(lapText, centerX, centerY);
    ctx.shadowBlur = 0;

    const secFontSize = Math.round(lapFontSize * 0.36);
    ctx.font = `900 ${secFontSize}px "JetBrains Mono", monospace`;
    ctx.fillStyle = accent.color;
    const metrics = ctx.measureText(lapText);
    ctx.textAlign = 'left';
    ctx.fillText('s', centerX + metrics.width / 2 + 10, centerY + lapFontSize * 0.22);
    ctx.restore();

    const labelSize = Math.round(Math.min(width, height) * 0.038);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `800 ${labelSize}px outfit, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText('LAP RECORD', centerX, centerY + lapFontSize * 0.55);
    ctx.restore();

    const ctaHeight = Math.round(Math.min(width, height) * 0.09);
    const ctaWidth = Math.min(width - pad * 2, Math.round(width * 0.78));
    const ctaX = (width - ctaWidth) / 2;
    const ctaY = height - pad - ctaHeight;
    roundRectPath(ctx, ctaX, ctaY, ctaWidth, ctaHeight, ctaHeight / 2);
    const ctaGrad = ctx.createLinearGradient(ctaX, ctaY, ctaX + ctaWidth, ctaY);
    ctaGrad.addColorStop(0, accent.color);
    ctaGrad.addColorStop(1, theme.accent);
    ctx.fillStyle = ctaGrad;
    ctx.fill();
    const ctaFontSize = Math.round(ctaHeight * 0.45);
    ctx.fillStyle = '#07131f';
    ctx.font = `900 ${ctaFontSize}px outfit, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BEAT THIS TIME →', ctaX + ctaWidth / 2, ctaY + ctaHeight / 2);

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `700 ${Math.round(labelSize * 0.7)}px outfit, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(state.handle, pad, ctaY - 12);
    ctx.restore();
}

function renderThumbnailSkillCheck(ctx, width, height, theme) {
    const accent = getMoodAccent();
    drawThumbnailBackground(ctx, width, height, theme, accent);

    const pad = Math.max(24, Math.min(width, height) * 0.045);
    const isHorizontal = width > height * 1.2;
    const isSquare = Math.abs(width - height) < Math.min(width, height) * 0.12;

    const trackRect = isHorizontal
        ? { x: width * 0.42, y: pad, width: width * 0.58 - pad, height: height - pad * 2 }
        : isSquare
            ? { x: width * 0.5, y: height * 0.15, width: width * 0.5 - pad, height: height * 0.7 }
            : { x: pad, y: height * 0.48, width: width - pad * 2, height: height * 0.45 };

    const mapped = drawThumbnailTrackSilhouette(ctx, width, height, theme, trackRect);

    const apexProgress = getTrackApexProgress(state.trackKey);
    const apexPoint = getProgressPoint(mapped.centerline, apexProgress);
    const ringRadius = Math.max(24, Math.min(trackRect.width, trackRect.height) * 0.12);
    ctx.save();
    ctx.strokeStyle = accent.color;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(apexPoint.x, apexPoint.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(apexPoint.x, apexPoint.y, ringRadius + 12, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    const textAreaX = pad;
    const textAreaY = pad;
    const textAreaW = isHorizontal
        ? width * 0.42 - pad * 2
        : isSquare
            ? width * 0.5 - pad * 2
            : width - pad * 2;
    const textAreaH = isHorizontal || isSquare ? height - pad * 2 : height * 0.48;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = accent.color;
    const kickerSize = Math.max(14, Math.round(Math.min(width, height) * 0.028));
    ctx.font = `800 ${kickerSize}px outfit, system-ui, sans-serif`;
    ctx.fillText('▌ SKILL CHECK', textAreaX, textAreaY);
    ctx.restore();

    const headlineLines = (() => {
        const candidateSizes = isHorizontal ? [96, 84, 72, 60, 52] : [88, 76, 68, 60, 52, 44];
        let chosenSize = candidateSizes[candidateSizes.length - 1];
        let chosenLines = [];
        for (const size of candidateSizes) {
            ctx.font = `900 ${size}px "JetBrains Mono", monospace`;
            const wrapped = wrapText(ctx, state.headline.toUpperCase(), textAreaW);
            if (wrapped.length <= 3) {
                chosenSize = size;
                chosenLines = wrapped;
                break;
            }
            chosenSize = size;
            chosenLines = wrapped;
        }
        return { fontSize: chosenSize, lines: chosenLines };
    })();

    drawKineticHeadline(ctx, {
        lines: headlineLines.lines,
        fontSize: headlineLines.fontSize,
        lineHeight: Math.round(headlineLines.fontSize * 0.94),
        x: textAreaX,
        y: textAreaY + kickerSize * 2.2,
        color: '#ffffff',
        theme,
        beats: { hook: 1, hookPunch: 0, reveal: 1, apex: 0, payoff: 1, apexHit: 0, payoffPop: 0 },
        alignment: 'left',
        maxWidth: textAreaW
    });

    const arrowStartX = isHorizontal || isSquare
        ? textAreaX + textAreaW
        : textAreaX + textAreaW / 2;
    const arrowStartY = isHorizontal || isSquare
        ? textAreaY + textAreaH * 0.5
        : textAreaY + textAreaH - pad;
    ctx.save();
    ctx.strokeStyle = accent.color;
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 8]);
    ctx.beginPath();
    ctx.moveTo(arrowStartX, arrowStartY);
    const dirX = apexPoint.x - arrowStartX;
    const dirY = apexPoint.y - arrowStartY;
    const dirLen = Math.hypot(dirX, dirY) || 1;
    ctx.lineTo(apexPoint.x - (dirX / dirLen) * (ringRadius + 6), apexPoint.y - (dirY / dirLen) * (ringRadius + 6));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const ctaSize = Math.max(18, Math.round(Math.min(width, height) * 0.04));
    const ctaY = height - pad - ctaSize * 1.6;
    ctx.save();
    ctx.fillStyle = 'rgba(4, 9, 15, 0.88)';
    const ctaText = `THIS CORNER · ${state.cta.toUpperCase()}`;
    ctx.font = `900 ${ctaSize}px outfit, system-ui, sans-serif`;
    const ctaMetrics = ctx.measureText(ctaText);
    const ctaPillW = Math.min(width - pad * 2, ctaMetrics.width + pad * 1.4);
    const ctaPillH = ctaSize * 1.6;
    const ctaX = isHorizontal ? textAreaX : pad;
    roundRectPath(ctx, ctaX, ctaY, ctaPillW, ctaPillH, 10);
    ctx.fill();
    ctx.strokeStyle = accent.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(ctaText, ctaX + pad * 0.7, ctaY + ctaPillH / 2);
    ctx.restore();
}

function renderThumbnailRival(ctx, width, height, theme) {
    const accent = getMoodAccent();
    drawThumbnailBackground(ctx, width, height, theme, accent);

    const pad = Math.max(24, Math.min(width, height) * 0.04);
    const isHorizontal = width > height * 1.2;
    const split = isHorizontal ? 'vertical' : 'horizontal';

    const youRect = split === 'horizontal'
        ? { x: 0, y: 0, width, height: height / 2 }
        : { x: 0, y: 0, width: width / 2, height };
    const themRect = split === 'horizontal'
        ? { x: 0, y: height / 2, width, height: height / 2 }
        : { x: width / 2, y: 0, width: width / 2, height };

    ctx.save();
    ctx.fillStyle = 'rgba(34, 197, 94, 0.08)';
    ctx.fillRect(youRect.x, youRect.y, youRect.width, youRect.height);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
    ctx.fillRect(themRect.x, themRect.y, themRect.width, themRect.height);
    ctx.restore();

    const youLap = state.lapTime;
    const friendDelta = 1.42;
    const themLap = state.lapTime + friendDelta;

    function drawSide(rect, label, time, color, isYou) {
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const timeFontSize = Math.round(Math.min(rect.width, rect.height) * (split === 'horizontal' ? 0.55 : 0.5));
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.max(14, Math.round(timeFontSize * 0.18))}px outfit, system-ui, sans-serif`;
        ctx.fillStyle = color;
        ctx.fillText(label, cx, cy - timeFontSize * 0.4);
        ctx.font = `900 ${timeFontSize}px "JetBrains Mono", monospace`;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fillText(`${time.toFixed(2)}s`, cx, cy);
        ctx.shadowBlur = 0;
        if (!isYou) {
            ctx.fillStyle = '#ef4444';
            ctx.font = `900 ${Math.round(timeFontSize * 0.22)}px "JetBrains Mono", monospace`;
            ctx.fillText(`+${friendDelta.toFixed(2)}s`, cx, cy + timeFontSize * 0.4);
        } else {
            ctx.fillStyle = '#22c55e';
            ctx.font = `900 ${Math.round(timeFontSize * 0.22)}px "JetBrains Mono", monospace`;
            ctx.fillText('★ FASTEST', cx, cy + timeFontSize * 0.4);
        }
        ctx.restore();
    }

    drawSide(youRect, 'YOU', youLap, '#22c55e', true);
    drawSide(themRect, 'YOUR FRIEND', themLap, '#ef4444', false);

    const vsSize = Math.round(Math.min(width, height) * (split === 'horizontal' ? 0.16 : 0.22));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const vsX = split === 'horizontal' ? width / 2 : width / 2;
    const vsY = split === 'horizontal' ? height / 2 : height / 2;
    ctx.fillStyle = '#07131f';
    ctx.beginPath();
    ctx.arc(vsX, vsY, vsSize * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = accent.color;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${vsSize}px "JetBrains Mono", monospace`;
    ctx.fillText('VS', vsX, vsY);
    ctx.restore();

    const dividerColor = accent.color;
    ctx.save();
    ctx.strokeStyle = dividerColor;
    ctx.lineWidth = 3;
    if (split === 'horizontal') {
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
    } else {
        ctx.beginPath();
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width / 2, height);
        ctx.stroke();
    }
    ctx.restore();

    const ctaSize = Math.max(16, Math.round(Math.min(width, height) * 0.035));
    const ctaText = `${TRACKS[state.trackKey].name.toUpperCase()} · ${state.handle}`;
    ctx.save();
    ctx.font = `800 ${ctaSize}px outfit, system-ui, sans-serif`;
    const metrics = ctx.measureText(ctaText);
    const pillW = Math.min(width - pad * 2, metrics.width + pad * 1.2);
    const pillH = ctaSize * 1.6;
    const pillX = (width - pillW) / 2;
    const pillY = height - pad - pillH;
    roundRectPath(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(4, 9, 15, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ctaText, width / 2, pillY + pillH / 2);
    ctx.restore();
}

const THUMBNAIL_LAYOUTS = [
    { key: 'record', render: renderThumbnailRecord },
    { key: 'skillcheck', render: renderThumbnailSkillCheck },
    { key: 'rival', render: renderThumbnailRival }
];

function renderThumbnailLayout(width, height, theme, layoutKey) {
    sizeExportCanvas(width, height);
    const ctx = exportCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const layout = THUMBNAIL_LAYOUTS.find((candidate) => candidate.key === layoutKey) ?? THUMBNAIL_LAYOUTS[0];
    layout.render(ctx, width, height, theme);
}

function renderStaticFrame(width, height, aspectId, progress, options = {}) {
    sizeExportCanvas(width, height);
    renderFrame(exportCtx, state.durationSec * 1000 * progress, {
        exporting: true,
        poster: true,
        aspectId,
        seamlessLoop: false,
        ...options
    });
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) reject(new Error(`Encoding to ${type} failed.`));
            else resolve(blob);
        }, type, quality);
    });
}

async function exportPoster() {
    const aspect = getAspectRatio(state.aspectId);
    const theme = THEMES.find((candidate) => candidate.id === state.themeId) ?? THEMES[0];
    const styleId = state.templateStyle;
    if (styleId && styleId !== 'classic') {
        renderStaticFrame(aspect.width, aspect.height, aspect.id, 1);
    } else {
        renderThumbnailLayout(aspect.width, aspect.height, theme, 'record');
    }
    try {
        const pngBlob = await canvasToBlob(el.exportCanvas, 'image/png');
        const tag = styleId && styleId !== 'classic' ? styleId : 'record';
        downloadBlob(pngBlob, `vectorgp-${getSafeTrackSlug()}-poster-${tag}-${aspect.id}.png`);
        updateStatusUi(`Poster PNG exported (${aspect.width}×${aspect.height}).`);
    }
    catch (error) {
        updateStatusUi(error?.message || 'Poster export failed.');
    }
    finally {
        resizeCanvasesForState();
        renderPreview();
    }
}

async function exportThumbnailPack() {
    if (state.exportInProgress) return;
    state.exportInProgress = true;
    const wasPlaying = state.isPlaying;
    state.isPlaying = false;
    const savedStyle = state.templateStyle;
    updateStatusUi('Rendering thumbnail pack…');
    const theme = THEMES.find((candidate) => candidate.id === state.themeId) ?? THEMES[0];
    const templateStyleIds = ['arcade-crt', 'magazine', 'sticker', 'telemetry', 'trading-card', 'cockpit'];
    try {
        let count = 0;
        const total = ASPECT_RATIOS.length * templateStyleIds.length * 2;
        for (const aspect of ASPECT_RATIOS) {
            for (const styleId of templateStyleIds) {
                state.templateStyle = styleId;
                renderStaticFrame(aspect.width, aspect.height, aspect.id, 1);
                const png = await canvasToBlob(el.exportCanvas, 'image/png');
                downloadBlob(png, `vectorgp-${getSafeTrackSlug()}-thumb-${styleId}-${aspect.id}.png`);
                count += 1;
                updateStatusUi(`Thumbnail pack · ${count}/${total}`);
                await wait(30);
                const jpg = await canvasToBlob(el.exportCanvas, 'image/jpeg', 0.9);
                downloadBlob(jpg, `vectorgp-${getSafeTrackSlug()}-thumb-${styleId}-${aspect.id}.jpg`);
                count += 1;
                updateStatusUi(`Thumbnail pack · ${count}/${total}`);
                await wait(30);
            }
        }
        updateStatusUi(`Thumbnail pack exported (${total} files, 6 distinct templates × ${ASPECT_RATIOS.length} aspects).`);
    }
    catch (error) {
        console.error(error);
        updateStatusUi(error?.message || 'Thumbnail pack failed.');
    }
    finally {
        state.templateStyle = savedStyle;
        state.exportInProgress = false;
        state.isPlaying = wasPlaying;
        resizeCanvasesForState();
        renderPreview();
    }
}

function renderDisplayBanner(banner, theme) {
    sizeExportCanvas(banner.width, banner.height);
    const ctx = exportCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, banner.width, banner.height);
    drawBackground(ctx, theme, banner.width, banner.height, 1200, false);

    const isWide = banner.width / banner.height > 1.4;
    const isTall = banner.height / banner.width > 1.4;
    const pad = Math.max(10, Math.min(24, Math.round(Math.min(banner.width, banner.height) * 0.08)));

    const mapRect = isWide
        ? { x: banner.width - banner.height + pad, y: pad, width: banner.height - pad * 2, height: banner.height - pad * 2 }
        : isTall
            ? { x: pad, y: pad, width: banner.width - pad * 2, height: Math.round(banner.height * 0.55) }
            : { x: Math.round(banner.width * 0.5), y: pad, width: Math.round(banner.width * 0.5) - pad, height: banner.height - pad * 2 };

    const mapped = mapTrackToRect(state.trackKey, mapRect);
    ctx.save();
    tracePath(ctx, mapped.outer, true);
    ctx.fillStyle = 'rgba(8, 14, 22, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(1.5, banner.height / 120);
    ctx.stroke();
    tracePath(ctx, mapped.inner, true);
    ctx.fillStyle = theme.trackInner;
    ctx.fill();
    tracePath(ctx, mapped.centerline, false);
    ctx.strokeStyle = theme.route;
    ctx.lineWidth = Math.max(1.5, banner.height / 150);
    ctx.stroke();
    ctx.restore();

    const textAreaX = isWide ? pad : pad;
    const textAreaY = isTall ? mapRect.y + mapRect.height + pad : pad;
    const textAreaWidth = isWide
        ? banner.width - banner.height - pad
        : isTall
            ? banner.width - pad * 2
            : Math.round(banner.width * 0.5) - pad * 2;
    const textAreaHeight = isTall ? banner.height - textAreaY - pad : banner.height - pad * 2;

    ctx.save();
    ctx.fillStyle = theme.accent;
    const kickerFontSize = Math.max(10, Math.round(banner.height * 0.08));
    ctx.font = `800 ${kickerFontSize}px outfit, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('MINI RACER', textAreaX, textAreaY);

    ctx.fillStyle = theme.text;
    const headlineFontSize = Math.max(14, Math.round(Math.min(textAreaWidth / 10, banner.height * 0.22)));
    ctx.font = `900 ${headlineFontSize}px "JetBrains Mono", monospace`;
    const headlineLines = wrapText(ctx, state.headline.toUpperCase(), textAreaWidth);
    const headlineLineHeight = Math.round(headlineFontSize * 0.95);
    const maxHeadlineLines = Math.min(headlineLines.length, Math.max(1, Math.floor((textAreaHeight - kickerFontSize * 1.4) / headlineLineHeight) - 1));
    for (let i = 0; i < maxHeadlineLines; i += 1) {
        ctx.fillText(headlineLines[i], textAreaX, textAreaY + kickerFontSize * 1.4 + i * headlineLineHeight);
    }

    const ctaFontSize = Math.max(10, Math.round(banner.height * 0.1));
    ctx.fillStyle = theme.accent;
    ctx.font = `900 ${ctaFontSize}px outfit, system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    const ctaText = state.cta.toUpperCase();
    const ctaMetrics = ctx.measureText(ctaText);
    const ctaPillWidth = Math.min(textAreaWidth, ctaMetrics.width + pad * 2);
    const ctaPillHeight = ctaFontSize + pad;
    const ctaPillY = textAreaY + textAreaHeight - ctaPillHeight;
    roundRectPath(ctx, textAreaX, ctaPillY, ctaPillWidth, ctaPillHeight, Math.round(ctaPillHeight / 2));
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.fillStyle = '#04090f';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(ctaText, textAreaX + ctaPillWidth / 2, ctaPillY + ctaPillHeight / 2);
    ctx.restore();
}

async function exportDisplayBannerPack() {
    if (state.exportInProgress) return;
    state.exportInProgress = true;
    const wasPlaying = state.isPlaying;
    state.isPlaying = false;
    updateStatusUi('Rendering display banner pack…');
    const theme = THEMES.find((candidate) => candidate.id === state.themeId) ?? THEMES[0];
    try {
        let count = 0;
        const total = DISPLAY_BANNERS.length * 2;
        for (const banner of DISPLAY_BANNERS) {
            renderDisplayBanner(banner, theme);
            const png = await canvasToBlob(el.exportCanvas, 'image/png');
            downloadBlob(png, `vectorgp-${getSafeTrackSlug()}-banner-${banner.width}x${banner.height}.png`);
            count += 1;
            updateStatusUi(`Display banner · ${count}/${total}`);
            await wait(30);
            const jpg = await canvasToBlob(el.exportCanvas, 'image/jpeg', 0.85);
            downloadBlob(jpg, `vectorgp-${getSafeTrackSlug()}-banner-${banner.width}x${banner.height}.jpg`);
            count += 1;
            updateStatusUi(`Display banner · ${count}/${total}`);
            await wait(30);
        }
        updateStatusUi(`Display pack exported (${total} files).`);
    }
    catch (error) {
        console.error(error);
        updateStatusUi(error?.message || 'Display pack failed.');
    }
    finally {
        state.exportInProgress = false;
        state.isPlaying = wasPlaying;
        resizeCanvasesForState();
        renderPreview();
    }
}

function shuffleHook() {
    const currentIndex = PROMO_PRESETS.findIndex((preset) => preset.id === state.presetId);
    const nextIndex = (currentIndex + 1 + Math.floor(Math.random() * (PROMO_PRESETS.length - 1))) % PROMO_PRESETS.length;
    setPreset(PROMO_PRESETS[nextIndex].id);
    restartPreview();
    updateStatusUi('Loaded a new hook preset.');
}

function animationLoop(now) {
    const deltaMs = now - state.lastFrameAt;
    state.lastFrameAt = now;
    if (state.isPlaying && !state.exportInProgress) {
        state.playheadMs = (state.playheadMs + deltaMs) % (state.durationSec * 1000);
        renderPreview();
    }
    requestAnimationFrame(animationLoop);
}

function attachEvents() {
    el.trackSelect.addEventListener('change', () => {
        readFormIntoState();
        restartPreview();
    });
    el.renderModeSelect.addEventListener('change', () => {
        readFormIntoState();
        restartPreview();
    });
    if (el.templateStyleSelect) {
        el.templateStyleSelect.addEventListener('change', () => {
            readFormIntoState();
            restartPreview();
        });
    }
    el.presetSelect.addEventListener('change', (event) => {
        setPreset(event.target.value);
        restartPreview();
    });
    el.themeSelect.addEventListener('change', () => {
        readFormIntoState();
        renderPreview();
    });
    if (el.aspectSelect) {
        el.aspectSelect.addEventListener('change', () => {
            readFormIntoState();
            renderPreview();
        });
    }

    [
        el.headlineInput,
        el.subheadInput,
        el.ctaInput,
        el.lapTimeInput,
        el.durationInput,
        el.handleInput
    ].forEach((input) => {
        input.addEventListener('input', () => {
            readFormIntoState();
            renderPreview();
        });
    });

    [
        el.showGridToggle,
        el.showTimerToggle,
        el.showSafeZonesToggle,
        el.seamlessLoopToggle,
        el.exportFormatSelect,
        el.exportContentSelect
    ].forEach((input) => {
        if (!input) return;
        input.addEventListener('change', () => {
            readFormIntoState();
            renderPreview();
        });
    });

    el.shuffleCopyBtn.addEventListener('click', shuffleHook);
    el.restartBtn.addEventListener('click', restartPreview);
    el.playToggleBtn.addEventListener('click', () => {
        state.isPlaying = !state.isPlaying;
        state.lastFrameAt = performance.now();
        updateStatusUi(state.isPlaying ? 'Preview resumed.' : 'Preview paused.');
        renderPreview();
    });
    el.exportVideoBtn.addEventListener('click', () => {
        readFormIntoState();
        exportVideo().catch((error) => {
            state.exportInProgress = false;
            updateStatusUi(error?.message || 'Clip export failed.');
            renderPreview();
        });
    });
    if (el.exportAllAspectsBtn) {
        el.exportAllAspectsBtn.addEventListener('click', () => {
            readFormIntoState();
            exportAllAspectVideos().catch((error) => {
                state.exportInProgress = false;
                updateStatusUi(error?.message || 'Batch export failed.');
                renderPreview();
            });
        });
    }
    el.exportPosterBtn.addEventListener('click', () => {
        readFormIntoState();
        exportPoster();
    });
    if (el.exportThumbnailPackBtn) {
        el.exportThumbnailPackBtn.addEventListener('click', () => {
            readFormIntoState();
            exportThumbnailPack().catch((error) => {
                state.exportInProgress = false;
                updateStatusUi(error?.message || 'Thumbnail pack failed.');
                renderPreview();
            });
        });
    }
    if (el.exportDisplayPackBtn) {
        el.exportDisplayPackBtn.addEventListener('click', () => {
            readFormIntoState();
            exportDisplayBannerPack().catch((error) => {
                state.exportInProgress = false;
                updateStatusUi(error?.message || 'Display pack failed.');
                renderPreview();
            });
        });
    }
}

function installDebugHooks() {
    window.render_game_to_text = () => JSON.stringify({
        tool: 'tiktok-studio',
        track: TRACKS[state.trackKey].name,
        renderMode: state.renderMode,
        preset: state.presetId,
        theme: state.themeId,
        headline: state.headline,
        cta: state.cta,
        lapTime: state.lapTime,
        durationSec: state.durationSec,
        playheadMs: Math.round(state.playheadMs),
        playing: state.isPlaying,
        exportInProgress: state.exportInProgress,
        aspect: state.aspectId,
        canvas: { width: el.canvas.width, height: el.canvas.height }
    });

    window.advanceTime = (ms) => {
        const durationMs = state.durationSec * 1000;
        state.playheadMs = (state.playheadMs + ms + durationMs) % durationMs;
        renderPreview();
    };
}

function init() {
    populateTrackSelect();
    populateSelect(el.renderModeSelect, RENDER_MODES);
    if (el.templateStyleSelect) populateSelect(el.templateStyleSelect, TEMPLATE_STYLES);
    populateSelect(el.presetSelect, PROMO_PRESETS);
    populateSelect(el.themeSelect, THEMES);
    if (el.aspectSelect) populateSelect(el.aspectSelect, ASPECT_RATIOS);
    resizeCanvasesForState();
    syncFormFromState();
    attachEvents();
    installDebugHooks();
    renderPreview();
    requestAnimationFrame(animationLoop);
}

init();
