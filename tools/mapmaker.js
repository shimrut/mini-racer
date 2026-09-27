import { CONFIG } from '../game/config.js';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import {
    drawTrackBoundaries,
    drawTrackFinishLine,
    fillTrackPresentation,
} from '../game/track/canvas.js';
import { resolveTrackPresentation } from '../game/track/presentation.js';
import { TRACK_GROUNDS, TRACK_GROUND_KEYS, getStoredTrackGroundKey, getTrackGround } from '../game/track/grounds.js';
import { buildTrackGeometry } from '../game/track/runtime.js';
import { TRACKS } from '../game/track/tracks.js';
import {
    buildPerpendicularLaneGate,
} from './mapmaker/lane-gate.js';
import { buildAutoGates, closedLoopLength, nearestDistanceAlongLoop } from './mapmaker/auto-gates.js';
import { validateTrackQuality } from './mapmaker/track-quality.js';
import { runTrackBotCheck } from './runner.js';
import { analyzeTrackFlow, FLOW_DRAW_GUIDE, measureStraights } from './mapmaker/track-flow.js';
import {
    clearDraftRecovery,
    createEditHistory,
    loadDraftRecovery,
    saveDraftRecovery,
} from './mapmaker/edit-history.js';
import { snapStartPose } from './mapmaker/start-pose.js';
import { buildRibbonWallsFromCenterline } from './mapmaker/ribbon-walls.js';
import {
    DEFAULT_DRAW_WIDTH,
    formatTrackNumber as formatNumber,
    generateTrackIntegrationSnippet,
    generateTrackModuleSource,
    getTrackModuleFilename,
    isValidTrackKey
} from './mapmaker/track-source.js';
import { clamp, clonePoint, distance, midpoint, normalizeVector } from './geometry.js';
import seriesFileData from '../game/campaign/series.json' with { type: 'json' };
import medalTimesFileData from '../game/medals/medal-times.json' with { type: 'json' };
import {
    getCampaignSeriesMinStages,
    isCampaignSeriesLive,
} from '../game/campaign/series-rules.js';
import {
    applyTrackSeriesUpdate,
    DAILY_DESTINATION,
    findTrackStage,
    moveSeriesStage,
    normalizeCampaignSeriesData,
    parseTrackDestination,
    seriesDestination,
    suggestRequiredMedals,
    UNUSED_DESTINATION,
} from './mapmaker/campaign-series.js';
import {
    averageDraftLap,
    BRONZE_WARNING_SEC,
    draftLapsStorageKey,
    getMedalRowError,
    lapToAuthorTime,
    MEDAL_TIERS,
    normalizeMedalRow,
    readDraftLaps,
    suggestMedalTimes,
} from './mapmaker/medal-times.js';

const SCHEDULED_TRACK_KEYS = new Set(TRACK_SCHEDULE_KEYS);

const TOOL_LABELS = {
    draw: 'line build',
    outer: 'outer wall',
    inner: 'inner wall',
    startLine: 'finish line',
    startPos: 'start position',
    checkpoints: 'checkpoints'
};

const EDITOR_TOOLS = ['outer', 'inner', 'startLine', 'startPos', 'checkpoints'];

const BLANK_VIEW_BOUNDS = { minX: -40, maxX: 40, minY: -30, maxY: 30 };
const FIXED_DRAW_WIDTH = DEFAULT_DRAW_WIDTH;
const MIN_LINE_SMOOTHING = 0;
const MAX_LINE_SMOOTHING = 1;
const DEFAULT_LINE_SMOOTHING = 0.35;
const DEFAULT_CORNER_RADIUS = 3;
const CORNER_RADIUS_PRESETS = [
    { value: 0, label: 'Sharp' },
    { value: 1.5, label: 'A bit rounded' },
    { value: 3, label: 'Rounded' },
    { value: 5, label: 'Soft' },
];
const CORNER_RADIUS_VALUES = CORNER_RADIUS_PRESETS.map((preset) => preset.value);

const CAR_RADIUS = CONFIG.carRadius;
const CAR_HALF_LENGTH = CONFIG.carCollisionHalfLength;

function cloneTracks(source) {
    if (typeof structuredClone === 'function') {
        return structuredClone(source);
    }
    return JSON.parse(JSON.stringify(source));
}

function getBrowserStorage(name) {
    try {
        return window[name];
    } catch {
        return null;
    }
}

function geometrySignature(track) {
    return JSON.stringify([
        track.outer,
        track.inner,
        track.startLine,
        track.startPos,
        track.startAngle,
        track.checkpoints,
        track.cornerRadius,
    ]);
}

function dedupeStrokePoints(points, minimumDistance) {
    if (!points.length) {
        return [];
    }
    const filtered = [clonePoint(points[0])];
    for (let index = 1; index < points.length; index += 1) {
        if (distance(points[index], filtered[filtered.length - 1]) >= minimumDistance) {
            filtered.push(clonePoint(points[index]));
        }
    }
    if (filtered.length === 1 && points.length > 1) {
        filtered.push(clonePoint(points[points.length - 1]));
    }
    return filtered;
}

function smoothLoopPoints(points, strength) {
    const smoothing = clamp(strength, MIN_LINE_SMOOTHING, MAX_LINE_SMOOTHING);
    if (points.length < 3 || smoothing <= 0) {
        return points.map(clonePoint);
    }

    const neighborWeight = smoothing * 0.2;
    const pointWeight = 1 - neighborWeight * 2;
    return points.map((point, index) => {
        const prev = points[(index - 1 + points.length) % points.length];
        const next = points[(index + 1) % points.length];
        return {
            x: prev.x * neighborWeight + point.x * pointWeight + next.x * neighborWeight,
            y: prev.y * neighborWeight + point.y * pointWeight + next.y * neighborWeight
        };
    });
}

function smoothOpenPoints(points, strength) {
    const smoothing = clamp(strength, MIN_LINE_SMOOTHING, MAX_LINE_SMOOTHING);
    if (points.length < 3 || smoothing <= 0) return points.map(clonePoint);
    const neighborWeight = smoothing * 0.2;
    const pointWeight = 1 - neighborWeight * 2;
    return points.map((point, index) => {
        if (index === 0 || index === points.length - 1) return clonePoint(point);
        const prev = points[index - 1];
        const next = points[index + 1];
        return {
            x: prev.x * neighborWeight + point.x * pointWeight + next.x * neighborWeight,
            y: prev.y * neighborWeight + point.y * pointWeight + next.y * neighborWeight,
        };
    });
}

function offsetTrackLayout(layout, offsetX, offsetY) {
    const movePoint = (point) => ({
        x: point.x + offsetX,
        y: point.y + offsetY
    });
    return {
        ...layout,
        outer: layout.outer.map(movePoint),
        inner: layout.inner.map(movePoint),
        startLine: {
            p1: movePoint(layout.startLine.p1),
            p2: movePoint(layout.startLine.p2)
        },
        startPos: movePoint(layout.startPos),
        checkpoints: layout.checkpoints.map((checkpoint) => ({
            p1: movePoint(checkpoint.p1),
            p2: movePoint(checkpoint.p2)
        })),
        centerline: layout.centerline?.map(movePoint),
    };
}

function normalizeTrackLayout(layout, padding = 4) {
    const points = [
        ...layout.outer,
        ...layout.inner,
        layout.startLine.p1,
        layout.startLine.p2,
        layout.startPos,
        ...layout.checkpoints.flatMap((checkpoint) => [checkpoint.p1, checkpoint.p2])
    ];
    let minX = Infinity;
    let minY = Infinity;
    points.forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
    });
    const offsetX = minX < padding ? padding - minX : 0;
    const offsetY = minY < padding ? padding - minY : 0;
    const normalized = offsetX === 0 && offsetY === 0
        ? layout
        : offsetTrackLayout(layout, offsetX, offsetY);
    return { ...normalized, normalizationOffset: { x: offsetX, y: offsetY } };
}

function buildRoadWallsFromLoop(rawPoints, trackWidth, lineSmoothing) {
    const filtered = dedupeStrokePoints(rawPoints, 0.35);
    if (filtered.length < 3) {
        return null;
    }

    const centerline = smoothLoopPoints(filtered, lineSmoothing);
    const loopLength = closedLoopLength(centerline);
    if (loopLength < trackWidth * 5) {
        return null;
    }

    return buildRibbonWallsFromCenterline(centerline, trackWidth / 2);
}

function buildTrackFromLoop(rawPoints, trackWidth, lineSmoothing, cornerRadius) {
    const walls = buildRoadWallsFromLoop(rawPoints, trackWidth, lineSmoothing);
    if (!walls) {
        return null;
    }
    const { outer, inner } = walls;
    const gates = buildAutoGates(walls.centerline, outer, inner, trackWidth, { cornerRadius });
    if (!gates) return null;
    return normalizeTrackLayout({
        outer: outer.map(clonePoint),
        inner: inner.map(clonePoint),
        startLine: gates.startLine,
        startPos: gates.startPos,
        startAngle: gates.startAngle,
        checkpoints: gates.checkpoints,
        centerline: walls.centerline.map(clonePoint),
        cornerRadius
    });
}

function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) {
        return { distance: distance(point, a), closest: clonePoint(a), indexT: 0 };
    }
    let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const closest = {
        x: a.x + dx * t,
        y: a.y + dy * t
    };
    return {
        distance: distance(point, closest),
        closest,
        indexT: t
    };
}

function createBlankTrack(name = 'New Track') {
    return {
        name,
        cornerRadius: DEFAULT_CORNER_RADIUS,
        drawWidth: FIXED_DRAW_WIDTH,
        lineSmoothing: DEFAULT_LINE_SMOOTHING,
        outer: [],
        inner: [],
        startLine: {
            p1: { x: 0, y: 0 },
            p2: { x: 0, y: 0 }
        },
        startPos: { x: 0, y: 0 },
        startAngle: 0,
        checkpoints: []
    };
}

class MapmakerApp {
    constructor() {
        this.canvas = document.getElementById('map-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.trackSelect = document.getElementById('editor-track-select');
        this.toolButtons = Array.from(document.querySelectorAll('#tool-buttons [data-tool]'));
        this.stageTitle = document.getElementById('stage-title');
        this.stageSubtitle = document.getElementById('stage-subtitle');
        this.canvasHint = document.getElementById('canvas-hint');
        this.trackKeyInput = document.getElementById('track-key-input');
        this.trackNameInput = document.getElementById('track-name-input');
        this.trackDestinationSelect = document.getElementById('track-destination-select');
        this.seriesStageFields = document.getElementById('series-stage-fields');
        this.seriesStageLabel = document.getElementById('series-stage-label');
        this.seriesLapsSelect = document.getElementById('series-laps-select');
        this.seriesTargetInput = document.getElementById('series-target-input');
        this.seriesStageHint = document.getElementById('series-stage-hint');
        this.seriesStageList = document.getElementById('series-stage-list');
        this.medalTimesState = document.getElementById('medal-times-state');
        this.draftLapsList = document.getElementById('draft-laps-list');
        this.medalTimesHint = document.getElementById('medal-times-hint');
        this.medalInputs = Object.fromEntries(MEDAL_TIERS.map((tier) => [
            tier,
            document.getElementById(`medal-${tier}-input`),
        ]));
        this.cornerRadiusSelect = document.getElementById('corner-radius-select');
        this.groundSelect = document.getElementById('ground-select');
        this.lineSmoothingInput = document.getElementById('line-smoothing-input');
        this.drawMetricsLabel = document.getElementById('draw-metrics-label');
        this.selectedXInput = document.getElementById('selected-x-input');
        this.selectedYInput = document.getElementById('selected-y-input');
        this.selectionLabel = document.getElementById('selection-label');
        this.checkpointSelect = document.getElementById('checkpoint-select');
        this.checkpointCount = document.getElementById('checkpoint-count');
        this.checkpointPanel = document.getElementById('checkpoint-panel');
        this.statusText = document.getElementById('status-text');
        this.dirtyBadge = document.getElementById('dirty-badge');
        this.saveTrackBtn = document.getElementById('save-track-btn');
        this.copyBackupBtn = document.getElementById('copy-backup-btn');
        this.newTrackBtn = document.getElementById('new-track-btn');
        this.duplicateTrackBtn = document.getElementById('duplicate-track-btn');
        this.removeTrackBtn = document.getElementById('remove-track-btn');
        this.removeTrackDialog = document.getElementById('remove-track-dialog');
        this.removeTrackDialogMessage = document.getElementById('remove-track-dialog-message');
        this.insertPointBtn = document.getElementById('insert-point-btn');
        this.deletePointBtn = document.getElementById('delete-point-btn');
        this.reversePolygonBtn = document.getElementById('reverse-polygon-btn');
        this.addCheckpointBtn = document.getElementById('add-checkpoint-btn');
        this.removeCheckpointBtn = document.getElementById('remove-checkpoint-btn');
        this.reframeBtn = document.getElementById('reframe-btn');
        this.undoEditBtn = document.getElementById('undo-edit-btn');
        this.redoEditBtn = document.getElementById('redo-edit-btn');
        this.driveDraftBtn = document.getElementById('drive-draft-btn');
        this.restoreDraftsDialog = document.getElementById('restore-drafts-dialog');
        this.restoreDraftsDialogMessage = document.getElementById('restore-drafts-dialog-message');
        this.qualityCount = document.getElementById('quality-count');
        this.qualitySummary = document.getElementById('quality-summary');
        this.qualityIssues = document.getElementById('quality-issues');
        this.flowCount = document.getElementById('flow-count');
        this.flowSummary = document.getElementById('flow-summary');
        this.flowRules = document.getElementById('flow-rules');
        this.runBotsBtn = document.getElementById('run-bots-btn');
        this.botCheckCount = document.getElementById('bot-check-count');
        this.botCheckSummary = document.getElementById('bot-check-summary');
        this.botCheckIssues = document.getElementById('bot-check-issues');

        const initialTrackKey = Object.keys(TRACKS)[0];
        this.state = {
            tracks: cloneTracks(TRACKS),
            selectedTrackKey: initialTrackKey,
            tool: 'outer',
            selectedHandle: null,
            hoverHandle: null,
            hoverSegment: null,
            checkpointIndex: 0,
            drag: null,
            dirtyTrackKeys: new Set(),
            originalTrackKeyByKey: new Map(
                Object.keys(TRACKS).map((trackKey) => [trackKey, trackKey]),
            ),
            status: 'Ready.',
            isSpaceDown: false,
            skipDrawClick: false,
            draftLoop: [],
            draftCursor: null,
            draftCloseHover: false,
            view: {
                zoom: 1,
                panX: 0,
                panY: 0,
                frozenBounds: null
            }
        };

        this.editHistories = new Map(Object.entries(this.state.tracks).map(
            ([key, track]) => [key, createEditHistory(track)],
        ));
        this.activeHistoryEditKey = null;
        this.draftLoopsByKey = new Map();
        this.destinationByKey = new Map();
        this.seriesData = normalizeCampaignSeriesData(seriesFileData);
        this.medalTimes = { ...medalTimesFileData };
        this.stageSettingsByKey = new Map();
        this.medalRowByKey = new Map();
        this.autoRoadGuideByKey = new Map();
        this.recoveryTimer = null;
        this.skipBeforeUnload = false;
        this.qualityTimer = null;
        this.qualityReport = null;
        this.qualityTrackKey = null;
        this.flowTimer = null;
        this.flowReport = null;
        this.flowTrackKey = null;
        this.flowSignature = null;
        this.baselineQualityCodesByKey = new Map();
        this.baselineGeometryByKey = new Map();

        this.bindEvents();
        this.populateTrackSelect();
        this.loadTrack(initialTrackKey);
        this.resizeCanvas();

        const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        resizeObserver.observe(this.canvas.parentElement);
        this.offerDraftRecovery();
    }

    get track() {
        return this.state.tracks[this.state.selectedTrackKey];
    }

    getEditHistory(key = this.state.selectedTrackKey) {
        if (!this.editHistories.has(key)) {
            this.editHistories.set(key, createEditHistory(this.state.tracks[key]));
        }
        return this.editHistories.get(key);
    }

    syncHistoryButtons() {
        const history = this.getEditHistory();
        this.undoEditBtn.disabled = !history.canUndo && this.state.draftLoop.length === 0;
        this.redoEditBtn.disabled = !history.canRedo;
    }

    beginHistoryEdit() {
        if (this.activeHistoryEditKey) return;
        this.activeHistoryEditKey = this.state.selectedTrackKey;
        this.getEditHistory().beginEdit(this.track);
    }

    commitHistoryEdit() {
        const key = this.activeHistoryEditKey;
        if (!key) return;
        this.activeHistoryEditKey = null;
        if (this.state.tracks[key]) this.getEditHistory(key).commitEdit(this.state.tracks[key]);
        this.syncHistoryButtons();
    }

    restoreEdit(track, message) {
        this.state.tracks[this.state.selectedTrackKey] = track;
        this.loadTrack(this.state.selectedTrackKey);
        this.markDirty(message, true, { recordHistory: false });
        this.syncHistoryButtons();
    }

    undoEdit() {
        if (this.state.draftLoop.length) {
            this.undoDraftLoopPoint();
            return;
        }
        const track = this.getEditHistory().undo();
        if (track) this.restoreEdit(track, 'Undid last edit.');
    }

    redoEdit() {
        const track = this.getEditHistory().redo();
        if (track) this.restoreEdit(track, 'Redid edit.');
    }

    scheduleDraftRecovery() {
        if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(() => this.flushDraftRecovery(), 200);
    }

    flushDraftRecovery() {
        if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
        if (this.state.draftLoop.length) {
            this.draftLoopsByKey.set(this.state.selectedTrackKey, cloneTracks(this.state.draftLoop));
        } else {
            this.draftLoopsByKey.delete(this.state.selectedTrackKey);
        }
        const keys = new Set([...this.state.dirtyTrackKeys, ...this.draftLoopsByKey.keys()]);
        const drafts = [...keys].filter((key) => this.state.tracks[key]).map((key) => ({
            trackKey: key,
            originalTrackKey: this.state.originalTrackKeyByKey.get(key) ?? null,
            destination: this.destinationByKey.get(key) ?? this.getDestinationForTrackKey(key),
            track: this.state.tracks[key],
            draftLoop: this.draftLoopsByKey.get(key) ?? [],
        }));
        if (drafts.length) {
            saveDraftRecovery(getBrowserStorage('localStorage'), {
                selectedTrackKey: keys.has(this.state.selectedTrackKey) ? this.state.selectedTrackKey : null,
                drafts,
            });
        } else {
            clearDraftRecovery(getBrowserStorage('localStorage'));
        }
    }

    offerDraftRecovery() {
        const recovery = loadDraftRecovery(getBrowserStorage('localStorage'));
        if (!recovery?.drafts.length) {
            try { getBrowserStorage('sessionStorage')?.removeItem('mapmaker:return-from-playtest:v1'); } catch {}
            return;
        }
        let returningFromPlaytest = false;
        try {
            returningFromPlaytest = getBrowserStorage('sessionStorage')?.getItem('mapmaker:return-from-playtest:v1') === '1';
        } catch {}
        if (returningFromPlaytest) {
            try { getBrowserStorage('sessionStorage')?.removeItem('mapmaker:return-from-playtest:v1'); } catch {}
            this.restoreDraftRecovery(recovery);
            return;
        }
        this.restoreDraftsDialogMessage.textContent = `${recovery.drafts.length} unsaved map${recovery.drafts.length === 1 ? '' : 's'} found in this browser. Restore them to the editor?`;
        this.restoreDraftsDialog.returnValue = '';
        this.restoreDraftsDialog.showModal();
        this.restoreDraftsDialog.addEventListener('close', () => {
            if (this.restoreDraftsDialog.returnValue !== 'restore') {
                clearDraftRecovery(getBrowserStorage('localStorage'));
                return;
            }
            this.restoreDraftRecovery(recovery);
        }, { once: true });
    }

    restoreDraftRecovery(recovery) {
        for (const draft of recovery.drafts) {
            if (draft.originalTrackKey && draft.originalTrackKey !== draft.trackKey) {
                delete this.state.tracks[draft.originalTrackKey];
                this.state.originalTrackKeyByKey.delete(draft.originalTrackKey);
                this.editHistories.delete(draft.originalTrackKey);
            }
            this.state.tracks[draft.trackKey] = draft.track;
            this.state.dirtyTrackKeys.add(draft.trackKey);
            if (draft.originalTrackKey) {
                this.state.originalTrackKeyByKey.set(draft.trackKey, draft.originalTrackKey);
            }
            this.destinationByKey.set(draft.trackKey, draft.destination);
            this.draftLoopsByKey.set(draft.trackKey, draft.draftLoop);
            this.editHistories.set(draft.trackKey, createEditHistory(draft.track));
        }
        this.populateTrackSelect();
        this.loadTrack(recovery.selectedTrackKey || recovery.drafts[0].trackKey);
        this.setStatus(`Restored ${recovery.drafts.length} unsaved map${recovery.drafts.length === 1 ? '' : 's'}.`);
    }

    scheduleQualityCheck() {
        if (this.qualityTimer) clearTimeout(this.qualityTimer);
        this.qualityTimer = setTimeout(() => this.refreshQualityCheck(), 140);
    }

    refreshQualityCheck() {
        if (this.qualityTimer) clearTimeout(this.qualityTimer);
        this.qualityTimer = null;
        const key = this.state.selectedTrackKey;
        const report = validateTrackQuality(this.track);
        this.syncMedalTimesPanel();
        this.syncSeriesStageFields();
        this.qualityReport = report;
        this.qualityTrackKey = key;
        const errors = report.issues.filter((issue) => issue.severity === 'error');
        const warnings = report.issues.filter((issue) => issue.severity === 'warning');
        this.qualityCount.textContent = `${errors.length} errors · ${warnings.length} warnings`;
        this.qualityCount.className = `pill${errors.length ? ' pill-danger' : warnings.length ? ' pill-warn' : ' pill-ok'}`;
        const approximateLapLength = (
            closedLoopLength(this.track.outer) + closedLoopLength(this.track.inner)
        ) / 2;
        this.qualitySummary.textContent = !this.hasTrackGeometry()
            ? 'Draw a closed road to check its walls, start, and lap gates.'
            : `${report.issues.length ? 'Review the marked locations.' : 'No structural issues found.'} Approx. lap ${formatNumber(approximateLapLength)}u · narrowest wall gap ${formatNumber(report.minClearance ?? 0)}u.`;
        this.qualityIssues.replaceChildren();
        let markerNumber = 0;
        for (const issue of report.issues.slice(0, 12)) {
            const item = document.createElement('li');
            item.dataset.severity = issue.severity;
            if (issue.hotspot) {
                markerNumber += 1;
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = `${markerNumber}. ${issue.message}`;
                button.addEventListener('click', () => this.focusQualityIssue(issue));
                item.appendChild(button);
            } else {
                item.textContent = issue.message;
            }
            this.qualityIssues.appendChild(item);
        }
        this.scheduleFlowCheck();
        if (this.botReport) this.renderBotReport();
        this.draw();
        return report;
    }

    scheduleFlowCheck() {
        if (this.flowTimer) clearTimeout(this.flowTimer);
        this.flowTimer = setTimeout(() => this.refreshFlowCheck(), 260);
    }

    refreshFlowCheck() {
        if (this.flowTimer) clearTimeout(this.flowTimer);
        this.flowTimer = null;
        const key = this.state.selectedTrackKey;
        let blockedReason = null;
        if (!this.hasTrackGeometry()) {
            blockedReason = 'Draw a closed road to check how it flows.';
        } else if (this.qualityReport?.hasErrors) {
            blockedReason = 'Fix the errors above to check how the road flows.';
        }
        const signature = blockedReason ? null : geometrySignature(this.track);
        if (!blockedReason && key === this.flowTrackKey && signature === this.flowSignature) {
            return this.flowReport;
        }
        this.flowReport = blockedReason ? null : analyzeTrackFlow(this.track);
        this.flowTrackKey = key;
        this.flowSignature = signature;
        this.renderFlowReport(blockedReason ?? 'This road cannot be measured for flow.');
        this.draw();
        return this.flowReport;
    }

    renderFlowReport(unavailableReason) {
        this.flowRules.replaceChildren();
        const report = this.flowReport;
        if (!report) {
            this.flowCount.textContent = 'Not checked';
            this.flowCount.className = 'pill';
            this.flowSummary.textContent = unavailableReason;
            return;
        }
        const total = report.rules.length;
        this.flowCount.textContent = `${report.passed} of ${total} rules`;
        this.flowCount.className = `pill${report.passed === total ? ' pill-ok' : ''}`;
        this.flowSummary.textContent = report.passed === total
            ? `The road meets all flow rules. Approx. lap ${report.lapSeconds.toFixed(1)} s on the fast line.`
            : `Blue markers show where the flow breaks. These are hints, not errors. Approx. lap ${report.lapSeconds.toFixed(1)} s on the fast line.`;
        report.rules.forEach((rule, index) => {
            const item = document.createElement('li');
            item.dataset.flow = rule.pass ? 'pass' : 'miss';
            const text = `F${index + 1}. ${rule.message}`;
            if (rule.hotspot) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = text;
                button.addEventListener('click', () => this.focusQualityIssue(rule));
                item.appendChild(button);
            } else {
                item.textContent = text;
            }
            this.flowRules.appendChild(item);
        });
    }

    focusQualityIssue(issue) {
        if (!issue.hotspot) return;
        const viewport = this.getViewport();
        const screen = this.worldToScreen(issue.hotspot, viewport);
        this.state.view.panX += viewport.width / 2 - screen.x;
        this.state.view.panY += viewport.height / 2 - screen.y;
        this.draw();
    }

    drawQualityMarkers(viewport) {
        if (this.qualityTrackKey !== this.state.selectedTrackKey) return;
        this.qualityReport?.issues.filter((issue) => issue.hotspot).slice(0, 12).forEach((issue, index) => {
            const screen = this.worldToScreen(issue.hotspot, viewport);
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.arc(screen.x, screen.y, 9, 0, Math.PI * 2);
            this.ctx.fillStyle = issue.severity === 'error' ? '#f43f5e' : '#fbbf24';
            this.ctx.fill();
            this.ctx.lineWidth = 2;
            this.ctx.strokeStyle = '#0b1020';
            this.ctx.stroke();
            this.ctx.fillStyle = '#0b1020';
            this.ctx.font = 'bold 10px system-ui';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(String(index + 1), screen.x, screen.y);
            this.ctx.restore();
        });
    }

    drawFlowMarkers(viewport) {
        if (!this.flowReport || this.flowTrackKey !== this.state.selectedTrackKey) return;
        // Hide markers while an edit waits for its flow check, so none point at a moved wall.
        if (geometrySignature(this.track) !== this.flowSignature) return;
        this.flowReport.rules.forEach((rule, index) => {
            if (!rule.hotspot) return;
            const screen = this.worldToScreen(rule.hotspot, viewport);
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.roundRect(screen.x - 12, screen.y - 9, 24, 18, 5);
            this.ctx.fillStyle = '#38bdf8';
            this.ctx.fill();
            this.ctx.lineWidth = 2;
            this.ctx.strokeStyle = '#0b1020';
            this.ctx.stroke();
            this.ctx.fillStyle = '#0b1020';
            this.ctx.font = 'bold 10px system-ui';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(`F${index + 1}`, screen.x, screen.y);
            this.ctx.restore();
        });
    }

    getDrawWidth() {
        this.track.drawWidth = FIXED_DRAW_WIDTH;
        return FIXED_DRAW_WIDTH;
    }

    getLineSmoothing() {
        return Number.isFinite(Number(this.track.lineSmoothing))
            ? clamp(Number(this.track.lineSmoothing), MIN_LINE_SMOOTHING, MAX_LINE_SMOOTHING)
            : DEFAULT_LINE_SMOOTHING;
    }

    getCornerRadius() {
        return Number.isFinite(Number(this.track.cornerRadius))
            ? Math.max(0, Number(this.track.cornerRadius))
            : DEFAULT_CORNER_RADIUS;
    }

    nearestCornerRadiusPreset(value = this.getCornerRadius()) {
        const radius = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : DEFAULT_CORNER_RADIUS;
        return CORNER_RADIUS_VALUES.reduce((best, candidate) => (
            Math.abs(candidate - radius) < Math.abs(best - radius) ? candidate : best
        ), DEFAULT_CORNER_RADIUS);
    }

    syncCornerRadiusControl() {
        if (!this.cornerRadiusSelect) {
            return;
        }
        this.cornerRadiusSelect.value = String(this.nearestCornerRadiusPreset());
    }

    setCornerRadius(value, options = {}) {
        const nextRadius = this.nearestCornerRadiusPreset(value);
        this.track.cornerRadius = nextRadius;
        this.syncCornerRadiusControl();
        if (options.markDirty !== false) {
            const preset = CORNER_RADIUS_PRESETS.find((entry) => entry.value === nextRadius);
            this.markDirty(
                options.status ?? `Set wall corners to ${preset?.label ?? 'Rounded'}.`,
                options.updateStatus !== false,
            );
        }
    }

    syncGroundControl() {
        if (!this.groundSelect) {
            return;
        }
        if (this.groundSelect.options.length === 0) {
            TRACK_GROUND_KEYS.forEach((key) => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = TRACK_GROUNDS[key].label;
                this.groundSelect.appendChild(option);
            });
        }
        this.groundSelect.value = getTrackGround(this.track).key;
    }

    setGround(key) {
        this.track.ground = key;
        const storedKey = getStoredTrackGroundKey(this.track);
        if (storedKey === null) {
            delete this.track.ground;
        }
        this.syncGroundControl();
        this.markDirty(`Set ground to ${getTrackGround(this.track).label}.`);
    }

    syncDrawWidthControls() {
        this.track.drawWidth = FIXED_DRAW_WIDTH;
        this.updateDrawMetricsLabel();
    }

    syncLineSmoothingControl() {
        if (this.lineSmoothingInput) {
            this.lineSmoothingInput.value = formatNumber(this.getLineSmoothing());
        }
    }

    updateDrawMetricsLabel() {
        if (this.drawMetricsLabel) {
            const straights = this.getDraftStraights(this.state.draftLoop, false);
            const longest = straights.reduce((best, run) => Math.max(best, run.length), 0);
            const straightNote = straights.length
                ? ` Longest straight ${Math.round(longest)}u (flow guide: ${FLOW_DRAW_GUIDE.maxStraight}u or less).`
                : '';
            this.drawMetricsLabel.textContent = `Road width ${formatNumber(this.getDrawWidth())}u.${straightNote}`;
        }
    }

    getDraftStraights(points, closed) {
        if (points.length < 2) return [];
        const smoothing = this.getLineSmoothing();
        const path = closed
            ? smoothLoopPoints(dedupeStrokePoints(points, 0.35), smoothing)
            : smoothOpenPoints(points, smoothing);
        return measureStraights(path, { closed, halfWidth: this.getDrawWidth() / 2 })
            .map((run) => ({ ...run, path }));
    }

    drawLongStraights(points, closed, viewport) {
        const runs = this.getDraftStraights(points, closed)
            .filter((run) => run.length > FLOW_DRAW_GUIDE.maxStraight);
        if (!runs.length) return;
        this.ctx.save();
        this.ctx.lineCap = 'round';
        this.ctx.font = 'bold 12px system-ui';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        for (const run of runs) {
            const { path } = run;
            const indices = [run.from];
            for (let index = (run.from + 1) % path.length; ; index = (index + 1) % path.length) {
                indices.push(index);
                if (index === run.to) break;
            }
            const screens = indices.map((index) => this.worldToScreen(path[index], viewport));
            this.ctx.beginPath();
            screens.forEach((screen, order) => (order ? this.ctx.lineTo(screen.x, screen.y) : this.ctx.moveTo(screen.x, screen.y)));
            this.ctx.setLineDash([10, 7]);
            this.ctx.strokeStyle = '#38bdf8';
            this.ctx.lineWidth = 3;
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            const a = screens[Math.floor((screens.length - 1) / 2)];
            const b = screens[Math.ceil((screens.length - 1) / 2)];
            const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const label = `${Math.round(run.length)}u straight`;
            this.ctx.lineWidth = 4;
            this.ctx.strokeStyle = '#0b1020';
            this.ctx.strokeText(label, middle.x, middle.y - 14);
            this.ctx.fillStyle = '#38bdf8';
            this.ctx.fillText(label, middle.x, middle.y - 14);
        }
        this.ctx.restore();
    }

    bindEvents() {
        this.trackSelect.addEventListener('change', (event) => {
            this.loadTrack(event.target.value);
        });

        this.toolButtons.forEach((button) => {
            button.addEventListener('click', () => this.setTool(button.dataset.tool));
        });

        this.trackNameInput.addEventListener('input', () => {
            this.track.name = this.trackNameInput.value || 'Untitled Track';
            this.syncTrackSelectText();
            this.updateStageText();
            this.markDirty('Updated track name.');
        });

        this.trackDestinationSelect.addEventListener('change', () => {
            const destination = this.getSelectedDestination();
            this.destinationByKey.set(this.state.selectedTrackKey, destination);
            this.stageSettingsByKey.delete(this.state.selectedTrackKey);
            this.syncSeriesStageFields();
            const series = this.getDestinationSeries(destination);
            this.markDirty(
                series
                    ? `Marked track for the ${series.name} series.`
                    : destination === DAILY_DESTINATION
                        ? 'Marked track for Daily Challenge.'
                        : 'Marked track as not used.',
            );
        });

        this.seriesLapsSelect.addEventListener('change', () => this.updateStageSettings());
        this.seriesTargetInput.addEventListener('change', () => this.updateStageSettings());
        this.seriesStageList.addEventListener('click', (event) => {
            const button = event.target.closest?.('button[data-direction]');
            if (!button) return;
            void this.moveStage(button.dataset.trackKey, Number(button.dataset.direction));
        });

        this.medalInputs.author.addEventListener('change', () => {
            this.setAuthorTime(Number(this.medalInputs.author.value));
        });
        for (const tier of ['gold', 'silver', 'bronze']) {
            this.medalInputs[tier].addEventListener('change', () => this.updateMedalRowFromInputs());
        }
        this.draftLapsList.addEventListener('click', (event) => {
            const button = event.target.closest?.('button[data-lap]');
            if (!button) return;
            this.setAuthorTime(lapToAuthorTime(Number(button.dataset.lap)));
        });

        this.cornerRadiusSelect.addEventListener('change', () => {
            this.setCornerRadius(Number(this.cornerRadiusSelect.value));
        });

        this.groundSelect?.addEventListener('change', () => {
            this.setGround(this.groundSelect.value);
        });

        this.lineSmoothingInput.addEventListener('input', () => {
            const rawValue = this.lineSmoothingInput.value.trim();
            if (!rawValue) {
                return;
            }
            const value = Number(rawValue);
            this.track.lineSmoothing = Number.isFinite(value)
                ? clamp(value, MIN_LINE_SMOOTHING, MAX_LINE_SMOOTHING)
                : DEFAULT_LINE_SMOOTHING;
            this.lineSmoothingInput.value = formatNumber(this.getLineSmoothing());
            this.updateDrawMetricsLabel();
            this.updateCanvasHint();
            this.markDirty('Updated line-build smoothing.', false);
        });
        this.lineSmoothingInput.addEventListener('blur', () => {
            this.lineSmoothingInput.value = formatNumber(this.getLineSmoothing());
        });

        this.trackKeyInput.addEventListener('change', () => {
            this.renameTrackKey(this.trackKeyInput.value.trim());
        });
        this.trackKeyInput.addEventListener('blur', () => {
            this.trackKeyInput.value = this.state.selectedTrackKey;
        });

        const updateSelectedCoordinate = () => {
            const gate = this.getSelectedLaneGateRef();
            if (gate) {
                return;
            }
            const handle = this.state.selectedHandle;
            const nextX = Number(this.selectedXInput.value);
            const nextY = Number(this.selectedYInput.value);
            if (
                handle?.kind === 'startPos'
                && Number.isFinite(nextX)
                && Number.isFinite(nextY)
            ) {
                this.snapStartPoseToLine({
                    seedPoint: { x: nextX, y: nextY },
                    status: 'Updated start car (snapped perpendicular to start line).',
                });
                return;
            }
            const point = this.getSelectedPointRef();
            if (!point) {
                return;
            }
            if (Number.isFinite(nextX)) {
                point.x = nextX;
            }
            if (Number.isFinite(nextY)) {
                point.y = nextY;
            }
            this.markDirty('Updated point coordinates.');
            this.syncSelectedInputs();
        };

        this.selectedXInput.addEventListener('change', updateSelectedCoordinate);
        this.selectedYInput.addEventListener('change', updateSelectedCoordinate);

        this.checkpointSelect.addEventListener('change', () => {
            this.state.checkpointIndex = Number(this.checkpointSelect.value) || 0;
            if (this.state.tool === 'checkpoints') {
                this.state.selectedHandle = {
                    kind: 'checkpoint',
                    checkpointIndex: this.state.checkpointIndex,
                };
            }
            this.syncSelectedInputs();
            this.updateStageText();
            this.draw();
        });

        this.newTrackBtn.addEventListener('click', () => this.createTrack());
        this.duplicateTrackBtn.addEventListener('click', () => this.duplicateTrack());
        this.removeTrackBtn.addEventListener('click', () => this.removeTrack());
        this.insertPointBtn.addEventListener('click', () => this.insertPointAfterSelection());
        this.deletePointBtn.addEventListener('click', () => this.deleteSelectedPoint());
        this.reversePolygonBtn.addEventListener('click', () => this.reverseActivePolygon());
        this.copyBackupBtn.addEventListener('click', () => this.copyBackup());
        this.addCheckpointBtn.addEventListener('click', () => this.addCheckpoint());
        this.removeCheckpointBtn.addEventListener('click', () => this.removeCheckpoint());
        this.reframeBtn.addEventListener('click', () => this.resetView());
        this.undoEditBtn.addEventListener('click', () => this.undoEdit());
        this.redoEditBtn.addEventListener('click', () => this.redoEdit());
        this.driveDraftBtn.addEventListener('click', () => this.driveDraft());
        this.runBotsBtn.addEventListener('click', () => this.runBots());
        this.saveTrackBtn.addEventListener('click', () => this.saveAndIntegrateTrack());

        this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
        this.canvas.addEventListener('pointerup', () => this.onPointerUp());
        this.canvas.addEventListener('pointerleave', () => this.onPointerUp());
        this.canvas.addEventListener('click', (event) => this.onCanvasClick(event));
        this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });

        window.addEventListener('keydown', (event) => this.onKeyDown(event));
        window.addEventListener('keyup', (event) => {
            if (event.code === 'Space') {
                if (event.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
                    return;
                }
                event.preventDefault();
                this.state.isSpaceDown = false;
                this.canvas.dataset.pan = 'false';
            }
        });
        window.addEventListener('beforeunload', (event) => {
            this.flushDraftRecovery();
            if (this.skipBeforeUnload) return;
            if (this.state.dirtyTrackKeys.size === 0 && !this.state.draftLoop.length && !this.draftLoopsByKey.size) {
                return;
            }
            event.preventDefault();
            event.returnValue = '';
        });
    }

    resizeCanvas() {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.draw();
    }

    resetView() {
        this.state.view.zoom = 1;
        this.state.view.panX = 0;
        this.state.view.panY = 0;
        this.state.view.frozenBounds = null;
        this.setStatus('View reframed.');
        this.draw();
    }

    setTool(tool, selectedHandle) {
        this.state.tool = tool;
        const hasExplicitSelection = arguments.length > 1;
        if (tool === 'draw') {
            this.state.selectedHandle = null;
        } else if (hasExplicitSelection) {
            this.state.selectedHandle = selectedHandle ? { ...selectedHandle } : null;
        } else if (tool === 'checkpoints' && this.track.checkpoints.length > 0) {
            this.state.selectedHandle = {
                kind: 'checkpoint',
                checkpointIndex: this.state.checkpointIndex,
            };
        } else if (tool === 'startLine') {
            this.state.selectedHandle = { kind: 'startLine' };
        } else if (tool === 'startPos') {
            this.state.selectedHandle = { kind: 'startPos' };
        } else {
            this.state.selectedHandle = { kind: 'polygon', path: tool, index: 0 };
        }
        if (tool === 'checkpoints' && this.state.selectedHandle?.kind === 'checkpoint') {
            this.state.checkpointIndex = this.state.selectedHandle.checkpointIndex;
            this.checkpointSelect.value = String(this.state.checkpointIndex);
        }
        this.syncSelectedInputs();
        this.updateStageText();
        this.draw();
    }

    updateStageText() {
        this.stageTitle.textContent = this.track.name;
        this.stageSubtitle.textContent = `Editing ${TOOL_LABELS[this.state.tool]}`;
        this.toolButtons.forEach((button) => {
            button.dataset.active = String(button.dataset.tool === this.state.tool);
        });
        this.checkpointPanel.hidden = this.state.tool !== 'checkpoints';
        this.updateCanvasHint();
    }

    populateTrackSelect() {
        const previous = this.state.selectedTrackKey;
        this.trackSelect.innerHTML = '';
        Object.entries(this.state.tracks).forEach(([key, track]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = this.getTrackOptionText(key, track);
            this.trackSelect.appendChild(option);
        });
        this.trackSelect.value = previous;
    }

    getTrackOptionText(key, track) {
        return this.state.dirtyTrackKeys.has(key)
            ? `${track.name} • Unsaved`
            : track.name;
    }

    // The saved stage of a track: { series, stageIndex }, or null.
    getSavedStage(trackKey = this.state.selectedTrackKey) {
        const savedKey = this.state.originalTrackKeyByKey.get(trackKey);
        return savedKey ? findTrackStage(this.seriesData, savedKey) : null;
    }

    getSavedDestination(trackKey) {
        const stage = this.getSavedStage(trackKey);
        if (stage) return seriesDestination(stage.series.id);
        const originalTrackKey = this.state.originalTrackKeyByKey.get(trackKey);
        if (!originalTrackKey || SCHEDULED_TRACK_KEYS.has(originalTrackKey)) return DAILY_DESTINATION;
        return UNUSED_DESTINATION;
    }

    getDestinationForTrackKey(trackKey) {
        const saved = this.getSavedDestination(trackKey);
        const chosen = this.destinationByKey.get(trackKey);
        return chosen && parseTrackDestination(chosen, this.seriesData) ? chosen : saved;
    }

    getDestinationSeries(destination) {
        const parsed = parseTrackDestination(destination, this.seriesData);
        return parsed?.type === 'series'
            ? this.seriesData.series.find((series) => series.id === parsed.seriesId) ?? null
            : null;
    }

    getSelectedDestination() {
        const value = this.trackDestinationSelect.value;
        return parseTrackDestination(value, this.seriesData) ? value : DAILY_DESTINATION;
    }

    syncDestinationOptions(trackKey) {
        const select = this.trackDestinationSelect;
        select.replaceChildren();
        const addOption = (value, label) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        };
        addOption(DAILY_DESTINATION, 'Daily Challenge');
        for (const series of this.seriesData.series) {
            const state = isCampaignSeriesLive(series)
                ? 'live'
                : `hidden, ${series.stages.length}/${getCampaignSeriesMinStages(series)} stages`;
            addOption(seriesDestination(series.id), `Campaign · ${series.name} (${state})`);
        }
        if (this.getSavedDestination(trackKey) === UNUSED_DESTINATION) {
            addOption(UNUSED_DESTINATION, 'Not used');
        }
        const savedStage = this.getSavedStage(trackKey);
        const locked = Boolean(savedStage && isCampaignSeriesLive(savedStage.series));
        select.disabled = locked;
        select.title = locked
            ? `${savedStage.series.name} is live, so this track stays in it.`
            : '';
    }

    syncDestinationControl(trackKey = this.state.selectedTrackKey) {
        this.syncDestinationOptions(trackKey);
        this.trackDestinationSelect.value = this.getDestinationForTrackKey(trackKey);
        this.syncSeriesStageFields();
    }

    // The stage that the selected track has, or gets when it is saved.
    getPlannedStage(trackKey = this.state.selectedTrackKey) {
        const series = this.getDestinationSeries(this.getDestinationForTrackKey(trackKey));
        if (!series) return null;
        const saved = this.getSavedStage(trackKey);
        const existing = saved?.series.id === series.id ? saved : null;
        const stageIndex = existing ? existing.stageIndex : series.stages.length;
        const savedStage = existing ? series.stages[stageIndex] : null;
        const settings = this.stageSettingsByKey.get(trackKey) ?? {};
        return {
            series,
            stageIndex,
            isNew: !existing,
            fixed: Boolean(existing) && isCampaignSeriesLive(series),
            laps: settings.laps ?? savedStage?.laps ?? 1,
            requiredMedals: settings.requiredMedals ?? savedStage?.requiredMedals ?? suggestRequiredMedals(series),
        };
    }

    syncSeriesStageFields() {
        const planned = this.getPlannedStage();
        this.seriesStageFields.hidden = !planned;
        if (!planned) return;
        const { series, stageIndex, fixed } = planned;
        const stageNumber = String(stageIndex).padStart(2, '0');
        this.seriesStageLabel.textContent = `${series.name} · Stage ${stageNumber}${planned.isNew ? ' (new)' : ''}`;
        this.seriesLapsSelect.value = String(planned.laps);
        this.seriesTargetInput.value = String(planned.requiredMedals);
        this.seriesLapsSelect.disabled = fixed;
        this.seriesTargetInput.disabled = fixed || stageIndex === 0;
        const ground = getTrackGround(this.track).key;
        const groundWarning = ground !== series.ground
            ? `This track is ${TRACK_GROUNDS[ground]?.label ?? ground}, but ${series.name} is a ${TRACK_GROUNDS[series.ground]?.label ?? series.ground} series.`
            : '';
        this.seriesStageHint.hidden = !groundWarning;
        this.seriesStageHint.textContent = groundWarning;
        this.seriesStageHint.classList.toggle('series-stage-hint-warn', Boolean(groundWarning));
        this.renderSeriesStageList(series, planned);
    }

    renderSeriesStageList(series, planned) {
        const list = this.seriesStageList;
        list.replaceChildren();
        const live = isCampaignSeriesLive(series);
        const trackKeys = series.stages.map((stage) => stage.trackKey);
        if (planned.isNew) trackKeys.push(this.state.selectedTrackKey);
        const savedKey = this.state.originalTrackKeyByKey.get(this.state.selectedTrackKey);
        trackKeys.forEach((trackKey, index) => {
            const item = document.createElement('li');
            const isCurrent = trackKey === savedKey || (planned.isNew && index === trackKeys.length - 1);
            item.dataset.current = String(isCurrent);
            const number = document.createElement('span');
            number.textContent = String(index).padStart(2, '0');
            const name = document.createElement('span');
            name.textContent = this.state.tracks[trackKey]?.name ?? TRACKS[trackKey]?.name ?? trackKey;
            item.append(number, name);
            const canMove = !live && !(planned.isNew && index === trackKeys.length - 1);
            for (const [direction, label] of [[-1, 'Up'], [1, 'Down']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ghost-btn';
                button.textContent = label;
                button.dataset.trackKey = trackKey;
                button.dataset.direction = String(direction);
                const target = index + direction;
                button.disabled = !canMove || target < 0 || target >= series.stages.length;
                item.appendChild(button);
            }
            list.appendChild(item);
        });
    }

    updateStageSettings() {
        const trackKey = this.state.selectedTrackKey;
        const laps = Number(this.seriesLapsSelect.value);
        const requiredMedals = Number(this.seriesTargetInput.value);
        this.stageSettingsByKey.set(trackKey, { laps, requiredMedals });
        this.syncSeriesStageFields();
        this.markDirty(`Set the stage to ${laps} lap${laps === 1 ? '' : 's'} and a target of ${requiredMedals} medals.`);
    }

    async moveStage(trackKey, direction) {
        const series = this.getPlannedStage()?.series;
        if (!series) return;
        try {
            const response = await fetch('/__mapmaker/move-stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seriesId: series.id, trackKey, direction }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Move failed with status ${response.status}.`);
            this.seriesData = moveSeriesStage(this.seriesData, series.id, trackKey, direction);
            this.syncSeriesStageFields();
            this.setStatus(`Moved ${trackKey} ${direction < 0 ? 'up' : 'down'} in ${series.name}.`);
        } catch (error) {
            console.error(error);
            this.setStatus(`${error.message} Run Mapmaker through the local Vite server.`, true);
        }
    }

    getSavedMedalRow(trackKey = this.state.selectedTrackKey) {
        const savedKey = this.state.originalTrackKeyByKey.get(trackKey) ?? trackKey;
        return normalizeMedalRow(this.medalTimes[savedKey]);
    }

    getMedalRow(trackKey = this.state.selectedTrackKey) {
        return this.medalRowByKey.get(trackKey) ?? this.getSavedMedalRow(trackKey);
    }

    medalTimesFixed(trackKey = this.state.selectedTrackKey) {
        const stage = this.getSavedStage(trackKey);
        return Boolean(stage && isCampaignSeriesLive(stage.series) && this.getSavedMedalRow(trackKey));
    }

    syncMedalTimesPanel() {
        const trackKey = this.state.selectedTrackKey;
        const row = this.medalRowByKey.get(trackKey)
            ?? this.medalTimes[this.state.originalTrackKeyByKey.get(trackKey) ?? trackKey]
            ?? null;
        const fixed = this.medalTimesFixed(trackKey);
        for (const tier of MEDAL_TIERS) {
            const value = Number(row?.[tier]);
            this.medalInputs[tier].value = Number.isFinite(value) && value > 0 ? value.toFixed(2) : '';
            this.medalInputs[tier].disabled = fixed;
        }

        const laps = this.track ? readDraftLaps(getBrowserStorage('localStorage'), draftLapsStorageKey(trackKey, this.track)) : [];
        this.draftLapsList.replaceChildren();
        const addLapButton = (lap, label, kind) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ghost-btn';
            button.dataset.lap = String(lap);
            button.dataset.kind = kind;
            button.textContent = label;
            button.disabled = fixed;
            button.title = `Use ${lapToAuthorTime(lap).toFixed(2)} s as the author time.`;
            this.draftLapsList.appendChild(button);
        };
        laps.forEach((lap, index) => addLapButton(lap, `${index + 1}. ${lap.toFixed(3)} s`, 'lap'));
        const average = averageDraftLap(laps);
        if (average !== null) addLapButton(average, `Average ${average.toFixed(3)} s`, 'average');
        if (!laps.length) {
            const note = document.createElement('p');
            note.className = 'field-hint';
            note.textContent = 'No Drive Draft laps on this layout yet.';
            this.draftLapsList.appendChild(note);
        }

        const edited = this.medalRowByKey.has(trackKey);
        const error = row ? getMedalRowError(row) : 'Set all four medal times.';
        const bronze = Number(row?.bronze);
        const notes = [];
        if (fixed) {
            notes.push('This track is a stage of a live series, so its medal times are fixed.');
        } else if (row && error) {
            notes.push(error);
        }
        if (Number.isFinite(bronze) && bronze >= BRONZE_WARNING_SEC) {
            notes.push(`Keep a bronze lap under ${BRONZE_WARNING_SEC} s, because the server refuses very long laps.`);
        }
        this.medalTimesHint.hidden = notes.length === 0;
        this.medalTimesHint.textContent = notes.join(' ');
        this.medalTimesHint.classList.toggle(
            'medal-times-hint-warn',
            Boolean(row && error) || (Number.isFinite(bronze) && bronze >= BRONZE_WARNING_SEC),
        );
        this.medalTimesState.textContent = fixed ? 'Fixed' : !row ? 'Not set' : error ? 'Check' : edited ? 'Unsaved' : 'Set';
        this.medalTimesState.className = `pill${!row || error ? ' pill-warn' : edited ? ' pill-warn' : ' pill-ok'}`;
    }

    setAuthorTime(authorSec) {
        if (this.medalTimesFixed()) return;
        const row = suggestMedalTimes(authorSec);
        if (!row) {
            this.setStatus('The author time must be more than 0 s.', true);
            return;
        }
        this.medalRowByKey.set(this.state.selectedTrackKey, row);
        this.syncMedalTimesPanel();
        this.markDirty(`Set the author time to ${row.author.toFixed(2)} s.`);
    }

    updateMedalRowFromInputs() {
        if (this.medalTimesFixed()) return;
        const row = Object.fromEntries(MEDAL_TIERS.map((tier) => [tier, Number(this.medalInputs[tier].value)]));
        this.medalRowByKey.set(this.state.selectedTrackKey, row);
        this.syncMedalTimesPanel();
        this.markDirty('Changed the medal times.');
    }

    syncTrackSelectText() {
        const option = this.trackSelect.querySelector(`option[value="${this.state.selectedTrackKey}"]`);
        if (option) {
            option.textContent = this.getTrackOptionText(this.state.selectedTrackKey, this.track);
        }
    }

    loadTrack(trackKey) {
        if (!this.state.tracks[trackKey]) {
            return;
        }
        const originalTrackKey = this.state.originalTrackKeyByKey.get(trackKey);
        if (originalTrackKey && !this.baselineQualityCodesByKey.has(trackKey) && TRACKS[originalTrackKey]) {
            this.baselineQualityCodesByKey.set(trackKey, new Set(
                validateTrackQuality(TRACKS[originalTrackKey]).issues
                    .filter((issue) => issue.severity === 'error')
                    .map((issue) => issue.code),
            ));
            this.baselineGeometryByKey.set(trackKey, geometrySignature(TRACKS[originalTrackKey]));
        }
        if (this.state.selectedTrackKey !== trackKey) {
            this.botReport = null;
            this.botReportSignature = '';
            this.renderBotReport();
            if (this.state.draftLoop.length) {
                this.draftLoopsByKey.set(this.state.selectedTrackKey, cloneTracks(this.state.draftLoop));
            } else {
                this.draftLoopsByKey.delete(this.state.selectedTrackKey);
            }
        }
        this.commitHistoryEdit();
        this.state.selectedTrackKey = trackKey;
        this.trackSelect.value = trackKey;
        this.trackKeyInput.value = trackKey;
        this.trackNameInput.value = this.track.name;
        this.syncDestinationControl(trackKey);
        this.syncMedalTimesPanel();
        this.syncCornerRadiusControl();
        this.syncGroundControl();
        this.syncLineSmoothingControl();
        this.syncDrawWidthControls();
        this.state.draftLoop = cloneTracks(this.draftLoopsByKey.get(trackKey) ?? []);
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.state.skipDrawClick = false;
        this.state.view.frozenBounds = null;
        this.state.selectedHandle = { kind: 'polygon', path: this.state.tool === 'inner' ? 'inner' : 'outer', index: 0 };
        if (!this.hasTrackGeometry()) {
            this.state.tool = 'draw';
            this.state.selectedHandle = null;
        } else if (this.state.tool === 'startLine') {
            this.state.selectedHandle = { kind: 'startLine' };
        } else if (this.state.tool === 'startPos') {
            this.state.selectedHandle = { kind: 'startPos' };
        } else if (this.state.tool === 'checkpoints') {
            this.state.selectedHandle = this.track.checkpoints.length
                ? { kind: 'checkpoint', checkpointIndex: 0 }
                : null;
        }
        this.state.checkpointIndex = 0;
        this.refreshCheckpointSelect();
        this.syncSelectedInputs();
        this.updateStageText();
        this.updateDrawMetricsLabel();
        this.syncDirtyBadge();
        this.syncHistoryButtons();
        this.draw();
        this.scheduleQualityCheck();
        if (this.state.dirtyTrackKeys.size || this.draftLoopsByKey.size) {
            this.scheduleDraftRecovery();
        }
    }

    refreshCheckpointSelect() {
        this.checkpointSelect.innerHTML = '';
        const checkpoints = this.track.checkpoints;
        checkpoints.forEach((_, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = `Checkpoint ${index + 1}`;
            this.checkpointSelect.appendChild(option);
        });
        this.checkpointCount.textContent = `${checkpoints.length} total`;
        if (checkpoints.length === 0) {
            const option = document.createElement('option');
            option.value = '0';
            option.textContent = 'No checkpoints';
            this.checkpointSelect.appendChild(option);
            this.checkpointSelect.disabled = true;
        } else {
            this.checkpointSelect.disabled = false;
            this.state.checkpointIndex = Math.max(0, Math.min(this.state.checkpointIndex, checkpoints.length - 1));
            this.checkpointSelect.value = String(this.state.checkpointIndex);
        }
    }

    renameTrackKey(nextKey) {
        const currentKey = this.state.selectedTrackKey;
        if (!nextKey || nextKey === currentKey) {
            this.trackKeyInput.value = currentKey;
            return;
        }
        if (!isValidTrackKey(nextKey)) {
            this.trackKeyInput.value = currentKey;
            this.setStatus('Track key must be a valid non-reserved JavaScript identifier.', true);
            return;
        }
        if (this.state.tracks[nextKey]) {
            this.trackKeyInput.value = currentKey;
            this.setStatus('That track key already exists.', true);
            return;
        }

        const entries = Object.entries(this.state.tracks);
        const rebuilt = {};
        entries.forEach(([key, value]) => {
            rebuilt[key === currentKey ? nextKey : key] = value;
        });
        this.state.tracks = rebuilt;
        const history = this.editHistories.get(currentKey);
        this.editHistories.delete(currentKey);
        if (history) this.editHistories.set(nextKey, history);
        const baselineCodes = this.baselineQualityCodesByKey.get(currentKey);
        this.baselineQualityCodesByKey.delete(currentKey);
        if (baselineCodes) this.baselineQualityCodesByKey.set(nextKey, baselineCodes);
        const baselineGeometry = this.baselineGeometryByKey.get(currentKey);
        this.baselineGeometryByKey.delete(currentKey);
        if (baselineGeometry) this.baselineGeometryByKey.set(nextKey, baselineGeometry);
        const draftLoop = this.draftLoopsByKey.get(currentKey);
        this.draftLoopsByKey.delete(currentKey);
        if (draftLoop) this.draftLoopsByKey.set(nextKey, draftLoop);
        const guide = this.autoRoadGuideByKey.get(currentKey);
        this.autoRoadGuideByKey.delete(currentKey);
        if (guide) this.autoRoadGuideByKey.set(nextKey, guide);
        const destination = this.getDestinationForTrackKey(currentKey);
        this.destinationByKey.delete(currentKey);
        this.destinationByKey.set(nextKey, destination);
        for (const byKey of [this.stageSettingsByKey, this.medalRowByKey]) {
            const value = byKey.get(currentKey);
            byKey.delete(currentKey);
            if (value) byKey.set(nextKey, value);
        }
        const originalTrackKey = this.state.originalTrackKeyByKey.get(currentKey) ?? null;
        this.state.originalTrackKeyByKey.delete(currentKey);
        if (originalTrackKey) {
            this.state.originalTrackKeyByKey.set(nextKey, originalTrackKey);
        }
        this.state.dirtyTrackKeys.delete(currentKey);
        this.state.dirtyTrackKeys.add(nextKey);
        this.state.selectedTrackKey = nextKey;
        this.populateTrackSelect();
        this.trackSelect.value = nextKey;
        this.trackKeyInput.value = nextKey;
        this.markDirty(
            `Renamed track key to ${nextKey}. Save & Integrate will replace the old definition and integration entries.`
        );
    }

    createTrack() {
        const rawKey = window.prompt('New track key', 'newCircuit');
        if (!rawKey) {
            return;
        }
        const key = rawKey.trim();
        if (!isValidTrackKey(key)) {
            this.setStatus('Track key must be a valid non-reserved JavaScript identifier.', true);
            return;
        }
        if (this.state.tracks[key]) {
            this.setStatus('That track key already exists.', true);
            return;
        }
        const name = (window.prompt('Track display name', 'New Circuit') || 'New Circuit').trim() || 'New Circuit';
        this.state.tracks[key] = createBlankTrack(name);
        this.populateTrackSelect();
        this.loadTrack(key);
        this.markDirty(`Created blank track ${name}.`);
    }

    duplicateTrack() {
        const sourceKey = this.state.selectedTrackKey;
        const rawKey = window.prompt('Clone track key', `${sourceKey}Copy`);
        if (!rawKey) {
            return;
        }
        const key = rawKey.trim();
        if (!isValidTrackKey(key)) {
            this.setStatus('Track key must be a valid non-reserved JavaScript identifier.', true);
            return;
        }
        if (this.state.tracks[key]) {
            this.setStatus('That track key already exists.', true);
            return;
        }

        const copy = cloneTracks(this.track);
        const name = (window.prompt('Clone display name', `${copy.name} Copy`) || `${copy.name} Copy`).trim() || `${copy.name} Copy`;
        copy.name = name;
        this.state.tracks[key] = copy;
        this.populateTrackSelect();
        this.loadTrack(key);
        this.markDirty(`Cloned ${sourceKey} into ${key}.`);
    }

    confirmTrackRemoval(message) {
        this.removeTrackDialogMessage.textContent = message;
        this.removeTrackDialog.returnValue = '';
        this.removeTrackDialog.showModal();
        return new Promise((resolve) => {
            this.removeTrackDialog.addEventListener('close', () => {
                resolve(this.removeTrackDialog.returnValue === 'remove');
            }, { once: true });
        });
    }

    async removeTrack() {
        const selectedKey = this.state.selectedTrackKey;
        const originalKey = this.state.originalTrackKeyByKey.get(selectedKey) ?? null;
        const trackName = this.track.name;
        const warning = originalKey
            ? `Permanently remove ${trackName} (${originalKey}) from the game? This deletes its definition, catalog entry, Daily schedule entry, and medal times. Published Daily races and Head-to-Head posts using it may stop working. Unsaved edits will also be lost.`
            : `Discard unsaved track ${trackName} (${selectedKey})?`;
        try {
            if (!await this.confirmTrackRemoval(warning)) return;
        } catch (error) {
            this.setStatus(`Unable to open the removal confirmation: ${error.message}`, true);
            return;
        }

        this.removeTrackBtn.disabled = true;
        this.saveTrackBtn.disabled = true;
        try {
            if (originalKey) {
                const response = await fetch('/__mapmaker/remove-track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trackKey: originalKey }),
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(result.error || `Removal failed with status ${response.status}.`);
                }
                SCHEDULED_TRACK_KEYS.delete(originalKey);
            }

            const keys = Object.keys(this.state.tracks);
            const selectedIndex = keys.indexOf(selectedKey);
            const nextKey = keys[selectedIndex + 1] || keys[selectedIndex - 1];
            delete this.state.tracks[selectedKey];
            this.editHistories.delete(selectedKey);
            this.draftLoopsByKey.delete(selectedKey);
            this.destinationByKey.delete(selectedKey);
            this.stageSettingsByKey.delete(selectedKey);
            this.medalRowByKey.delete(selectedKey);
            this.baselineQualityCodesByKey.delete(selectedKey);
            this.baselineGeometryByKey.delete(selectedKey);
            this.autoRoadGuideByKey.delete(selectedKey);
            this.state.originalTrackKeyByKey.delete(selectedKey);
            this.state.dirtyTrackKeys.delete(selectedKey);
            this.state.selectedTrackKey = nextKey;
            this.populateTrackSelect();
            this.loadTrack(nextKey);
            this.setStatus(originalKey
                ? `Removed ${trackName} (${originalKey}) from the repository. Review track-specific references and registry integrity tests before shipping.`
                : `Discarded unsaved track ${trackName}.`);
            this.scheduleDraftRecovery();
        } catch (error) {
            console.error(error);
            this.setStatus(error.message, true);
        } finally {
            this.removeTrackBtn.disabled = false;
            this.saveTrackBtn.disabled = false;
        }
    }

    getSelectedPointRef() {
        const handle = this.state.selectedHandle;
        if (!handle) {
            return null;
        }
        if (handle.kind === 'polygon') {
            return this.track[handle.path][handle.index] || null;
        }
        if (handle.kind === 'startPos') {
            return this.track.startPos;
        }
        return null;
    }

    getSelectedLaneGateRef() {
        const handle = this.state.selectedHandle;
        if (!handle) {
            return null;
        }
        if (handle.kind === 'startLine') {
            return this.track.startLine;
        }
        if (handle.kind === 'checkpoint') {
            return this.track.checkpoints[handle.checkpointIndex] || null;
        }
        return null;
    }

    getLaneGateMidpoint(gate) {
        if (!gate?.p1 || !gate?.p2) {
            return null;
        }
        return {
            x: (gate.p1.x + gate.p2.x) / 2,
            y: (gate.p1.y + gate.p2.y) / 2,
        };
    }

    snapSelectedLaneGate(seedPoint, options = {}) {
        if (!this.hasTrackGeometry()) {
            return false;
        }
        const gate = this.getSelectedLaneGateRef();
        if (!gate) {
            return false;
        }
        const previousMidpoint = {
            x: (gate.p1.x + gate.p2.x) / 2,
            y: (gate.p1.y + gate.p2.y) / 2,
        };
        const snapped = buildPerpendicularLaneGate(
            seedPoint,
            this.track.outer,
            this.track.inner,
            { previousMidpoint },
        );
        if (!snapped) {
            return false;
        }
        if (this.state.selectedHandle?.kind === 'checkpoint') {
            const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
            if (guide) guide.manualGates = true;
        }
        gate.p1.x = snapped.p1.x;
        gate.p1.y = snapped.p1.y;
        gate.p2.x = snapped.p2.x;
        gate.p2.y = snapped.p2.y;
        if (this.state.selectedHandle?.kind === 'startLine') {
            this.snapStartPoseToLine({
                seedPoint: this.track.startPos,
                markDirty: false,
            });
        }
        this.syncSelectedInputs();
        if (options.markDirty !== false) {
            const label = this.state.selectedHandle?.kind === 'checkpoint'
                ? 'Snapped checkpoint across the lane.'
                : 'Snapped start line across the lane.';
            this.markDirty(options.status ?? label, options.updateStatus !== false);
        }
        return true;
    }

    snapStartPoseToLine(options = {}) {
        if (!this.hasTrackGeometry()) {
            return false;
        }
        const seedPoint = options.seedPoint || this.track.startPos;
        const snapped = snapStartPose(seedPoint, this.track.startLine, {
            preferredAngle: this.track.startAngle,
        });
        if (!snapped) {
            return false;
        }
        this.track.startPos.x = snapped.startPos.x;
        this.track.startPos.y = snapped.startPos.y;
        this.track.startAngle = snapped.startAngle;
        this.reflowAutoCheckpoints();
        this.syncSelectedInputs();
        if (options.markDirty !== false) {
            this.markDirty(
                options.status ?? 'Snapped start car perpendicular to the start line.',
                options.updateStatus !== false,
            );
        } else {
            this.draw();
        }
        return true;
    }

    reflowAutoCheckpoints() {
        const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
        if (!guide || guide.manualGates) return;
        if (guide.wallSignature !== JSON.stringify([this.track.outer, this.track.inner])) return;
        const startMid = midpoint(this.track.startLine.p1, this.track.startLine.p2);
        const nearest = nearestDistanceAlongLoop(guide.centerline, startMid);
        if (!nearest) return;
        const heading = { x: Math.cos(this.track.startAngle), y: Math.sin(this.track.startAngle) };
        const direction = heading.x * nearest.tangent.x + heading.y * nearest.tangent.y < 0 ? -1 : 1;
        const generated = buildAutoGates(
            guide.centerline,
            this.track.outer,
            this.track.inner,
            this.getDrawWidth(),
            { startDistance: nearest.distance, direction, cornerRadius: this.getCornerRadius() },
        );
        if (!generated) return;
        this.track.checkpoints = generated.checkpoints;
        this.refreshCheckpointSelect();
    }

    syncSelectedInputs() {
        const gate = this.getSelectedLaneGateRef();
        const point = this.getSelectedPointRef();
        const handle = this.state.selectedHandle;
        const hasPoint = Boolean(point) && !gate;
        this.selectedXInput.disabled = !hasPoint;
        this.selectedYInput.disabled = !hasPoint;
        if (hasPoint) {
            this.selectedXInput.value = formatNumber(point.x);
            this.selectedYInput.value = formatNumber(point.y);
        } else {
            this.selectedXInput.value = '';
            this.selectedYInput.value = '';
        }

        if (!handle) {
            this.selectionLabel.textContent = 'No point selected.';
            return;
        }

        if (handle.kind === 'polygon') {
            this.selectionLabel.textContent = `${handle.path} point ${handle.index + 1}`;
        } else if (handle.kind === 'startLine') {
            this.selectionLabel.textContent = 'start line (drag line to move)';
        } else if (handle.kind === 'startPos') {
            this.selectionLabel.textContent = 'start position';
        } else if (handle.kind === 'checkpoint') {
            this.selectionLabel.textContent = `checkpoint ${handle.checkpointIndex + 1} (drag line to move)`;
        }
    }

    hasTrackGeometry() {
        return this.track.outer.length >= 3 && this.track.inner.length >= 3;
    }

    updateCanvasHint() {
        if (!this.canvasHint) {
            return;
        }
        if (this.state.tool === 'draw') {
            const pointCount = this.state.draftLoop.length;
            if (pointCount === 0) {
                this.canvasHint.textContent = 'Click to start drawing the road.';
                return;
            }
            if (pointCount < 3) {
                this.canvasHint.textContent = `Click to keep drawing. Place ${3 - pointCount} more point${pointCount === 2 ? '' : 's'} before you can close the loop.`;
            } else if (this.state.draftCloseHover) {
                this.canvasHint.textContent = 'This is the closed road. Click the first point to build it.';
            } else {
                this.canvasHint.textContent = 'Click to add another point. The road stays open until you click the first point.';
            }
            return;
        }
        if (!this.hasTrackGeometry()) {
            this.canvasHint.textContent = 'This track has no walls yet. Switch to Line Build and close the loop first.';
            return;
        }
        if (this.state.tool === 'startPos') {
            this.canvasHint.textContent = 'Drag the start car. It stays centered on the start line and always faces perpendicular to it.';
            return;
        }
        if (this.state.tool === 'startLine' || this.state.tool === 'checkpoints') {
            this.canvasHint.textContent = 'Drag the line to slide it along the track. End dots show length only — dragging them still moves the whole gate.';
            return;
        }
        this.canvasHint.textContent = 'Click the track to select, then drag to edit or use the sidebar for precise values.';
    }

    validateTrack(track) {
        const report = validateTrackQuality(track);
        const baseline = this.baselineQualityCodesByKey.get(this.state.selectedTrackKey) ?? new Set();
        const geometryUnchanged = geometrySignature(track) === this.baselineGeometryByKey.get(this.state.selectedTrackKey);
        const blocking = report.issues.find((issue) => (
            issue.severity === 'error' && (!geometryUnchanged || !baseline.has(issue.code))
        ));
        this.refreshQualityCheck();
        return blocking?.message.replace(/\.$/, '') ?? null;
    }

    getTrackBounds() {
        if (this.state.view.frozenBounds) {
            return this.state.view.frozenBounds;
        }
        return this.computeTrackBounds();
    }

    computeTrackBounds() {
        if (this.state.tool === 'draw' && !this.hasTrackGeometry()) {
            return BLANK_VIEW_BOUNDS;
        }

        const points = [];
        if (this.hasTrackGeometry()) {
            points.push(
                ...this.track.outer,
                ...this.track.inner,
                this.track.startLine.p1,
                this.track.startLine.p2,
                this.track.startPos,
                ...this.track.checkpoints.flatMap((checkpoint) => [checkpoint.p1, checkpoint.p2])
            );
        }
        if (this.state.draftLoop.length) {
            points.push(...this.state.draftLoop);
        }

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        points.forEach((point) => {
            minX = Math.min(minX, point.x);
            maxX = Math.max(maxX, point.x);
            minY = Math.min(minY, point.y);
            maxY = Math.max(maxY, point.y);
        });

        if (!Number.isFinite(minX)) {
            return { minX: -24, maxX: 24, minY: -16, maxY: 16 };
        }
        return {
            minX,
            maxX,
            minY,
            maxY
        };
    }

    freezeViewBounds() {
        if (this.state.view.frozenBounds) {
            return;
        }
        const bounds = this.computeTrackBounds();
        this.state.view.frozenBounds = {
            minX: bounds.minX,
            maxX: bounds.maxX,
            minY: bounds.minY,
            maxY: bounds.maxY
        };
    }

    releaseViewBounds({ keepCameraSteady = true } = {}) {
        if (!this.state.view.frozenBounds) {
            return;
        }

        if (keepCameraSteady) {
            const before = this.getViewport();
            const focusScreen = { x: before.width / 2, y: before.height / 2 };
            const focusWorld = this.screenToWorld(focusScreen.x, focusScreen.y, before);
            this.state.view.frozenBounds = null;
            const after = this.getViewport();
            const focusScreenAfter = this.worldToScreen(focusWorld, after);
            this.state.view.panX += focusScreen.x - focusScreenAfter.x;
            this.state.view.panY += focusScreen.y - focusScreenAfter.y;
            return;
        }

        this.state.view.frozenBounds = null;
    }

    getViewport() {
        const ratio = window.devicePixelRatio || 1;
        const width = this.canvas.width / ratio;
        const height = this.canvas.height / ratio;
        const bounds = this.getTrackBounds();
        const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
        const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
        const padding = 70;
        const fitScale = Math.min(
            (width - padding * 2) / contentWidth,
            (height - padding * 2) / contentHeight
        );
        const scale = Math.max(8, fitScale) * this.state.view.zoom;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        return {
            width,
            height,
            scale,
            offsetX: width / 2 - centerX * scale + this.state.view.panX,
            offsetY: height / 2 - centerY * scale + this.state.view.panY
        };
    }

    worldToScreen(point, viewport = this.getViewport()) {
        return {
            x: point.x * viewport.scale + viewport.offsetX,
            y: point.y * viewport.scale + viewport.offsetY
        };
    }

    screenToWorld(x, y, viewport = this.getViewport()) {
        return {
            x: (x - viewport.offsetX) / viewport.scale,
            y: (y - viewport.offsetY) / viewport.scale
        };
    }

    setZoom(nextZoom, anchorCanvasPoint = null, viewport = this.getViewport()) {
        const clampedZoom = Math.min(6, Math.max(0.35, nextZoom));
        if (Math.abs(clampedZoom - this.state.view.zoom) < 0.000001) {
            return;
        }

        const anchorWorldPoint = anchorCanvasPoint
            ? this.screenToWorld(anchorCanvasPoint.x, anchorCanvasPoint.y, viewport)
            : null;

        this.state.view.zoom = clampedZoom;

        if (anchorWorldPoint && anchorCanvasPoint) {
            const anchoredViewport = this.getViewport();
            const anchoredScreenPoint = this.worldToScreen(anchorWorldPoint, anchoredViewport);
            this.state.view.panX += anchorCanvasPoint.x - anchoredScreenPoint.x;
            this.state.view.panY += anchorCanvasPoint.y - anchoredScreenPoint.y;
        }

        this.draw();
    }

    getToolForHandle(handle) {
        if (!handle) {
            return null;
        }
        if (handle.kind === 'polygon') {
            return handle.path;
        }
        if (handle.kind === 'checkpoint') {
            return 'checkpoints';
        }
        if (handle.kind === 'startLine') {
            return 'startLine';
        }
        if (handle.kind === 'startPos') {
            return 'startPos';
        }
        return null;
    }

    getHandlesForTool(tool) {
        if (tool === 'outer' || tool === 'inner') {
            return this.track[tool].map((point, index) => ({
                kind: 'polygon',
                path: tool,
                index,
                point
            }));
        }
        if (!this.hasTrackGeometry()) {
            return [];
        }
        if (tool === 'startLine') {
            return [
                { kind: 'startLine', endpoint: 'p1', point: this.track.startLine.p1 },
                { kind: 'startLine', endpoint: 'p2', point: this.track.startLine.p2 },
            ];
        }
        if (tool === 'startPos') {
            return [{ kind: 'startPos', point: this.track.startPos }];
        }
        if (tool === 'checkpoints') {
            return this.track.checkpoints.flatMap((checkpoint, checkpointIndex) => ([
                { kind: 'checkpoint', checkpointIndex, endpoint: 'p1', point: checkpoint.p1 },
                { kind: 'checkpoint', checkpointIndex, endpoint: 'p2', point: checkpoint.p2 },
            ]));
        }
        return [];
    }

    getAllHandles() {
        return EDITOR_TOOLS.flatMap((tool) => this.getHandlesForTool(tool));
    }

    getSelectableSegments() {
        if (!this.hasTrackGeometry()) {
            return [];
        }
        const segments = [];

        ['outer', 'inner'].forEach((path) => {
            const polygon = this.track[path];
            for (let index = 0; index < polygon.length; index += 1) {
                segments.push({
                    kind: 'polygonSegment',
                    path,
                    index,
                    a: polygon[index],
                    b: polygon[(index + 1) % polygon.length]
                });
            }
        });

        segments.push({
            kind: 'startLineSegment',
            a: this.track.startLine.p1,
            b: this.track.startLine.p2
        });

        this.track.checkpoints.forEach((checkpoint, checkpointIndex) => {
            segments.push({
                kind: 'checkpointSegment',
                checkpointIndex,
                a: checkpoint.p1,
                b: checkpoint.p2
            });
        });

        return segments;
    }

    handleMatches(a, b) {
        if (!a || !b || a.kind !== b.kind) {
            return false;
        }
        if (a.kind === 'polygon') {
            return a.path === b.path && a.index === b.index;
        }
        if (a.kind === 'startLine') {
            return true;
        }
        if (a.kind === 'startPos') {
            return true;
        }
        return a.checkpointIndex === b.checkpointIndex;
    }

    getCanvasPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };
    }

    hitTest(canvasPoint, viewport = this.getViewport(), handles = this.getAllHandles()) {
        let best = null;
        const hitRadius = 12;
        handles.forEach((handle) => {
            const screen = this.worldToScreen(handle.point, viewport);
            const dist = Math.hypot(screen.x - canvasPoint.x, screen.y - canvasPoint.y);
            if (dist > hitRadius) {
                return;
            }

            const selectionPriority = this.handleMatches(this.state.selectedHandle, handle) ? 2 : 0;
            const toolPriority = this.getToolForHandle(handle) === this.state.tool ? 1 : 0;
            const priority = selectionPriority + toolPriority;

            if (
                !best
                || priority > best.priority
                || (priority === best.priority && dist < best.distance)
            ) {
                best = { handle, distance: dist, priority };
            }
        });
        return best ? best.handle : null;
    }

    hitTestSegment(canvasPoint, viewport = this.getViewport()) {
        const hitRadius = 12;
        let best = null;

        this.getSelectableSegments().forEach((segment) => {
            const start = this.worldToScreen(segment.a, viewport);
            const end = this.worldToScreen(segment.b, viewport);
            const match = distanceToSegment(canvasPoint, start, end);
            const radius = (
                segment.kind === 'startLineSegment'
                || segment.kind === 'checkpointSegment'
            )
                ? 14
                : hitRadius;
            if (match.distance <= radius && (!best || match.distance < best.distance)) {
                best = { segment, distance: match.distance };
            }
        });

        return best ? best.segment : null;
    }

    selectHandle(handle) {
        const tool = this.getToolForHandle(handle);
        if (!tool) {
            return;
        }
        if (handle.kind === 'checkpoint') {
            this.state.checkpointIndex = handle.checkpointIndex;
        }
        this.setTool(tool, handle);
    }

    selectSegment(segment, canvasPoint, viewport) {
        if (!segment) {
            return false;
        }

        const start = this.worldToScreen(segment.a, viewport);
        const end = this.worldToScreen(segment.b, viewport);
        const nearestEndpoint = distance(canvasPoint, start) <= distance(canvasPoint, end) ? 'p1' : 'p2';

        if (segment.kind === 'polygonSegment') {
            const nextIndex = (segment.index + 1) % this.track[segment.path].length;
            const index = nearestEndpoint === 'p1' ? segment.index : nextIndex;
            this.selectHandle({ kind: 'polygon', path: segment.path, index });
            return true;
        }

        if (segment.kind === 'startLineSegment') {
            this.selectHandle({ kind: 'startLine' });
            return true;
        }

        if (segment.kind === 'checkpointSegment') {
            this.selectHandle({
                kind: 'checkpoint',
                checkpointIndex: segment.checkpointIndex,
            });
            return true;
        }

        return false;
    }

    getDraftCloseHandle(canvasPoint, viewport = this.getViewport()) {
        if (this.state.draftLoop.length < 3) {
            return null;
        }
        const startPoint = this.state.draftLoop[0];
        const screenPoint = this.worldToScreen(startPoint, viewport);
        return distance(canvasPoint, screenPoint) <= 18 ? startPoint : null;
    }

    addDraftLoopPoint(point) {
        const lastPoint = this.state.draftLoop[this.state.draftLoop.length - 1];
        if (lastPoint && distance(lastPoint, point) < 0.35) {
            return;
        }
        this.state.draftLoop = [...this.state.draftLoop, clonePoint(point)];
        this.state.draftCursor = clonePoint(point);
        this.state.draftCloseHover = false;
        this.syncHistoryButtons();
        this.scheduleDraftRecovery();
        this.updateDrawMetricsLabel();
        this.updateCanvasHint();
        this.draw();
    }

    undoDraftLoopPoint() {
        if (!this.state.draftLoop.length) {
            return;
        }
        this.state.draftLoop = this.state.draftLoop.slice(0, -1);
        this.state.draftCursor = this.state.draftLoop.length
            ? clonePoint(this.state.draftLoop[this.state.draftLoop.length - 1])
            : null;
        this.state.draftCloseHover = false;
        this.syncHistoryButtons();
        this.scheduleDraftRecovery();
        this.setStatus(this.state.draftLoop.length ? 'Removed last draft point.' : 'Cleared draft loop.');
        this.updateDrawMetricsLabel();
        this.updateCanvasHint();
        this.draw();
    }

    clearDraftLoop() {
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.syncHistoryButtons();
        this.scheduleDraftRecovery();
        this.setStatus('Cleared draft loop.');
        this.updateDrawMetricsLabel();
        this.updateCanvasHint();
        this.draw();
    }

    commitDraftLoop(points) {
        const width = this.getDrawWidth();
        const lineSmoothing = this.getLineSmoothing();
        const cornerRadius = this.getCornerRadius();
        const generated = buildTrackFromLoop(points, width, lineSmoothing, cornerRadius);
        if (!generated) {
            this.setStatus('Draft loop is not usable yet. Add cleaner spacing and close it again.', true);
            this.draw();
            return false;
        }

        // Hold the drawn road at the same screen scale and location when walls appear.
        const draftViewport = this.getViewport();
        const draftBounds = this.getTrackBounds();
        this.state.view.frozenBounds = { ...draftBounds };
        this.state.view.panX -= generated.normalizationOffset.x * draftViewport.scale;
        this.state.view.panY -= generated.normalizationOffset.y * draftViewport.scale;

        this.track.outer = generated.outer;
        this.track.inner = generated.inner;
        this.track.startLine = generated.startLine;
        this.track.startPos = generated.startPos;
        this.track.startAngle = generated.startAngle;
        this.track.checkpoints = generated.checkpoints;
        this.track.cornerRadius = generated.cornerRadius;
        this.track.lineSmoothing = lineSmoothing;
        this.autoRoadGuideByKey.set(this.state.selectedTrackKey, {
            centerline: generated.centerline,
            wallSignature: JSON.stringify([generated.outer, generated.inner]),
            manualGates: false,
        });
        this.syncCornerRadiusControl();
        this.syncLineSmoothingControl();
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.draftLoopsByKey.delete(this.state.selectedTrackKey);
        this.state.checkpointIndex = 0;
        this.refreshCheckpointSelect();
        this.updateDrawMetricsLabel();
        this.setTool('outer', { kind: 'polygon', path: 'outer', index: 0 });
        this.markDirty('Built walls from closed line loop.');
        return true;
    }

    onPointerDown(event) {
        const viewport = this.getViewport();
        const canvasPoint = this.getCanvasPoint(event);

        if (event.button === 1 || this.state.isSpaceDown) {
            this.canvas.setPointerCapture(event.pointerId);
            this.state.drag = {
                type: 'pan',
                startX: canvasPoint.x,
                startY: canvasPoint.y,
                panX: this.state.view.panX,
                panY: this.state.view.panY
            };
            this.state.skipDrawClick = true;
            this.canvas.dataset.pan = 'true';
            return;
        }

        if (this.state.tool === 'draw') {
            if (event.button === 2) {
                this.undoDraftLoopPoint();
                return;
            }
            if (event.button !== 0) {
                return;
            }
            return;
        }

        this.canvas.setPointerCapture(event.pointerId);

        const hit = this.hitTest(canvasPoint, viewport);
        if (hit) {
            this.beginHistoryEdit();
            this.selectHandle(hit);
            this.freezeViewBounds();
            this.state.drag = {
                type: 'handle',
                handle: this.state.selectedHandle
            };
            this.draw();
            return;
        }

        const segmentHit = this.hitTestSegment(canvasPoint, viewport);
        if (segmentHit) {
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            if (event.shiftKey && segmentHit.kind === 'polygonSegment') {
                this.insertPointOnSegment(segmentHit.path, segmentHit.index, worldPoint);
                return;
            }
            this.selectSegment(segmentHit, canvasPoint, viewport);
            if (
                segmentHit.kind === 'startLineSegment'
                || segmentHit.kind === 'checkpointSegment'
            ) {
                this.beginHistoryEdit();
                this.freezeViewBounds();
                this.state.drag = {
                    type: 'laneGate',
                    handle: this.state.selectedHandle,
                };
                this.snapSelectedLaneGate(worldPoint, {
                    status: segmentHit.kind === 'checkpointSegment'
                        ? 'Moved checkpoint (snapped perpendicular to walls).'
                        : 'Moved start line (snapped perpendicular to walls).',
                    updateStatus: false,
                });
            }
            this.draw();
            return;
        }

        if ((this.state.tool === 'outer' || this.state.tool === 'inner') && event.shiftKey) {
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            this.insertPointNear(worldPoint);
            return;
        }

        if (this.state.tool === 'startPos') {
            this.beginHistoryEdit();
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            this.state.selectedHandle = { kind: 'startPos' };
            this.snapStartPoseToLine({
                seedPoint: worldPoint,
                status: 'Moved start car (snapped perpendicular to start line).',
            });
            return;
        }

        this.state.selectedHandle = null;
        this.syncSelectedInputs();
        this.draw();
    }

    onPointerMove(event) {
        const viewport = this.getViewport();
        const canvasPoint = this.getCanvasPoint(event);
        const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);

        if (this.state.drag?.type === 'pan') {
            this.state.view.panX = this.state.drag.panX + (canvasPoint.x - this.state.drag.startX);
            this.state.view.panY = this.state.drag.panY + (canvasPoint.y - this.state.drag.startY);
            this.draw();
            return;
        }

        if (this.state.tool === 'draw') {
            this.state.draftCursor = worldPoint;
            this.state.draftCloseHover = Boolean(this.getDraftCloseHandle(canvasPoint, viewport));
            this.updateCanvasHint();
            this.draw();
            return;
        }

        if (this.state.drag?.type === 'handle') {
            const handle = this.state.drag.handle;
            if (handle?.kind === 'startLine' || handle?.kind === 'checkpoint') {
                this.snapSelectedLaneGate(worldPoint, {
                    status: handle.kind === 'checkpoint'
                        ? 'Moved checkpoint (snapped perpendicular to walls).'
                        : 'Moved start line (snapped perpendicular to walls).',
                    updateStatus: false,
                });
                this.draw();
                return;
            }
            if (handle?.kind === 'startPos') {
                this.snapStartPoseToLine({
                    seedPoint: worldPoint,
                    status: 'Moved start car (snapped perpendicular to start line).',
                    updateStatus: false,
                });
                return;
            }
            const point = this.getSelectedPointRef();
            if (point) {
                point.x = worldPoint.x;
                point.y = worldPoint.y;
                this.syncSelectedInputs();
                this.markDirty('Moved point.', false);
                this.draw();
            }
            return;
        }

        if (this.state.drag?.type === 'laneGate') {
            const handle = this.state.drag.handle;
            this.state.selectedHandle = handle;
            this.snapSelectedLaneGate(worldPoint, {
                status: handle?.kind === 'checkpoint'
                    ? 'Moved checkpoint (snapped perpendicular to walls).'
                    : 'Moved start line (snapped perpendicular to walls).',
                updateStatus: false,
            });
            this.draw();
            return;
        }

        this.state.hoverHandle = this.hitTest(canvasPoint, viewport);
        const segmentHover = this.hitTestSegment(canvasPoint, viewport);
        this.state.hoverSegment = (
            segmentHover?.kind === 'startLineSegment'
            || segmentHover?.kind === 'checkpointSegment'
        )
            ? segmentHover
            : null;
        this.draw();
    }

    onCanvasClick(event) {
        if (this.state.tool !== 'draw') {
            return;
        }
        if (this.state.skipDrawClick) {
            this.state.skipDrawClick = false;
            return;
        }
        const viewport = this.getViewport();
        const canvasPoint = this.getCanvasPoint(event);
        const closeHandle = this.getDraftCloseHandle(canvasPoint, viewport);
        if (closeHandle) {
            this.commitDraftLoop(this.state.draftLoop);
            return;
        }
        const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
        this.addDraftLoopPoint(worldPoint);
    }

    onPointerUp() {
        if (this.state.drag?.type !== 'pan') {
            this.state.skipDrawClick = false;
        }
        if (this.state.drag?.type === 'handle' || this.state.drag?.type === 'laneGate') {
            this.releaseViewBounds({ keepCameraSteady: true });
        }
        this.commitHistoryEdit();
        this.state.drag = null;
        this.canvas.dataset.pan = 'false';
        this.draw();
    }

    onWheel(event) {
        event.preventDefault();
        const viewport = this.getViewport();
        const canvasPoint = this.getCanvasPoint(event);
        const deltaModeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                ? 120
                : 1;

        // Trackpad pinch arrives as ctrl+wheel.
        if (event.ctrlKey) {
            const zoomFactor = Math.exp((-event.deltaY * deltaModeScale) * 0.01);
            this.setZoom(this.state.view.zoom * zoomFactor, canvasPoint, viewport);
            return;
        }

        // Pixel deltas mean a trackpad pan.
        if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
            this.state.view.panX -= event.deltaX * deltaModeScale;
            this.state.view.panY -= event.deltaY * deltaModeScale;
            this.draw();
            return;
        }

        const nextZoom = event.deltaY < 0 ? this.state.view.zoom * 1.1 : this.state.view.zoom / 1.1;
        this.setZoom(nextZoom, canvasPoint, viewport);
    }

    onKeyDown(event) {
        if (event.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) this.redoEdit();
            else this.undoEdit();
            return;
        }

        if (event.code === 'Space') {
            event.preventDefault();
            this.state.isSpaceDown = true;
            this.canvas.dataset.pan = 'true';
            return;
        }

        if (this.state.tool === 'draw') {
            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                this.undoDraftLoopPoint();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.clearDraftLoop();
            }
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            this.deleteSelectedPoint();
            return;
        }

        const gate = this.getSelectedLaneGateRef();
        const point = this.getSelectedPointRef();
        if (!gate && !point) {
            return;
        }

        const step = event.shiftKey ? 1 : 0.25;
        let moved = false;
        const origin = gate
            ? this.getLaneGateMidpoint(gate)
            : { x: point.x, y: point.y };
        if (!origin) {
            return;
        }
        let nextX = origin.x;
        let nextY = origin.y;
        if (event.key === 'ArrowLeft') {
            nextX -= step;
            moved = true;
        } else if (event.key === 'ArrowRight') {
            nextX += step;
            moved = true;
        } else if (event.key === 'ArrowUp') {
            nextY -= step;
            moved = true;
        } else if (event.key === 'ArrowDown') {
            nextY += step;
            moved = true;
        }

        if (moved) {
            event.preventDefault();
            const handle = this.state.selectedHandle;
            if (gate && (handle?.kind === 'startLine' || handle?.kind === 'checkpoint')) {
                this.snapSelectedLaneGate({ x: nextX, y: nextY }, {
                    status: handle.kind === 'checkpoint'
                        ? 'Nudged checkpoint (snapped perpendicular to walls).'
                        : 'Nudged start line (snapped perpendicular to walls).',
                });
                return;
            }
            if (handle?.kind === 'startPos') {
                this.snapStartPoseToLine({
                    seedPoint: { x: nextX, y: nextY },
                    status: 'Nudged start car (snapped perpendicular to start line).',
                });
                return;
            }
            point.x = nextX;
            point.y = nextY;
            this.syncSelectedInputs();
            this.markDirty('Nudged selected point.');
        }
    }

    insertPointNear(worldPoint) {
        const path = this.state.tool;
        const polygon = this.track[path];
        if (!polygon || polygon.length < 2) {
            return;
        }

        let bestIndex = 0;
        let bestDistance = Infinity;
        let bestPoint = worldPoint;

        for (let index = 0; index < polygon.length; index++) {
            const nextIndex = (index + 1) % polygon.length;
            const match = distanceToSegment(worldPoint, polygon[index], polygon[nextIndex]);
            if (match.distance < bestDistance) {
                bestDistance = match.distance;
                bestIndex = index;
                bestPoint = match.closest;
            }
        }

        polygon.splice(bestIndex + 1, 0, bestPoint);
        this.state.selectedHandle = {
            kind: 'polygon',
            path,
            index: bestIndex + 1
        };
        this.syncSelectedInputs();
        this.markDirty(`Inserted ${path} point.`);
    }

    insertPointOnSegment(path, index, worldPoint) {
        const polygon = this.track[path];
        if (!polygon || polygon.length < 2) {
            return;
        }

        const nextIndex = (index + 1) % polygon.length;
        const point = distanceToSegment(worldPoint, polygon[index], polygon[nextIndex]).closest;
        polygon.splice(index + 1, 0, point);
        this.setTool(path, {
            kind: 'polygon',
            path,
            index: index + 1
        });
        this.markDirty(`Inserted ${path} point.`);
    }

    insertPointAfterSelection() {
        if (this.state.tool !== 'outer' && this.state.tool !== 'inner') {
            this.setStatus('Point insertion is only available for wall polygons.', true);
            return;
        }

        const handle = this.state.selectedHandle;
        const polygon = this.track[this.state.tool];
        if (!handle || handle.kind !== 'polygon') {
            const center = this.getTrackBounds();
            this.insertPointNear({
                x: (center.minX + center.maxX) / 2,
                y: (center.minY + center.maxY) / 2
            });
            return;
        }

        const current = polygon[handle.index];
        const next = polygon[(handle.index + 1) % polygon.length];
        polygon.splice(handle.index + 1, 0, midpoint(current, next));
        this.state.selectedHandle = {
            kind: 'polygon',
            path: this.state.tool,
            index: handle.index + 1
        };
        this.syncSelectedInputs();
        this.markDirty(`Inserted ${this.state.tool} point.`);
    }

    deleteSelectedPoint() {
        const handle = this.state.selectedHandle;
        if (!handle || handle.kind !== 'polygon') {
            this.setStatus('Select an outer or inner wall point first.', true);
            return;
        }

        const polygon = this.track[handle.path];
        if (polygon.length <= 3) {
            this.setStatus('A wall needs at least 3 points.', true);
            return;
        }

        polygon.splice(handle.index, 1);
        this.state.selectedHandle = {
            kind: 'polygon',
            path: handle.path,
            index: Math.max(0, handle.index - 1)
        };
        this.syncSelectedInputs();
        this.markDirty(`Deleted ${handle.path} point.`);
    }

    reverseActivePolygon() {
        if (this.state.tool !== 'outer' && this.state.tool !== 'inner') {
            this.setStatus('Reverse is only available for outer and inner walls.', true);
            return;
        }
        this.track[this.state.tool].reverse();
        this.state.selectedHandle = { kind: 'polygon', path: this.state.tool, index: 0 };
        this.syncSelectedInputs();
        this.markDirty(`Reversed ${this.state.tool} wall order.`);
    }

    addCheckpoint() {
        if (!this.hasTrackGeometry()) {
            this.setStatus('Build outer and inner walls before adding a checkpoint.', true);
            return;
        }
        const bounds = this.getTrackBounds();
        const seed = {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
        };
        const snapped = buildPerpendicularLaneGate(seed, this.track.outer, this.track.inner);
        const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
        if (guide) guide.manualGates = true;
        const checkpoint = snapped || {
            p1: { x: seed.x - 2, y: seed.y },
            p2: { x: seed.x + 2, y: seed.y },
        };
        this.track.checkpoints.push({
            p1: { x: checkpoint.p1.x, y: checkpoint.p1.y },
            p2: { x: checkpoint.p2.x, y: checkpoint.p2.y },
        });
        this.state.checkpointIndex = this.track.checkpoints.length - 1;
        this.state.selectedHandle = {
            kind: 'checkpoint',
            checkpointIndex: this.state.checkpointIndex,
        };
        this.refreshCheckpointSelect();
        this.setTool('checkpoints');
        this.markDirty('Added checkpoint (snapped perpendicular to walls).');
    }

    removeCheckpoint() {
        if (!this.track.checkpoints.length) {
            this.setStatus('There are no checkpoints to remove.', true);
            return;
        }
        const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
        if (guide) guide.manualGates = true;
        this.track.checkpoints.splice(this.state.checkpointIndex, 1);
        this.state.checkpointIndex = Math.max(0, this.state.checkpointIndex - 1);
        this.refreshCheckpointSelect();
        this.state.selectedHandle = this.track.checkpoints.length
            ? {
                kind: 'checkpoint',
                checkpointIndex: this.state.checkpointIndex,
            }
            : null;
        this.syncSelectedInputs();
        this.markDirty('Removed checkpoint.');
    }

    setStatus(message, isError = false) {
        this.state.status = message;
        this.statusText.textContent = message;
        this.statusText.style.color = isError ? '#fda4af' : '';
    }

    markDirty(message, updateStatus = true, options = {}) {
        if (options.recordHistory !== false && this.activeHistoryEditKey !== this.state.selectedTrackKey) {
            const history = this.getEditHistory();
            history.recordEdit(history.current(), this.track);
            this.syncHistoryButtons();
        }
        this.state.dirtyTrackKeys.add(this.state.selectedTrackKey);
        this.syncTrackSelectText();
        this.syncDirtyBadge();
        if (updateStatus) {
            this.setStatus(message);
        }
        this.scheduleDraftRecovery();
        this.scheduleQualityCheck();
        this.draw();
    }

    syncDirtyBadge() {
        const isDirty = this.state.dirtyTrackKeys.has(this.state.selectedTrackKey);
        this.dirtyBadge.textContent = isDirty ? 'Unsaved' : 'Saved';
        this.dirtyBadge.classList.toggle('pill-warn', isDirty);
    }

    markSaved(message) {
        this.baselineQualityCodesByKey.set(this.state.selectedTrackKey, new Set(
            validateTrackQuality(this.track).issues
                .filter((issue) => issue.severity === 'error')
                .map((issue) => issue.code),
        ));
        this.baselineGeometryByKey.set(this.state.selectedTrackKey, geometrySignature(this.track));
        this.state.dirtyTrackKeys.delete(this.state.selectedTrackKey);
        this.syncTrackSelectText();
        this.syncDirtyBadge();
        this.setStatus(message);
        this.syncDestinationControl();
        this.syncMedalTimesPanel();
        this.scheduleDraftRecovery();
        this.scheduleQualityCheck();
    }

    drawGrid(viewport) {
        const { ctx } = this;
        const minor = viewport.scale;
        const width = viewport.width;
        const height = viewport.height;
        const startX = viewport.offsetX % minor;
        const startY = viewport.offsetY % minor;

        ctx.save();
        if (this.state.tool === 'draw') ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1;

        for (let x = startX; x < width; x += minor) {
            const worldX = Math.round((x - viewport.offsetX) / viewport.scale);
            ctx.strokeStyle = worldX % 5 === 0 ? 'rgba(148, 163, 184, 0.18)' : 'rgba(148, 163, 184, 0.08)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        for (let y = startY; y < height; y += minor) {
            const worldY = Math.round((y - viewport.offsetY) / viewport.scale);
            ctx.strokeStyle = worldY % 5 === 0 ? 'rgba(148, 163, 184, 0.18)' : 'rgba(148, 163, 184, 0.08)';
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        ctx.restore();
    }

    buildScreenPath(points, viewport) {
        const path = new Path2D();
        if (points.length < 2) {
            return path;
        }
        const first = this.worldToScreen(points[0], viewport);
        path.moveTo(first.x, first.y);
        for (let index = 1; index < points.length; index += 1) {
            const point = this.worldToScreen(points[index], viewport);
            path.lineTo(point.x, point.y);
        }
        path.closePath();
        return path;
    }

    drawRaceCurbs(path, presentation, lineWidth) {
        const dash = Math.max(6, lineWidth * 3);
        this.ctx.save();
        this.ctx.lineWidth = lineWidth;
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'butt';
        this.ctx.setLineDash([dash, dash]);
        this.ctx.strokeStyle = presentation.curbRed || CONFIG.curbRed;
        this.ctx.stroke(path);
        this.ctx.lineDashOffset = dash;
        this.ctx.strokeStyle = presentation.curbWhite || CONFIG.curbWhite;
        this.ctx.stroke(path);
        this.ctx.setLineDash([]);
        this.ctx.lineDashOffset = 0;
        this.ctx.restore();
    }

    drawRaceTrackPreview(viewport) {
        const geometry = buildTrackGeometry({
            outer: this.track.outer,
            inner: this.track.inner,
            cornerRadius: this.getCornerRadius(),
        });
        if (geometry.outer.length < 3 || geometry.inner.length < 3) {
            return;
        }

        const presentation = resolveTrackPresentation(this.state.selectedTrackKey, { ground: this.track.ground });
        const outerPath = this.buildScreenPath(geometry.outer, viewport);
        const innerPath = this.buildScreenPath(geometry.inner, viewport);
        const surfacePath = new Path2D();
        surfacePath.addPath(outerPath);
        surfacePath.addPath(innerPath);

        const curbWidth = clamp(viewport.scale * 0.18, 2, 6);
        const finishWidth = clamp(viewport.scale * 0.35, 4, 12);

        fillTrackPresentation(this.ctx, surfacePath, innerPath, presentation);

        const startLine = this.track.startLine;
        if (startLine?.p1 && startLine?.p2) {
            this.ctx.save();
            this.ctx.clip(surfacePath, 'evenodd');
            drawTrackFinishLine(
                this.ctx,
                this.worldToScreen(startLine.p1, viewport),
                this.worldToScreen(startLine.p2, viewport),
                finishWidth,
                presentation,
            );
            this.ctx.restore();
        }

        if (presentation.showCurbs !== false) {
            this.drawRaceCurbs(outerPath, presentation, curbWidth);
            this.drawRaceCurbs(innerPath, presentation, curbWidth);
        }

        drawTrackBoundaries(this.ctx, outerPath, innerPath, presentation);
    }

    drawPolygon(points, viewport, fillStyle, strokeStyle, options = {}) {
        if (!points.length) {
            return;
        }
        const first = this.worldToScreen(points[0], viewport);
        this.ctx.beginPath();
        this.ctx.moveTo(first.x, first.y);
        for (let index = 1; index < points.length; index++) {
            const point = this.worldToScreen(points[index], viewport);
            this.ctx.lineTo(point.x, point.y);
        }
        this.ctx.closePath();
        if (fillStyle && fillStyle !== 'transparent') {
            this.ctx.fillStyle = fillStyle;
            this.ctx.fill();
        }
        this.ctx.lineWidth = options.lineWidth ?? 2;
        this.ctx.strokeStyle = strokeStyle;
        this.ctx.stroke();
    }

    drawLineSegment(a, b, viewport, color, width = 3, dashed = false) {
        const start = this.worldToScreen(a, viewport);
        const end = this.worldToScreen(b, viewport);
        this.ctx.beginPath();
        this.ctx.lineWidth = width;
        this.ctx.strokeStyle = color;
        this.ctx.setLineDash(dashed ? [10, 7] : []);
        this.ctx.moveTo(start.x, start.y);
        this.ctx.lineTo(end.x, end.y);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
    }

    drawHandle(handle, viewport) {
        const point = handle.point;
        const screen = this.worldToScreen(point, viewport);
        const isSelected = this.handleMatches(this.state.selectedHandle, handle);
        const isHovered = this.handleMatches(this.state.hoverHandle, handle);
        const isActiveTool = this.getToolForHandle(handle) === this.state.tool;
        const radius = isSelected ? 8 : isHovered ? 7 : isActiveTool ? 6 : 4.5;
        let fill = '#f8fafc';
        if (handle.kind === 'polygon') {
            fill = handle.path === 'outer' ? '#f43f5e' : '#38bdf8';
        } else if (handle.kind === 'checkpoint') {
            fill = '#22c55e';
        } else if (handle.kind === 'startPos') {
            fill = '#fbbf24';
        } else if (handle.kind === 'startLine') {
            fill = '#a78bfa';
        }

        this.ctx.save();
        this.ctx.globalAlpha = isSelected || isHovered || isActiveTool ? 1 : 0.45;
        this.ctx.beginPath();
        this.ctx.fillStyle = fill;
        this.ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.5)';
        this.ctx.lineWidth = isSelected ? 3 : 2;
        this.ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.restore();
    }

    drawDraftLoop(viewport) {
        const points = this.state.draftLoop;
        if (!points.length) return;

        const cursor = this.state.draftCursor;
        const candidate = !this.state.draftCloseHover
            && cursor
            && distance(cursor, points[points.length - 1]) >= 0.35
            ? cursor
            : null;
        const previewPoints = candidate ? [...points, candidate] : points;
        const roadPreview = this.state.draftCloseHover && points.length >= 3
            ? this.getDraftRoadPreview(points)
            : null;

        this.ctx.save();
        if (roadPreview) {
            const road = new Path2D();
            road.addPath(this.buildScreenPath(roadPreview.outer, viewport));
            road.addPath(this.buildScreenPath(roadPreview.inner, viewport));
            this.ctx.fillStyle = 'rgba(71, 85, 105, 0.96)';
            this.ctx.fill(road, 'evenodd');
            this.drawPolygon(roadPreview.outer, viewport, 'transparent', '#fbbf24', { lineWidth: 2 });
            this.drawPolygon(roadPreview.inner, viewport, 'transparent', '#fbbf24', { lineWidth: 2 });
        } else {
            const openPath = this.buildOpenRoadPath(previewPoints, viewport);
            this.ctx.lineJoin = 'round';
            this.ctx.lineCap = 'round';
            this.ctx.strokeStyle = '#fbbf24';
            this.ctx.lineWidth = this.getDrawWidth() * viewport.scale + 4;
            this.ctx.stroke(openPath);
            this.ctx.strokeStyle = '#475569';
            this.ctx.lineWidth = this.getDrawWidth() * viewport.scale;
            this.ctx.stroke(openPath);
        }
        this.drawLongStraights(roadPreview ? points : previewPoints, Boolean(roadPreview), viewport);

        points.forEach((point, index) => {
            const screen = this.worldToScreen(point, viewport);
            this.ctx.beginPath();
            this.ctx.fillStyle = index === 0 ? '#fbbf24' : '#f8fafc';
            this.ctx.strokeStyle = '#0f172a';
            this.ctx.lineWidth = 2;
            this.ctx.arc(screen.x, screen.y, index === 0 ? 6 : 4, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
        });

        if (candidate) {
            const screen = this.worldToScreen(candidate, viewport);
            this.ctx.beginPath();
            this.ctx.fillStyle = '#38bdf8';
            this.ctx.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
            this.ctx.fill();
        }
        if (points.length >= 3) {
            const first = this.worldToScreen(points[0], viewport);
            this.ctx.beginPath();
            this.ctx.strokeStyle = this.state.draftCloseHover ? '#ffffff' : 'rgba(251, 191, 36, 0.75)';
            this.ctx.lineWidth = 2;
            this.ctx.arc(first.x, first.y, this.state.draftCloseHover ? 12 : 10, 0, Math.PI * 2);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    buildOpenRoadPath(points, viewport) {
        const smoothed = smoothOpenPoints(points, this.getLineSmoothing());
        const path = new Path2D();
        const first = this.worldToScreen(smoothed[0], viewport);
        path.moveTo(first.x, first.y);
        for (let index = 1; index < smoothed.length - 1; index += 1) {
            const prev = smoothed[index - 1];
            const curr = smoothed[index];
            const next = smoothed[index + 1];
            const incoming = normalizeVector(curr.x - prev.x, curr.y - prev.y);
            const outgoing = normalizeVector(next.x - curr.x, next.y - curr.y);
            const turn = Math.acos(clamp(incoming.x * outgoing.x + incoming.y * outgoing.y, -1, 1));
            const tanHalf = Math.tan(turn / 2);
            const maxTrim = Math.min(distance(prev, curr), distance(curr, next)) * 0.45;
            const radius = tanHalf > 1e-6
                ? Math.min(this.getDrawWidth() / 2, maxTrim / tanHalf)
                : 0;
            const corner = this.worldToScreen(curr, viewport);
            if (!Number.isFinite(radius) || radius < 0.001) {
                path.lineTo(corner.x, corner.y);
                continue;
            }
            const following = this.worldToScreen(next, viewport);
            path.arcTo(corner.x, corner.y, following.x, following.y, radius * viewport.scale);
        }
        if (smoothed.length > 1) {
            const last = this.worldToScreen(smoothed[smoothed.length - 1], viewport);
            path.lineTo(last.x, last.y);
        }
        return path;
    }

    getDraftRoadPreview(points) {
        const width = this.getDrawWidth();
        const smoothing = this.getLineSmoothing();
        const cornerRadius = this.getCornerRadius();
        const cached = this.draftRoadPreview;
        const cacheMatches = cached?.points === points
            && cached.width === width
            && cached.smoothing === smoothing
            && cached.cornerRadius === cornerRadius;
        let generated = cached?.generated;
        if (!cacheMatches) {
            const walls = buildRoadWallsFromLoop(points, width, smoothing);
            generated = walls ? buildTrackGeometry({
                outer: walls.outer,
                inner: walls.inner,
                cornerRadius,
            }) : null;
        }
        this.draftRoadPreview = {
            points, width, smoothing, cornerRadius, generated,
        };
        return generated;
    }

    drawGhostCar(worldPoint, angle, viewport, options = {}) {
        if (!worldPoint || !Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y)) {
            return;
        }
        if (!Number.isFinite(angle)) {
            angle = 0;
        }

        const muted = options.muted === true;
        const screen = this.worldToScreen(worldPoint, viewport);
        const radius = CAR_RADIUS * viewport.scale;
        const halfAxis = CAR_HALF_LENGTH * viewport.scale;
        if (radius < 0.5) {
            return;
        }

        this.ctx.save();
        this.ctx.translate(screen.x, screen.y);
        this.ctx.rotate(angle);
        this.ctx.beginPath();
        this.ctx.moveTo(-halfAxis, -radius);
        this.ctx.lineTo(halfAxis, -radius);
        this.ctx.arc(halfAxis, 0, radius, -Math.PI / 2, Math.PI / 2);
        this.ctx.lineTo(-halfAxis, radius);
        this.ctx.arc(-halfAxis, 0, radius, Math.PI / 2, -Math.PI / 2);
        this.ctx.closePath();
        this.ctx.fillStyle = muted ? 'rgba(248, 250, 252, 0.10)' : 'rgba(248, 250, 252, 0.22)';
        this.ctx.fill();
        this.ctx.strokeStyle = muted ? 'rgba(248, 250, 252, 0.45)' : 'rgba(248, 250, 252, 0.92)';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(halfAxis + radius * 0.2, 0);
        this.ctx.lineTo(halfAxis - radius * 0.45, -radius * 0.5);
        this.ctx.lineTo(halfAxis - radius * 0.45, radius * 0.5);
        this.ctx.closePath();
        this.ctx.fillStyle = muted ? 'rgba(251, 191, 36, 0.35)' : 'rgba(251, 191, 36, 0.8)';
        this.ctx.fill();
        this.ctx.restore();
    }

    drawStartPosition(viewport) {
        this.drawGhostCar(this.track.startPos, this.track.startAngle || 0, viewport);
    }

    drawCheckpointLabels(viewport) {
        this.ctx.save();
        this.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        this.track.checkpoints.forEach((checkpoint, index) => {
            const center = midpoint(checkpoint.p1, checkpoint.p2);
            const screen = this.worldToScreen(center, viewport);
            this.ctx.fillStyle = index === this.state.checkpointIndex && this.state.tool === 'checkpoints'
                ? '#dcfce7'
                : '#86efac';
            this.ctx.fillText(`CP ${index + 1}`, screen.x, screen.y - 8);
        });
        this.ctx.restore();
    }

    draw() {
        const ratio = window.devicePixelRatio || 1;
        const viewport = this.getViewport();
        this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.ctx.clearRect(0, 0, viewport.width, viewport.height);

        this.drawGrid(viewport);

        if (this.hasTrackGeometry()) {
            this.drawRaceTrackPreview(viewport);
            this.drawPolygon(
                this.track.outer,
                viewport,
                'transparent',
                'rgba(244, 63, 94, 0.38)',
                { lineWidth: 1.5 },
            );
            this.drawPolygon(
                this.track.inner,
                viewport,
                'transparent',
                'rgba(56, 189, 248, 0.38)',
                { lineWidth: 1.5 },
            );
            this.drawLineSegment(
                this.track.startLine.p1,
                this.track.startLine.p2,
                viewport,
                'rgba(167, 139, 250, 0.55)',
                3,
                true,
            );
            this.drawStartPosition(viewport);

            this.track.checkpoints.forEach((checkpoint, index) => {
                const active = this.state.tool === 'checkpoints' && index === this.state.checkpointIndex;
                this.drawLineSegment(
                    checkpoint.p1,
                    checkpoint.p2,
                    viewport,
                    active ? '#4ade80' : 'rgba(74, 222, 128, 0.7)',
                    active ? 4 : 3
                );
            });
            this.drawCheckpointLabels(viewport);
        }

        this.drawFlowMarkers(viewport);
        this.drawQualityMarkers(viewport);

        this.drawDraftLoop(viewport);

        const handles = this.getAllHandles().sort((a, b) => {
            const aPriority = Number(this.handleMatches(this.state.selectedHandle, a)) * 4
                + Number(this.handleMatches(this.state.hoverHandle, a)) * 2
                + Number(this.getToolForHandle(a) === this.state.tool);
            const bPriority = Number(this.handleMatches(this.state.selectedHandle, b)) * 4
                + Number(this.handleMatches(this.state.hoverHandle, b)) * 2
                + Number(this.getToolForHandle(b) === this.state.tool);
            return aPriority - bPriority;
        });
        handles.forEach((handle) => this.drawHandle(handle, viewport));
    }

    async copyBackup() {
        const invalidTrack = this.validateTrack(this.track);
        if (invalidTrack) {
            this.setStatus(`Finish ${this.track.name} before copying a backup: ${invalidTrack}.`, true);
            return;
        }

        const filename = getTrackModuleFilename(this.state.selectedTrackKey);
        const moduleSource = generateTrackModuleSource(this.track);
        const text = `${moduleSource}\n${generateTrackIntegrationSnippet(this.state.selectedTrackKey, this.track.name)}`;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                this.setStatus(`Copied ${filename} and the catalog lines.`);
                return;
            }
        } catch (error) {
            console.error(error);
        }

        const blob = new Blob([moduleSource], { type: 'text/javascript;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.setStatus(`Downloaded ${filename}.`);
    }

    renderBotReport() {
        const report = this.botReport;
        this.botCheckIssues.replaceChildren();
        if (!report) {
            this.botCheckCount.textContent = 'Not run';
            this.botCheckCount.className = 'pill';
            this.botCheckSummary.hidden = true;
            this.botCheckSummary.textContent = '';
            return;
        }
        const issueCount = report.issues.filter((issue) => issue.severity !== 'info').length;
        this.botCheckCount.textContent = issueCount
            ? `${issueCount} issue${issueCount === 1 ? '' : 's'}`
            : 'Clean';
        this.botCheckCount.className = `pill${
            report.issues.some((issue) => issue.severity === 'error')
                ? ' pill-danger'
                : issueCount
                    ? ' pill-warn'
                    : ' pill-ok'
        }`;
        const finishers = report.simulation ? report.simulation.aggregate.finishers : 0;
        const crashes = report.simulation ? report.simulation.aggregate.crashes : 0;
        const crashLabel = crashes === 1 ? '1 crash' : `${crashes} crashes`;
        let summary = report.simulation
            ? `${finishers} of ${report.settings.botCount} finished. ${crashLabel}.`
            : 'Bots did not run. The drawing has a problem that blocks them.';
        if (geometrySignature(this.track) !== this.botReportSignature) {
            summary = `The drawing changed since this check. ${summary}`;
        }
        this.botCheckSummary.hidden = false;
        this.botCheckSummary.textContent = summary;
        for (const issue of report.issues) {
            const item = document.createElement('li');
            item.dataset.severity = issue.severity;
            item.textContent = `${issue.title}. ${issue.detail}`;
            this.botCheckIssues.appendChild(item);
        }
    }

    async runBots() {
        if (!this.hasTrackGeometry()) {
            this.setStatus('Draw a closed road before running bots.', true);
            return;
        }
        const trackKey = this.state.selectedTrackKey;
        const snapshot = cloneTracks(this.track);
        const signature = geometrySignature(snapshot);
        this.runBotsBtn.disabled = true;
        this.botCheckSummary.hidden = false;
        this.botCheckSummary.textContent = `Running bots on ${snapshot.name}...`;
        this.setStatus(`Running bots on ${snapshot.name}...`);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        try {
            const report = runTrackBotCheck(snapshot);
            if (trackKey !== this.state.selectedTrackKey) return;
            this.botReport = report;
            this.botReportSignature = signature;
            this.renderBotReport();
            const finishers = report.simulation ? report.simulation.aggregate.finishers : 0;
            this.setStatus(report.simulation
                ? `Bot check finished. ${finishers} of ${report.settings.botCount} finished.`
                : 'Bot check finished. The drawing blocked the bots.');
        } catch (error) {
            console.error(error);
            this.setStatus('Bot check failed.', true);
        } finally {
            this.runBotsBtn.disabled = false;
        }
    }

    driveDraft() {
        const track = this.track;
        if (!track || track.outer.length < 3 || track.inner.length < 3) {
            this.setStatus('Draw a closed road before driving the draft.', true);
            return;
        }
        try {
            window.sessionStorage.setItem('mapmaker:playtest-draft:v1', JSON.stringify({
                trackKey: this.state.selectedTrackKey,
                track,
            }));
            window.sessionStorage.setItem('mapmaker:return-from-playtest:v1', '1');
            this.flushDraftRecovery();
            this.skipBeforeUnload = true;
            window.location.assign('mapmaker-playtest.html');
        } catch (error) {
            this.setStatus('Draft Drive could not open in this browser.', true);
            console.error(error);
        }
    }

    async saveAndIntegrateTrack() {
        const invalidTrack = this.validateTrack(this.track);
        if (invalidTrack) {
            this.setStatus(`Cannot save ${this.track.name}: ${invalidTrack}.`, true);
            return;
        }

        const trackKey = this.state.selectedTrackKey;
        const originalTrackKey = this.state.originalTrackKeyByKey.get(trackKey) ?? null;
        const destination = this.getSelectedDestination();
        const currentlyScheduled = Boolean(
            (originalTrackKey && SCHEDULED_TRACK_KEYS.has(originalTrackKey))
            || SCHEDULED_TRACK_KEYS.has(trackKey),
        );
        if (
            originalTrackKey
            && originalTrackKey !== trackKey
            && !window.confirm(
                `Rename ${originalTrackKey} to ${trackKey}? This will delete the old definition file and replace its catalog, schedule, import, and registry entries.`,
            )
        ) {
            return;
        }
        const plannedStage = this.getPlannedStage(trackKey);
        const medalRow = this.medalRowByKey.get(trackKey) ?? null;
        if (plannedStage) {
            const rowError = getMedalRowError(this.getMedalRow(trackKey));
            if (rowError) {
                this.setStatus(`Cannot save ${this.track.name} as a ${plannedStage.series.name} stage: ${rowError}`, true);
                return;
            }
        } else if (medalRow && getMedalRowError(medalRow)) {
            this.setStatus(`Cannot save ${this.track.name}: ${getMedalRowError(medalRow)}`, true);
            return;
        }
        if (
            destination !== DAILY_DESTINATION
            && currentlyScheduled
            && !window.confirm(
                `Move ${trackKey} off the Daily Challenge schedule? It will stay in the track catalog, but will not appear in future Daily GP days.`,
            )
        ) {
            return;
        }
        if (
            plannedStage?.isNew
            && isCampaignSeriesLive(plannedStage.series)
            && !window.confirm(
                `${plannedStage.series.name} is live. After this save, ${trackKey} is fixed as Stage ${String(plannedStage.stageIndex).padStart(2, '0')}: you cannot move it, remove it, or change its laps, medal target or medal times. Continue?`,
            )
        ) {
            return;
        }

        this.saveTrackBtn.disabled = true;
        this.setStatus(`Saving and integrating ${this.track.name}...`);
        try {
            const response = await fetch('/__mapmaker/save-track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trackKey,
                    originalTrackKey,
                    trackName: this.track.name,
                    destination,
                    laps: plannedStage && !plannedStage.fixed ? plannedStage.laps : null,
                    requiredMedals: plannedStage && !plannedStage.fixed ? plannedStage.requiredMedals : null,
                    medalRow,
                    track: this.track,
                }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(result.error || `Save failed with status ${response.status}.`);
            }

            this.seriesData = applyTrackSeriesUpdate(this.seriesData, {
                trackKey,
                originalTrackKey,
                destination,
                laps: plannedStage && !plannedStage.fixed ? plannedStage.laps : null,
                requiredMedals: plannedStage && !plannedStage.fixed ? plannedStage.requiredMedals : null,
            }).data;
            if (originalTrackKey && originalTrackKey !== trackKey && this.medalTimes[originalTrackKey]) {
                this.medalTimes[trackKey] = this.medalTimes[originalTrackKey];
                delete this.medalTimes[originalTrackKey];
            }
            if (medalRow) this.medalTimes[trackKey] = normalizeMedalRow(medalRow);
            this.medalRowByKey.delete(trackKey);
            this.stageSettingsByKey.delete(trackKey);
            this.destinationByKey.delete(trackKey);
            this.state.originalTrackKeyByKey.set(trackKey, trackKey);
            if (destination === DAILY_DESTINATION) {
                SCHEDULED_TRACK_KEYS.add(trackKey);
                if (originalTrackKey && originalTrackKey !== trackKey) {
                    SCHEDULED_TRACK_KEYS.delete(originalTrackKey);
                }
            } else {
                SCHEDULED_TRACK_KEYS.delete(trackKey);
                if (originalTrackKey) {
                    SCHEDULED_TRACK_KEYS.delete(originalTrackKey);
                }
            }
            const savedSeries = this.getDestinationSeries(destination);
            const scheduleText = destination === DAILY_DESTINATION
                ? (
                    Number.isInteger(result.scheduleIndex) && result.scheduleIndex >= 0
                        ? ` Added to Daily Challenge at schedule position ${result.scheduleIndex + 1}.`
                        : ' Marked for Daily Challenge.'
                )
                : savedSeries
                    ? ` Saved as ${savedSeries.name} Stage ${String(result.stageIndex).padStart(2, '0')}.`
                    : ' Saved as not used (not on the Daily schedule).';
            const renameText = result.removedFilename
                ? ` Removed ${result.removedFilename}.`
                : '';
            this.markSaved(
                `Saved and integrated ${result.filename}.${scheduleText}${renameText}`,
            );
        } catch (error) {
            console.error(error);
            this.setStatus(
                `${error.message} Run Mapmaker through the local Vite server, or use Copy backup.`,
                true,
            );
        } finally {
            this.saveTrackBtn.disabled = false;
        }
    }
}

new MapmakerApp();
