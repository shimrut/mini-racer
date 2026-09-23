import { CONFIG } from '../game/config.js';
import { KPH_PER_WORLD_UNIT } from '../game/car/handling.js';
import { RingBuffer } from '../game/race/ring-buffer.js';
import { updateSimulation } from '../game/race/simulation.js';
import { buildTrackCanvas } from '../game/track/canvas.js';
import { resolveTrackPresentation } from '../game/track/presentation.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../game/track/runtime.js';

const DRAFT_KEY = 'mapmaker:playtest-draft:v1';
const STEP = CONFIG.fixedDt;
const canvas = document.getElementById('drive-canvas');
const context = canvas.getContext('2d', { alpha: false });
const ui = {
    title: document.getElementById('track-title'),
    state: document.getElementById('drive-state'),
    time: document.getElementById('time-value'),
    gate: document.getElementById('gate-value'),
    speed: document.getElementById('speed-value'),
    contacts: document.getElementById('contact-value'),
    lap: document.getElementById('lap-value'),
    feedback: document.getElementById('drive-feedback'),
    note: document.getElementById('stage-note'),
    pause: document.getElementById('pause-button'),
    view: document.getElementById('view-button'),
};

let draft = null;
let geometry = null;
let collision = null;
let bounds = null;
let trackCanvas = null;
let trackCanvasOrigin = { x: 0, y: 0 };
let state = null;
let paused = false;
let overview = false;
let wallContacts = 0;
let contactSpots = [];
let lapTime = null;
let feedback = '';
let loadError = null;
let lastFrame = 0;
let frameRemainder = 0;
let manualTime = false;
const heldKeys = new Set();
const heldButtons = { left: false, right: false };

function finitePoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validGate(gate) {
    return finitePoint(gate?.p1) && finitePoint(gate?.p2);
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
        || !track.outer.every(finitePoint) || !track.inner.every(finitePoint)
        || !finitePoint(track.startPos) || !Number.isFinite(track.startAngle)
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
        routeTrace: new RingBuffer(480, () => ({ x: 0, y: 0 })),
        routeTraceStrokeStyle: null,
        runHistory: new RingBuffer(1400, () => ({ x: 0, y: 0 })),
        trailTimer: 0,
        runHistoryTimer: 0,
    };
}

function resetRun() {
    if (!draft) return;
    state = makeRunState();
    paused = false;
    wallContacts = 0;
    contactSpots = [];
    lapTime = null;
    feedback = 'Steer through the checkpoints, then cross the finish line.';
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
    ui.view.textContent = overview ? 'Follow car' : 'Show whole track';
    render();
}

function tick() {
    if (!state || paused || state.status !== 'playing') return;
    state.keys.left = heldKeys.has('ArrowLeft') || heldKeys.has('KeyA') || heldButtons.left;
    state.keys.right = heldKeys.has('ArrowRight') || heldKeys.has('KeyD') || heldButtons.right;
    const wasTouching = state.wallContactActive;
    const previousGate = state.nextCheckpointIndex;
    const events = updateSimulation(state, STEP, CONFIG, draft.track, collision.collisionSegments);

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
        feedback = `Lap complete in ${lapTime.toFixed(2)} s with ${wallContacts} wall contact${wallContacts === 1 ? '' : 's'}.`;
    } else if (previousGate > 0 && state.nextCheckpointIndex === 0) {
        feedback = 'Finish crossed before all checkpoints. Gate progress reset.';
    }
}

function advanceTime(milliseconds) {
    manualTime = true;
    frameRemainder = 0;
    const steps = Math.min(6000, Math.max(0, Math.round(Number(milliseconds) / (STEP * 1000))));
    for (let index = 0; index < steps; index += 1) tick();
    render();
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

function drawCar(map, zoom) {
    const center = map(state.pos);
    context.save();
    context.translate(center.x, center.y);
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

function render() {
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
    const zoom = overview ? fit : Math.max(25, Math.min(38, fit * 2));
    const center = overview
        ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
        : state.pos;
    const map = (point) => ({
        x: width / 2 + (point.x - center.x) * zoom,
        y: height / 2 + (point.y - center.y) * zoom,
    });

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
    drawCar(map, zoom);

    ui.state.textContent = state.status === 'won' ? 'Lap complete' : paused ? 'Paused' : 'Driving';
    ui.time.textContent = `${state.currentTime.toFixed(2)} s`;
    ui.gate.textContent = state.status === 'won' ? 'Complete' : state.nextCheckpointIndex < draft.track.checkpoints.length
        ? `${state.nextCheckpointIndex + 1} / ${draft.track.checkpoints.length}`
        : 'Finish line';
    ui.speed.textContent = `${Math.round(state.cachedSpeed * KPH_PER_WORLD_UNIT)} km/h`;
    ui.contacts.textContent = String(wallContacts);
    ui.lap.textContent = lapTime === null ? 'Not finished' : `${lapTime.toFixed(2)} s`;
    ui.feedback.textContent = feedback;
    ui.pause.disabled = state.status === 'won';
    ui.note.hidden = true;
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
        view: overview ? 'whole-track' : 'follow-car',
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
    const presentation = resolveTrackPresentation(draft.trackKey);
    const art = buildTrackCanvas(draft.track, geometry, presentation);
    trackCanvas = art.canvas;
    trackCanvasOrigin = art.origin;
    resetRun();
} catch (error) {
    loadError = error instanceof Error ? error.message : 'Could not load this draft.';
    ui.state.textContent = 'Unavailable';
    ui.feedback.textContent = loadError;
    ui.note.textContent = loadError;
    ui.note.hidden = false;
}

function frame(now) {
    if (!manualTime && lastFrame) frameRemainder += Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    while (frameRemainder >= STEP) {
        tick();
        frameRemainder -= STEP;
    }
    render();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
