import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { TRACK_SCHEDULE_KEYS, getTrackName } from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import { ensurePath2D, isMainModule } from './node-script.js';
import { renderTrackPreviewCanvas } from '../game/track/preview-renderer.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../game/track/presentation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 630;
export const SHARE_IMAGE_MAX_BYTES = 1024 * 1024;
export const SHARE_IMAGE_JPEG_QUALITY = 85;

const BG = '#010410';
const SURFACE = '#0f172a';
const TEXT = '#f8fafc';
const ACCENT = '#ef4444';

export function getShareImageAbsolutePath(trackKey, assetsRoot = join(repoRoot, 'assets')) {
    return join(assetsRoot, 'share', `${trackKey}.jpg`);
}

export function generateMissingShareImages(options = {}) {
    ensurePath2D();

    const assetsRoot = options.assetsRoot || join(repoRoot, 'assets');
    const shareDir = join(assetsRoot, 'share');
    const trackKeys = options.trackKeys || TRACK_SCHEDULE_KEYS;
    const force = options.force === true;

    mkdirSync(shareDir, { recursive: true });

    const generated = [];
    const skipped = [];

    for (const trackKey of trackKeys) {
        const outPath = getShareImageAbsolutePath(trackKey, assetsRoot);
        if (!force && existsSync(outPath)) {
            skipped.push(trackKey);
            continue;
        }

        const track = TRACKS[trackKey];
        if (!track?.outer || !track?.inner) {
            throw new Error(`generate-share-images: missing track geometry for "${trackKey}"`);
        }

        const buffer = renderShareImageJpeg(trackKey, track);
        if (buffer.byteLength > SHARE_IMAGE_MAX_BYTES) {
            throw new Error(
                `generate-share-images: ${trackKey}.jpg is ${buffer.byteLength} bytes (max ${SHARE_IMAGE_MAX_BYTES})`,
            );
        }

        writeFileSync(outPath, buffer);
        generated.push(trackKey);
    }

    return { generated, skipped };
}

export function renderShareImageJpeg(trackKey, track = TRACKS[trackKey]) {
    ensurePath2D();
    if (!track?.outer || !track?.inner) {
        throw new Error(`generate-share-images: missing track geometry for "${trackKey}"`);
    }

    const canvas = createCanvas(SHARE_IMAGE_WIDTH, SHARE_IMAGE_HEIGHT);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, SHARE_IMAGE_WIDTH, SHARE_IMAGE_HEIGHT);

    const panelX = 48;
    const panelY = 120;
    const panelW = SHARE_IMAGE_WIDTH - 96;
    const panelH = SHARE_IMAGE_HEIGHT - 168;
    ctx.fillStyle = SURFACE;
    ctx.beginPath();
    ctx.roundRect(panelX, panelY, panelW, panelH, 24);
    ctx.fill();

    const trackCanvas = createCanvas(panelW - 48, panelH - 48);
    renderTrackPreviewCanvas(trackCanvas, {
        trackGeometry: { outer: track.outer, inner: track.inner },
        presentation: resolveTrackPresentation(trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.SHARE,
            ground: track.ground,
        }),
        startLine: track.startLine,
        startPos: track.startPos,
        startAngle: track.startAngle ?? 0,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        showSchematicCarTrail: false,
        moveSchematicCarPastStartLine: false,
        schematicCarImage: null,
        hideSchematicStartArrow: false,
        runHistory: [],
    });
    ctx.drawImage(trackCanvas, panelX + 24, panelY + 24);

    ctx.fillStyle = ACCENT;
    ctx.font = '600 28px sans-serif';
    ctx.fillText('MINI RACER', 56, 56);

    const trackName = getTrackName(trackKey, track.name || trackKey).toUpperCase();
    ctx.fillStyle = TEXT;
    ctx.font = '700 48px sans-serif';
    ctx.fillText(trackName, 56, 104, SHARE_IMAGE_WIDTH - 112);

    return canvas.toBuffer('image/jpeg', SHARE_IMAGE_JPEG_QUALITY);
}

if (isMainModule(import.meta.url)) {
    const { generated, skipped } = generateMissingShareImages();
    console.log(
        `generate-share-images: generated ${generated.length}, skipped ${skipped.length}`,
    );
    if (generated.length) {
        console.log(`  created: ${generated.join(', ')}`);
    }
    for (const trackKey of generated) {
        const size = statSync(getShareImageAbsolutePath(trackKey)).size;
        console.log(`  ${trackKey}.jpg ${Math.round(size / 1024)} KB`);
    }
}
