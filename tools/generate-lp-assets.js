// Builds the LP page track background with preview.js's schematic renderer. Run: `npm run generate:lp-assets [--track=circuit]`
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, Path2D as NodePath2D, loadImage } from '@napi-rs/canvas';
import { STOCK_CAR_ASSET_NAME } from '../game/car/sprite.js';
import { TRACKS } from '../game/track/tracks.js';
import { renderTrackPreviewCanvas } from '../game/track/preview-renderer.js';
import {
    resolveTrackPresentation,
    TRACK_PRESENTATION_SURFACES,
} from '../game/track/presentation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

export const LP_TRACK_WIDTH = 2880;
export const LP_TRACK_HEIGHT = 1620;
export const LP_DEFAULT_TRACK_KEY = 'circuit';
export const LP_BG = '#020617';
export const LP_TRACK_INSET_RATIO = 0.1;

function ensurePath2D() {
    if (typeof globalThis.Path2D === 'undefined') {
        globalThis.Path2D = NodePath2D;
    }
}

export function getLpTrackAbsolutePath(lpRoot = join(repoRoot, 'LP')) {
    return join(lpRoot, 'track.png');
}

function resolveTrackKey(raw) {
    const key = typeof raw === 'string' && raw.trim() ? raw.trim() : LP_DEFAULT_TRACK_KEY;
    if (!TRACKS[key]?.outer || !TRACKS[key]?.inner) {
        throw new Error(`generate-lp-assets: unknown or incomplete track "${key}"`);
    }
    return key;
}

function parseTrackKeyFromArgv(argv = process.argv.slice(2)) {
    for (const arg of argv) {
        if (arg.startsWith('--track=')) return arg.slice('--track='.length);
    }
    return LP_DEFAULT_TRACK_KEY;
}

async function loadPreviewCarImage() {
    const absolute = join(repoRoot, 'public', STOCK_CAR_ASSET_NAME);
    if (!existsSync(absolute)) {
        throw new Error(`generate-lp-assets: missing car asset at ${absolute}`);
    }
    return loadImage(absolute);
}

export function renderLpTrackPreviewCanvas(canvas, {
    trackKey,
    track,
    carImage = null,
    skin = 'default',
} = {}) {
    ensurePath2D();
    const key = resolveTrackKey(trackKey);
    const geometry = track || TRACKS[key];
    if (!geometry?.outer || !geometry?.inner) {
        throw new Error(`generate-lp-assets: missing track geometry for "${key}"`);
    }

    const presentation = resolveTrackPresentation(key, {
        surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW,
        event: skin ? { key: 'daily-challenge', trackKey: key, skin } : null,
    });

    renderTrackPreviewCanvas(canvas, {
        trackGeometry: { outer: geometry.outer, inner: geometry.inner },
        presentation,
        startLine: geometry.startLine,
        startPos: geometry.startPos,
        startAngle: geometry.startAngle ?? 0,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        showSchematicCarTrail: true,
        moveSchematicCarPastStartLine: true,
        schematicCarImage: carImage,
        hideSchematicStartArrow: true,
        runHistory: [],
    });
}

export async function renderLpTrackPng({
    trackKey = LP_DEFAULT_TRACK_KEY,
    track = null,
    carImage = null,
    width = LP_TRACK_WIDTH,
    height = LP_TRACK_HEIGHT,
} = {}) {
    ensurePath2D();
    const key = resolveTrackKey(trackKey);
    const geometry = track || TRACKS[key];
    const resolvedCar = carImage === null ? await loadPreviewCarImage() : carImage;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = LP_BG;
    ctx.fillRect(0, 0, width, height);

    const inset = Math.round(Math.min(width, height) * LP_TRACK_INSET_RATIO);
    const trackW = Math.max(1, width - inset * 2);
    const trackH = Math.max(1, height - inset * 2);
    const trackCanvas = createCanvas(trackW, trackH);
    renderLpTrackPreviewCanvas(trackCanvas, {
        trackKey: key,
        track: geometry,
        carImage: resolvedCar,
        skin: 'default',
    });
    ctx.drawImage(trackCanvas, inset, inset);

    return canvas.toBuffer('image/png');
}

export async function generateLpTrackAsset(options = {}) {
    const lpRoot = options.lpRoot || join(repoRoot, 'LP');
    const trackKey = resolveTrackKey(options.trackKey || LP_DEFAULT_TRACK_KEY);
    const outPath = getLpTrackAbsolutePath(lpRoot);

    mkdirSync(lpRoot, { recursive: true });
    const buffer = await renderLpTrackPng({
        trackKey,
        width: options.width || LP_TRACK_WIDTH,
        height: options.height || LP_TRACK_HEIGHT,
    });
    writeFileSync(outPath, buffer);

    const legacyJpeg = join(lpRoot, 'track.jpg');
    if (existsSync(legacyJpeg)) {
        unlinkSync(legacyJpeg);
    }

    return { trackKey, outPath, bytes: buffer.byteLength };
}

function isMainModule() {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
    const trackKey = parseTrackKeyFromArgv();
    const result = await generateLpTrackAsset({ trackKey });
    console.log(
        `generate-lp-assets: wrote ${result.outPath} (${Math.round(result.bytes / 1024)} KB) for track "${result.trackKey}"`,
    );
}
