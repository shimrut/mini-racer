import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { RingBuffer } from '../game/race/ring-buffer.js';
import {
    createTyreTrackBuffer,
    drawSkidMarks,
    drawSpray,
    drawTyreTracks,
    recordGroundEffects,
} from '../game/race/ground-effects.js';
import { updateSimulation } from '../game/race/simulation.js';
import {
    getCameraZoom,
    getDesiredLookAhead,
    getLookAheadLerpFactor,
} from '../game/race/race-camera.js';
import { RaceHud } from '../game/race/ui-hud.js';
import { CarSpriteLoader, getDrawnCar } from '../game/car/sprite.js';
import { buildTrackCanvas, drawViewportPresentationBackground } from '../game/track/canvas.js';
import { getTrackGround, getTrackGroundMaxSpeedKph } from '../game/track/grounds.js';
import { getPosterCarAssetName } from '../game/track/poster-car.js';
import { resolveTrackPresentation } from '../game/track/presentation.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../game/track/runtime.js';
import { isFinitePoint } from './geometry.js';
import { summarizeDriveFlow } from './mapmaker/track-flow.js';
import {
    draftLapsStorageKey,
    readDraftLaps,
    recordDraftLap,
} from './mapmaker/medal-times.js';
import { MAPMAKER_ONLINE } from './mapmaker/cloud-maps.js';

const DRAFT_KEY = 'mapmaker:playtest-draft:v1';
const STEP = CONFIG.fixedDt;
const canvas = document.getElementById('drive-canvas');
const context = canvas.getContext('2d', { alpha: false });
const ui = {
    title: document.getElementById('track-title'),
    feedback: document.getElementById('drive-feedback'),
    note: document.getElementById('stage-note'),
    pause: document.getElementById('pause-button'),
    view: document.getElementById('view-button'),
    stage: document.querySelector('.stage'),
    frameDesktop: document.getElementById('frame-desktop'),
    frameMobile: document.getElementById('frame-mobile'),
    flow: document.getElementById('flow-drive'),
    flowSlowest: document.getElementById('flow-slowest'),
    flowGap: document.getElementById('flow-gap'),
    flowBeat: document.getElementById('flow-beat'),
    flowSwitch: document.getElementById('flow-switch'),
};
// Online, the Mapmaker is the index page of /mapmaker/.
if (MAPMAKER_ONLINE) document.querySelector('.drive-back').href = './';

let draft = null;
let geometry = null;
let collision = null;
let bounds = null;
let trackCanvas = null;
let trackCanvasOrigin = { x: 0, y: 0 };
let trackPresentation = null;
let state = null;
let paused = false;
let overview = false;
let raceFrame = 'desktop';
let wallContacts = 0;
let contactSpots = [];
let lapTime = null;
let flowSamples = [];
let flowSummary = null;
let feedback = '';
let loadError = null;
let lastFrame = 0;
let frameRemainder = 0;
let manualTime = false;
let hud = null;
let draftLaps = [];
let draftLapsKey = null;
// The race car: an image, or a car drawn in code, sized as in the race.
const car = { image: null, drawn: null, drawWidth: 64, drawHeight: 32 };
const lookAhead = { x: 0, y: 0 };
const desiredLookAhead = { x: 0, y: 0 };
const heldKeys = new Set();
const heldButtons = { left: false, right: false };

function validGate(gate) {
    return isFinitePoint(gate?.p1) && isFinitePoint(gate?.p2);
}

function readDraft() {
    let saved;
    try {
        saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    } catch {
        throw new Error('The browser could not read this draft. Return to Mapmaker and try Drive Draft again.');
    }
    const track = saved?.track;
    if (!track || !Array.isArray(track.outer) || !Array.isArray(track.inner)
        || track.outer.length < 3 || track.inner.length < 3
        || !track.outer.every(isFinitePoint) || !track.inner.every(isFinitePoint)
        || !isFinitePoint(track.startPos) || !Number.isFinite(track.startAngle)
        || !validGate(track.startLine)
        || !Array.isArray(track.checkpoints) || !track.checkpoints.every(validGate)) {
        throw new Error('No drivable draft is available. Return to Mapmaker and choose Drive Draft.');
    }
    return {
        trackKey: typeof saved.trackKey === 'string' ? saved.trackKey : 'draft',
        track,
    };
}

function makeRunState() {
    const track = draft.track;
    return {
        status: 'playing',
        activeRaceMode: 'daily',
        currentTrackKey: draft.trackKey,
        activeRunId: 0,
        currentTime: 0,
        pos: { ...track.startPos },
        angle: track.startAngle,
        velocity: { x: 0, y: 0 },
        angularVelocity: 0,
        cachedSpeed: 0,
        keys: { left: false, right: false },
        nextCheckpointIndex: 0,
        lapCheckpointTimesSec: [],
        relaunchDelayRemaining: 0,
        wallImpactCooldownRemaining: 0,
        wallContactReleaseRemaining: 0,
        wallContactActive: false,
        collisionHash: collision.collisionHash,
        particles: [],
        frameSkip: 0,
        qualityLevel: 0,
        skidMarks: new RingBuffer(160, () => ({ x: 0, y: 0, cos: 0, sin: 0 })),
        tyreTracks: createTyreTrackBuffer(),
        routeTrace: new RingBuffer(480, () => ({ x: 0, y: 0 })),
        routeTraceStrokeStyle: null,
        runHistory: new RingBuffer(1400, () => ({ x: 0, y: 0 })),
        trailTimer: 0,
        runHistoryTimer: 0,
    };
}

function getStorage() {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function syncBestLap() {
    hud?.setHudBestMetric(draftLaps.length
        ? { value: draftLaps[0].toFixed(3), visible: true }
        : { visible: false });
}

function loadCar() {
    const assetName = getPosterCarAssetName(draft.track);
    new CarSpriteLoader().load(assetName, {
        onLoaded: (image) => {
            car.image = image;
            car.drawn = getDrawnCar(assetName);
            car.drawn?.resetMotion();
            car.drawWidth = 52;
            car.drawHeight = 52;
            render();
        },
        onError: () => {
            console.warn(`Unable to load ${assetName}; Drive Draft shows a plain car.`);
        },
    });
}

function resetRun() {
    if (!draft) return;
    state = makeRunState();
    lookAhead.x = 0;
    lookAhead.y = 0;
    car.drawn?.resetMotion();
    hud?.resetHud();
    paused = false;
    wallContacts = 0;
    contactSpots = [];
    lapTime = null;
    flowSamples = [];
    flowSummary = null;
    feedback = '';
    ui.pause.textContent = 'Pause';
    render();
}

function togglePause() {
    if (!state || state.status === 'won') return;
    paused = !paused;
    ui.pause.textContent = paused ? 'Resume' : 'Pause';
    render();
}

function toggleView() {
    overview = !overview;
    ui.view.textContent = overview ? 'Follow car' : 'Whole track';
    render();
}

function setRaceFrame(frame) {
    raceFrame = frame;
    ui.stage.dataset.frame = frame === 'mobile' ? 'portrait' : 'desktop';
    ui.frameDesktop.setAttribute('aria-pressed', String(frame === 'desktop'));
    ui.frameMobile.setAttribute('aria-pressed', String(frame === 'mobile'));
    requestAnimationFrame(() => render());
}

function tick() {
    if (!state || paused || state.status !== 'playing') return;
    state.keys.left = heldKeys.has('ArrowLeft') || heldKeys.has('KeyA') || heldButtons.left;
    state.keys.right = heldKeys.has('ArrowRight') || heldKeys.has('KeyD') || heldButtons.right;
    const wasTouching = state.wallContactActive;
    const previousGate = state.nextCheckpointIndex;
    const events = updateSimulation(state, STEP, CONFIG, draft.track, collision.collisionSegments);
    recordGroundEffects(state, trackPresentation, CONFIG, events);
    flowSamples.push({
        time: state.currentTime,
        speed: state.cachedSpeed,
        steer: Number(state.keys.right) - Number(state.keys.left),
    });

    if (!wasTouching && state.wallContactActive) {
        wallContacts += 1;
        contactSpots.push({ x: state.pos.x, y: state.pos.y });
        if (contactSpots.length > 40) contactSpots.shift();
        feedback = 'Wall contact. Try a wider line through this bend.';
    }
    if (events.checkpointPassed) {
        feedback = `Checkpoint ${events.checkpointPassed.index + 1} passed.`;
    }
    if (events.challengeLapCompleted) {
        lapTime = events.challengeCompletedLapTime;
        flowSummary = summarizeDriveFlow(flowSamples);
        const previousBest = draftLaps[0] ?? null;
        draftLaps = recordDraftLap(getStorage(), draftLapsKey, lapTime);
        syncBestLap();
        hud?.syncHud({ time: lapTime, speed: state.cachedSpeed, force: true });
        const bestText = previousBest === null || lapTime < previousBest ? ' New best on this layout.' : '';
        feedback = `Lap complete in ${lapTime.toFixed(3)} s with ${wallContacts} wall contact${wallContacts === 1 ? '' : 's'}.${bestText}`;
    } else if (previousGate > 0 && state.nextCheckpointIndex === 0) {
        feedback = 'Finish crossed before all checkpoints. Gate progress reset.';
    }
}

function advanceTime(milliseconds) {
    manualTime = true;
    frameRemainder = 0;
    const steps = Math.min(6000, Math.max(0, Math.round(Number(milliseconds) / (STEP * 1000))));
    for (let index = 0; index < steps; index += 1) tick();
    render(steps * STEP);
    return renderGameToText();
}

function getBounds() {
    const points = [...geometry.outer, ...geometry.inner];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
}

function drawGate(gate, color, label, map) {
    const a = map(gate.p1);
    const b = map(gate.p2);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.setLineDash([8, 6]);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = color;
    context.font = '700 13px system-ui';
    context.fillText(label, (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 - 8);
    context.restore();
}

// Tyre tracks, skid marks, dust and snow spray, drawn with the race code in track-canvas pixels.
function drawGroundEffects(center, zoom, width, height) {
    const gs = CONFIG.gridSize;
    const scale = zoom / gs;
    context.save();
    context.translate(width / 2 - center.x * zoom, height / 2 - center.y * zoom);
    context.scale(scale, scale);
    drawTyreTracks(context, state.tyreTracks, trackPresentation, gs, scale);
    drawSkidMarks(context, state.skidMarks, trackPresentation, gs, scale);
    drawSpray(context, state.particles, trackPresentation, gs);
    for (const particle of state.particles) {
        if (particle.spray) continue;
        context.globalAlpha = particle.maxLife > 0 ? Math.max(0, particle.life / particle.maxLife) : 0;
        context.fillStyle = particle.color;
        context.beginPath();
        context.arc(particle.x * gs, particle.y * gs, particle.size, 0, Math.PI * 2);
        context.fill();
    }
    context.restore();
}

// Draws the race car as the race does: the drawn car with its wheels and
// ground marks, or the car image, with the race shadow.
function drawRaceCar(map, zoom, dt) {
    const center = map(state.pos);
    const drawWidth = car.drawWidth * (CONFIG.carSpriteRenderScale ?? 1);
    const drawHeight = car.drawHeight * (CONFIG.carSpriteRenderScale ?? 1);
    context.save();
    context.translate(center.x, center.y);
    context.rotate(state.angle);
    context.scale(zoom / CONFIG.gridSize, zoom / CONFIG.gridSize);
    if (car.drawn) {
        const running = state.status === 'playing' && !paused;
        car.drawn.update(running ? dt : 0, {
            speedKph: state.cachedSpeed * KPH_PER_WORLD_UNIT,
            speedPx: running ? state.cachedSpeed * CONFIG.gridSize : 0,
            steer: (state.keys.right ? 1 : 0) - (state.keys.left ? 1 : 0),
            holding: false,
            size: drawWidth,
            lowQuality: false,
        });
        car.drawn.drawGround(context, drawWidth);
    }
    const look = trackPresentation;
    context.shadowColor = look?.carShadowColor ?? CONFIG.carSpriteShadowColor;
    context.shadowBlur = look?.carShadowBlur ?? CONFIG.carSpriteShadowBlur;
    context.shadowOffsetX = look?.carShadowOffsetX ?? CONFIG.carSpriteShadowOffsetX;
    context.shadowOffsetY = look?.carShadowOffsetY ?? CONFIG.carSpriteShadowOffsetY;
    if (car.drawn) {
        car.drawn.draw(context, drawWidth);
    } else {
        context.drawImage(car.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    }
    context.restore();
}

function drawCar(map, zoom, dt) {
    if (car.image) {
        drawRaceCar(map, zoom, dt);
        return;
    }
    const center = map(state.pos);
    context.save();
    context.translate(center.x, center.y);
    // Same ground shadow as the race, so the car sits on the road.
    if (trackPresentation?.carShadowColor) {
        context.shadowColor = trackPresentation.carShadowColor;
        context.shadowBlur = trackPresentation.carShadowBlur ?? 0;
        context.shadowOffsetX = trackPresentation.carShadowOffsetX ?? 0;
        context.shadowOffsetY = trackPresentation.carShadowOffsetY ?? 0;
    }
    context.rotate(state.angle);
    context.scale(zoom, zoom);
    context.fillStyle = '#07111e';
    context.fillRect(-0.4, -0.37, 0.22, 0.13);
    context.fillRect(0.22, -0.37, 0.22, 0.13);
    context.fillRect(-0.4, 0.24, 0.22, 0.13);
    context.fillRect(0.22, 0.24, 0.22, 0.13);
    context.fillStyle = '#f43f5e';
    context.strokeStyle = '#fff4e6';
    context.lineWidth = 0.045;
    context.beginPath();
    context.roundRect(-0.615, -0.275, 1.23, 0.55, 0.16);
    context.fill();
    context.stroke();
    context.fillStyle = '#fbbf24';
    context.fillRect(0.18, -0.18, 0.2, 0.36);
    context.restore();
}

function render(dt = 0) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, width, height);
    if (!state) return;

    const fit = Math.min(
        (width - 56) / Math.max(1, bounds.maxX - bounds.minX),
        (height - 56) / Math.max(1, bounds.maxY - bounds.minY),
    );
    // Follow view: the race camera for the chosen screen, not the browser window.
    const mobileCameraMode = raceFrame === 'mobile';
    getDesiredLookAhead(desiredLookAhead, state.velocity, state.cachedSpeed, width, height, mobileCameraMode);
    const lerpFactor = getLookAheadLerpFactor(dt, mobileCameraMode);
    lookAhead.x += (desiredLookAhead.x - lookAhead.x) * lerpFactor;
    lookAhead.y += (desiredLookAhead.y - lookAhead.y) * lerpFactor;
    const zoom = overview ? fit : CONFIG.gridSize * getCameraZoom(mobileCameraMode);
    const center = overview
        ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
        : {
            x: state.pos.x + lookAhead.x / CONFIG.gridSize,
            y: state.pos.y + lookAhead.y / CONFIG.gridSize,
        };
    const map = (point) => ({
        x: width / 2 + (point.x - center.x) * zoom,
        y: height / 2 + (point.y - center.y) * zoom,
    });

    // The ground's own background, as in the race: stars on a space track.
    if (trackPresentation) {
        const pixelsPerTrackPixel = zoom / CONFIG.gridSize;
        drawViewportPresentationBackground(context, width, height, {
            x: center.x * CONFIG.gridSize - width / 2 / pixelsPerTrackPixel,
            y: center.y * CONFIG.gridSize - height / 2 / pixelsPerTrackPixel,
        }, pixelsPerTrackPixel, trackPresentation);
    }

    if (trackCanvas) {
        const topLeft = map({
            x: trackCanvasOrigin.x / CONFIG.gridSize,
            y: trackCanvasOrigin.y / CONFIG.gridSize,
        });
        context.drawImage(
            trackCanvas,
            topLeft.x,
            topLeft.y,
            trackCanvas.width / CONFIG.gridSize * zoom,
            trackCanvas.height / CONFIG.gridSize * zoom,
        );
    }
    draft.track.checkpoints.forEach((gate, index) => {
        const active = state.status !== 'won' && index === state.nextCheckpointIndex;
        drawGate(gate, active ? '#38bdf8' : '#8a9aaf', `${index + 1}`, map);
    });
    drawGate(draft.track.startLine, '#fbbf24', 'FINISH', map);
    for (const spot of contactSpots) {
        const point = map(spot);
        context.fillStyle = '#fb7185';
        context.beginPath();
        context.arc(point.x, point.y, 5, 0, Math.PI * 2);
        context.fill();
    }
    drawGroundEffects(center, zoom, width, height);
    drawCar(map, zoom, dt);
    // After the finish, the HUD keeps the lap time, as in the race.
    if (state.status === 'playing') hud?.syncHud({ time: state.currentTime, speed: state.cachedSpeed });

    const gateLabel = state.status === 'won'
        ? 'Complete'
        : state.nextCheckpointIndex < draft.track.checkpoints.length
            ? `Gate ${state.nextCheckpointIndex + 1} of ${draft.track.checkpoints.length}`
            : 'Finish line';
    const wallLabel = `${wallContacts} wall${wallContacts === 1 ? '' : 's'}`;
    ui.feedback.textContent = feedback || (paused ? `Paused · ${gateLabel}` : `${gateLabel} · ${wallLabel}`);
    renderFlowSummary();
    ui.pause.disabled = state.status === 'won';
    ui.note.hidden = true;
}

function showFlowValue(element, text, pass) {
    element.textContent = text;
    element.dataset.flow = pass ? 'pass' : 'miss';
}

function renderFlowSummary() {
    ui.flow.hidden = !flowSummary;
    if (!flowSummary) return;
    const percent = (share) => `${Math.round(share * 100)}%`;
    showFlowValue(ui.flowSlowest,
        `${percent(flowSummary.slowestShare)} speed`,
        flowSummary.pass.corner);
    showFlowValue(ui.flowGap,
        `${flowSummary.steerFreeSec.toFixed(1)} s clear`,
        flowSummary.pass.steerGap);
    showFlowValue(ui.flowBeat,
        `beat ${(1 / Math.max(flowSummary.inputsPerSec, 0.01)).toFixed(1)} s`,
        flowSummary.pass.beat);
    showFlowValue(ui.flowSwitch,
        `${percent(flowSummary.switchShare)} sides`,
        flowSummary.pass.leftRight);
}

function renderGameToText() {
    if (!state) return JSON.stringify({ mode: 'unavailable', error: loadError });
    return JSON.stringify({
        mode: state.status === 'won' ? 'lap-complete' : paused ? 'paused' : 'driving',
        coordinates: 'world units; origin upper left; x right, y down',
        trackKey: draft.trackKey,
        car: {
            x: Number(state.pos.x.toFixed(3)),
            y: Number(state.pos.y.toFixed(3)),
            angle: Number(state.angle.toFixed(3)),
            speedKph: Math.round(state.cachedSpeed * KPH_PER_WORLD_UNIT),
        },
        timeSec: Number(state.currentTime.toFixed(3)),
        nextCheckpoint: state.status === 'won' ? 'complete' : state.nextCheckpointIndex < draft.track.checkpoints.length
            ? state.nextCheckpointIndex + 1 : 'finish',
        checkpointCount: draft.track.checkpoints.length,
        wallContacts,
        lapTimeSec: lapTime,
        savedLapsSec: draftLaps,
        flow: flowSummary,
        view: overview ? 'whole-track' : 'follow-car',
        screen: raceFrame,
        feedback,
    });
}

window.render_game_to_text = renderGameToText;
window.advanceTime = advanceTime;

document.addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(event.code)) {
        event.preventDefault();
    }
    heldKeys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') togglePause();
    if (event.code === 'KeyR') resetRun();
    if (event.code === 'KeyM') toggleView();
});
document.addEventListener('keyup', (event) => heldKeys.delete(event.code));
window.addEventListener('blur', () => {
    heldKeys.clear();
    heldButtons.left = false;
    heldButtons.right = false;
});
ui.pause.addEventListener('click', togglePause);
ui.view.addEventListener('click', toggleView);
ui.frameDesktop.addEventListener('click', () => setRaceFrame('desktop'));
ui.frameMobile.addEventListener('click', () => setRaceFrame('mobile'));
document.getElementById('reset-button').addEventListener('click', resetRun);
for (const direction of ['left', 'right']) {
    const button = document.getElementById(`steer-${direction}`);
    button.addEventListener('pointerdown', (event) => {
        button.setPointerCapture(event.pointerId);
        heldButtons[direction] = true;
    });
    button.addEventListener('pointerup', () => { heldButtons[direction] = false; });
    button.addEventListener('pointercancel', () => { heldButtons[direction] = false; });
    button.addEventListener('lostpointercapture', () => { heldButtons[direction] = false; });
}
window.addEventListener('resize', render);

try {
    draft = readDraft();
    ui.title.textContent = draft.track.name || draft.trackKey || 'Draft Drive';
    geometry = buildTrackGeometry(draft.track);
    bounds = getBounds();
    collision = buildCollisionRuntime(geometry);
    const presentation = resolveTrackPresentation(draft.trackKey, { ground: draft.track.ground });
    trackPresentation = presentation;
    const art = buildTrackCanvas(draft.track, geometry, presentation);
    trackCanvas = art.canvas;
    trackCanvasOrigin = art.origin;
    hud = new RaceHud();
    hud.setMaxSpeed(getTrackGroundMaxSpeedKph(CONFIG.maxSpeed, draft.track));
    hud.setGround(getTrackGround(draft.track).key);
    draftLapsKey = draftLapsStorageKey(draft.trackKey, draft.track);
    draftLaps = readDraftLaps(getStorage(), draftLapsKey);
    resetRun();
    syncBestLap();
    loadCar();
} catch (error) {
    loadError = error instanceof Error ? error.message : 'Could not load this draft.';
    ui.feedback.textContent = loadError;
    ui.note.textContent = loadError;
    ui.note.hidden = false;
}

function frame(now) {
    const frameDt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    if (!manualTime) frameRemainder += frameDt;
    lastFrame = now;
    while (frameRemainder >= STEP) {
        tick();
        frameRemainder -= STEP;
    }
    render(manualTime ? 0 : frameDt);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
