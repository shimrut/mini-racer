import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { CONFIG } from '../game/config.js';
import { updateSimulation } from '../game/race/simulation.js';
import { TRACKS } from '../game/track/tracks.js';
import { getTrackName } from '../game/track/catalog.js';
import { buildTrackGeometry } from '../game/track/runtime.js';
import { renderTrackPreviewCanvas } from '../game/track/preview-renderer.js';
import { buildTrackCanvas } from '../game/track/canvas.js';
import { resolveTrackPresentation, TRACK_PRESENTATION_SURFACES } from '../game/track/presentation.js';
import { createReplaySimulationState, driveAutopilot } from '../tests/helpers/autopilot.js';
import { ensurePath2D, isMainModule } from './node-script.js';
import { DrawnCar, DRAWN_CAR_MODELS } from '../game/car/drawn-car.js';
import { DRAWN_CAR_SKINS } from '../game/car/drawn-car-skins.js';
import { CAR_PAINT_COLORS } from '../game/car/car-paint.js';
import { getSpriteBounds } from '../game/settings/garage-ui.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOWCASE_TRACK_KEYS = ['circuit', 'goldenRatio', 'squareRoot', 'halfLife'];
export const HERO_WIDTH = 1400;
export const HERO_HEIGHT = 1000;

// Copy authoritative game UI without rewriting its visual rules. Only the font
// URL changes because the standalone site has a different directory layout.
export function syncLpShowcaseUi(outputRoot = join(repoRoot, 'LP', 'showcase')) {
    const uiRoot = join(outputRoot, 'ui');
    mkdirSync(uiRoot, { recursive: true });
    for (const name of ['foundation', 'race-hud-and-medals', 'lobby-and-garage', 'lobby-modes', 'garage-workshop']) {
        copyFileSync(join(repoRoot, 'styles', `${name}.css`), join(uiRoot, `${name}.css`));
    }
    writeFileSync(join(uiRoot, 'fonts.css'), readFileSync(join(repoRoot, 'styles', 'fonts.css'), 'utf8').replaceAll('../public/fonts/', '../../fonts/'));
    copyFileSync(join(repoRoot, 'game', 'medals', 'medal-icon.js'), join(uiRoot, 'medal-icon.js'));
}

export function renderShowcaseCar(color, { cropped = true } = {}) {
    ensurePath2D();
    const previous = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class { constructor(width, height) { return createCanvas(width, height); } };
    try {
        const car = new DrawnCar(DRAWN_CAR_MODELS.formula, DRAWN_CAR_SKINS['drawn/formula-red'], {
            pixelsPerUnit: cropped ? 9 : 3,
            paint: { main: color },
        });
        const sprite = car.sprite;
        if (!cropped) return sprite.toBuffer('image/png');
        const bounds = getSpriteBounds(sprite);
        const canvas = createCanvas(bounds.width, bounds.height);
        canvas.getContext('2d').drawImage(sprite, -bounds.left, -bounds.top);
        return canvas.toBuffer('image/png');
    } finally {
        if (previous === undefined) delete globalThis.OffscreenCanvas;
        else globalThis.OffscreenCanvas = previous;
    }
}

// Matches the schematic preview renderer's smoothed bounds and 16px padding.
// The replay overlay and the generated image must use the same transform.
export function getShowcaseLayout(track, width, height) {
    const geometry = buildTrackGeometry(track);
    const points = [...geometry.outer, ...geometry.inner];
    const minX = Math.min(...points.map(point => point.x));
    const maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    const maxY = Math.max(...points.map(point => point.y));
    const scale = Math.min((width - 32) / Math.max(1, maxX - minX), (height - 32) / Math.max(1, maxY - minY));
    const offsetX = 16 + (width - 32 - (maxX - minX) * scale) / 2;
    const offsetY = 16 + (height - 32 - (maxY - minY) * scale) / 2;
    return {
        scale,
        mapPoint: point => ({ x: offsetX + (point.x - minX) * scale, y: offsetY + (point.y - minY) * scale }),
    };
}

export function renderShowcaseTrack(trackKey, width, height) {
    ensurePath2D();
    const track = TRACKS[trackKey];
    const canvas = createCanvas(width, height);
    renderTrackPreviewCanvas(canvas, {
        trackGeometry: track,
        cornerRadius: track.cornerRadius,
        presentation: resolveTrackPresentation(trackKey, { surface: TRACK_PRESENTATION_SURFACES.DAILY_CHALLENGE_PREVIEW }),
        startLine: track.startLine,
        transparentBackground: true,
        previewRenderMode: 'schematic',
        hideSchematicStartArrow: true,
    });
    return canvas.toBuffer('image/png');
}

// Full race artwork shares the game's road, curbs, finish and tyre-wall
// drawing, then uses the schematic replay's exact geometry transform.
export function renderShowcaseRaceTrack(trackKey, width, height) {
    ensurePath2D();
    const track = TRACKS[trackKey];
    if (!track?.outer || !track?.inner) throw new Error(`Unknown showcase track: ${trackKey}`);
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement(tagName) {
            if (tagName !== 'canvas') throw new Error(`Unsupported showcase element: ${tagName}`);
            return createCanvas(1, 1);
        },
    };
    try {
        const presentation = resolveTrackPresentation(trackKey, {
            surface: TRACK_PRESENTATION_SURFACES.RACE,
            ground: track.ground,
        });
        const { canvas: trackCanvas, origin } = buildTrackCanvas(track, buildTrackGeometry(track), {
            ...presentation,
            // Let the landing page supply the off-track composition; all road
            // and trackside artwork keeps its actual game presentation.
            infieldColor: 'rgba(0, 0, 0, 0)',
        });
        const canvas = createCanvas(width, height);
        const layout = getShowcaseLayout(track, width, height);
        const scale = layout.scale / CONFIG.gridSize;
        const position = layout.mapPoint({ x: origin.x / CONFIG.gridSize, y: origin.y / CONFIG.gridSize });
        canvas.getContext('2d').drawImage(trackCanvas, position.x, position.y, trackCanvas.width * scale, trackCanvas.height * scale);
        return canvas.toBuffer('image/png');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
}

function recordLap(track, layout, options) {
    const driven = driveAutopilot(track, options);
    if (!driven.winData || driven.winData.completedLaps !== 1) {
        throw new Error('Landing showcase autopilot did not complete its lap.');
    }
    const { state, collisionSegments } = createReplaySimulationState(track, { trackKey: 'circuit' });
    const frames = [];
    const record = (t, position, angle) => {
        const mapped = layout.mapPoint(position);
        frames.push({ t, x: mapped.x, y: mapped.y, angle });
    };
    record(0, state.pos, state.angle);
    let frameIndex = 0;
    let finished = false;
    for (const input of driven.replay.inputs) {
        state.keys.left = input.left;
        state.keys.right = input.right;
        for (let index = 0; index < input.frames; index += 1) {
            const previous = { t: state.currentTime, x: state.pos.x, y: state.pos.y, angle: state.angle };
            const events = updateSimulation(state, CONFIG.fixedDt, CONFIG, track, collisionSegments);
            frameIndex += 1;
            if (events.winTriggered) {
                // Finish times are interpolated inside the simulation tick. End
                // the displayed trace on that crossing, not beyond the line.
                const finishTime = events.winData.lapTime;
                const fraction = (finishTime - previous.t) / CONFIG.fixedDt;
                record(finishTime * 1000, {
                    x: previous.x + (state.pos.x - previous.x) * fraction,
                    y: previous.y + (state.pos.y - previous.y) * fraction,
                }, previous.angle + (state.angle - previous.angle) * fraction);
                finished = true;
                break;
            }
            if (frameIndex % 3 === 0) record(state.currentTime * 1000, state.pos, state.angle);
        }
        if (finished) break;
    }
    if (!finished) throw new Error('Landing showcase replay did not reproduce the completed lap.');
    return {
        frames,
        durationMs: driven.winData.lapTime * 1000,
        completedCheckpoints: driven.winData.completedCheckpointCount,
        wallImpacts: driven.wallImpacts,
    };
}

export function createShowcaseReplay({ width = HERO_WIDTH, height = HERO_HEIGHT } = {}) {
    const track = TRACKS.circuit;
    const layout = getShowcaseLayout(track, width, height);
    const main = recordLap(track, layout, { lookAhead: 7 });
    const ghost = recordLap(track, layout, { lookAhead: 6 });
    return {
        width, height,
        trackKey: 'circuit',
        trackName: getTrackName('circuit'),
        source: 'Shared game simulation; autopilot steering; stock physics; one complete lap.',
        coordinateSystem: 'Image pixels; t in milliseconds; angle in radians clockwise from right.',
        durationMs: main.durationMs,
        ghostDurationMs: ghost.durationMs,
        carWidth: 64,
        carHeight: 64,
        completedCheckpoints: main.completedCheckpoints,
        ghostCompletedCheckpoints: ghost.completedCheckpoints,
        wallImpacts: main.wallImpacts,
        ghostWallImpacts: ghost.wallImpacts,
        frames: main.frames,
        ghostFrames: ghost.frames,
    };
}

export function generateLpShowcase({ outputRoot = join(repoRoot, 'LP', 'showcase') } = {}) {
    mkdirSync(outputRoot, { recursive: true });
    syncLpShowcaseUi(outputRoot);
    writeFileSync(join(outputRoot, 'hero.png'), renderShowcaseTrack('circuit', HERO_WIDTH, HERO_HEIGHT));
    writeFileSync(join(outputRoot, 'race-sharkBite.png'), renderShowcaseRaceTrack('sharkBite', 1900, 1200));
    writeFileSync(join(outputRoot, 'race-circuit.png'), renderShowcaseRaceTrack('circuit', HERO_WIDTH, HERO_HEIGHT));
    for (const key of SHOWCASE_TRACK_KEYS) {
        writeFileSync(join(outputRoot, `${key}.png`), renderShowcaseTrack(key, 700, 500));
    }
    for (const color of CAR_PAINT_COLORS) {
        writeFileSync(join(outputRoot, `street-${color.id}.png`), renderShowcaseCar(color.value));
    }
    writeFileSync(join(outputRoot, 'street-replay.png'), renderShowcaseCar(CAR_PAINT_COLORS.find(color => color.id === 'red').value, { cropped: false }));
    const replay = createShowcaseReplay();
    writeFileSync(join(outputRoot, 'replay.json'), `${JSON.stringify(replay)}\n`);
    return { outputRoot, durationMs: replay.durationMs, ghostDurationMs: replay.ghostDurationMs };
}

if (isMainModule(import.meta.url)) console.log(generateLpShowcase());
