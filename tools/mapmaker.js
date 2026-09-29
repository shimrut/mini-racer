import { CONFIG } from '../game/config.js';
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
import { placeCheckpointInLongestGap, validateTrackQuality } from './mapmaker/track-quality.js';
import { analyzeTrackFlow, FLOW_DRAW_GUIDE, measureStraights } from './mapmaker/track-flow.js';
import {
    clearDraftRecovery,
    createEditHistory,
    loadDraftRecovery,
    saveDraftRecovery,
} from './mapmaker/edit-history.js';
import { snapLineBuildPoint } from './mapmaker/line-build.js';
import { snapStartPose } from './mapmaker/start-pose.js';
import { buildRibbonWallsFromCenterline } from './mapmaker/ribbon-walls.js';
import {
    DEFAULT_DRAW_WIDTH,
    isValidTrackKey,
    trackKeyFromName
} from './mapmaker/track-source.js';
import { clamp, clonePoint, distance, midpoint, normalizeVector } from './geometry.js';
import seriesFileData from '../game/campaign/series.json' with { type: 'json' };
import medalTimesFileData from '../game/medals/medal-times.json' with { type: 'json' };
import { isCampaignSeriesLive } from '../game/campaign/series-rules.js';
import { findTrackStage, normalizeCampaignSeriesData } from './mapmaker/campaign-series.js';
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
import { TrackPreviews } from './mapmaker/track-preview.js';
import { MAPMAKER_ONLINE, deleteCloudMap, listCloudMaps, saveCloudMap } from './mapmaker/cloud-maps.js';

const PANEL_HIDDEN_KEY = 'mapmaker:panel-hidden:v1';
const PLAYTEST_DRAFT_KEY = 'mapmaker:playtest-draft:v1';
const STATUS_MS = 3500;
const STATUS_ERROR_MS = 8000;
const STATUS_MS_PER_CHAR = 60;
// Picker cards for cloud maps in the local Mapmaker use this key prefix, which
// no track key can have.
const CLOUD_CARD_PREFIX = 'cloud:';
// A finger that moves less than this many pixels is a tap, not a pan.
const TOUCH_TAP_SLOP = 8;
const BLANK_VIEW_BOUNDS = { minX: -40, maxX: 40, minY: -30, maxY: 30 };
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

function smoothLoopPoints(points) {
    const smoothing = DEFAULT_LINE_SMOOTHING;
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

function smoothOpenPoints(points) {
    const smoothing = DEFAULT_LINE_SMOOTHING;
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

function buildRoadWallsFromLoop(rawPoints, trackWidth) {
    const filtered = dedupeStrokePoints(rawPoints, 0.35);
    if (filtered.length < 3) {
        return null;
    }

    const centerline = smoothLoopPoints(filtered);
    const loopLength = closedLoopLength(centerline);
    if (loopLength < trackWidth * 5) {
        return null;
    }

    return buildRibbonWallsFromCenterline(centerline, trackWidth / 2);
}

function buildTrackFromLoop(rawPoints, trackWidth, cornerRadius) {
    const walls = buildRoadWallsFromLoop(rawPoints, trackWidth);
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
        this.trackPickerBtn = document.getElementById('track-picker-btn');
        this.trackPickerName = document.getElementById('track-picker-name');
        this.trackPickerDialog = document.getElementById('track-picker-dialog');
        this.trackSearch = document.getElementById('track-search');
        this.trackPickerList = document.getElementById('track-picker-list');
        this.panel = document.getElementById('maker-panel');
        this.panelToggleBtn = document.getElementById('panel-toggle-btn');
        this.toolButtons = Array.from(document.querySelectorAll('#tool-buttons [data-tool]'));
        this.canvasHint = document.getElementById('canvas-hint');
        this.touchTools = document.getElementById('touch-tools');
        this.trackNameInput = document.getElementById('track-name-input');
        this.medalTimesState = document.getElementById('medal-times-state');
        this.draftLapsList = document.getElementById('draft-laps-list');
        this.medalTimesHint = document.getElementById('medal-times-hint');
        this.medalInputs = Object.fromEntries(MEDAL_TIERS.map((tier) => [
            tier,
            document.getElementById(`medal-${tier}-input`),
        ]));
        this.cornerRadiusOptions = document.getElementById('corner-radius-options');
        this.groundOptions = document.getElementById('ground-options');
        this.saveTrackBtn = document.getElementById('save-track-btn');
        this.newTrackBtn = document.getElementById('new-track-btn');
        this.removeTrackBtn = document.getElementById('remove-track-btn');
        this.checkpointCount = document.getElementById('checkpoint-count');
        this.addCheckpointBtn = document.getElementById('add-checkpoint-btn');
        this.deleteCheckpointBtn = document.getElementById('delete-checkpoint-btn');
        this.removeTrackDialog = document.getElementById('remove-track-dialog');
        this.removeTrackDialogMessage = document.getElementById('remove-track-dialog-message');
        this.driveDraftBtn = document.getElementById('drive-draft-btn');
        this.restoreDraftsDialog = document.getElementById('restore-drafts-dialog');
        this.restoreDraftsDialogMessage = document.getElementById('restore-drafts-dialog-message');
        this.qualityCount = document.getElementById('quality-count');
        this.qualityIssues = document.getElementById('quality-issues');
        this.flowTips = document.getElementById('flow-tips');
        this.flowCount = document.getElementById('flow-count');
        this.flowRules = document.getElementById('flow-rules');

        const initialTrackKey = Object.keys(TRACKS)[0];
        this.state = {
            tracks: cloneTracks(TRACKS),
            selectedTrackKey: initialTrackKey,
            tool: 'edit',
            selectedHandle: null,
            hoverHandle: null,
            hoverSegment: null,
            drag: null,
            dirtyTrackKeys: new Set(),
            originalTrackKeyByKey: new Map(
                Object.keys(TRACKS).map((trackKey) => [trackKey, trackKey]),
            ),
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
        this.seriesData = normalizeCampaignSeriesData(seriesFileData);
        this.medalTimes = { ...medalTimesFileData };
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
        this.trackPreviews = new TrackPreviews((key) => (key.startsWith(CLOUD_CARD_PREFIX)
            ? this.cloudMaps.find((map) => CLOUD_CARD_PREFIX + map.trackKey === key)?.track
            : this.state.tracks[key]));
        this.hintText = '';
        this.statusMessage = null;
        this.statusIsError = false;
        this.statusTimer = null;
        this.busy = false;
        // Track key -> the key of its saved cloud map.
        this.cloudKeyByKey = new Map();
        // The local Mapmaker lists the cloud maps in the track picker.
        this.cloudMaps = [];
        this.cloudMapsError = '';
        this.touchInput = window.matchMedia('(pointer: coarse)').matches;
        this.touchPoints = new Map();
        this.pinch = null;

        if (MAPMAKER_ONLINE) {
            document.querySelectorAll('.local-only').forEach((element) => { element.hidden = true; });
        }
        this.buildOptionGroup(this.cornerRadiusOptions, 'corner-radius', CORNER_RADIUS_PRESETS);
        this.buildOptionGroup(this.groundOptions, 'ground', TRACK_GROUND_KEYS.map((key) => ({
            value: key,
            label: TRACK_GROUNDS[key].label,
        })));
        let storedPanelHidden = null;
        try { storedPanelHidden = getBrowserStorage('localStorage')?.getItem(PANEL_HIDDEN_KEY); } catch {}
        this.setPanelHidden(storedPanelHidden === null
            ? window.matchMedia('(max-width: 900px)').matches
            : storedPanelHidden === '1');
        this.bindEvents();
        this.loadTrack(initialTrackKey);
        this.resizeCanvas();

        const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        resizeObserver.observe(this.canvas.parentElement);
        this.offerDraftRecovery();
        if (MAPMAKER_ONLINE) this.loadCloudMapsOnline();
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
    }

    restoreEdit(track, message) {
        this.state.tracks[this.state.selectedTrackKey] = track;
        this.loadTrack(this.state.selectedTrackKey);
        this.markDirty(message, true, { recordHistory: false });
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
        // Until Restore or Discard is chosen, the stored maps are not in the editor yet.
        if (this.restoreDraftsDialog.open) return;
        if (this.state.draftLoop.length) {
            this.draftLoopsByKey.set(this.state.selectedTrackKey, cloneTracks(this.state.draftLoop));
        } else {
            this.draftLoopsByKey.delete(this.state.selectedTrackKey);
        }
        const keys = new Set([...this.state.dirtyTrackKeys, ...this.draftLoopsByKey.keys()]);
        const drafts = [...keys].filter((key) => this.state.tracks[key]).map((key) => ({
            trackKey: key,
            originalTrackKey: this.state.originalTrackKeyByKey.get(key) ?? null,
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
        this.restoreDraftsDialogMessage.textContent = `${recovery.drafts.length} unsaved map${recovery.drafts.length === 1 ? '' : 's'} found.`;
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

    // Puts a draft in the editor as an unsaved track. A renamed draft replaces
    // the saved track it came from.
    addDraft(draft) {
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
        if (draft.draftLoop.length) this.draftLoopsByKey.set(draft.trackKey, draft.draftLoop);
        this.editHistories.set(draft.trackKey, createEditHistory(draft.track));
    }

    restoreDraftRecovery(recovery) {
        recovery.drafts.forEach((draft) => this.addDraft(draft));
        this.loadTrack(recovery.selectedTrackKey || recovery.drafts[0].trackKey);
        this.setStatus(`Restored ${recovery.drafts.length} unsaved map${recovery.drafts.length === 1 ? '' : 's'}.`);
    }

    // A cloud map is a draft of a new track, or of a track that was in the
    // game when the map was saved.
    addCloudMap(map) {
        this.addDraft({ ...map, originalTrackKey: TRACKS[map.originalTrackKey] ? map.originalTrackKey : null });
        if (map.medalRow) this.medalRowByKey.set(map.trackKey, map.medalRow);
        this.cloudKeyByKey.set(map.trackKey, map.trackKey);
    }

    // Online, the cloud maps are the saved tracks, so they open clean. A map
    // with unsaved changes in this browser keeps them.
    async loadCloudMapsOnline() {
        let maps;
        try {
            maps = await listCloudMaps();
        } catch (error) {
            this.setStatus(`Cannot load your cloud maps: ${error.message}`, true);
            return;
        }
        for (const map of [...maps].reverse()) {
            if (this.state.dirtyTrackKeys.has(map.trackKey)) {
                this.cloudKeyByKey.set(map.trackKey, map.trackKey);
                continue;
            }
            this.addCloudMap(map);
            this.state.dirtyTrackKeys.delete(map.trackKey);
        }
        // Open the track just driven in Drive Draft, else the newest cloud map.
        let drivenKey = null;
        try {
            drivenKey = JSON.parse(getBrowserStorage('sessionStorage')?.getItem(PLAYTEST_DRAFT_KEY) ?? 'null')?.trackKey ?? null;
        } catch {}
        const openKey = this.state.dirtyTrackKeys.size
            ? this.state.selectedTrackKey
            : [drivenKey, maps[0]?.trackKey, this.state.selectedTrackKey].find((key) => key && this.state.tracks[key]);
        this.loadTrack(this.state.tracks[openKey] ? openKey : Object.keys(this.state.tracks)[0]);
        if (this.trackPickerDialog.open) this.renderTrackPicker();
    }

    async refreshCloudMapsLocal() {
        try {
            this.cloudMaps = await listCloudMaps();
            this.cloudMapsError = '';
        } catch (error) {
            this.cloudMaps = [];
            this.cloudMapsError = error.message;
        }
        if (this.trackPickerDialog.open) this.renderTrackPicker();
    }

    // The local Mapmaker opens a cloud map as an unsaved draft. Saving it adds
    // it to the game and deletes the cloud copy.
    openCloudMap(trackKey) {
        const map = this.cloudMaps.find((entry) => entry.trackKey === trackKey);
        if (!map) return;
        this.addCloudMap(map);
        this.trackPickerDialog.close();
        this.loadTrack(trackKey);
        this.setStatus(`Opened ${map.track.name} from cloud maps. Save adds it to the game.`);
    }

    // After a local save or removal, the cloud copy is not needed.
    async deleteCloudCopy(trackKey) {
        const cloudKey = this.cloudKeyByKey.get(trackKey);
        if (!cloudKey) return '';
        this.cloudKeyByKey.delete(trackKey);
        this.cloudMaps = this.cloudMaps.filter((map) => map.trackKey !== cloudKey);
        try {
            await deleteCloudMap(cloudKey);
            return ' Deleted its cloud copy.';
        } catch (error) {
            return ` Its cloud copy was not deleted: ${error.message}`;
        }
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
        this.qualityReport = report;
        this.qualityTrackKey = key;
        const errors = report.issues.filter((issue) => issue.severity === 'error');
        const warnings = report.issues.filter((issue) => issue.severity === 'warning');
        const hasGeometry = this.hasTrackGeometry();
        let label = 'OK';
        let tone = ' pill-ok';
        if (!hasGeometry) {
            label = 'Draw a track';
            tone = '';
        } else if (errors.length) {
            label = `${errors.length} error${errors.length === 1 ? '' : 's'}`;
            tone = ' pill-danger';
        } else if (warnings.length) {
            label = `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
            tone = ' pill-warn';
        }
        this.qualityCount.textContent = label;
        this.qualityCount.className = `pill${tone}`;
        this.qualityIssues.replaceChildren();
        let markerNumber = 0;
        for (const issue of hasGeometry ? report.issues.slice(0, 12) : []) {
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
        const blocked = !this.hasTrackGeometry() || Boolean(this.qualityReport?.hasErrors);
        const signature = blocked ? null : geometrySignature(this.track);
        if (!blocked && key === this.flowTrackKey && signature === this.flowSignature) {
            return;
        }
        this.flowReport = blocked ? null : analyzeTrackFlow(this.track);
        this.flowTrackKey = key;
        this.flowSignature = signature;
        this.renderFlowReport();
        this.draw();
    }

    renderFlowReport() {
        this.flowRules.replaceChildren();
        const report = this.flowReport;
        const misses = report ? report.rules.filter((rule) => !rule.pass).length : 0;
        this.flowTips.hidden = misses === 0;
        this.flowCount.textContent = String(misses);
        if (!report) return;
        report.rules.forEach((rule, index) => {
            if (rule.pass) return;
            const item = document.createElement('li');
            item.dataset.flow = 'miss';
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
        if (!this.flowTips.open || !this.flowReport || this.flowTrackKey !== this.state.selectedTrackKey) return;
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

    buildOptionGroup(container, name, options) {
        container.replaceChildren(...options.map(({ value, label }) => {
            const option = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = name;
            input.value = String(value);
            const text = document.createElement('span');
            text.textContent = label;
            option.append(input, text);
            return option;
        }));
    }

    checkOption(container, value) {
        const input = container.querySelector(`input[value="${value}"]`);
        if (input) input.checked = true;
    }

    syncCornerRadiusControl() {
        this.checkOption(this.cornerRadiusOptions, this.nearestCornerRadiusPreset());
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
        this.checkOption(this.groundOptions, getTrackGround(this.track).key);
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

    getDraftStraights(points, closed) {
        if (points.length < 2) return [];
        const path = closed
            ? smoothLoopPoints(dedupeStrokePoints(points, 0.35))
            : smoothOpenPoints(points);
        return measureStraights(path, { closed, halfWidth: DEFAULT_DRAW_WIDTH / 2 })
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
        this.trackPickerBtn.addEventListener('click', () => this.openTrackPicker());
        this.trackSearch.addEventListener('input', () => this.renderTrackPicker());
        this.trackSearch.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const first = this.trackPickerList.querySelector('[data-track-key]');
            if (first) this.pickCard(first.dataset.trackKey);
        });
        this.trackPickerList.addEventListener('click', (event) => {
            const card = event.target.closest?.('[data-track-key]');
            if (card) this.pickCard(card.dataset.trackKey);
        });
        if (!('closedBy' in HTMLDialogElement.prototype)) {
            this.trackPickerDialog.addEventListener('click', (event) => {
                if (event.target !== this.trackPickerDialog) return;
                const rect = this.trackPickerDialog.getBoundingClientRect();
                const inside = rect.top <= event.clientY && event.clientY <= rect.bottom
                    && rect.left <= event.clientX && event.clientX <= rect.right;
                if (!inside) this.trackPickerDialog.close();
            });
        }
        this.panelToggleBtn.addEventListener('click', () => this.setPanelHidden(!this.panel.hidden));
        this.flowTips.addEventListener('toggle', () => this.draw());

        this.toolButtons.forEach((button) => {
            button.addEventListener('click', () => this.setTool(button.dataset.tool));
        });

        this.trackNameInput.addEventListener('input', () => {
            const typed = this.trackNameInput.value;
            this.track.name = typed.trim() || 'Untitled Track';
            const derived = this.applyDerivedTrackKey(typed);
            this.syncTrackPickerButton();
            this.updateStageText();
            this.markDirty('Updated track name.', derived);
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

        this.cornerRadiusOptions.addEventListener('change', (event) => {
            this.setCornerRadius(Number(event.target.value));
        });

        this.groundOptions.addEventListener('change', (event) => {
            this.setGround(event.target.value);
        });

        this.newTrackBtn.addEventListener('click', () => this.createTrack());
        this.removeTrackBtn.addEventListener('click', () => this.removeTrack());
        this.addCheckpointBtn.addEventListener('click', () => this.addCheckpoint());
        this.deleteCheckpointBtn.addEventListener('click', () => this.deleteCheckpoint());
        this.driveDraftBtn.addEventListener('click', () => this.driveDraft());
        this.saveTrackBtn.addEventListener('click', () => this.saveAndIntegrateTrack());

        this.touchTools.addEventListener('click', (event) => {
            const action = event.target.closest?.('button[data-action]')?.dataset.action;
            if (action === 'undo') this.undoEdit();
            else if (action === 'redo') this.redoEdit();
            else if (action === 'add-point') this.insertPointAfterSelected();
            else if (action === 'delete-point') this.deleteSelectedPoint();
        });

        this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
        this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
        this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
        // A lifted finger leaves the canvas before its tap click arrives.
        this.canvas.addEventListener('pointerleave', (event) => {
            if (event.pointerType !== 'touch') this.onPointerUp(event);
        });
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
    }

    setPanelHidden(hidden) {
        this.panel.hidden = hidden;
        this.panelToggleBtn.setAttribute('aria-expanded', String(!hidden));
        try { getBrowserStorage('localStorage')?.setItem(PANEL_HIDDEN_KEY, hidden ? '1' : '0'); } catch {}
    }

    openTrackPicker() {
        this.trackSearch.value = '';
        this.renderTrackPicker();
        this.trackPickerDialog.showModal();
        if (!MAPMAKER_ONLINE) this.refreshCloudMapsLocal();
    }

    renderTrackPicker() {
        this.trackPreviews.reset();
        const query = this.trackSearch.value.trim().toLowerCase();
        const matches = (track) => !query || track.name.toLowerCase().includes(query);
        const createCard = (key, track, meta) => {
            const card = this.trackPreviews.createCard('button', key, track.name, meta);
            card.type = 'button';
            return card;
        };
        const createText = (tag, className, text) => {
            const element = document.createElement(tag);
            element.className = className;
            element.textContent = text;
            return element;
        };

        const cloudItems = [];
        const cloudMaps = this.cloudMaps.filter((map) => matches(map.track));
        if (cloudMaps.length || (this.cloudMapsError && !query)) {
            cloudItems.push(createText('h3', 'track-cards-heading', 'Cloud maps'));
            if (this.cloudMapsError) cloudItems.push(createText('p', 'field-hint', this.cloudMapsError));
            cloudItems.push(...cloudMaps.map((map) => createCard(
                CLOUD_CARD_PREFIX + map.trackKey,
                map.track,
                `Saved ${new Date(map.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
            )));
            cloudItems.push(createText('h3', 'track-cards-heading', 'Tracks'));
        }

        const keys = Object.keys(this.state.tracks).reverse().filter((key) => matches(this.state.tracks[key]));
        const trackItems = keys.map((key) => {
            const track = this.state.tracks[key];
            const meta = [
                getTrackGround(track).label,
                this.cloudKeyByKey.has(key) ? 'Cloud' : '',
                this.state.dirtyTrackKeys.has(key) ? 'Unsaved' : '',
            ].filter(Boolean).join(' · ');
            const card = createCard(key, track, meta);
            if (key === this.state.selectedTrackKey) card.setAttribute('aria-current', 'true');
            return card;
        });
        if (!keys.length) trackItems.push(createText('p', 'field-hint', 'No track has that name. Use New track to start one.'));
        this.trackPickerList.replaceChildren(...cloudItems, ...trackItems);
    }

    pickCard(cardKey) {
        if (cardKey.startsWith(CLOUD_CARD_PREFIX)) {
            this.openCloudMap(cardKey.slice(CLOUD_CARD_PREFIX.length));
            return;
        }
        this.trackPickerDialog.close();
        this.loadTrack(cardKey);
    }

    setTool(tool, selectedHandle) {
        this.state.tool = tool === 'draw' ? 'draw' : 'edit';
        if (this.state.tool === 'draw') {
            this.state.selectedHandle = null;
        } else if (arguments.length > 1) {
            this.state.selectedHandle = selectedHandle ? { ...selectedHandle } : null;
        } else if (!this.state.selectedHandle && this.hasTrackGeometry()) {
            this.state.selectedHandle = { kind: 'polygon', path: 'outer', index: 0 };
        }
        this.updateStageText();
        this.draw();
    }

    updateStageText() {
        this.toolButtons.forEach((button) => {
            button.dataset.active = String(button.dataset.tool === this.state.tool);
        });
        this.touchTools.dataset.tool = this.state.tool;
        this.updateCanvasHint();
    }

    syncTrackPickerButton() {
        this.trackPickerName.textContent = this.track.name;
    }

    // The saved stage of a track: { series, stageIndex }, or null.
    getSavedStage(trackKey = this.state.selectedTrackKey) {
        const savedKey = this.state.originalTrackKeyByKey.get(trackKey);
        return savedKey ? findTrackStage(this.seriesData, savedKey) : null;
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
            note.textContent = 'No Drive Draft laps yet.';
            this.draftLapsList.appendChild(note);
        }

        const edited = this.medalRowByKey.has(trackKey);
        const error = row ? getMedalRowError(row) : 'Set all four medal times.';
        const bronze = Number(row?.bronze);
        const notes = [];
        if (fixed) {
            notes.push('Fixed: the track is in a live series.');
        } else if (row && error) {
            notes.push(error);
        }
        if (Number.isFinite(bronze) && bronze >= BRONZE_WARNING_SEC) {
            notes.push(`Keep bronze under ${BRONZE_WARNING_SEC} s. Longer laps are refused.`);
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
            this.resetView();
            if (this.state.draftLoop.length) {
                this.draftLoopsByKey.set(this.state.selectedTrackKey, cloneTracks(this.state.draftLoop));
            } else {
                this.draftLoopsByKey.delete(this.state.selectedTrackKey);
            }
        }
        this.commitHistoryEdit();
        this.state.selectedTrackKey = trackKey;
        this.syncTrackPickerButton();
        this.trackNameInput.value = this.track.name;
        this.syncMedalTimesPanel();
        this.syncCornerRadiusControl();
        this.syncGroundControl();
        this.state.draftLoop = cloneTracks(this.draftLoopsByKey.get(trackKey) ?? []);
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.state.skipDrawClick = false;
        this.state.view.frozenBounds = null;
        if (!this.hasTrackGeometry()) {
            this.state.tool = 'draw';
            this.state.selectedHandle = null;
        } else {
            this.state.tool = 'edit';
            this.state.selectedHandle = { kind: 'polygon', path: 'outer', index: 0 };
        }
        this.updateStageText();
        this.syncActionButtons();
        this.draw();
        this.scheduleQualityCheck();
        if (this.state.dirtyTrackKeys.size || this.draftLoopsByKey.size) {
            this.scheduleDraftRecovery();
        }
    }

    renameTrackKey(nextKey) {
        const currentKey = this.state.selectedTrackKey;
        if (!nextKey || nextKey === currentKey || !isValidTrackKey(nextKey) || this.state.tracks[nextKey]) {
            return false;
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
        const medalRow = this.medalRowByKey.get(currentKey);
        this.medalRowByKey.delete(currentKey);
        if (medalRow) this.medalRowByKey.set(nextKey, medalRow);
        const cloudKey = this.cloudKeyByKey.get(currentKey);
        this.cloudKeyByKey.delete(currentKey);
        if (cloudKey) this.cloudKeyByKey.set(nextKey, cloudKey);
        const originalTrackKey = this.state.originalTrackKeyByKey.get(currentKey) ?? null;
        this.state.originalTrackKeyByKey.delete(currentKey);
        if (originalTrackKey) {
            this.state.originalTrackKeyByKey.set(nextKey, originalTrackKey);
        }
        this.state.dirtyTrackKeys.delete(currentKey);
        this.state.dirtyTrackKeys.add(nextKey);
        this.state.selectedTrackKey = nextKey;
        this.state.dirtyTrackKeys.add(nextKey);
        return true;
    }

    applyDerivedTrackKey(name) {
        const nextKey = trackKeyFromName(name);
        if (!nextKey || nextKey === this.state.selectedTrackKey) {
            return true;
        }
        if (!isValidTrackKey(nextKey)) {
            this.setStatus('That name cannot be a track key.', true);
            return false;
        }
        if (this.state.tracks[nextKey]) {
            this.setStatus('That name is already used by another track.', true);
            return false;
        }
        return this.renameTrackKey(nextKey);
    }

    createTrack() {
        let name = 'New Track';
        for (let number = 2; this.state.tracks[trackKeyFromName(name)]; number += 1) {
            name = `New Track ${number}`;
        }
        const key = trackKeyFromName(name);
        this.state.tracks[key] = createBlankTrack(name);
        this.loadTrack(key);
        this.markDirty(`Created ${name}.`);
        this.setPanelHidden(false);
        this.trackNameInput.focus();
        this.trackNameInput.select();
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
        const cloudKey = this.cloudKeyByKey.get(selectedKey) ?? null;
        const trackName = this.track.name;
        const cloudText = cloudKey ? ' Its cloud copy is deleted too.' : '';
        let warning;
        if (MAPMAKER_ONLINE) {
            warning = cloudKey
                ? `Delete ${trackName} from your cloud maps?${originalKey ? ' The game keeps its own version.' : ''}`
                : `Discard unsaved track ${trackName}?`;
        } else {
            warning = originalKey
                ? `Remove ${trackName} from the game for good? Published Daily races and Head-to-Head posts that use it may stop working.${cloudText}`
                : `Discard unsaved track ${trackName}?${cloudText}`;
        }
        try {
            if (!await this.confirmTrackRemoval(warning)) return;
        } catch (error) {
            this.setStatus(`Unable to open the removal confirmation: ${error.message}`, true);
            return;
        }

        this.removeTrackBtn.disabled = true;
        this.busy = true;
        this.syncActionButtons();
        try {
            if (MAPMAKER_ONLINE) {
                if (cloudKey) await deleteCloudMap(cloudKey);
            } else if (originalKey) {
                const response = await fetch('/__mapmaker/remove-track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trackKey: originalKey }),
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(result.error || `Removal failed with status ${response.status}.`);
                }
            }
            const cloudResult = MAPMAKER_ONLINE ? '' : await this.deleteCloudCopy(selectedKey);

            const keys = Object.keys(this.state.tracks);
            const selectedIndex = keys.indexOf(selectedKey);
            let nextKey = keys[selectedIndex + 1] || keys[selectedIndex - 1];
            delete this.state.tracks[selectedKey];
            this.cloudKeyByKey.delete(selectedKey);
            this.editHistories.delete(selectedKey);
            this.draftLoopsByKey.delete(selectedKey);
            this.medalRowByKey.delete(selectedKey);
            this.baselineQualityCodesByKey.delete(selectedKey);
            this.baselineGeometryByKey.delete(selectedKey);
            this.autoRoadGuideByKey.delete(selectedKey);
            this.state.originalTrackKeyByKey.delete(selectedKey);
            this.state.dirtyTrackKeys.delete(selectedKey);
            // Online, a deleted cloud copy of a game track shows the game version again.
            if (MAPMAKER_ONLINE && originalKey && TRACKS[originalKey]) {
                this.state.tracks[originalKey] = cloneTracks(TRACKS[originalKey]);
                this.state.originalTrackKeyByKey.set(originalKey, originalKey);
                this.editHistories.delete(originalKey);
                nextKey = originalKey;
            }
            this.state.selectedTrackKey = nextKey;
            this.resetView();
            this.loadTrack(nextKey);
            if (MAPMAKER_ONLINE) {
                this.setStatus(cloudKey ? `Deleted ${trackName} from your cloud maps.` : `Discarded unsaved track ${trackName}.`);
            } else {
                this.setStatus((originalKey
                    ? `Removed ${trackName}.`
                    : `Discarded unsaved track ${trackName}.`) + cloudResult);
            }
            this.scheduleDraftRecovery();
        } catch (error) {
            console.error(error);
            this.setStatus(error.message, true);
        } finally {
            this.removeTrackBtn.disabled = false;
            this.busy = false;
            this.syncActionButtons();
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
            DEFAULT_DRAW_WIDTH,
            { startDistance: nearest.distance, direction, cornerRadius: this.getCornerRadius() },
        );
        if (!generated) return;
        this.track.checkpoints = generated.checkpoints;
    }

    hasTrackGeometry() {
        return this.track.outer.length >= 3 && this.track.inner.length >= 3;
    }

    getCanvasHint() {
        const click = this.touchInput ? 'Tap' : 'Click';
        if (this.state.tool === 'draw') {
            const pointCount = this.state.draftLoop.length;
            if (pointCount === 0) {
                return `${click} to start the road.`;
            }
            if (pointCount < 3) {
                return `${click} to add ${3 - pointCount} more point${pointCount === 2 ? '' : 's'}.`;
            }
            if (this.state.draftCloseHover) {
                return `${click} to close the road.`;
            }
            return `${click} to add a point. ${click} the first point to close the road.`;
        }
        if (!this.hasTrackGeometry()) {
            return 'No road yet. Use Draw.';
        }
        const kind = this.state.selectedHandle?.kind;
        if (kind === 'startPos') {
            return 'Drag to move the start.';
        }
        if (kind === 'startLine' || kind === 'checkpoint') {
            return 'Drag to slide it along the road.';
        }
        if (this.touchInput) {
            return 'Tap to select, drag to move. Pinch to zoom.';
        }
        return 'Click to select, drag to move. Shift+click a wall adds a point. Delete removes. Cmd+Z undoes.';
    }

    updateCanvasHint() {
        this.hintText = this.getCanvasHint();
        this.renderCanvasHint();
    }

    renderCanvasHint() {
        this.canvasHint.textContent = this.statusMessage ?? this.hintText;
        this.canvasHint.dataset.kind = this.statusMessage === null ? 'hint' : this.statusIsError ? 'error' : 'status';
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

    getAllHandles() {
        if (!this.hasTrackGeometry()) {
            return [];
        }
        const handles = ['outer', 'inner'].flatMap((path) => this.track[path].map((point, index) => ({
            kind: 'polygon',
            path,
            index,
            point,
        })));
        handles.push(
            { kind: 'startLine', endpoint: 'p1', point: this.track.startLine.p1 },
            { kind: 'startLine', endpoint: 'p2', point: this.track.startLine.p2 },
            { kind: 'startPos', point: this.track.startPos },
        );
        this.track.checkpoints.forEach((checkpoint, checkpointIndex) => {
            handles.push(
                { kind: 'checkpoint', checkpointIndex, endpoint: 'p1', point: checkpoint.p1 },
                { kind: 'checkpoint', checkpointIndex, endpoint: 'p2', point: checkpoint.p2 },
            );
        });
        return handles;
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

    // Fingers are less exact than a mouse, so touch gets larger hit areas.
    get hitScale() {
        return this.touchInput ? 2 : 1;
    }

    hitTest(canvasPoint, viewport = this.getViewport(), handles = this.getAllHandles()) {
        let best = null;
        const hitRadius = 12 * this.hitScale;
        handles.forEach((handle) => {
            const screen = this.worldToScreen(handle.point, viewport);
            const dist = Math.hypot(screen.x - canvasPoint.x, screen.y - canvasPoint.y);
            if (dist > hitRadius) {
                return;
            }

            const priority = this.handleMatches(this.state.selectedHandle, handle) ? 2 : 0;

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
        const hitRadius = 12 * this.hitScale;
        let best = null;

        this.getSelectableSegments().forEach((segment) => {
            const start = this.worldToScreen(segment.a, viewport);
            const end = this.worldToScreen(segment.b, viewport);
            const match = distanceToSegment(canvasPoint, start, end);
            const radius = (
                segment.kind === 'startLineSegment'
                || segment.kind === 'checkpointSegment'
            )
                ? 14 * this.hitScale
                : hitRadius;
            if (match.distance <= radius && (!best || match.distance < best.distance)) {
                best = { segment, distance: match.distance };
            }
        });

        return best ? best.segment : null;
    }

    selectHandle(handle) {
        if (!handle) {
            return;
        }
        this.setTool('edit', handle);
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
        return distance(canvasPoint, screenPoint) <= 18 * this.hitScale ? startPoint : null;
    }

    // Online, Save keeps an unfinished road, so a drawn point is a change to save.
    draftLoopChanged() {
        if (MAPMAKER_ONLINE) {
            this.state.dirtyTrackKeys.add(this.state.selectedTrackKey);
            this.syncActionButtons();
        }
        this.scheduleDraftRecovery();
    }

    addDraftLoopPoint(point) {
        const lastPoint = this.state.draftLoop[this.state.draftLoop.length - 1];
        if (lastPoint && distance(lastPoint, point) < 0.35) {
            return;
        }
        this.state.draftLoop = [...this.state.draftLoop, clonePoint(point)];
        this.state.draftCursor = clonePoint(point);
        this.state.draftCloseHover = false;
        this.draftLoopChanged();
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
        this.draftLoopChanged();
        this.setStatus(this.state.draftLoop.length ? 'Removed last draft point.' : 'Cleared draft loop.');
        this.updateCanvasHint();
        this.draw();
    }

    clearDraftLoop() {
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.draftLoopChanged();
        this.setStatus('Cleared draft loop.');
        this.updateCanvasHint();
        this.draw();
    }

    commitDraftLoop(points) {
        const cornerRadius = this.getCornerRadius();
        const generated = buildTrackFromLoop(points, DEFAULT_DRAW_WIDTH, cornerRadius);
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
        delete this.track.lineSmoothing;
        delete this.track.drawWidth;
        this.autoRoadGuideByKey.set(this.state.selectedTrackKey, {
            centerline: generated.centerline,
            wallSignature: JSON.stringify([generated.outer, generated.inner]),
            manualGates: false,
        });
        this.syncCornerRadiusControl();
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.draftLoopsByKey.delete(this.state.selectedTrackKey);
        this.setTool('edit', { kind: 'polygon', path: 'outer', index: 0 });
        this.markDirty('Built walls from closed line loop.');
        return true;
    }

    // A mouse pan moves at once. A finger pans only once it moves past the
    // tap slop, so a tap still draws or selects.
    startPan(event, canvasPoint, moved) {
        this.canvas.setPointerCapture(event.pointerId);
        this.state.drag = {
            type: 'pan',
            startX: canvasPoint.x,
            startY: canvasPoint.y,
            panX: this.state.view.panX,
            panY: this.state.view.panY,
            moved,
        };
        if (moved) {
            this.state.skipDrawClick = true;
            this.canvas.dataset.pan = 'true';
        }
    }

    // One finger works like the mouse. A second finger pinches to zoom and
    // pan, and ends what the first finger was doing. Returns true when this
    // finger is part of a pinch.
    trackTouch(event) {
        this.touchPoints.set(event.pointerId, this.getCanvasPoint(event));
        if (this.touchPoints.size === 1) {
            this.state.skipDrawClick = false;
            return false;
        }
        if (this.touchPoints.size === 2) {
            this.endDrag();
            const [a, b] = [...this.touchPoints.values()];
            this.pinch = { spread: distance(a, b), center: midpoint(a, b) };
            this.state.skipDrawClick = true;
        }
        return true;
    }

    movePinch() {
        const [a, b] = [...this.touchPoints.values()];
        const center = midpoint(a, b);
        const spread = distance(a, b);
        this.state.view.panX += center.x - this.pinch.center.x;
        this.state.view.panY += center.y - this.pinch.center.y;
        const zoom = this.state.view.zoom * spread / Math.max(1, this.pinch.spread);
        this.pinch = { spread, center };
        this.setZoom(zoom, center);
        this.draw();
    }

    onPointerDown(event) {
        document.activeElement?.blur?.();
        this.touchInput = event.pointerType === 'touch';
        if (this.touchInput && this.trackTouch(event)) return;
        const viewport = this.getViewport();
        const canvasPoint = this.getCanvasPoint(event);

        if (event.button === 1 || this.state.isSpaceDown) {
            this.startPan(event, canvasPoint, true);
            return;
        }

        if (this.state.tool === 'draw') {
            if (this.touchInput) {
                this.startPan(event, canvasPoint, false);
                return;
            }
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

        const selected = this.state.selectedHandle;
        if (event.shiftKey && selected?.kind === 'polygon') {
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            this.insertPointNear(worldPoint);
            return;
        }

        if (selected?.kind === 'startPos') {
            this.beginHistoryEdit();
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            this.snapStartPoseToLine({
                seedPoint: worldPoint,
                status: 'Moved start car (snapped perpendicular to start line).',
            });
            return;
        }

        this.state.selectedHandle = null;
        if (this.touchInput) this.startPan(event, canvasPoint, false);
        this.draw();
    }

    onPointerMove(event) {
        this.touchInput = event.pointerType === 'touch';
        if (this.touchPoints.has(event.pointerId)) {
            this.touchPoints.set(event.pointerId, this.getCanvasPoint(event));
            if (this.pinch) {
                this.movePinch();
                return;
            }
        }
        const viewport = this.getViewport();
        const canvasPoint = this.getCanvasPoint(event);
        const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);

        const drag = this.state.drag;
        if (drag?.type === 'pan') {
            const dx = canvasPoint.x - drag.startX;
            const dy = canvasPoint.y - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) < TOUCH_TAP_SLOP) return;
            drag.moved = true;
            this.state.skipDrawClick = true;
            this.state.view.panX = drag.panX + dx;
            this.state.view.panY = drag.panY + dy;
            this.draw();
            return;
        }

        if (this.state.tool === 'draw') {
            const lastPoint = this.state.draftLoop[this.state.draftLoop.length - 1] ?? null;
            this.state.draftCursor = snapLineBuildPoint(lastPoint, worldPoint);
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
        const lastPoint = this.state.draftLoop[this.state.draftLoop.length - 1] ?? null;
        const snapped = snapLineBuildPoint(lastPoint, worldPoint);
        if (!snapped) {
            return;
        }
        this.addDraftLoopPoint(snapped);
    }

    onPointerUp(event) {
        if (this.touchPoints.delete(event.pointerId) && this.pinch) {
            if (!this.touchPoints.size) this.pinch = null;
            return;
        }
        this.endDrag();
    }

    endDrag() {
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
            this.markDirty('Nudged selected point.');
        }
    }

    insertPointNear(worldPoint) {
        const path = this.state.selectedHandle?.kind === 'polygon'
            ? this.state.selectedHandle.path
            : null;
        const polygon = path ? this.track[path] : null;
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

    // The touch Add point button: a new wall point halfway to the next one.
    insertPointAfterSelected() {
        const handle = this.state.selectedHandle;
        if (handle?.kind !== 'polygon') {
            this.setStatus('Select a wall point first.', true);
            return;
        }
        const polygon = this.track[handle.path];
        const next = polygon[(handle.index + 1) % polygon.length];
        this.insertPointOnSegment(handle.path, handle.index, midpoint(polygon[handle.index], next));
    }

    deleteSelectedPoint() {
        const handle = this.state.selectedHandle;
        if (handle?.kind === 'checkpoint') {
            this.deleteCheckpoint();
            return;
        }
        if (!handle || handle.kind !== 'polygon') {
            this.setStatus('Select a wall point or a checkpoint first.', true);
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
        this.markDirty(`Deleted ${handle.path} point.`);
    }

    // A checkpoint added or deleted by hand stops Draw from placing them again.
    keepCheckpointsAsEdited() {
        const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
        if (guide) guide.manualGates = true;
    }

    addCheckpoint() {
        const placed = this.hasTrackGeometry() ? placeCheckpointInLongestGap(this.track) : null;
        if (!placed) {
            this.setStatus('No room for a checkpoint. Fix the problems under Checks first.', true);
            return;
        }
        this.keepCheckpointsAsEdited();
        this.track.checkpoints.splice(placed.index, 0, placed.checkpoint);
        this.setTool('edit', { kind: 'checkpoint', checkpointIndex: placed.index });
        this.markDirty(`Added CP ${placed.index + 1}.`);
    }

    deleteCheckpoint() {
        const handle = this.state.selectedHandle;
        if (handle?.kind !== 'checkpoint') {
            this.setStatus('Select a checkpoint on the map first.', true);
            return;
        }
        this.keepCheckpointsAsEdited();
        this.track.checkpoints.splice(handle.checkpointIndex, 1);
        this.state.selectedHandle = null;
        this.markDirty(`Deleted CP ${handle.checkpointIndex + 1}.`);
    }

    syncCheckpointPanel() {
        const count = String(this.track.checkpoints.length);
        if (this.checkpointCount.textContent !== count) this.checkpointCount.textContent = count;
        this.addCheckpointBtn.disabled = !this.hasTrackGeometry();
        this.deleteCheckpointBtn.disabled = this.state.selectedHandle?.kind !== 'checkpoint';
    }

    setStatus(message, isError = false) {
        this.statusMessage = message;
        this.statusIsError = isError;
        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => {
            this.statusMessage = null;
            this.renderCanvasHint();
        }, Math.max(isError ? STATUS_ERROR_MS : STATUS_MS, message.length * STATUS_MS_PER_CHAR));
        this.renderCanvasHint();
    }

    markDirty(message, updateStatus = true, options = {}) {
        if (options.recordHistory !== false && this.activeHistoryEditKey !== this.state.selectedTrackKey) {
            const history = this.getEditHistory();
            history.recordEdit(history.current(), this.track);
        }
        this.state.dirtyTrackKeys.add(this.state.selectedTrackKey);
        this.syncActionButtons();
        if (updateStatus) {
            this.setStatus(message);
        }
        this.scheduleDraftRecovery();
        this.scheduleQualityCheck();
        this.draw();
    }

    syncActionButtons() {
        const key = this.state.selectedTrackKey;
        const isDirty = this.state.dirtyTrackKeys.has(key);
        this.saveTrackBtn.textContent = isDirty ? 'Save' : 'Saved';
        this.saveTrackBtn.disabled = this.busy || !isDirty;
        // Only the local Mapmaker can remove a track from the game.
        this.removeTrackBtn.hidden = MAPMAKER_ONLINE
            && this.state.originalTrackKeyByKey.has(key) && !this.cloudKeyByKey.has(key);
    }

    markSaved(message) {
        this.baselineQualityCodesByKey.set(this.state.selectedTrackKey, new Set(
            validateTrackQuality(this.track).issues
                .filter((issue) => issue.severity === 'error')
                .map((issue) => issue.code),
        ));
        this.baselineGeometryByKey.set(this.state.selectedTrackKey, geometrySignature(this.track));
        this.state.dirtyTrackKeys.delete(this.state.selectedTrackKey);
        this.syncActionButtons();
        this.setStatus(message);
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
        const radius = isSelected ? 8 : isHovered ? 7 : 4.5;
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
        this.ctx.globalAlpha = isSelected || isHovered ? 1 : 0.45;
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
            this.ctx.lineWidth = DEFAULT_DRAW_WIDTH * viewport.scale + 4;
            this.ctx.stroke(openPath);
            this.ctx.strokeStyle = '#475569';
            this.ctx.lineWidth = DEFAULT_DRAW_WIDTH * viewport.scale;
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
        const smoothed = smoothOpenPoints(points);
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
                ? Math.min(DEFAULT_DRAW_WIDTH / 2, maxTrim / tanHalf)
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
        const width = DEFAULT_DRAW_WIDTH;
        const cornerRadius = this.getCornerRadius();
        const cached = this.draftRoadPreview;
        const cacheMatches = cached?.points === points
            && cached.width === width
            && cached.cornerRadius === cornerRadius;
        let generated = cached?.generated;
        if (!cacheMatches) {
            const walls = buildRoadWallsFromLoop(points, width);
            generated = walls ? buildTrackGeometry({
                outer: walls.outer,
                inner: walls.inner,
                cornerRadius,
            }) : null;
        }
        this.draftRoadPreview = {
            points, width, cornerRadius, generated,
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

    drawCheckpointLabels(selectedCheckpoint, viewport) {
        this.ctx.save();
        this.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        this.track.checkpoints.forEach((checkpoint, index) => {
            const screen = this.worldToScreen(midpoint(checkpoint.p1, checkpoint.p2), viewport);
            this.ctx.fillStyle = index === selectedCheckpoint ? '#dcfce7' : '#86efac';
            this.ctx.fillText(`CP ${index + 1}`, screen.x, screen.y - 10);
        });
        this.ctx.restore();
    }

    draw() {
        this.syncCheckpointPanel();
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

            const selectedCheckpoint = this.state.selectedHandle?.kind === 'checkpoint'
                ? this.state.selectedHandle.checkpointIndex
                : -1;
            this.track.checkpoints.forEach((checkpoint, index) => {
                const active = index === selectedCheckpoint;
                this.drawLineSegment(
                    checkpoint.p1,
                    checkpoint.p2,
                    viewport,
                    active ? '#4ade80' : 'rgba(74, 222, 128, 0.45)',
                    active ? 4 : 2
                );
            });
            this.drawCheckpointLabels(selectedCheckpoint, viewport);
        }

        this.drawFlowMarkers(viewport);
        this.drawQualityMarkers(viewport);

        this.drawDraftLoop(viewport);

        const handles = this.getAllHandles().sort((a, b) => {
            const aPriority = Number(this.handleMatches(this.state.selectedHandle, a)) * 2
                + Number(this.handleMatches(this.state.hoverHandle, a));
            const bPriority = Number(this.handleMatches(this.state.selectedHandle, b)) * 2
                + Number(this.handleMatches(this.state.hoverHandle, b));
            return aPriority - bPriority;
        });
        handles.forEach((handle) => this.drawHandle(handle, viewport));
    }

    driveDraft() {
        const track = this.track;
        if (!track || track.outer.length < 3 || track.inner.length < 3) {
            this.setStatus('Draw a closed road before driving the draft.', true);
            return;
        }
        try {
            window.sessionStorage.setItem(PLAYTEST_DRAFT_KEY, JSON.stringify({
                trackKey: this.state.selectedTrackKey,
                track,
            }));
            window.sessionStorage.setItem('mapmaker:return-from-playtest:v1', '1');
            this.flushDraftRecovery();
            this.skipBeforeUnload = true;
            window.location.assign('mapmaker-playtest.html');
        } catch (error) {
            this.setStatus('Drive Draft could not open in this browser.', true);
            console.error(error);
        }
    }

    // Online, Save keeps unfinished maps too: the checks run when the local
    // Mapmaker adds the map to the game.
    async saveToCloud() {
        const trackKey = this.state.selectedTrackKey;
        this.busy = true;
        this.syncActionButtons();
        this.setStatus(`Saving ${this.track.name} to your cloud maps...`);
        try {
            await saveCloudMap({
                trackKey,
                originalTrackKey: this.state.originalTrackKeyByKey.get(trackKey) ?? null,
                track: this.track,
                draftLoop: this.state.draftLoop,
                medalRow: this.medalRowByKey.get(trackKey) ?? null,
                replaceKey: this.cloudKeyByKey.get(trackKey) ?? null,
            });
            this.cloudKeyByKey.set(trackKey, trackKey);
            this.markSaved(`Saved ${this.track.name} to cloud maps. Add it to the game from the Mapmaker at home.`);
        } catch (error) {
            console.error(error);
            this.setStatus(error.message, true);
        } finally {
            this.busy = false;
            this.syncActionButtons();
        }
    }

    async saveAndIntegrateTrack() {
        if (MAPMAKER_ONLINE) {
            await this.saveToCloud();
            return;
        }
        const invalidTrack = this.validateTrack(this.track);
        if (invalidTrack) {
            this.setStatus(`Cannot save ${this.track.name}: ${invalidTrack}.`, true);
            return;
        }

        const trackKey = this.state.selectedTrackKey;
        const originalTrackKey = this.state.originalTrackKeyByKey.get(trackKey) ?? null;
        if (
            originalTrackKey
            && originalTrackKey !== trackKey
            && !window.confirm(
                `Rename ${originalTrackKey} to ${trackKey}? The old track file is replaced.`,
            )
        ) {
            return;
        }
        const savedStage = this.getSavedStage(trackKey);
        const medalRow = this.medalRowByKey.get(trackKey) ?? null;
        if (savedStage) {
            const rowError = getMedalRowError(this.getMedalRow(trackKey));
            if (rowError) {
                this.setStatus(`Cannot save ${this.track.name} as a ${savedStage.series.name} stage: ${rowError}`, true);
                return;
            }
        } else if (medalRow && getMedalRowError(medalRow)) {
            this.setStatus(`Cannot save ${this.track.name}: ${getMedalRowError(medalRow)}`, true);
            return;
        }

        this.busy = true;
        this.syncActionButtons();
        this.setStatus(`Saving ${this.track.name}...`);
        try {
            const response = await fetch('/__mapmaker/save-track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trackKey,
                    originalTrackKey,
                    trackName: this.track.name,
                    medalRow,
                    track: this.track,
                }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(result.error || `Save failed with status ${response.status}.`);
            }

            if (savedStage) savedStage.series.stages[savedStage.stageIndex].trackKey = trackKey;
            if (originalTrackKey && originalTrackKey !== trackKey && this.medalTimes[originalTrackKey]) {
                this.medalTimes[trackKey] = this.medalTimes[originalTrackKey];
                delete this.medalTimes[originalTrackKey];
            }
            if (medalRow) this.medalTimes[trackKey] = normalizeMedalRow(medalRow);
            this.medalRowByKey.delete(trackKey);
            this.state.originalTrackKeyByKey.set(trackKey, trackKey);
            const useText = result.action === 'created'
                ? ' Assign it in the Campaign Planner.'
                : '';
            const cloudText = await this.deleteCloudCopy(trackKey);
            this.markSaved(`Saved ${this.track.name}.${useText}${cloudText}`);
        } catch (error) {
            console.error(error);
            this.setStatus(
                `${error.message} Run Mapmaker through the local Vite server.`,
                true,
            );
        } finally {
            this.busy = false;
            this.syncActionButtons();
        }
    }
}

new MapmakerApp();
