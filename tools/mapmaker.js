import { CONFIG } from '../game/config.js';
import { getDefaultDrawnCarAssetForGround } from '../game/car/car-skin-grounds.js';
import { DRAWN_CAR_DRAW_PIXELS } from '../game/car/drawn-car/formula.js';
import { getDrawnCar } from '../game/car/sprite.js';
import { TRACK_GROUNDS, TRACK_GROUND_KEYS, getStoredTrackGroundKey, getTrackGround } from '../game/track/grounds.js';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { buildTrackGeometry } from '../game/track/runtime.js';
import { TRACKS } from '../game/track/tracks.js';
import {
    buildPerpendicularLaneGate,
} from './mapmaker/lane-gate.js';
import { buildAutoGates } from './mapmaker/auto-gates.js';
import { placeCheckpointInLongestGap, validateTrackQuality } from './mapmaker/track-quality.js';
import { analyzeTrackFlow, FLOW_DRAW_GUIDE, measureStraights } from './mapmaker/track-flow.js';
import {
    clearDraftRecovery,
    createEditHistory,
    DRAFT_RECOVERY_KEY,
    loadDraftRecovery,
    saveDraftRecovery,
} from './mapmaker/edit-history.js';
import { snapLineBuildPoint } from './mapmaker/line-build.js';
import { moveCorner, selectCorner } from './mapmaker/corner-edit.js';
import { buildRoadLine, isValidRoadLine, MAX_ROAD_LINE_POINTS, withRoadLine } from './mapmaker/road-line.js';
import {
    buildRoadFromLine,
    buildRoadWallsFromLoop,
    buildTrackFromLoop,
    dedupeStrokePoints,
    normalizeTrackLayout,
    smoothLoopPoints,
    smoothOpenPoints,
    startOnLoop,
} from './mapmaker/road-build.js';
import { wallContinuations } from './mapmaker/wall-continuation.js';
import { snapStartPose } from './mapmaker/start-pose.js';
import { fitCurvesToCorners } from './mapmaker/ribbon-walls.js';
import {
    DEFAULT_DRAW_WIDTH,
    ROAD_WIDTHS,
    WIDE_ROAD_WIDTH,
    isValidTrackKey,
    trackKeyFromName
} from './mapmaker/track-source.js';
import { clamp, clonePoint, distance, midpoint, normalizeVector } from './geometry.js';
import seriesFileData from '../game/campaign/series.json' with { type: 'json' };
import medalTimesFileData from '../game/medals/medal-times.json' with { type: 'json' };
import { isAppCampaignSeriesLive } from '../game/campaign/series-rules.js';
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
import { creatorApi } from './mapmaker/creator-api.js';
import { CreatorPanels } from './mapmaker/creator-panels.js';
import {
    captureUnsavedCreatorWork,
    hasCreatorUnsavedWork,
    isCreatorTrackAtSavedVersion,
    keepLockedCreatorDraft,
    loadLockedCreatorTrack,
    rememberSavedCreatorContent,
    restoreUnsavedCreatorWork,
    saveCreatorTrackWithRecovery,
} from './mapmaker/creator-track-save.js';
import {
    clearPendingMedalText,
    hasPendingMedalText,
    medalFieldText,
    movePendingMedalText,
    readPendingMedalText,
    setPendingMedalText,
} from './mapmaker/pending-medal-text.js';
import {
    MAPMAKER_ONLINE, cloudStorageKey, closeCloudSession, deleteCloudMap, getCloudGroundKeys,
    listCloudMaps, loadCloudSession, saveCloudMap, verifyCloudSession,
} from './mapmaker/cloud-maps.js';

const PANEL_HIDDEN_KEY = 'mapmaker:panel-hidden:v1';
const PLAYTEST_DRAFT_KEY = 'mapmaker:playtest-draft:v1';
const CREATOR_MODE = document.body?.dataset.creator === 'true';
const STATUS_MS = 3500;
const STATUS_ERROR_MS = 8000;
const STATUS_MS_PER_CHAR = 60;
// Picker cards for cloud maps in the local Mapmaker use this key prefix, which
// no track key can have.
const CLOUD_CARD_PREFIX = 'cloud:';
// A finger that moves less than this many pixels is a tap, not a pan.
const TOUCH_TAP_SLOP = 8;
const BLANK_VIEW_BOUNDS = { minX: -40, maxX: 40, minY: -30, maxY: 30 };
const DEFAULT_CORNER_RADIUS = 3;
const CORNER_RADIUS_PRESETS = [
    { value: 0, label: 'Sharp' },
    { value: 1.5, label: 'A bit rounded' },
    { value: 3, label: 'Rounded' },
    { value: 5, label: 'Soft' },
];
const CORNER_RADIUS_VALUES = CORNER_RADIUS_PRESETS.map((preset) => preset.value);

// Editor-only schematic colors. Ground remains visible through a restrained road tint.
const EDITOR_ROAD_TONES = Object.freeze({
    tarmac: ['#344255', '#273548'],
    grip: ['#344255', '#273548'],
    dirt: ['#4a403d', '#342f30'],
    snow: ['#526174', '#3d4d60'],
    water: ['#2d5366', '#244154'],
    space: ['#3b3c60', '#292d4d'],
});
const EDITOR_EDGE = Object.freeze({ outer: '#ff8ca4', inner: '#c0deff' });

const CAR_RADIUS = CONFIG.carRadius;

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
        this.creatorMode = CREATOR_MODE;
        this.canvas = document.getElementById('map-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.trackPickerBtn = document.getElementById('track-picker-btn');
        this.trackPickerName = document.getElementById('track-picker-name');
        this.trackPickerDialog = document.getElementById('track-picker-dialog');
        this.trackSearch = document.getElementById('track-search');
        this.trackPlaceFilters = document.getElementById('track-place-filters');
        this.trackGroundFilters = document.getElementById('track-ground-filters');
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
        this.cornerRadiusScope = document.getElementById('corner-radius-scope');
        this.cornerRadiusHint = document.getElementById('corner-radius-hint');
        this.groundOptions = document.getElementById('ground-options');
        this.roadWidthOptions = document.getElementById('road-width-options');
        this.roadWidthScope = document.getElementById('road-width-scope');
        this.roadWidthHint = document.getElementById('road-width-hint');
        this.saveTrackBtn = document.getElementById('save-track-btn');
        this.creatorSaveStatus = document.getElementById('creator-save-status');
        this.creatorLockNote = document.getElementById('creator-lock-note');
        this.creatorLockActions = document.getElementById('creator-lock-actions');
        this.creatorKeepCopyBtn = document.getElementById('creator-keep-copy-btn');
        this.creatorLoadLockedBtn = document.getElementById('creator-load-locked-btn');
        this.creatorDriveDialog = document.getElementById('creator-drive-dialog');
        this.creatorDriveFrame = document.getElementById('creator-drive-frame');
        this.newTrackBtn = document.getElementById('new-track-btn');
        this.removeTrackBtn = document.getElementById('remove-track-btn');
        this.checkpointCount = document.getElementById('checkpoint-count');
        this.addCheckpointBtn = document.getElementById('add-checkpoint-btn');
        this.deleteCheckpointBtn = document.getElementById('delete-checkpoint-btn');
        this.checkpointHint = document.getElementById('checkpoint-hint');
        this.confirmDialog = document.getElementById('confirm-dialog');
        this.confirmDialogTitle = document.getElementById('confirm-dialog-title');
        this.confirmDialogMessage = document.getElementById('confirm-dialog-message');
        this.confirmDialogButton = document.getElementById('confirm-dialog-button');
        this.driveDraftBtn = document.getElementById('drive-draft-btn');
        this.restoreDraftsDialog = document.getElementById('restore-drafts-dialog');
        this.restoreDraftsDialogMessage = document.getElementById('restore-drafts-dialog-message');
        this.qualityCount = document.getElementById('quality-count');
        this.qualityIssues = document.getElementById('quality-issues');
        this.flowTips = document.getElementById('flow-tips');
        this.flowCount = document.getElementById('flow-count');
        this.flowRules = document.getElementById('flow-rules');

        const ownTracksOnly = this.creatorMode || MAPMAKER_ONLINE;
        const initialTrackKey = ownTracksOnly ? 'newTrack' : Object.keys(TRACKS)[0];
        this.state = {
            tracks: ownTracksOnly ? { newTrack: createBlankTrack() } : cloneTracks({ ...TRACKS }),
            selectedTrackKey: initialTrackKey,
            tool: 'edit',
            selectedHandle: null,
            selectedCorner: null,
            radiusScope: 'track',
            widthScope: 'track',
            // The road width of the next Draw.
            drawWidth: DEFAULT_DRAW_WIDTH,
            hoverHandle: null,
            hoverSegment: null,
            drag: null,
            dirtyTrackKeys: new Set(),
            originalTrackKeyByKey: new Map(ownTracksOnly ? []
                : Object.keys(TRACKS).map((trackKey) => [trackKey, trackKey])),
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
        this.medalTimes = MAPMAKER_ONLINE ? {} : { ...medalTimesFileData };
        this.medalRowByKey = new Map();
        // Typed medal text that is not in the medal row yet, by track and tier.
        this.pendingMedalText = new Map();
        // Saves with no clear answer, by track key: the server may have them.
        this.uncertainTracksByKey = new Map();
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
        this.creatorLoaded = !this.creatorMode;
        this.creatorLoading = false;
        // Track key -> its stored record in the Creator: revision, lock, origin.
        this.creatorRecords = new Map();
        this.creatorSaveErrors = new Map();
        this.creatorSavingKey = null;
        this.creatorDeletingKey = null;
        this.creatorWriteGeneration = 0;
        this.creatorRefreshPending = false;
        this.creatorUsername = null;
        this.creatorPanels = null;
        // Track key -> the key of its saved cloud map.
        this.cloudKeyByKey = new Map();
        // The local Mapmaker lists the cloud maps in the track picker.
        this.cloudMaps = [];
        this.cloudMapsError = '';
        this.cloudReady = !MAPMAKER_ONLINE;
        this.scheduleKeys = new Set(TRACK_SCHEDULE_KEYS);
        this.trackPickerPlace = 'all';
        this.trackPickerGround = 'all';
        this.touchInput = window.matchMedia('(pointer: coarse)').matches;
        this.touchPoints = new Map();
        this.pinch = null;

        if (MAPMAKER_ONLINE) {
            document.querySelectorAll('.local-only').forEach((element) => { element.hidden = true; });
            document.querySelectorAll('.online-only').forEach((element) => { element.hidden = false; });
        }
        this.buildOptionGroup(this.cornerRadiusOptions, 'corner-radius', CORNER_RADIUS_PRESETS);
        if (this.roadWidthOptions) this.buildOptionGroup(this.roadWidthOptions, 'road-width', ROAD_WIDTHS);
        this.buildGroundControls();
        this.buildFilterGroup(this.trackPlaceFilters, [
            { value: 'all', label: 'All' },
            ...(MAPMAKER_ONLINE ? [] : [
                { value: 'daily', label: 'Daily' },
                { value: 'campaign', label: 'Campaign' },
                { value: 'unused', label: 'Not used' },
                ...(this.creatorMode ? [] : [{ value: 'cloud', label: 'Cloud' }]),
            ]),
        ], (value) => {
            this.trackPickerPlace = value;
            this.renderTrackPicker();
        });
        let storedPanelHidden = null;
        try { storedPanelHidden = getBrowserStorage('localStorage')?.getItem(PANEL_HIDDEN_KEY); } catch {}
        this.setPanelHidden(this.creatorMode ? window.matchMedia('(max-width: 900px)').matches : storedPanelHidden === null
            ? window.matchMedia('(max-width: 900px)').matches
            : storedPanelHidden === '1');
        this.bindEvents();
        this.loadTrack(initialTrackKey);
        this.resizeCanvas();

        const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        resizeObserver.observe(this.canvas.parentElement);
        if (this.creatorMode) {
            this.setCreatorEditable(false);
            this.newTrackBtn.disabled = true;
            this.creatorPanels = new CreatorPanels({
                onOpenTrack: (trackKey) => this.openCreatorTrack(trackKey),
                onTracksChanged: () => void this.loadCreatorTracks({ keepSelection: true }),
                setStatus: (message, isError) => this.setStatus(message, isError),
                confirm: (options) => this.confirmAction(options),
                choose: (options) => this.chooseAction(options),
            });
            this.bindCreatorTabs();
            this.bindCreatorLockActions();
            document.getElementById('creator-loader-retry')
                ?.addEventListener('click', () => void this.loadCreatorTracks());
            void this.loadCreatorTracks();
        } else if (MAPMAKER_ONLINE) {
            document.getElementById('cloud-retry-btn').addEventListener('click', () => void this.loadCloudMapsOnline());
            document.querySelectorAll('[data-switch-password]').forEach((button) => {
                button.addEventListener('click', () => void this.switchCloudPassword());
            });
            window.addEventListener('pageshow', (event) => {
                if (event.persisted) window.location.reload();
            });
            window.addEventListener('focus', () => {
                if (!this.cloudReady) return;
                void verifyCloudSession().catch(() => {
                    this.flushDraftRecovery();
                    window.location.reload();
                });
            });
            void this.loadCloudMapsOnline();
        } else {
            this.offerDraftRecovery();
        }
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
        if (this.creatorMode || !this.cloudReady) return;
        if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(() => this.flushDraftRecovery(), 200);
    }

    flushDraftRecovery() {
        if (this.creatorMode || !this.cloudReady) return;
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
            ...(MAPMAKER_ONLINE ? {
                cloudKey: this.cloudKeyByKey.get(key) ?? null,
                medalRow: this.getMedalRow(key),
                pendingMedalText: Object.fromEntries(this.pendingMedalText.get(key) ?? []),
            } : {}),
        }));
        if (drafts.length) {
            saveDraftRecovery(getBrowserStorage('localStorage'), {
                selectedTrackKey: keys.has(this.state.selectedTrackKey) ? this.state.selectedTrackKey : null,
                drafts,
            }, cloudStorageKey(DRAFT_RECOVERY_KEY));
        } else {
            clearDraftRecovery(getBrowserStorage('localStorage'), cloudStorageKey(DRAFT_RECOVERY_KEY));
        }
    }

    offerDraftRecovery() {
        const recovery = loadDraftRecovery(getBrowserStorage('localStorage'), cloudStorageKey(DRAFT_RECOVERY_KEY));
        if (!recovery?.drafts.length) {
            try { getBrowserStorage('sessionStorage')?.removeItem(cloudStorageKey('mapmaker:return-from-playtest:v1')); } catch {}
            return;
        }
        let returningFromPlaytest = false;
        try {
            returningFromPlaytest = getBrowserStorage('sessionStorage')?.getItem(cloudStorageKey('mapmaker:return-from-playtest:v1')) === '1';
        } catch {}
        if (returningFromPlaytest) {
            try { getBrowserStorage('sessionStorage')?.removeItem(cloudStorageKey('mapmaker:return-from-playtest:v1')); } catch {}
            this.restoreDraftRecovery(recovery);
            return;
        }
        this.restoreDraftsDialogMessage.textContent = `${recovery.drafts.length} unsaved map${recovery.drafts.length === 1 ? '' : 's'} found.`;
        this.restoreDraftsDialog.returnValue = '';
        this.restoreDraftsDialog.showModal();
        this.restoreDraftsDialog.addEventListener('close', () => {
            if (this.restoreDraftsDialog.returnValue !== 'restore') {
                clearDraftRecovery(getBrowserStorage('localStorage'), cloudStorageKey(DRAFT_RECOVERY_KEY));
                return;
            }
            this.restoreDraftRecovery(recovery);
        }, { once: true });
    }

    // Puts a draft in the editor as an unsaved track. A renamed draft replaces
    // the saved track it came from.
    addDraft(draft) {
        if (!MAPMAKER_ONLINE && draft.originalTrackKey && draft.originalTrackKey !== draft.trackKey) {
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
        else this.draftLoopsByKey.delete(draft.trackKey);
        if (draft.cloudKey) this.cloudKeyByKey.set(draft.trackKey, draft.cloudKey);
        if (Object.hasOwn(draft, 'medalRow')) {
            if (draft.medalRow) this.medalRowByKey.set(draft.trackKey, draft.medalRow);
            else this.medalRowByKey.delete(draft.trackKey);
        }
        if (draft.pendingMedalText) {
            this.pendingMedalText.set(draft.trackKey, new Map(Object.entries(draft.pendingMedalText)));
        }
        this.editHistories.set(draft.trackKey, createEditHistory(draft.track));
    }

    restoreDraftRecovery(recovery) {
        recovery.drafts.forEach((draft) => {
            if (MAPMAKER_ONLINE && draft.cloudKey && draft.cloudKey !== draft.trackKey) {
                delete this.state.tracks[draft.cloudKey];
                this.cloudKeyByKey.delete(draft.cloudKey);
                this.editHistories.delete(draft.cloudKey);
                this.medalRowByKey.delete(draft.cloudKey);
                this.state.originalTrackKeyByKey.delete(draft.cloudKey);
            }
            this.addDraft(draft);
        });
        this.loadTrack(this.state.tracks[recovery.selectedTrackKey] ? recovery.selectedTrackKey : recovery.drafts[0].trackKey);
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
        if (this.cloudLoading) return;
        this.cloudLoading = true;
        document.querySelector('.maker-header').inert = true;
        document.querySelector('.maker-editor').inert = true;
        const loadState = document.getElementById('cloud-load-state');
        loadState.hidden = false;
        document.getElementById('cloud-load-message').textContent = 'Loading your maps…';
        document.getElementById('cloud-retry-btn').hidden = true;
        let maps;
        try {
            await loadCloudSession();
            this.buildGroundControls();
            maps = await listCloudMaps();
        } catch (error) {
            document.getElementById('cloud-load-message').textContent = `Cannot load your maps: ${error.message}`;
            document.getElementById('cloud-retry-btn').hidden = false;
            this.cloudLoading = false;
            return;
        }
        if (maps.length && !this.cloudReady) {
            this.state.tracks = {};
            this.editHistories.clear();
        }
        for (const map of [...maps].reverse()) {
            if (this.state.dirtyTrackKeys.has(map.trackKey)) {
                this.cloudKeyByKey.set(map.trackKey, map.trackKey);
                continue;
            }
            this.addCloudMap(map);
            this.state.dirtyTrackKeys.delete(map.trackKey);
        }
        // Open the track just driven in Test Drive, else the newest cloud map.
        let drivenKey = null;
        try {
            drivenKey = JSON.parse(getBrowserStorage('sessionStorage')?.getItem(cloudStorageKey(PLAYTEST_DRAFT_KEY)) ?? 'null')?.trackKey ?? null;
        } catch {}
        const openKey = this.state.dirtyTrackKeys.size
            ? this.state.selectedTrackKey
            : [drivenKey, maps[0]?.trackKey, this.state.selectedTrackKey].find((key) => key && this.state.tracks[key]);
        this.loadTrack(this.state.tracks[openKey] ? openKey : Object.keys(this.state.tracks)[0]);
        this.cloudReady = true;
        this.cloudLoading = false;
        document.querySelector('.maker-header').inert = false;
        document.querySelector('.maker-editor').inert = false;
        loadState.hidden = true;
        this.syncMedalTimesPanel();
        this.syncActionButtons();
        this.offerDraftRecovery();
        if (this.trackPickerDialog.open) this.renderTrackPicker();
    }

    async switchCloudPassword() {
        if (this.busy) return;
        this.flushDraftRecovery();
        try {
            await closeCloudSession();
            this.skipBeforeUnload = true;
            window.location.assign('/mapmaker/');
        } catch (error) {
            this.setStatus(error.message, true);
        }
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
        if (this.creatorMode) this.syncActionButtons();
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

    buildFilterGroup(container, options, onPick) {
        container.replaceChildren(...options.map(({ value, label }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.value = value;
            button.textContent = label;
            button.addEventListener('click', () => onPick(value));
            return button;
        }));
    }

    syncFilterGroup(container, value) {
        for (const button of container.querySelectorAll('button')) {
            const active = button.dataset.value === value;
            button.dataset.active = String(active);
            button.setAttribute('aria-pressed', String(active));
        }
    }

    // Daily, a campaign series, or neither. Cloud maps are a separate list.
    trackListPlace(trackKey) {
        const savedKey = this.state.originalTrackKeyByKey.get(trackKey) ?? trackKey;
        if (findTrackStage(this.seriesData, savedKey)) return 'campaign';
        if (this.scheduleKeys.has(savedKey)) return 'daily';
        return 'unused';
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
        const bendIndex = this.getSelectedBendIndex();
        const corner = bendIndex === null ? this.state.selectedCorner : { bendIndex };
        if (!corner) this.state.radiusScope = 'track';
        const selectedPoint = corner?.radiusPoints?.[0];
        const override = bendIndex !== null
            ? this.track.roadLine.points[bendIndex].cornerRadius
            : selectedPoint && this.track[selectedPoint.path][selectedPoint.index]?.cornerRadius;
        const value = this.state.radiusScope === 'corner' && Number.isFinite(override)
            ? override : this.getCornerRadius();
        this.checkOption(this.cornerRadiusOptions, this.nearestCornerRadiusPreset(value));
        for (const button of this.cornerRadiusScope.querySelectorAll('button')) {
            const active = button.dataset.scope === this.state.radiusScope;
            button.dataset.active = String(active);
            button.setAttribute('aria-pressed', String(active));
            if (button.dataset.scope === 'corner') button.disabled = !corner;
        }
        this.cornerRadiusHint.textContent = this.state.radiusScope === 'corner'
            ? 'Applies to the selected bend. Other corners keep their setting.'
            : 'Applies to every corner on this track.';
        this.syncRoadWidthControl();
    }

    // Road width works on a road made with Draw. Before Draw, it picks the
    // width that Draw makes.
    syncRoadWidthControl() {
        if (!this.roadWidthOptions) return;
        const line = this.hasRoadLine() ? this.track.roadLine : null;
        const bendIndex = this.getSelectedBendIndex();
        if (bendIndex === null) this.state.widthScope = 'track';
        const editable = Boolean(line) || !(this.track && this.hasTrackGeometry());
        const value = !line ? this.state.drawWidth
            : this.state.widthScope === 'section' ? line.points[bendIndex].width ?? line.width : line.width;
        const nearest = ROAD_WIDTHS.reduce((best, preset) => (
            Math.abs(preset.width - value) < Math.abs(best.width - value) ? preset : best
        ));
        this.checkOption(this.roadWidthOptions, nearest.value);
        for (const input of this.roadWidthOptions.querySelectorAll('input')) {
            input.disabled = !editable;
            if (!editable) input.checked = false;
        }
        for (const button of this.roadWidthScope.querySelectorAll('button')) {
            const active = button.dataset.scope === this.state.widthScope;
            button.dataset.active = String(active);
            button.setAttribute('aria-pressed', String(active));
            if (button.dataset.scope === 'section') button.disabled = bendIndex === null;
        }
        this.roadWidthHint.textContent = !editable ? 'Only for roads made with Draw.'
            : !line ? 'Draw makes the road this wide.'
                : this.state.widthScope === 'section' ? 'Applies from the selected bend to the next one.'
                    : 'Applies to the whole road.';
    }

    // Whole track sets the road width and clears each section's own width.
    // Selected bend sets the road from that bend to the next one.
    setRoadWidth(value) {
        const preset = ROAD_WIDTHS.find((entry) => entry.value === value);
        if (!preset) return;
        if (!this.hasTrackGeometry()) {
            this.state.drawWidth = preset.width;
            this.syncRoadWidthControl();
            this.setStatus(`Draw makes a ${preset.label.toLowerCase()} road.`);
            this.draw();
            return;
        }
        if (!this.hasRoadLine()) return;
        const line = this.track.roadLine;
        const bendIndex = this.state.widthScope === 'section' ? this.getSelectedBendIndex() : null;
        const points = line.points.map((point, at) => {
            const { width: _, ...bend } = point;
            if (bendIndex === null) return bend;
            if (at !== bendIndex) return point;
            return preset.width === line.width ? bend : { ...bend, width: preset.width };
        });
        const width = bendIndex === null ? preset.width : line.width;
        if (!this.rebuildRoad({ ...line, points, width })) {
            this.syncRoadWidthControl();
            this.setStatus('The road cannot be this wide here.', true);
            return;
        }
        this.normalizeRoadTrack();
        this.syncRoadWidthControl();
        this.markDirty(`Set ${bendIndex === null ? 'whole road' : 'selected section'} to ${preset.label}.`);
    }

    setCornerRadius(value, options = {}) {
        const nextRadius = this.nearestCornerRadiusPreset(value);
        if (this.hasRoadLine()) {
            this.setRoadCornerRadius(nextRadius, options);
            return;
        }
        const corner = this.state.radiusScope === 'corner' ? this.state.selectedCorner : null;
        if (this.state.radiusScope === 'corner' && !corner) return;
        const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
        const guideMatchesWalls = guide?.wallSignature === JSON.stringify([this.track.outer, this.track.inner]);
        const selectedPivot = this.state.selectedCorner?.radiusPoints[0];
        const cornerPoint = selectedPivot
            ? { ...this.track[selectedPivot.path][selectedPivot.index], path: selectedPivot.path }
            : null;
        if (corner) {
            corner.radiusPoints.forEach(({ path, index }) => {
                const point = this.track[path][index];
                if (nextRadius === this.getCornerRadius()) delete point.cornerRadius;
                else point.cornerRadius = nextRadius;
            });
        } else {
            this.track.cornerRadius = nextRadius;
            for (const path of ['outer', 'inner']) {
                this.track[path].forEach((point) => { delete point.cornerRadius; });
            }
        }
        if (this.hasTrackGeometry()) {
            const walls = fitCurvesToCorners(this.track.outer, this.track.inner, this.getCornerRadius(), WIDE_ROAD_WIDTH);
            const handle = this.state.selectedHandle;
            if (handle?.kind === 'polygon' && walls[handle.path].length !== this.track[handle.path].length) {
                this.state.selectedHandle = null;
            }
            this.track.outer = walls.outer;
            this.track.inner = walls.inner;
            if (guideMatchesWalls) guide.wallSignature = JSON.stringify([walls.outer, walls.inner]);
            if (cornerPoint) {
                const points = this.track[cornerPoint.path];
                const index = points.reduce((best, point, at) => (
                    distance(point, cornerPoint) < distance(points[best], cornerPoint) ? at : best
                ), 0);
                this.state.selectedCorner = selectCorner(this.track, cornerPoint.path, index, WIDE_ROAD_WIDTH);
            }
        }
        this.syncCornerRadiusControl();
        if (options.markDirty !== false) {
            const preset = CORNER_RADIUS_PRESETS.find((entry) => entry.value === nextRadius);
            this.markDirty(
                options.status ?? `Set ${corner ? 'selected corner' : 'whole track'} to ${preset?.label ?? 'Rounded'}.`,
                options.updateStatus !== false,
            );
        }
    }

    buildGroundControls() {
        const keys = getCloudGroundKeys();
        this.buildOptionGroup(this.groundOptions, 'ground', keys.map((key) => ({
            value: key,
            label: TRACK_GROUNDS[key].label,
        })));
        this.buildFilterGroup(this.trackGroundFilters, [
            { value: 'all', label: 'Any ground' },
            ...keys.map((key) => ({ value: key, label: TRACK_GROUNDS[key].label })),
        ], (value) => {
            this.trackPickerGround = value;
            this.renderTrackPicker();
        });
    }

    syncGroundControl() {
        this.checkOption(this.groundOptions, getTrackGround(this.track).key);
    }

    setGround(key) {
        if (!getCloudGroundKeys().includes(key)) return;
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
        return measureStraights(path, { closed, halfWidth: this.state.drawWidth / 2 })
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

        // Typing keeps the text at once. The change event puts it in the row.
        for (const tier of MEDAL_TIERS) {
            this.medalInputs[tier].addEventListener('input', () => this.recordMedalText(tier));
        }
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
        this.cornerRadiusScope.addEventListener('click', (event) => {
            const scope = event.target.closest('button[data-scope]')?.dataset.scope;
            const hasCorner = Boolean(this.state.selectedCorner) || this.getSelectedBendIndex() !== null;
            if (!scope || (scope === 'corner' && !hasCorner)) return;
            this.state.radiusScope = scope;
            this.syncCornerRadiusControl();
        });

        this.roadWidthOptions?.addEventListener('change', (event) => {
            this.setRoadWidth(event.target.value);
        });
        this.roadWidthScope?.addEventListener('click', (event) => {
            const scope = event.target.closest('button[data-scope]')?.dataset.scope;
            if (!scope || (scope === 'section' && this.getSelectedBendIndex() === null)) return;
            this.state.widthScope = scope;
            this.syncRoadWidthControl();
            this.draw();
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
        document.getElementById('creator-retry-btn')?.addEventListener('click', () => this.loadCreatorTracks());

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
            const panelChanges = this.creatorPanels?.hasUnsavedChanges() ?? false;
            const trackChanges = this.creatorMode
                ? hasCreatorUnsavedWork(this)
                : this.state.dirtyTrackKeys.size > 0 || this.state.draftLoop.length > 0 || this.draftLoopsByKey.size > 0;
            if (!trackChanges && !panelChanges) return;
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
        if (!this.creatorMode) {
            try { getBrowserStorage('localStorage')?.setItem(PANEL_HIDDEN_KEY, hidden ? '1' : '0'); } catch {}
        }
    }

    openTrackPicker() {
        this.trackSearch.value = '';
        this.renderTrackPicker();
        this.trackPickerDialog.showModal();
        if (!MAPMAKER_ONLINE && !this.creatorMode) this.refreshCloudMapsLocal();
    }

    renderTrackPicker() {
        this.trackPreviews.reset();
        this.syncFilterGroup(this.trackPlaceFilters, this.trackPickerPlace);
        this.syncFilterGroup(this.trackGroundFilters, this.trackPickerGround);
        const query = this.trackSearch.value.trim().toLowerCase();
        const place = this.trackPickerPlace;
        const ground = this.trackPickerGround;
        const nameMatches = (track) => !query || track.name.toLowerCase().includes(query);
        const groundMatches = (track) => ground === 'all' || getTrackGround(track).key === ground;
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

        const showCloud = place === 'all' || place === 'cloud';
        const cloudItems = [];
        const cloudMaps = showCloud
            ? this.cloudMaps.filter((map) => nameMatches(map.track) && groundMatches(map.track))
            : [];
        if (cloudMaps.length || (showCloud && this.cloudMapsError && !query && ground === 'all')) {
            cloudItems.push(createText('h3', 'track-cards-heading', 'Cloud maps'));
            if (this.cloudMapsError) cloudItems.push(createText('p', 'field-hint', this.cloudMapsError));
            cloudItems.push(...cloudMaps.map((map) => createCard(
                CLOUD_CARD_PREFIX + map.trackKey,
                map.track,
                `Saved ${new Date(map.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
            )));
            if (place !== 'cloud') cloudItems.push(createText('h3', 'track-cards-heading', 'Tracks'));
        }

        const trackItems = [];
        if (place !== 'cloud') {
            const keys = Object.keys(this.state.tracks).reverse().filter((key) => {
                const track = this.state.tracks[key];
                return nameMatches(track)
                    && groundMatches(track)
                    && (place === 'all' || this.trackListPlace(key) === place);
            });
            trackItems.push(...keys.map((key) => {
                const track = this.state.tracks[key];
                const meta = [
                    getTrackGround(track).label,
                    this.creatorMode ? (this.creatorRecords.get(key)?.privateDraft !== false ? 'My draft' : 'Shared') : '',
                    this.cloudKeyByKey.has(key) ? 'Cloud' : '',
                    this.state.dirtyTrackKeys.has(key) ? 'Unsaved' : '',
                ].filter(Boolean).join(' · ');
                const card = createCard(key, track, meta);
                if (key === this.state.selectedTrackKey) card.setAttribute('aria-current', 'true');
                return card;
            }));
            if (!keys.length) {
                trackItems.push(createText(
                    'p',
                    'field-hint',
                    query ? 'No track has that name. Use New track to start one.' : 'No tracks match.',
                ));
            }
        } else if (!cloudMaps.length && !(this.cloudMapsError && !query && ground === 'all')) {
            cloudItems.push(createText(
                'p',
                'field-hint',
                query ? 'No cloud map has that name.' : 'No cloud maps.',
            ));
        }
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
        this.state.tool = ['draw', 'corner'].includes(tool) ? tool : 'edit';
        if (this.state.tool === 'draw') {
            this.state.selectedHandle = null;
            this.state.selectedCorner = null;
        } else if (this.state.tool === 'corner') {
            this.state.selectedHandle = null;
        } else if (arguments.length > 1) {
            this.state.selectedHandle = selectedHandle ? { ...selectedHandle } : null;
            this.state.selectedCorner = null;
        } else if (!this.state.selectedHandle && this.hasTrackGeometry() && !this.hasRoadLine()) {
            this.state.selectedHandle = { kind: 'polygon', path: 'outer', index: 0 };
            this.state.selectedCorner = null;
        }
        if (this.state.tool !== 'corner') this.state.radiusScope = 'track';
        this.syncCornerRadiusControl();
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
        if (MAPMAKER_ONLINE) return false;
        if (this.creatorMode) return this.isCreatorLocked(trackKey);
        const stage = this.getSavedStage(trackKey);
        return Boolean(stage && isAppCampaignSeriesLive(stage.series) && this.getSavedMedalRow(trackKey));
    }

    syncMedalTimesPanel() {
        const trackKey = this.state.selectedTrackKey;
        const row = this.medalRowByKey.get(trackKey)
            ?? this.medalTimes[this.state.originalTrackKeyByKey.get(trackKey) ?? trackKey]
            ?? null;
        const fixed = this.medalTimesFixed(trackKey) || Boolean(this.creatorDeletingKey);
        for (const tier of MEDAL_TIERS) {
            const pending = fixed ? undefined : readPendingMedalText(this.pendingMedalText, trackKey, tier);
            this.medalInputs[tier].value = medalFieldText(pending, row?.[tier]);
            this.medalInputs[tier].disabled = fixed;
        }

        const laps = this.track && this.cloudReady ? readDraftLaps(getBrowserStorage('localStorage'), cloudStorageKey(draftLapsStorageKey(trackKey, this.track))) : [];
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
            note.textContent = 'No Test Drive laps yet.';
            this.draftLapsList.appendChild(note);
        }

        const edited = (MAPMAKER_ONLINE ? this.state.dirtyTrackKeys.has(trackKey) : this.medalRowByKey.has(trackKey))
            || hasPendingMedalText(this.pendingMedalText, trackKey);
        const error = row ? getMedalRowError(row) : 'Set all four medal times.';
        const bronze = Number(row?.bronze);
        const notes = [];
        if (fixed) {
            notes.push(this.creatorMode ? 'Fixed: players have raced this track.' : 'Fixed: the track is in a live series.');
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

    // An author time fills the other three medals, so it replaces the whole
    // row and every typed medal text. A refused time keeps its typed text.
    setAuthorTime(authorSec) {
        if (this.medalTimesFixed()) return false;
        const row = suggestMedalTimes(authorSec);
        if (!row) {
            this.setStatus('The author time must be more than 0 s.', true);
            return false;
        }
        this.medalRowByKey.set(this.state.selectedTrackKey, row);
        clearPendingMedalText(this.pendingMedalText, this.state.selectedTrackKey);
        this.syncMedalTimesPanel();
        this.markDirty(`Set the author time to ${row.author.toFixed(2)} s.`);
        return true;
    }

    // The row takes all four fields as they show, so every typed text is in it.
    updateMedalRowFromInputs() {
        if (this.medalTimesFixed()) return;
        const row = Object.fromEntries(MEDAL_TIERS.map((tier) => [tier, Number(this.medalInputs[tier].value)]));
        this.medalRowByKey.set(this.state.selectedTrackKey, row);
        clearPendingMedalText(this.pendingMedalText, this.state.selectedTrackKey);
        this.syncMedalTimesPanel();
        this.markDirty('Changed the medal times.');
    }

    // Puts the typed medal text of the open track in its row, as the change
    // event does. A field can keep text with no change event: text typed back
    // to its first value. An author time that equals the row changes nothing,
    // so it does not fill the other medals again.
    commitPendingMedalText(key) {
        if (!hasPendingMedalText(this.pendingMedalText, key)) return true;
        if (key !== this.state.selectedTrackKey) return false;
        const authorText = readPendingMedalText(this.pendingMedalText, key, 'author');
        if (authorText !== undefined) {
            const row = this.medalRowByKey.get(key)
                ?? this.medalTimes[this.state.originalTrackKeyByKey.get(key) ?? key] ?? null;
            const author = Number(authorText);
            if (author > 0 && author === Number(row?.author)) {
                clearPendingMedalText(this.pendingMedalText, key, ['author']);
            } else if (!this.setAuthorTime(author)) {
                return false;
            }
        }
        if (hasPendingMedalText(this.pendingMedalText, key)) this.updateMedalRowFromInputs();
        return !hasPendingMedalText(this.pendingMedalText, key);
    }

    // Keeps the typed text and marks the track unsaved. It does not repaint the
    // field: a number field reports a half-typed "12." as empty.
    recordMedalText(tier) {
        if (this.medalTimesFixed()) return;
        const key = this.state.selectedTrackKey;
        setPendingMedalText(this.pendingMedalText, key, tier, this.medalInputs[tier].value);
        this.state.dirtyTrackKeys.add(key);
        this.medalTimesState.textContent = 'Unsaved';
        this.medalTimesState.className = 'pill pill-warn';
        this.syncActionButtons();
        if (MAPMAKER_ONLINE) this.scheduleDraftRecovery();
        if (this.creatorMode && this.creatorSavingKey !== key && !this.creatorSaveErrors.has(key)) {
            this.setCreatorSaveStatus('Unsaved changes', 'unsaved');
        }
    }

    loadTrack(trackKey) {
        if (this.creatorDeletingKey) return;
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
        this.state.selectedCorner = null;
        this.state.radiusScope = 'track';
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
            this.state.selectedHandle = this.hasRoadLine() ? null : { kind: 'polygon', path: 'outer', index: 0 };
        }
        this.updateStageText();
        this.syncActionButtons();
        if (this.creatorMode) this.syncCreatorTrackState();
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
        movePendingMedalText(this.pendingMedalText, currentKey, nextKey);
        const cloudKey = this.cloudKeyByKey.get(currentKey);
        this.cloudKeyByKey.delete(currentKey);
        if (cloudKey) this.cloudKeyByKey.set(nextKey, cloudKey);
        const originalTrackKey = this.state.originalTrackKeyByKey.get(currentKey) ?? null;
        this.state.originalTrackKeyByKey.delete(currentKey);
        if (originalTrackKey) {
            this.state.originalTrackKeyByKey.set(nextKey, originalTrackKey);
        }
        this.state.dirtyTrackKeys.delete(currentKey);
        const saveError = this.creatorSaveErrors.get(currentKey);
        this.creatorSaveErrors.delete(currentKey);
        if (saveError) this.creatorSaveErrors.set(nextKey, saveError);
        this.state.dirtyTrackKeys.add(nextKey);
        this.state.selectedTrackKey = nextKey;
        this.state.dirtyTrackKeys.add(nextKey);
        return true;
    }

    applyDerivedTrackKey(name) {
        // A track in Redis keeps its key. A new name changes only the name.
        if (this.creatorMode && (this.creatorRecords.has(this.state.selectedTrackKey)
            || this.creatorSavingKey === this.state.selectedTrackKey)) return true;
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

    async createTrack() {
        if (this.creatorMode && (!this.creatorLoaded || this.busy)) return;
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

    // Reddit shows the Creator in a frame that ignores window.confirm, so
    // every question uses this page dialog.
    confirmAction({ title, message, confirmLabel, danger = false }) {
        this.confirmDialogTitle.textContent = title;
        this.confirmDialogMessage.textContent = message;
        this.confirmDialogButton.textContent = confirmLabel;
        this.confirmDialogButton.className = danger ? 'danger-btn' : 'primary-btn';
        this.confirmDialog.returnValue = '';
        this.confirmDialog.showModal();
        return new Promise((resolve) => {
            this.confirmDialog.addEventListener('close', () => {
                resolve(this.confirmDialog.returnValue === 'confirm');
            }, { once: true });
        });
    }

    confirmTrackRemoval(message) {
        return this.confirmAction(this.creatorMode
            ? { title: 'Delete track?', message, confirmLabel: 'Delete', danger: true }
            : { title: 'Remove track?', message, confirmLabel: 'Remove', danger: true });
    }

    async removeTrack() {
        if (this.creatorMode) {
            await this.deleteCreatorTrack();
            return;
        }
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
            clearPendingMedalText(this.pendingMedalText, selectedKey);
            this.baselineQualityCodesByKey.delete(selectedKey);
            this.baselineGeometryByKey.delete(selectedKey);
            this.autoRoadGuideByKey.delete(selectedKey);
            this.state.originalTrackKeyByKey.delete(selectedKey);
            this.state.dirtyTrackKeys.delete(selectedKey);
            // Keep a usable blank editor after its final map is removed.
            if (!nextKey) {
                nextKey = 'newTrack';
                this.state.tracks[nextKey] = createBlankTrack();
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
        const road = this.autoCheckpointRoad();
        if (!road) return;
        const start = startOnLoop(road.centerline, this.track.startLine, this.track.startAngle);
        if (!start) return;
        const generated = buildAutoGates(
            road.centerline,
            this.track.outer,
            this.track.inner,
            road.width,
            { ...start, cornerRadius: this.getCornerRadius() },
        );
        if (!generated) return;
        this.track.checkpoints = generated.checkpoints;
    }

    // The middle of the road that automatic checkpoints follow, and its width.
    autoCheckpointRoad() {
        if (this.hasRoadLine()) {
            const { points, width } = this.track.roadLine;
            const walls = buildRoadWallsFromLoop(points, width, this.getCornerRadius());
            return walls ? { centerline: walls.centerline, width } : null;
        }
        const guide = this.autoRoadGuideByKey.get(this.state.selectedTrackKey);
        if (!guide || guide.manualGates) return null;
        if (guide.wallSignature !== JSON.stringify([this.track.outer, this.track.inner])) return null;
        return { centerline: guide.centerline, width: guide.width ?? WIDE_ROAD_WIDTH };
    }

    hasTrackGeometry() {
        return this.track.outer.length >= 3 && this.track.inner.length >= 3;
    }

    // A track drawn with Draw keeps its road line. Its bends are what you edit:
    // the walls, the start and the checkpoints are built from them.
    hasRoadLine() {
        return Boolean(this.track) && this.hasTrackGeometry() && isValidRoadLine(this.track.roadLine);
    }

    getSelectedBendIndex() {
        const handle = this.state.selectedHandle;
        return handle?.kind === 'bend' && this.hasRoadLine() && this.track.roadLine.points[handle.index]
            ? handle.index : null;
    }

    // Builds the road again from the line. The start stays near where it was.
    // Nothing changes when the line cannot make a road.
    rebuildRoad(roadLine = this.track.roadLine) {
        const built = buildRoadFromLine(roadLine, {
            cornerRadius: this.getCornerRadius(),
            startLine: this.track.startLine,
            startAngle: this.track.startAngle,
        });
        if (!built) return false;
        this.track.roadLine = roadLine;
        this.track.outer = built.outer;
        this.track.inner = built.inner;
        this.track.startLine = built.startLine;
        this.track.startPos = built.startPos;
        this.track.startAngle = built.startAngle;
        this.track.checkpoints = built.checkpoints;
        return true;
    }

    changeRoadLine(points) {
        return this.rebuildRoad({ ...this.track.roadLine, points });
    }

    moveBend(index, worldPoint) {
        const points = this.track.roadLine.points.map((point, at) => (
            at === index ? { ...point, x: worldPoint.x, y: worldPoint.y } : point
        ));
        if (this.changeRoadLine(points)) return true;
        this.setStatus('The road cannot bend there.', true);
        return false;
    }

    insertBend(afterIndex, worldPoint) {
        const points = this.track.roadLine.points;
        if (points.length >= MAX_ROAD_LINE_POINTS) {
            this.setStatus(`A road can have at most ${MAX_ROAD_LINE_POINTS} bends.`, true);
            return;
        }
        const next = points[(afterIndex + 1) % points.length];
        // The new bend keeps the width of the section that it splits.
        const at = {
            ...distanceToSegment(worldPoint, points[afterIndex], next).closest,
            ...(points[afterIndex].width !== undefined ? { width: points[afterIndex].width } : {}),
        };
        const changed = [...points.slice(0, afterIndex + 1), at, ...points.slice(afterIndex + 1)];
        if (!this.changeRoadLine(changed)) {
            this.setStatus('The road cannot bend there.', true);
            return;
        }
        this.normalizeRoadTrack();
        this.state.selectedHandle = { kind: 'bend', index: afterIndex + 1 };
        this.syncCornerRadiusControl();
        this.markDirty('Added bend.');
    }

    deleteBend(index) {
        const points = this.track.roadLine.points;
        if (points.length <= 3) {
            this.setStatus('A road needs at least 3 bends.', true);
            return;
        }
        if (!this.changeRoadLine(points.filter((_, at) => at !== index))) {
            this.setStatus('The road needs this bend.', true);
            return;
        }
        this.normalizeRoadTrack();
        this.state.selectedHandle = { kind: 'bend', index: Math.max(0, index - 1) };
        this.syncCornerRadiusControl();
        this.markDirty('Deleted bend.');
    }

    // Whole track sets every corner and clears each bend's own setting.
    // Selected corner sets only the selected bend.
    setRoadCornerRadius(nextRadius, options = {}) {
        const bendIndex = this.state.radiusScope === 'corner' ? this.getSelectedBendIndex() : null;
        if (this.state.radiusScope === 'corner' && bendIndex === null) return;
        const before = { cornerRadius: this.track.cornerRadius, roadLine: this.track.roadLine };
        const points = this.track.roadLine.points.map((point, at) => {
            const { cornerRadius: _, ...bend } = point;
            if (bendIndex === null) return bend;
            if (at !== bendIndex) return point;
            return nextRadius === this.getCornerRadius() ? bend : { ...bend, cornerRadius: nextRadius };
        });
        if (bendIndex === null) this.track.cornerRadius = nextRadius;
        if (!this.changeRoadLine(points)) {
            this.track.cornerRadius = before.cornerRadius;
            this.track.roadLine = before.roadLine;
            this.syncCornerRadiusControl();
            this.setStatus('The road cannot take this corner setting.', true);
            return;
        }
        this.normalizeRoadTrack();
        this.syncCornerRadiusControl();
        if (options.markDirty !== false) {
            const preset = CORNER_RADIUS_PRESETS.find((entry) => entry.value === nextRadius);
            this.markDirty(
                options.status ?? `Set ${bendIndex === null ? 'whole track' : 'selected corner'} to ${preset?.label ?? 'Rounded'}.`,
                options.updateStatus !== false,
            );
        }
    }

    // A rebuilt road can reach past the top or the left edge. Then the whole
    // track moves back, as after Draw, and the view keeps it in place.
    normalizeRoadTrack() {
        const normalized = normalizeTrackLayout(this.track);
        const offset = normalized.normalizationOffset;
        if (!offset.x && !offset.y) return;
        if (this.state.view.frozenBounds) {
            const viewport = this.getViewport();
            this.state.view.panX -= offset.x * viewport.scale;
            this.state.view.panY -= offset.y * viewport.scale;
        }
        for (const key of ['outer', 'inner', 'startLine', 'startPos', 'checkpoints', 'roadLine']) {
            this.track[key] = normalized[key];
        }
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
        if (this.hasRoadLine() && !['startPos', 'startLine'].includes(this.state.selectedHandle?.kind)) {
            if (this.state.tool === 'corner') {
                return this.getSelectedBendIndex() !== null
                    ? 'Drag the bend to move the road. Set its roundness under Shape.'
                    : 'Select a bend, then drag it. The line from bend to bend is the straight shot. Green fits the car. Red leaves the road.';
            }
            return this.touchInput
                ? 'Drag a bend to move the road. Pinch to zoom.'
                : 'Drag a bend to move the road. Shift+click the line adds a bend. Delete removes it. Cmd+Z undoes.';
        }
        if (this.state.tool === 'corner') {
            return this.state.selectedCorner
                ? 'Drag the selected bend to reshape both walls. Set its roundness under Shape.'
                : 'Select a bend on either wall, then drag to reshape it. The line from bend to bend is the straight shot. Green fits the car. Red leaves the road.';
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
        if (this.hasRoadLine()) {
            return [
                ...this.track.roadLine.points.map((point, index) => ({ kind: 'bend', index, point })),
                { kind: 'startLine', endpoint: 'p1', point: this.track.startLine.p1 },
                { kind: 'startLine', endpoint: 'p2', point: this.track.startLine.p2 },
                { kind: 'startPos', point: this.track.startPos },
            ];
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
        if (this.hasRoadLine()) {
            const points = this.track.roadLine.points;
            return [
                ...points.map((point, index) => ({
                    kind: 'lineSegment', index, a: point, b: points[(index + 1) % points.length],
                })),
                { kind: 'startLineSegment', a: this.track.startLine.p1, b: this.track.startLine.p2 },
            ];
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
        if (a.kind === 'bend') {
            return a.index === b.index;
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
        // A bend keeps the open tool. Road width then sets its section, and in
        // Corner, Wall corners sets its rounding.
        if (handle.kind === 'bend') {
            this.state.selectedHandle = { kind: 'bend', index: handle.index };
            this.state.widthScope = 'section';
            if (this.state.tool === 'corner') this.state.radiusScope = 'corner';
            this.syncCornerRadiusControl();
            this.updateCanvasHint();
            this.draw();
            return;
        }
        this.setTool('edit', handle);
    }

    selectCornerAt(path, index) {
        this.state.selectedCorner = selectCorner(this.track, path, index, WIDE_ROAD_WIDTH);
        this.state.selectedHandle = null;
        this.state.radiusScope = 'corner';
        this.syncCornerRadiusControl();
        this.updateCanvasHint();
        this.draw();
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

        if (segment.kind === 'lineSegment') {
            const count = this.track.roadLine.points.length;
            this.selectHandle({ kind: 'bend', index: nearestEndpoint === 'p1' ? segment.index : (segment.index + 1) % count });
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
        if (MAPMAKER_ONLINE || this.creatorMode) {
            this.markTrackChanged();
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
        const generated = buildTrackFromLoop(points, this.state.drawWidth, cornerRadius);
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
        // The Creator saves this line beside the track, for later road edits.
        const roadLine = buildRoadLine(points, generated.normalizationOffset, this.state.drawWidth);
        if (roadLine) this.track.roadLine = roadLine;
        else delete this.track.roadLine;
        this.autoRoadGuideByKey.set(this.state.selectedTrackKey, {
            centerline: generated.centerline,
            wallSignature: JSON.stringify([generated.outer, generated.inner]),
            manualGates: false,
            width: this.state.drawWidth,
        });
        this.syncCornerRadiusControl();
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.draftLoopsByKey.delete(this.state.selectedTrackKey);
        this.setTool('edit', this.hasRoadLine() ? null : { kind: 'polygon', path: 'outer', index: 0 });
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

        if (this.state.tool === 'corner' && !this.hasRoadLine()) {
            if (event.button !== 0) return;
            this.canvas.setPointerCapture(event.pointerId);
            const marker = this.state.selectedCorner
                ? this.worldToScreen(this.state.selectedCorner.anchor, viewport) : null;
            const markerHit = marker && distance(canvasPoint, marker) <= 18 * this.hitScale;
            if (!markerHit) {
                const handle = this.hitTest(
                    canvasPoint, viewport, this.getAllHandles().filter((item) => item.kind === 'polygon'),
                );
                const segment = handle ? null : this.hitTestSegment(canvasPoint, viewport);
                let path = handle?.path;
                let index = handle?.index;
                if (!path && segment?.kind === 'polygonSegment') {
                    path = segment.path;
                    const a = this.worldToScreen(segment.a, viewport);
                    const b = this.worldToScreen(segment.b, viewport);
                    index = distance(canvasPoint, a) <= distance(canvasPoint, b)
                        ? segment.index : (segment.index + 1) % this.track[path].length;
                }
                if (!path) {
                    this.state.selectedCorner = null;
                    this.state.radiusScope = 'track';
                    this.syncCornerRadiusControl();
                    if (this.touchInput) this.startPan(event, canvasPoint, false);
                    this.draw();
                    return;
                }
                this.selectCornerAt(path, index);
            }
            this.beginHistoryEdit();
            this.freezeViewBounds();
            const selection = this.state.selectedCorner;
            this.state.drag = {
                type: 'corner',
                selection,
                startWorldPoint: this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport),
                startAnchor: { ...selection.anchor },
                startPoints: selection.members.map(({ path: wall, index: at }) => ({ ...this.track[wall][at] })),
            };
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
            if (event.shiftKey && segmentHit.kind === 'lineSegment') {
                this.insertBend(segmentHit.index, worldPoint);
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
        this.syncCornerRadiusControl();
        if (this.touchInput) this.startPan(event, canvasPoint, false);
        this.updateCanvasHint();
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

        if (drag?.type === 'corner') {
            const delta = {
                x: worldPoint.x - drag.startWorldPoint.x,
                y: worldPoint.y - drag.startWorldPoint.y,
            };
            moveCorner(this.track, drag.selection, drag.startPoints, delta);
            drag.selection.anchor = {
                x: drag.startAnchor.x + delta.x,
                y: drag.startAnchor.y + delta.y,
            };
            this.markDirty('Moved corner.', false);
            return;
        }

        if (this.state.tool === 'corner' && !this.hasRoadLine()) {
            this.state.hoverHandle = this.hitTest(
                canvasPoint, viewport, this.getAllHandles().filter((item) => item.kind === 'polygon'),
            );
            this.draw();
            return;
        }

        if (this.state.drag?.type === 'handle') {
            const handle = this.state.drag.handle;
            if (handle?.kind === 'bend') {
                if (this.hasRoadLine() && this.moveBend(handle.index, worldPoint)) {
                    this.state.drag.moved = true;
                    this.markDirty('Moved bend.', false);
                }
                return;
            }
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
        if (this.state.drag?.handle?.kind === 'bend' && this.state.drag.moved && this.hasRoadLine()) {
            this.normalizeRoadTrack();
            this.markDirty('Moved bend.');
        }
        if (['handle', 'laneGate', 'corner'].includes(this.state.drag?.type)) {
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

        if (this.state.tool === 'corner' && !this.hasRoadLine()) {
            const selection = this.state.selectedCorner;
            if (!selection) return;
            const step = event.shiftKey ? 1 : 0.25;
            const delta = {
                x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
                y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
            };
            if (delta.x || delta.y) {
                event.preventDefault();
                const startPoints = selection.members.map(({ path, index }) => ({ ...this.track[path][index] }));
                moveCorner(this.track, selection, startPoints, delta);
                selection.anchor = {
                    x: selection.anchor.x + delta.x,
                    y: selection.anchor.y + delta.y,
                };
                this.markDirty('Nudged corner.');
            }
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            this.deleteSelectedPoint();
            return;
        }

        const bendIndex = this.getSelectedBendIndex();
        if (bendIndex !== null) {
            const step = event.shiftKey ? 1 : 0.25;
            const bend = this.track.roadLine.points[bendIndex];
            const delta = {
                x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
                y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
            };
            if (delta.x || delta.y) {
                event.preventDefault();
                if (this.moveBend(bendIndex, { x: bend.x + delta.x, y: bend.y + delta.y })) {
                    this.normalizeRoadTrack();
                    this.markDirty('Nudged bend.');
                }
            }
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
        const bendIndex = this.getSelectedBendIndex();
        if (bendIndex !== null) {
            const points = this.track.roadLine.points;
            this.insertBend(bendIndex, midpoint(points[bendIndex], points[(bendIndex + 1) % points.length]));
            return;
        }
        if (this.hasRoadLine()) {
            this.setStatus('Select a bend first.', true);
            return;
        }
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
        const bendIndex = this.getSelectedBendIndex();
        if (bendIndex !== null) {
            this.deleteBend(bendIndex);
            return;
        }
        if (this.hasRoadLine()) {
            this.setStatus('Select a bend first.', true);
            return;
        }
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
        const automatic = this.hasRoadLine();
        this.addCheckpointBtn.disabled = !this.hasTrackGeometry() || automatic;
        this.deleteCheckpointBtn.disabled = this.state.selectedHandle?.kind !== 'checkpoint';
        if (this.checkpointHint) {
            const hint = automatic ? 'They follow the road.' : 'Select one on the map to delete it.';
            if (this.checkpointHint.textContent !== hint) this.checkpointHint.textContent = hint;
        }
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
        // A locked track cannot change: the edit is taken back.
        if (this.creatorMode && this.isCreatorLocked()) {
            this.state.tracks[this.state.selectedTrackKey] = this.getEditHistory().current();
            this.setStatus('Players have raced this track, so it cannot change.', true);
            this.draw();
            return;
        }
        if (options.recordHistory !== false && this.activeHistoryEditKey !== this.state.selectedTrackKey) {
            const history = this.getEditHistory();
            history.recordEdit(history.current(), this.track);
        }
        this.markTrackChanged();
        this.syncActionButtons();
        if (updateStatus) {
            this.setStatus(message);
        }
        this.scheduleDraftRecovery();
        this.scheduleQualityCheck();
        this.draw();
    }

    // Marks the open track changed. In the Creator, an edit that brings the
    // track back to the version on the server (an Undo, or a value typed back)
    // leaves it saved, as after a save.
    markTrackChanged() {
        const key = this.state.selectedTrackKey;
        if (this.creatorMode && isCreatorTrackAtSavedVersion(this, key)) {
            this.state.dirtyTrackKeys.delete(key);
            this.medalRowByKey.delete(key);
            this.creatorSaveErrors.delete(key);
            this.syncCreatorTrackState();
            return;
        }
        this.state.dirtyTrackKeys.add(key);
        if (this.creatorMode) this.setCreatorSaveStatus('Unsaved changes', 'unsaved');
    }

    syncActionButtons() {
        const key = this.state.selectedTrackKey;
        const isDirty = this.state.dirtyTrackKeys.has(key);
        if (this.creatorMode) {
            const locked = this.isCreatorLocked(key);
            this.saveTrackBtn.textContent = isDirty ? 'Save' : 'Saved';
            this.saveTrackBtn.disabled = this.busy || !this.creatorLoaded || !isDirty || locked;
            this.removeTrackBtn.textContent = this.creatorRecords.has(key) ? 'Delete track' : 'Discard track';
            this.removeTrackBtn.disabled = this.busy || !this.creatorLoaded || locked;
            this.driveDraftBtn.disabled = this.busy || !this.creatorLoaded;
            return;
        }
        this.saveTrackBtn.textContent = isDirty ? 'Save' : 'Saved';
        this.saveTrackBtn.disabled = this.busy || !this.cloudReady || !isDirty;
        if (MAPMAKER_ONLINE) {
            this.removeTrackBtn.disabled = this.busy || !this.cloudReady;
            this.trackNameInput.disabled = this.busy;
        }
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
            ctx.strokeStyle = worldX % 5 === 0 ? 'rgba(139, 171, 204, 0.16)' : 'rgba(139, 171, 204, 0.065)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        for (let y = startY; y < height; y += minor) {
            const worldY = Math.round((y - viewport.offsetY) / viewport.scale);
            ctx.strokeStyle = worldY % 5 === 0 ? 'rgba(139, 171, 204, 0.16)' : 'rgba(139, 171, 204, 0.065)';
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

    drawSchematicTrackPreview(viewport) {
        const geometry = buildTrackGeometry({
            outer: this.track.outer,
            inner: this.track.inner,
            cornerRadius: this.getCornerRadius(),
        });
        if (geometry.outer.length < 3 || geometry.inner.length < 3) {
            return;
        }

        const outerPath = this.buildScreenPath(geometry.outer, viewport);
        const innerPath = this.buildScreenPath(geometry.inner, viewport);
        const surfacePath = new Path2D();
        surfacePath.addPath(outerPath);
        surfacePath.addPath(innerPath);

        const [roadTop, roadBottom] = EDITOR_ROAD_TONES[getTrackGround(this.track).key];
        const roadFill = this.ctx.createLinearGradient(0, 0, 0, viewport.height);
        roadFill.addColorStop(0, roadTop);
        roadFill.addColorStop(1, roadBottom);
        this.ctx.save();
        this.ctx.fillStyle = roadFill;
        this.ctx.fill(surfacePath, 'evenodd');
        this.ctx.fillStyle = '#112034';
        this.ctx.fill(innerPath);

        this.ctx.lineJoin = 'round';
        this.ctx.lineWidth = 5;
        this.ctx.strokeStyle = 'rgba(255, 140, 164, 0.16)';
        this.ctx.stroke(outerPath);
        this.ctx.strokeStyle = 'rgba(192, 222, 255, 0.16)';
        this.ctx.stroke(innerPath);
        this.ctx.lineWidth = 2.25;
        this.ctx.strokeStyle = EDITOR_EDGE.outer;
        this.ctx.stroke(outerPath);
        this.ctx.strokeStyle = EDITOR_EDGE.inner;
        this.ctx.stroke(innerPath);
        this.ctx.restore();
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
        const radius = isSelected ? 8 : isHovered ? 7 : handle.kind === 'bend' ? 6 : 4.5;
        let fill = '#f8fafc';
        if (handle.kind === 'bend') {
            fill = '#f8fafc';
        } else if (handle.kind === 'polygon') {
            fill = handle.path === 'outer' ? EDITOR_EDGE.outer : '#79b7ff';
        } else if (handle.kind === 'checkpoint') {
            fill = '#58dfa5';
        } else if (handle.kind === 'startPos') {
            fill = '#fbbf24';
        } else if (handle.kind === 'startLine') {
            fill = '#a78bfa';
        }

        this.ctx.save();
        this.ctx.globalAlpha = isSelected || isHovered ? 1 : 0.88;
        this.ctx.beginPath();
        this.ctx.fillStyle = fill;
        this.ctx.strokeStyle = isSelected ? '#ffffff' : '#102033';
        this.ctx.lineWidth = isSelected ? 3 : 2;
        this.ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.restore();
    }

    drawWallContinuations(viewport) {
        const shots = wallContinuations(this.track.outer, this.track.inner, CAR_RADIUS * 2);
        this.ctx.save();
        for (const shot of shots) {
            this.fillWorldPolygon(shot.clear, viewport, 'rgba(88, 223, 165, 0.9)');
            this.fillWorldPolygon(shot.blocked, viewport, 'rgba(244, 63, 94, 0.9)');
            this.drawLineSegment(shot.from, shot.to, viewport, '#ffffff', 2, false);
        }
        this.ctx.restore();
    }

    fillWorldPolygon(points, viewport, fillStyle) {
        if (!points || points.length < 3) return;
        this.ctx.beginPath();
        const first = this.worldToScreen(points[0], viewport);
        this.ctx.moveTo(first.x, first.y);
        for (let index = 1; index < points.length; index += 1) {
            const point = this.worldToScreen(points[index], viewport);
            this.ctx.lineTo(point.x, point.y);
        }
        this.ctx.closePath();
        this.ctx.fillStyle = fillStyle;
        this.ctx.fill();
    }

    // The saved road line, from bend to bend.
    drawRoadLine(viewport) {
        const points = this.track.roadLine.points;
        this.ctx.save();
        this.ctx.setLineDash([6, 6]);
        this.ctx.beginPath();
        points.forEach((point, index) => {
            const screen = this.worldToScreen(point, viewport);
            if (index === 0) this.ctx.moveTo(screen.x, screen.y);
            else this.ctx.lineTo(screen.x, screen.y);
        });
        this.ctx.closePath();
        this.ctx.strokeStyle = 'rgba(248, 250, 252, 0.45)';
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();
        // The section that Road width sets.
        const bendIndex = this.state.widthScope === 'section' ? this.getSelectedBendIndex() : null;
        if (bendIndex !== null) {
            const from = this.worldToScreen(points[bendIndex], viewport);
            const to = this.worldToScreen(points[(bendIndex + 1) % points.length], viewport);
            this.ctx.setLineDash([]);
            this.ctx.beginPath();
            this.ctx.moveTo(from.x, from.y);
            this.ctx.lineTo(to.x, to.y);
            this.ctx.strokeStyle = 'rgba(248, 250, 252, 0.9)';
            this.ctx.lineWidth = 3;
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    drawCornerSelection(viewport) {
        const selection = this.state.selectedCorner;
        if (!selection) return;
        this.ctx.save();
        for (const { path, index, weight } of selection.members) {
            const screen = this.worldToScreen(this.track[path][index], viewport);
            this.ctx.beginPath();
            this.ctx.arc(screen.x, screen.y, 4 + weight * 2, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(251, 191, 36, ${0.3 + weight * 0.55})`;
            this.ctx.fill();
        }
        const center = this.worldToScreen(selection.anchor, viewport);
        this.ctx.beginPath();
        this.ctx.arc(center.x, center.y, 12, 0, Math.PI * 2);
        this.ctx.strokeStyle = '#fbbf24';
        this.ctx.lineWidth = 2.5;
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.arc(center.x, center.y, 3, 0, Math.PI * 2);
        this.ctx.fillStyle = '#fbbf24';
        this.ctx.fill();
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
            this.ctx.fillStyle = 'rgba(45, 59, 77, 0.96)';
            this.ctx.fill(road, 'evenodd');
            this.drawPolygon(roadPreview.outer, viewport, 'transparent', '#fbbf24', { lineWidth: 2 });
            this.drawPolygon(roadPreview.inner, viewport, 'transparent', '#fbbf24', { lineWidth: 2 });
        } else {
            const openPath = this.buildOpenRoadPath(previewPoints, viewport);
            this.ctx.lineJoin = 'round';
            this.ctx.lineCap = 'round';
            this.ctx.strokeStyle = '#fbbf24';
            this.ctx.lineWidth = this.state.drawWidth * viewport.scale + 4;
            this.ctx.stroke(openPath);
            this.ctx.strokeStyle = '#2d3b4d';
            this.ctx.lineWidth = this.state.drawWidth * viewport.scale;
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
                ? Math.min(this.state.drawWidth / 2, maxTrim / tanHalf)
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
        const width = this.state.drawWidth;
        const cornerRadius = this.getCornerRadius();
        const cached = this.draftRoadPreview;
        const cacheMatches = cached?.points === points
            && cached.width === width
            && cached.cornerRadius === cornerRadius;
        let generated = cached?.generated;
        if (!cacheMatches) {
            const walls = buildRoadWallsFromLoop(points, width, cornerRadius);
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

    drawGhostCar(worldPoint, angle, viewport) {
        if (!worldPoint || !Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y)) {
            return;
        }
        if (!Number.isFinite(angle)) {
            angle = 0;
        }

        const screen = this.worldToScreen(worldPoint, viewport);
        const radius = CAR_RADIUS * viewport.scale;
        if (radius < 0.5) {
            return;
        }

        const car = getDrawnCar(getDefaultDrawnCarAssetForGround(getTrackGround(this.track).key));
        const size = DRAWN_CAR_DRAW_PIXELS * (CONFIG.carSpriteRenderScale ?? 1) / CONFIG.gridSize * viewport.scale;
        this.ctx.save();
        this.ctx.translate(screen.x, screen.y);
        this.ctx.rotate(angle);
        this.ctx.drawImage(car.sprite, -size / 2, -size / 2, size, size);
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
            this.drawSchematicTrackPreview(viewport);
            this.drawPolygon(
                this.track.outer,
                viewport,
                'transparent',
                'rgba(255, 140, 164, 0.38)',
                { lineWidth: 1.5 },
            );
            this.drawPolygon(
                this.track.inner,
                viewport,
                'transparent',
                'rgba(192, 222, 255, 0.38)',
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
                    active ? '#58dfa5' : 'rgba(88, 223, 165, 0.72)',
                    active ? 4 : 2
                );
            });
            this.drawCheckpointLabels(selectedCheckpoint, viewport);
        }

        this.drawFlowMarkers(viewport);
        this.drawQualityMarkers(viewport);

        this.drawDraftLoop(viewport);

        const roadLine = this.hasRoadLine() && this.state.tool !== 'draw';
        if (this.state.tool === 'corner') {
            this.drawWallContinuations(viewport);
            if (!roadLine) {
                this.drawCornerSelection(viewport);
                return;
            }
        }
        if (roadLine) this.drawRoadLine(viewport);

        const handles = this.getAllHandles().sort((a, b) => {
            const aPriority = Number(this.handleMatches(this.state.selectedHandle, a)) * 2
                + Number(this.handleMatches(this.state.hoverHandle, a));
            const bPriority = Number(this.handleMatches(this.state.selectedHandle, b)) * 2
                + Number(this.handleMatches(this.state.hoverHandle, b));
            return aPriority - bPriority;
        });
        handles.forEach((handle) => this.drawHandle(handle, viewport));
    }

    setCreatorSaveStatus(message, state) {
        if (!this.creatorSaveStatus) return;
        this.creatorSaveStatus.textContent = message;
        this.creatorSaveStatus.dataset.state = state;
    }

    isCreatorLocked(trackKey = this.state.selectedTrackKey) {
        return Boolean(this.creatorRecords.get(trackKey)?.lockedAt);
    }

    // A locked track opens to look at, not to change.
    setCreatorEditable(editable) {
        this.canvas.style.pointerEvents = editable ? '' : 'none';
        this.trackNameInput.disabled = !editable;
        for (const control of this.panel.querySelectorAll('input, button, select')) {
            control.disabled = !editable;
        }
        this.toolButtons.forEach((button) => { button.disabled = !editable; });
        this.touchTools.querySelectorAll('button').forEach((button) => { button.disabled = !editable; });
        if (this.creatorLockNote) this.creatorLockNote.hidden = editable || !this.creatorLoaded;
    }

    syncCreatorTrackState() {
        const key = this.state.selectedTrackKey;
        const record = this.creatorRecords.get(key);
        const editable = this.creatorLoaded && !record?.lockedAt && !this.creatorDeletingKey;
        const draftNote = document.getElementById('creator-draft-note');
        if (draftNote) draftNote.hidden = !this.creatorLoaded || record?.privateDraft === false;
        this.trackPickerBtn.disabled = Boolean(this.creatorDeletingKey);
        this.newTrackBtn.disabled = !this.creatorLoaded || Boolean(this.creatorDeletingKey);
        this.setCreatorEditable(editable);
        // A locked track with unsaved changes: the work can go to a new
        // track, or the locked version can replace it.
        const lockedDraft = Boolean(this.creatorLoaded && record?.lockedAt && this.state.dirtyTrackKeys.has(key));
        if (this.creatorLockActions) {
            this.creatorLockActions.hidden = !lockedDraft;
            this.creatorLockNote.classList.toggle('has-actions', lockedDraft);
            this.creatorKeepCopyBtn.disabled = this.busy;
            this.creatorLoadLockedBtn.disabled = this.busy;
        }
        if (editable) {
            // These controls know when they must stay off.
            this.syncCornerRadiusControl();
            this.syncCheckpointPanel();
        }
        if (!this.creatorLoaded) return;
        if (record?.lockedAt) {
            this.setCreatorSaveStatus(record.lockReason === 'series' ? 'Locked: in a live series' : 'Locked: raced', 'locked');
        } else if (this.creatorSavingKey === key) {
            this.setCreatorSaveStatus('Saving…', 'saving');
        } else if (this.creatorSaveErrors.has(key)) {
            this.setCreatorSaveStatus(this.creatorSaveErrors.get(key), 'error');
        } else if (this.state.dirtyTrackKeys.has(key)) {
            this.setCreatorSaveStatus('Unsaved changes', 'unsaved');
        } else if (record) {
            const savedLabel = record.privateDraft ? 'Saved · private draft' : 'Saved · shared';
            this.setCreatorSaveStatus(record.checksPassed ? savedLabel : `${savedLabel} · checks fail`, record.checksPassed ? 'saved' : 'unsaved');
        } else {
            this.setCreatorSaveStatus('Not saved yet', 'unsaved');
        }
        this.syncMedalTimesPanel();
        this.syncActionButtons();
    }

    creatorRecordMeta(record) {
        return {
            revision: record.revision,
            lockedAt: record.lockedAt,
            lockReason: record.lockReason,
            origin: record.origin,
            privateDraft: record.privateDraft === true,
            checksPassed: record.checksPassed,
            checkError: record.checkError,
            updatedAt: record.updatedAt,
        };
    }

    addCreatorRecord(record) {
        const key = record.key;
        const track = cloneTracks(withRoadLine(record.track, record.roadLine));
        this.state.tracks[key] = track;
        this.creatorRecords.set(key, this.creatorRecordMeta(record));
        rememberSavedCreatorContent(this, record);
        this.editHistories.set(key, createEditHistory(track));
        this.state.originalTrackKeyByKey.set(key, key);
        if (record.medalRow) this.medalTimes[key] = record.medalRow;
        else delete this.medalTimes[key];
        this.medalRowByKey.delete(key);
        // The server version replaces the local one, typed text included. A
        // refresh puts back the unsaved work of a dirty track after this.
        clearPendingMedalText(this.pendingMedalText, key);
        if (record.draftLoop?.length) this.draftLoopsByKey.set(key, cloneTracks(record.draftLoop));
        else this.draftLoopsByKey.delete(key);
        this.state.dirtyTrackKeys.delete(key);
    }

    // The Daily list and the series tell the track picker where each track is used.
    applyCreatorPlaces(daily, seriesView) {
        this.scheduleKeys = new Set(daily?.schedule?.keys ?? []);
        const series = [...(seriesView?.appSeries ?? []), ...(seriesView?.series ?? [])];
        this.seriesData = {
            series: series.map((entry) => ({
                id: entry.id,
                name: entry.name,
                ground: entry.ground,
                stages: Array.isArray(entry.stages) ? entry.stages : [],
            })),
        };
    }

    // Loads the tracks in Redis. Tracks with unsaved changes in this page keep them.
    async loadCreatorTracks({ keepSelection = false } = {}) {
        if (this.creatorLoading) return;
        if (this.creatorSavingKey || this.creatorDeletingKey) {
            this.creatorRefreshPending = true;
            return;
        }
        this.creatorLoading = true;
        const writeGeneration = this.creatorWriteGeneration;
        const panelGeneration = this.creatorPanels.writeGeneration;
        // The page files are step 1 of the loader: this code runs only after them.
        const loadSteps = 5;
        let stepsDone = 1;
        let loadFailed = false;
        const step = (value) => {
            stepsDone += 1;
            // A request that ends after another one failed keeps the error on screen.
            if (!this.creatorLoaded && !loadFailed) this.showCreatorLoader('Loading the Creator…', { stepsDone, loadSteps });
            return value;
        };
        if (!this.creatorLoaded) {
            this.setCreatorSaveStatus('Loading tracks…', 'saving');
            this.showCreatorLoader('Loading the Creator…', { stepsDone, loadSteps });
        }
        try {
            // Every tab loads here, so switching tabs never waits for the server.
            const [{ tracks, username }, daily, seriesView, copyView] = await Promise.all([
                creatorApi.listTracks().then(step),
                creatorApi.readDaily().then(step),
                creatorApi.readSeries().then(step),
                creatorApi.readMigration().then(step),
            ]);
            if (writeGeneration !== this.creatorWriteGeneration) {
                this.creatorRefreshPending = true;
                return;
            }
            if (typeof username !== 'string' || !username.trim()) {
                throw new Error('Your Reddit account could not be identified. Try again.');
            }
            if (this.creatorUsername && username.trim().toLowerCase() !== this.creatorUsername.toLowerCase()) {
                this.creatorLoaded = false;
                throw new Error('The Reddit account changed. Reopen the Creator to load your drafts.');
            }
            this.creatorUsername = username.trim();
            const previousKey = this.state.selectedTrackKey;
            const unsaved = captureUnsavedCreatorWork(this);
            this.state.tracks = {};
            this.creatorRecords.clear();
            this.editHistories = new Map();
            // The picker lists the newest tracks first.
            for (const record of [...tracks].reverse()) this.addCreatorRecord(record);
            restoreUnsavedCreatorWork(this, unsaved);
            this.applyCreatorPlaces(daily, seriesView);
            this.creatorPanels.receiveViews({ daily, seriesView, copyView, generation: panelGeneration });
            this.creatorLoaded = true;
            this.showCreatorLoader(null);
            this.newTrackBtn.disabled = false;
            document.getElementById('creator-retry-btn').hidden = true;
            let openKey = keepSelection && this.state.tracks[previousKey]
                ? previousKey
                : tracks.find((record) => record.privateDraft)?.key;
            if (!openKey) {
                openKey = 'newTrack';
                this.state.tracks.newTrack = createBlankTrack();
                this.editHistories.set(openKey, createEditHistory(this.state.tracks.newTrack));
            }
            this.loadTrack(openKey);
            if (this.trackPickerDialog.open) this.renderTrackPicker();
        } catch (error) {
            this.setCreatorSaveStatus(`Could not load tracks: ${error.message}`, 'error');
            document.getElementById('creator-retry-btn').hidden = false;
            loadFailed = true;
            if (!this.creatorLoaded) this.showCreatorLoader(`Could not load the Creator: ${error.message}`, { failed: true });
        } finally {
            this.creatorLoading = false;
            if (this.creatorRefreshPending && !this.creatorSavingKey && !this.creatorDeletingKey) {
                this.creatorRefreshPending = false;
                void this.loadCreatorTracks({ keepSelection: true });
            }
        }
    }

    // The page covers the Creator until every tab has loaded once.
    showCreatorLoader(message, { failed = false, stepsDone = null, loadSteps = null } = {}) {
        const loader = document.getElementById('creator-loader');
        if (!loader) return;
        loader.hidden = message === null;
        loader.dataset.state = failed ? 'error' : 'loading';
        document.getElementById('creator-loader-retry').hidden = !failed;
        if (message === null) return;
        const text = document.getElementById('creator-loader-text');
        text.textContent = stepsDone === null ? message : `${message} ${stepsDone} of ${loadSteps}`;
        if (stepsDone === null) return;
        const bar = document.getElementById('creator-loader-bar');
        bar.setAttribute('aria-valuemax', String(loadSteps));
        bar.setAttribute('aria-valuenow', String(stepsDone));
        document.getElementById('creator-loader-fill').style.width = `${(stepsDone / loadSteps) * 100}%`;
    }

    openCreatorTrack(trackKey) {
        this.showCreatorTab('tracks');
        if (this.state.tracks[trackKey]) {
            this.loadTrack(trackKey);
        } else {
            this.setStatus('That track is in the app. The Creator opens only tracks in Redis.', true);
        }
    }

    async saveCreatorTrack() {
        if (!this.creatorLoaded || this.busy) return false;
        if (!this.applyDerivedTrackKey(this.track.name)) return false;
        const key = this.state.selectedTrackKey;
        if (this.isCreatorLocked(key)) return false;
        const record = this.creatorRecords.get(key);
        const name = this.track.name?.trim() ?? '';
        if (!name || name === 'Untitled Track') {
            this.setStatus('Give the track a name first.', true);
            return false;
        }
        if (!record && TRACKS[key]) {
            this.setStatus('A track in the game has this name already. Choose another name.', true);
            return false;
        }
        if (!this.commitPendingMedalText(key)) {
            this.setStatus(`Cannot save ${name}: finish the medal times.`, true);
            return false;
        }
        const medalRow = this.medalRowByKey.get(key) ?? this.medalTimes[key] ?? null;
        const medalError = medalRow ? getMedalRowError(medalRow) : null;
        if (medalError) {
            this.setStatus(`Cannot save ${name}: ${medalError}`, true);
            return false;
        }
        const saved = await saveCreatorTrackWithRecovery(this, key, geometrySignature);
        if (saved) this.creatorPanels.refreshAll();
        if (this.creatorRefreshPending && !this.creatorLoading) {
            this.creatorRefreshPending = false;
            void this.loadCreatorTracks({ keepSelection: true });
        }
        return saved;
    }

    // Takes a track out of this editor only. The server is not asked.
    discardCreatorTrack(key) {
        const wasOpen = this.state.selectedTrackKey === key;
        const keys = Object.keys(this.state.tracks);
        let nextKey = keys.findLast((candidate) => candidate !== key
            && (this.creatorRecords.get(candidate)?.privateDraft || this.state.dirtyTrackKeys.has(candidate)));
        delete this.state.tracks[key];
        this.creatorRecords.delete(key);
        this.editHistories.delete(key);
        this.draftLoopsByKey.delete(key);
        this.medalRowByKey.delete(key);
        clearPendingMedalText(this.pendingMedalText, key);
        this.uncertainTracksByKey.delete(key);
        delete this.medalTimes[key];
        this.state.originalTrackKeyByKey.delete(key);
        this.state.dirtyTrackKeys.delete(key);
        this.creatorSaveErrors.delete(key);
        if (!wasOpen) {
            this.syncCreatorTrackState();
            if (this.trackPickerDialog.open) this.renderTrackPicker();
            return;
        }
        this.state.draftLoop = [];
        if (!nextKey) {
            nextKey = 'newTrack';
            this.state.tracks.newTrack = createBlankTrack();
            this.editHistories.set(nextKey, createEditHistory(this.state.tracks.newTrack));
        }
        this.resetView();
        this.loadTrack(nextKey);
    }

    isAppTrackKey(key) {
        return Boolean(TRACKS[key]);
    }

    // A question with more than two answers. Escape and Cancel answer 'cancel'.
    chooseAction({ title, message, choices }) {
        const dialog = document.getElementById('choice-dialog');
        if (!dialog) return Promise.resolve('cancel');
        document.getElementById('choice-dialog-title').textContent = title;
        document.getElementById('choice-dialog-message').textContent = message;
        const cancel = document.createElement('button');
        cancel.type = 'submit';
        cancel.value = 'cancel';
        cancel.textContent = 'Cancel';
        const buttons = choices.map((choice) => {
            const button = document.createElement('button');
            button.type = 'submit';
            button.value = choice.value;
            button.textContent = choice.label;
            button.className = choice.danger ? 'danger-btn' : 'primary-btn';
            return button;
        });
        document.getElementById('choice-dialog-actions').replaceChildren(cancel, ...buttons);
        dialog.returnValue = '';
        dialog.showModal();
        return new Promise((resolve) => {
            dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
        });
    }

    async deleteCreatorTrack() {
        if (this.busy || !this.creatorLoaded) return;
        const key = this.state.selectedTrackKey;
        const record = this.creatorRecords.get(key);
        const name = this.track.name;
        if (record?.lockedAt) return;
        const message = !record
            ? `Discard unsaved track ${name}?`
            : record.origin === 'migrated'
                ? `Delete the Redis copy of ${name}? The game uses the app track again.`
                : `Delete ${name}? You cannot undo this.`;
        if (!await this.confirmTrackRemoval(message)) return;
        if (this.busy || this.state.selectedTrackKey !== key) return;
        this.busy = true;
        this.creatorDeletingKey = key;
        this.creatorWriteGeneration += 1;
        this.syncCreatorTrackState();
        try {
            if (record) {
                await creatorApi.deleteTrack(key, record.revision, this.creatorUsername);
                this.creatorPanels.refreshAll();
            }
            this.creatorDeletingKey = null;
            this.discardCreatorTrack(key);
            this.setStatus(record ? `Deleted ${name}.` : `Discarded ${name}.`);
        } catch (error) {
            this.setStatus(`Could not delete ${name}: ${error.message}`, true);
        } finally {
            this.busy = false;
            this.creatorDeletingKey = null;
            this.creatorWriteGeneration += 1;
            this.syncCreatorTrackState();
            if (this.creatorRefreshPending && !this.creatorLoading) {
                this.creatorRefreshPending = false;
                void this.loadCreatorTracks({ keepSelection: true });
            }
        }
    }

    bindCreatorLockActions() {
        this.creatorKeepCopyBtn?.addEventListener('click', () => {
            if (this.busy) return;
            void keepLockedCreatorDraft(this, this.state.selectedTrackKey, geometrySignature).then((saved) => {
                if (saved) this.creatorPanels.refreshAll();
            });
        });
        this.creatorLoadLockedBtn?.addEventListener('click', () => {
            if (this.busy) return;
            void loadLockedCreatorTrack(this, this.state.selectedTrackKey, geometrySignature);
        });
    }

    bindCreatorTabs() {
        this.creatorTabs = [...document.querySelectorAll('#creator-tabs [data-tab]')];
        this.creatorTabs.forEach((button) => {
            button.addEventListener('click', () => this.showCreatorTab(button.dataset.tab));
        });
        this.creatorDriveDialog?.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.closeCreatorTestDrive();
        });
        // Test Drive runs in a frame of this page, so the Creator never leaves Reddit.
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type === 'creator-test-drive-close') this.closeCreatorTestDrive();
        });
        this.showCreatorTab('tracks');
    }

    showCreatorTab(tab) {
        document.body.dataset.creatorTab = tab;
        this.creatorTabs.forEach((button) => {
            button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
        });
        for (const view of document.querySelectorAll('[data-creator-view]')) {
            view.hidden = view.dataset.creatorView !== tab;
        }
        if (tab === 'tracks') {
            this.resizeCanvas();
            this.draw();
        }
    }

    openCreatorTestDrive() {
        const frame = this.creatorDriveFrame;
        frame.addEventListener('load', () => {
            let loaded = false;
            try {
                loaded = frame.contentDocument?.body?.dataset.creatorPlaytest === 'true';
            } catch {}
            if (loaded) {
                // The keys drive the car at once, not a button of the Creator.
                frame.focus();
                frame.contentWindow?.focus();
                return;
            }
            if (frame.src === 'about:blank') return;
            // The frame did not open Test Drive. The page opens it instead,
            // after a save, because leaving the page drops unsaved changes.
            this.closeCreatorTestDrive();
            if (hasCreatorUnsavedWork(this)) {
                this.setStatus('Save or discard all unsaved tracks and Daily or Campaign changes, then open Test Drive again.', true);
                return;
            }
            this.skipBeforeUnload = true;
            window.location.assign('map-creator-playtest.html');
        }, { once: true });
        frame.src = `map-creator-playtest.html?drive=${Date.now()}`;
        this.creatorDriveDialog.showModal();
    }

    closeCreatorTestDrive() {
        if (!this.creatorDriveDialog.open) return;
        this.creatorDriveDialog.close();
        this.creatorDriveFrame.src = 'about:blank';
        this.syncMedalTimesPanel();
    }

    async driveDraft() {
        const track = this.track;
        if (this.creatorMode && this.state.draftLoop.length) {
            this.setStatus('Finish or clear the road you are drawing before Test Drive.', true);
            return;
        }
        if (!track || track.outer.length < 3 || track.inner.length < 3) {
            this.setStatus('Draw a closed road before a test drive.', true);
            return;
        }
        try {
            if (MAPMAKER_ONLINE) await verifyCloudSession();
            window.sessionStorage.setItem(cloudStorageKey(PLAYTEST_DRAFT_KEY), JSON.stringify({
                trackKey: this.state.selectedTrackKey,
                track,
            }));
            if (this.creatorMode) {
                this.openCreatorTestDrive();
                return;
            }
            window.sessionStorage.setItem(cloudStorageKey('mapmaker:return-from-playtest:v1'), '1');
            this.flushDraftRecovery();
            this.skipBeforeUnload = true;
            window.location.assign('mapmaker-playtest.html');
        } catch (error) {
            this.setStatus('Test Drive could not open in this browser.', true);
            console.error(error);
        }
    }

    // Online, Save keeps unfinished maps too: the checks run when the local
    // Mapmaker adds the map to the game.
    async saveToCloud() {
        const trackKey = this.state.selectedTrackKey;
        if (!this.commitPendingMedalText(trackKey)) {
            this.setStatus('Finish the medal times before saving.', true);
            return;
        }
        const medalError = this.medalRowByKey.has(trackKey) ? getMedalRowError(this.medalRowByKey.get(trackKey)) : null;
        if (medalError) {
            this.setStatus(medalError, true);
            return;
        }
        const submittedTrack = this.track;
        const snapshot = cloneTracks({
            trackKey,
            originalTrackKey: this.state.originalTrackKeyByKey.get(trackKey) ?? null,
            track: submittedTrack,
            draftLoop: this.state.draftLoop,
            medalRow: this.medalRowByKey.get(trackKey) ?? null,
            replaceKey: this.cloudKeyByKey.get(trackKey) ?? null,
        });
        this.busy = true;
        this.syncActionButtons();
        this.setStatus(`Saving ${this.track.name} to your cloud maps...`);
        try {
            await saveCloudMap(snapshot);
            // Bind the acknowledgement to the submitted map, even if the user
            // renamed it or selected another map while the request was running.
            const liveKey = Object.keys(this.state.tracks).find((key) => this.state.tracks[key] === submittedTrack)
                ?? (this.state.tracks[trackKey] ? trackKey : null);
            if (liveKey) {
                this.cloudKeyByKey.set(liveKey, trackKey);
                const liveLoop = liveKey === this.state.selectedTrackKey
                    ? this.state.draftLoop : this.draftLoopsByKey.get(liveKey) ?? [];
                const unchanged = liveKey === trackKey
                    && !hasPendingMedalText(this.pendingMedalText, liveKey)
                    && JSON.stringify(this.state.tracks[liveKey]) === JSON.stringify(snapshot.track)
                    && JSON.stringify(liveLoop) === JSON.stringify(snapshot.draftLoop)
                    && JSON.stringify(this.medalRowByKey.get(liveKey) ?? null) === JSON.stringify(snapshot.medalRow);
                if (unchanged) {
                    this.state.dirtyTrackKeys.delete(liveKey);
                    this.baselineGeometryByKey.set(liveKey, geometrySignature(snapshot.track));
                    this.baselineQualityCodesByKey.set(liveKey, new Set(validateTrackQuality(snapshot.track).issues
                        .filter((issue) => issue.severity === 'error').map((issue) => issue.code)));
                }
                this.scheduleDraftRecovery();
                this.setStatus(`Saved ${snapshot.track.name} to cloud maps.${unchanged ? '' : ' Newer edits remain unsaved.'}`);
            }
        } catch (error) {
            console.error(error);
            this.setStatus(error.message, true);
        } finally {
            this.busy = false;
            this.syncActionButtons();
            this.syncMedalTimesPanel();
        }
    }

    async saveAndIntegrateTrack() {
        if (this.creatorMode) {
            await this.saveCreatorTrack();
            return;
        }
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

const app = new MapmakerApp();
window.render_game_to_text = () => JSON.stringify({
    mode: 'mapmaker',
    ready: app.cloudReady,
    tracks: Object.keys(app.state.tracks),
    selectedTrackKey: app.state.selectedTrackKey,
    name: app.track?.name,
    tool: app.state.tool,
    dirtyTracks: [...app.state.dirtyTrackKeys],
    draftPoints: app.state.draftLoop.length,
    roadLine: app.track?.roadLine ?? null,
    outerPoints: app.track?.outer.length ?? 0,
    innerPoints: app.track?.inner.length ?? 0,
    medalRow: app.getMedalRow(),
    status: app.statusMessage,
});
window.advanceTime = () => app.draw();
