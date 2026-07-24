import { CONFIG } from '../game/config.js';
import { TRACK_SCHEDULE_KEYS } from '../game/track/catalog.js';
import { TRACKS } from '../game/track/tracks.js';
import { buildPerpendicularWallSpan } from './mapmaker/cross-track-snap.js';
import {
    formatTrackNumber as formatNumber,
    generateTrackIntegrationSnippet,
    generateTrackModuleSource,
    getTrackModuleFilename,
    isValidTrackKey
} from './mapmaker/track-source.js';

const TRACK_DESTINATIONS = new Set(['daily', 'campaign']);
const SCHEDULED_TRACK_KEYS = new Set(TRACK_SCHEDULE_KEYS);

const TOOL_LABELS = {
    draw: 'line build',
    outer: 'outer wall',
    inner: 'inner wall',
    startLine: 'start line',
    startPos: 'start position',
    checkpoints: 'checkpoints'
};

const EDITOR_TOOLS = ['outer', 'inner', 'startLine', 'startPos', 'checkpoints'];

const BLANK_VIEW_BOUNDS = { minX: -40, maxX: 40, minY: -30, maxY: 30 };
const FIXED_DRAW_WIDTH = 4;
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

// Match race collision capsule so authors can size lanes against the real car.
const CAR_RADIUS = CONFIG.carRadius;
const CAR_HALF_LENGTH = CONFIG.carCollisionHalfLength;
const CAR_WIDTH = CAR_RADIUS * 2;
const CAR_LENGTH = CAR_HALF_LENGTH * 2 + CAR_RADIUS * 2;

function formatCarWidths(worldUnits) {
    return formatNumber(worldUnits / CAR_WIDTH);
}

function cloneTracks(source) {
    if (typeof structuredClone === 'function') {
        return structuredClone(source);
    }
    return JSON.parse(JSON.stringify(source));
}

function clonePoint(point) {
    return { x: Number(point.x), y: Number(point.y) };
}

function midpoint(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
    };
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeVector(x, y) {
    const length = Math.hypot(x, y);
    if (length < 0.000001) {
        return { x: 0, y: 0 };
    }
    return { x: x / length, y: y / length };
}

function signedArea(points) {
    if (!points || points.length < 3) {
        return 0;
    }
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
        const next = points[(index + 1) % points.length];
        area += points[index].x * next.y - next.x * points[index].y;
    }
    return area / 2;
}

function totalLoopLength(points) {
    if (!points || points.length < 2) {
        return 0;
    }
    let total = 0;
    for (let index = 0; index < points.length; index += 1) {
        total += distance(points[index], points[(index + 1) % points.length]);
    }
    return total;
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

function sampleClosedLoopAtDistance(points, targetDistance) {
    if (points.length < 2) {
        const fallback = points[0] ? clonePoint(points[0]) : { x: 0, y: 0 };
        return {
            point: fallback,
            tangent: { x: 1, y: 0 }
        };
    }

    const loopLength = totalLoopLength(points);
    if (loopLength < 0.000001) {
        return {
            point: clonePoint(points[0]),
            tangent: { x: 1, y: 0 }
        };
    }

    let remaining = ((targetDistance % loopLength) + loopLength) % loopLength;
    for (let index = 0; index < points.length; index += 1) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const segmentLength = distance(a, b);
        if (segmentLength < 0.000001) {
            continue;
        }
        if (remaining <= segmentLength) {
            const t = clamp(remaining / segmentLength, 0, 1);
            return {
                point: {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t
                },
                tangent: normalizeVector(b.x - a.x, b.y - a.y)
            };
        }
        remaining -= segmentLength;
    }

    const last = points[points.length - 1];
    const first = points[0];
    return {
        point: clonePoint(first),
        tangent: normalizeVector(first.x - last.x, first.y - last.y)
    };
}

function offsetLoop(points, offsetDistance) {
    return points.map((point, index) => {
        const prev = points[(index - 1 + points.length) % points.length];
        const next = points[(index + 1) % points.length];
        let prevDir = normalizeVector(point.x - prev.x, point.y - prev.y);
        let nextDir = normalizeVector(next.x - point.x, next.y - point.y);
        if (Math.abs(prevDir.x) < 0.000001 && Math.abs(prevDir.y) < 0.000001) {
            prevDir = nextDir;
        }
        if (Math.abs(nextDir.x) < 0.000001 && Math.abs(nextDir.y) < 0.000001) {
            nextDir = prevDir;
        }

        const prevNormal = { x: -prevDir.y, y: prevDir.x };
        const nextNormal = { x: -nextDir.y, y: nextDir.x };
        let bisector = normalizeVector(prevNormal.x + nextNormal.x, prevNormal.y + nextNormal.y);
        if (Math.abs(bisector.x) < 0.000001 && Math.abs(bisector.y) < 0.000001) {
            bisector = nextNormal;
        }

        const alignment = clamp(
            Math.abs(bisector.x * nextNormal.x + bisector.y * nextNormal.y),
            0.3,
            1
        );
        const distanceScale = clamp(offsetDistance / alignment, -Math.abs(offsetDistance) * 3, Math.abs(offsetDistance) * 3);
        return {
            x: point.x + bisector.x * distanceScale,
            y: point.y + bisector.y * distanceScale
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
        }))
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
    return offsetX === 0 && offsetY === 0
        ? layout
        : offsetTrackLayout(layout, offsetX, offsetY);
}

function buildTrackFromLoop(rawPoints, trackWidth, lineSmoothing, cornerRadius) {
    const filtered = dedupeStrokePoints(rawPoints, 0.35);
    if (filtered.length < 3) {
        return null;
    }

    const centerline = smoothLoopPoints(filtered, lineSmoothing);
    const loopLength = totalLoopLength(centerline);
    if (loopLength < trackWidth * 5) {
        return null;
    }

    const halfWidth = trackWidth / 2;
    const candidateA = offsetLoop(centerline, halfWidth);
    const candidateB = offsetLoop(centerline, -halfWidth);
    const areaA = Math.abs(signedArea(candidateA));
    const areaB = Math.abs(signedArea(candidateB));
    if (!Number.isFinite(areaA) || !Number.isFinite(areaB) || Math.abs(areaA - areaB) < 0.001) {
        return null;
    }
    const outer = areaA >= areaB ? candidateA : candidateB;
    const inner = areaA >= areaB ? candidateB : candidateA;
    const startIndex = 0;
    const nextIndex = 1 % centerline.length;
    const startAngle = Math.atan2(
        centerline[nextIndex].y - centerline[startIndex].y,
        centerline[nextIndex].x - centerline[startIndex].x
    );
    const checkpointCount = Math.min(4, Math.max(3, Math.floor(outer.length / 12)));
    const checkpoints = [];
    for (let index = 1; index <= checkpointCount; index += 1) {
        const sample = sampleClosedLoopAtDistance(centerline, (loopLength * index) / (checkpointCount + 1));
        const normal = { x: -sample.tangent.y, y: sample.tangent.x };
        checkpoints.push({
            p1: {
                x: sample.point.x + normal.x * halfWidth,
                y: sample.point.y + normal.y * halfWidth
            },
            p2: {
                x: sample.point.x - normal.x * halfWidth,
                y: sample.point.y - normal.y * halfWidth
            }
        });
    }

    return normalizeTrackLayout({
        outer: outer.map(clonePoint),
        inner: inner.map(clonePoint),
        startLine: {
            p1: clonePoint(outer[startIndex]),
            p2: clonePoint(inner[startIndex])
        },
        startPos: midpoint(outer[nextIndex], inner[nextIndex]),
        startAngle,
        checkpoints,
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
        this.trackDestinationHint = document.getElementById('track-destination-hint');
        this.cornerRadiusSelect = document.getElementById('corner-radius-select');
        this.startAngleInput = document.getElementById('start-angle-input');
        this.lineSmoothingInput = document.getElementById('line-smoothing-input');
        this.drawMetricsLabel = document.getElementById('draw-metrics-label');
        this.selectedXInput = document.getElementById('selected-x-input');
        this.selectedYInput = document.getElementById('selected-y-input');
        this.selectionLabel = document.getElementById('selection-label');
        this.checkpointSelect = document.getElementById('checkpoint-select');
        this.checkpointCount = document.getElementById('checkpoint-count');
        this.statusText = document.getElementById('status-text');
        this.dirtyBadge = document.getElementById('dirty-badge');
        this.saveTrackBtn = document.getElementById('save-track-btn');
        this.downloadTrackBtn = document.getElementById('download-track-btn');
        this.newTrackBtn = document.getElementById('new-track-btn');
        this.duplicateTrackBtn = document.getElementById('duplicate-track-btn');
        this.insertPointBtn = document.getElementById('insert-point-btn');
        this.deletePointBtn = document.getElementById('delete-point-btn');
        this.reversePolygonBtn = document.getElementById('reverse-polygon-btn');
        this.copyTrackBtn = document.getElementById('copy-track-btn');
        this.copyIntegrationBtn = document.getElementById('copy-integration-btn');
        this.addCheckpointBtn = document.getElementById('add-checkpoint-btn');
        this.removeCheckpointBtn = document.getElementById('remove-checkpoint-btn');
        this.reframeBtn = document.getElementById('reframe-btn');

        const initialTrackKey = Object.keys(TRACKS)[0];
        this.state = {
            tracks: cloneTracks(TRACKS),
            selectedTrackKey: initialTrackKey,
            tool: 'outer',
            selectedHandle: null,
            hoverHandle: null,
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
                // Snapshot of content bounds while dragging a handle so extreme
                // points do not recenter/rescale the camera mid-drag.
                frozenBounds: null
            }
        };

        this.bindEvents();
        this.populateTrackSelect();
        this.loadTrack(initialTrackKey);
        this.resizeCanvas();

        const resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        resizeObserver.observe(this.canvas.parentElement);
    }

    get track() {
        return this.state.tracks[this.state.selectedTrackKey];
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

    syncDrawWidthControls() {
        this.track.drawWidth = FIXED_DRAW_WIDTH;
        this.updateDrawMetricsLabel();
    }

    syncLineSmoothingControl() {
        if (this.lineSmoothingInput) {
            this.lineSmoothingInput.value = formatNumber(this.getLineSmoothing());
        }
    }

    getDraftSegments() {
        const committed = [];
        const points = this.state.draftLoop;
        for (let index = 1; index < points.length; index += 1) {
            committed.push({
                a: points[index - 1],
                b: points[index],
                type: 'committed'
            });
        }

        if (!points.length || !this.state.draftCursor) {
            return { committed, preview: null };
        }

        const previewTarget = this.state.draftCloseHover && points.length >= 3
            ? points[0]
            : this.state.draftCursor;
        const previewLength = distance(points[points.length - 1], previewTarget);
        const preview = previewLength > 0.001
            ? {
                a: points[points.length - 1],
                b: previewTarget,
                type: this.state.draftCloseHover && points.length >= 3 ? 'closing' : 'preview'
            }
            : null;
        return { committed, preview };
    }

    getDraftMetrics() {
        const { committed, preview } = this.getDraftSegments();
        const committedLength = committed.reduce((total, segment) => total + distance(segment.a, segment.b), 0);
        const lastSegment = committed[committed.length - 1] ?? null;
        const previewLength = preview ? distance(preview.a, preview.b) : 0;
        return {
            width: this.getDrawWidth(),
            lineSmoothing: this.getLineSmoothing(),
            pointCount: this.state.draftLoop.length,
            committedLength,
            previewLength,
            totalPreviewLength: committedLength + previewLength,
            lastSegmentLength: lastSegment ? distance(lastSegment.a, lastSegment.b) : 0,
            previewType: preview?.type ?? null
        };
    }

    updateDrawMetricsLabel() {
        if (!this.drawMetricsLabel) {
            return;
        }
        const metrics = this.getDraftMetrics();
        const brushCars = formatCarWidths(metrics.width);
        const carSize = `Car ${formatNumber(CAR_WIDTH)}×${formatNumber(CAR_LENGTH)}u.`;
        const brushText = `Brush ${formatNumber(metrics.width)}u (~${brushCars} cars wide).`;
        const smoothingText = `Smoothing ${formatNumber(metrics.lineSmoothing)}.`;

        if (!metrics.pointCount) {
            let startLaneText = '';
            if (this.hasTrackGeometry() && this.track?.startLine) {
                const startLane = distance(this.track.startLine.p1, this.track.startLine.p2);
                if (Number.isFinite(startLane) && startLane > 0) {
                    startLaneText = ` Start line ${formatNumber(startLane)}u (~${formatCarWidths(startLane)} cars).`;
                }
            }
            this.drawMetricsLabel.textContent = `${carSize} ${brushText} ${smoothingText}${startLaneText} Place the first point to start measuring straights.`;
            return;
        }

        const parts = [carSize, brushText, smoothingText];
        if (metrics.lastSegmentLength > 0) {
            parts.push(`Last straight ${formatNumber(metrics.lastSegmentLength)}u (~${formatCarWidths(metrics.lastSegmentLength)} cars long).`);
        }
        if (metrics.previewLength > 0) {
            const label = metrics.previewType === 'closing' ? 'Closing straight' : 'Preview straight';
            parts.push(`${label} ${formatNumber(metrics.previewLength)}u (~${formatCarWidths(metrics.previewLength)} cars).`);
        }
        if (metrics.totalPreviewLength > 0) {
            parts.push(`Draft length ${formatNumber(metrics.totalPreviewLength)}u.`);
        }
        this.drawMetricsLabel.textContent = parts.join(' ');
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
            this.syncDestinationHint();
            this.markDirty(
                this.getSelectedDestination() === 'daily'
                    ? 'Marked track for Daily Challenge.'
                    : 'Marked track as Campaign only.',
            );
        });

        this.cornerRadiusSelect.addEventListener('change', () => {
            this.setCornerRadius(Number(this.cornerRadiusSelect.value));
        });

        this.startAngleInput.addEventListener('input', () => {
            const value = Number(this.startAngleInput.value);
            this.track.startAngle = Number.isFinite(value) ? value : 0;
            this.markDirty('Updated start angle.');
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
            const point = this.getSelectedPointRef();
            if (!point) {
                return;
            }
            const nextX = Number(this.selectedXInput.value);
            const nextY = Number(this.selectedYInput.value);
            if (Number.isFinite(nextX)) {
                point.x = nextX;
            }
            if (Number.isFinite(nextY)) {
                point.y = nextY;
            }

            const crossTrackLine = this.getSelectedCrossTrackLine();
            if (
                crossTrackLine
                && this.applyPerpendicularSnapToCrossTrackLine(crossTrackLine, {
                    x: point.x,
                    y: point.y,
                })
            ) {
                this.markDirty(
                    this.state.selectedHandle?.kind === 'startLine'
                        ? 'Updated start line (snapped across the track).'
                        : 'Updated checkpoint (snapped across the track).',
                );
                this.syncSelectedInputs();
                return;
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
                    endpoint: 'p1'
                };
            }
            this.syncSelectedInputs();
            this.updateStageText();
            this.draw();
        });

        this.newTrackBtn.addEventListener('click', () => this.createTrack());
        this.duplicateTrackBtn.addEventListener('click', () => this.duplicateTrack());
        this.insertPointBtn.addEventListener('click', () => this.insertPointAfterSelection());
        this.deletePointBtn.addEventListener('click', () => this.deleteSelectedPoint());
        this.reversePolygonBtn.addEventListener('click', () => this.reverseActivePolygon());
        this.copyTrackBtn.addEventListener('click', () => this.copyCurrentTrack());
        this.addCheckpointBtn.addEventListener('click', () => this.addCheckpoint());
        this.removeCheckpointBtn.addEventListener('click', () => this.removeCheckpoint());
        this.reframeBtn.addEventListener('click', () => this.resetView());
        this.saveTrackBtn.addEventListener('click', () => this.saveAndIntegrateTrack());
        this.downloadTrackBtn.addEventListener('click', () => this.downloadTrackModule());
        this.copyIntegrationBtn.addEventListener('click', () => this.copyTrackIntegration());

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
            if (this.state.dirtyTrackKeys.size === 0) {
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
                endpoint: 'p1'
            };
        } else if (tool === 'startLine') {
            this.state.selectedHandle = { kind: 'startLine', endpoint: 'p1' };
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

    getDestinationForTrackKey(trackKey) {
        const originalTrackKey = this.state.originalTrackKeyByKey.get(trackKey);
        if (originalTrackKey && SCHEDULED_TRACK_KEYS.has(originalTrackKey)) {
            return 'daily';
        }
        if (SCHEDULED_TRACK_KEYS.has(trackKey)) {
            return 'daily';
        }
        // Brand-new editor tracks default to Daily Challenge.
        if (!originalTrackKey) {
            return 'daily';
        }
        return 'campaign';
    }

    getSelectedDestination() {
        const value = this.trackDestinationSelect.value;
        return TRACK_DESTINATIONS.has(value) ? value : 'daily';
    }

    syncDestinationControl(trackKey = this.state.selectedTrackKey) {
        this.trackDestinationSelect.value = this.getDestinationForTrackKey(trackKey);
        this.syncDestinationHint();
    }

    syncDestinationHint() {
        if (!this.trackDestinationHint) {
            return;
        }
        this.trackDestinationHint.textContent = this.getSelectedDestination() === 'daily'
            ? 'Adds this track to the future Daily GP rotation when you Save & Integrate.'
            : 'Keeps this track out of Daily. Wire it into Campaign stages in the Campaign manifest.';
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
        this.state.selectedTrackKey = trackKey;
        this.trackSelect.value = trackKey;
        this.trackKeyInput.value = trackKey;
        this.trackNameInput.value = this.track.name;
        this.syncDestinationControl(trackKey);
        this.syncCornerRadiusControl();
        this.startAngleInput.value = String(this.track.startAngle ?? 0);
        this.syncLineSmoothingControl();
        this.syncDrawWidthControls();
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
        this.state.skipDrawClick = false;
        this.state.view.frozenBounds = null;
        this.state.selectedHandle = { kind: 'polygon', path: this.state.tool === 'inner' ? 'inner' : 'outer', index: 0 };
        if (!this.hasTrackGeometry()) {
            this.state.tool = 'draw';
            this.state.selectedHandle = null;
        } else if (this.state.tool === 'startLine') {
            this.state.selectedHandle = { kind: 'startLine', endpoint: 'p1' };
        } else if (this.state.tool === 'startPos') {
            this.state.selectedHandle = { kind: 'startPos' };
        } else if (this.state.tool === 'checkpoints') {
            this.state.selectedHandle = this.track.checkpoints.length
                ? { kind: 'checkpoint', checkpointIndex: 0, endpoint: 'p1' }
                : null;
        }
        this.state.checkpointIndex = 0;
        this.refreshCheckpointSelect();
        this.syncSelectedInputs();
        this.updateStageText();
        this.updateDrawMetricsLabel();
        this.syncDirtyBadge();
        this.draw();
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
        const rawKey = window.prompt('Duplicate track key', `${sourceKey}Copy`);
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
        const name = (window.prompt('Duplicate display name', `${copy.name} Copy`) || `${copy.name} Copy`).trim() || `${copy.name} Copy`;
        copy.name = name;
        this.state.tracks[key] = copy;
        this.populateTrackSelect();
        this.loadTrack(key);
        this.markDirty(`Duplicated ${sourceKey} into ${key}.`);
    }

    getSelectedPointRef() {
        const handle = this.state.selectedHandle;
        if (!handle) {
            return null;
        }
        if (handle.kind === 'polygon') {
            return this.track[handle.path][handle.index] || null;
        }
        if (handle.kind === 'startLine') {
            return this.track.startLine[handle.endpoint];
        }
        if (handle.kind === 'startPos') {
            return this.track.startPos;
        }
        if (handle.kind === 'checkpoint') {
            const checkpoint = this.track.checkpoints[handle.checkpointIndex];
            return checkpoint ? checkpoint[handle.endpoint] : null;
        }
        return null;
    }

    getSelectedCrossTrackLine() {
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

    applyPerpendicularSnapToCrossTrackLine(line, worldPoint) {
        if (!line || !this.hasTrackGeometry()) {
            return false;
        }
        const span = buildPerpendicularWallSpan(
            worldPoint,
            this.track.outer,
            this.track.inner,
        );
        if (!span) {
            return false;
        }
        line.p1.x = span.p1.x;
        line.p1.y = span.p1.y;
        line.p2.x = span.p2.x;
        line.p2.y = span.p2.y;
        return true;
    }

    syncSelectedInputs() {
        const point = this.getSelectedPointRef();
        const hasPoint = Boolean(point);
        this.selectedXInput.disabled = !hasPoint;
        this.selectedYInput.disabled = !hasPoint;
        if (hasPoint) {
            this.selectedXInput.value = formatNumber(point.x);
            this.selectedYInput.value = formatNumber(point.y);
        } else {
            this.selectedXInput.value = '';
            this.selectedYInput.value = '';
        }

        const handle = this.state.selectedHandle;
        if (!handle || !point) {
            this.selectionLabel.textContent = 'No point selected.';
            return;
        }

        if (handle.kind === 'polygon') {
            this.selectionLabel.textContent = `${handle.path} point ${handle.index + 1}`;
        } else if (handle.kind === 'startLine') {
            this.selectionLabel.textContent = `start line ${handle.endpoint}`;
        } else if (handle.kind === 'startPos') {
            this.selectionLabel.textContent = 'start position';
        } else if (handle.kind === 'checkpoint') {
            this.selectionLabel.textContent = `checkpoint ${handle.checkpointIndex + 1} ${handle.endpoint}`;
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
            const metrics = this.getDraftMetrics();
            const widthText = formatNumber(metrics.width);
            const smoothingText = formatNumber(metrics.lineSmoothing);
            if (pointCount === 0) {
                this.canvasHint.textContent = this.hasTrackGeometry()
                    ? `Click to place a new loop point. Brush ${widthText}u and smoothing ${smoothingText} are active.`
                    : `Blank canvas ready. Click to place loop points, then click the first point to close the track with a ${widthText}u corridor.`;
                return;
            }
            const previewText = metrics.previewLength > 0
                ? `${metrics.previewType === 'closing' ? 'Closing' : 'Next'} straight ${formatNumber(metrics.previewLength)}u.`
                : 'Move the cursor to preview the next straight.';
            this.canvasHint.textContent = pointCount < 3
                ? `${pointCount} point${pointCount === 1 ? '' : 's'} placed. Brush ${widthText}u. ${previewText} Add at least ${3 - pointCount} more point${pointCount === 2 ? '' : 's'} before closing the loop.`
                : `${pointCount} loop points placed. Brush ${widthText}u. ${previewText} Click the first point to finish the track, or keep adding corners.`;
            return;
        }
        if (!this.hasTrackGeometry()) {
            this.canvasHint.textContent = 'This track has no walls yet. Switch to Line Build and close the loop first.';
            return;
        }
        if (this.state.tool === 'startLine') {
            this.canvasHint.textContent = 'Drag the start line. It snaps wall-to-wall, perpendicular to the track.';
            return;
        }
        if (this.state.tool === 'checkpoints') {
            this.canvasHint.textContent = 'Drag a checkpoint. It snaps wall-to-wall, perpendicular to the track.';
            return;
        }
        this.canvasHint.textContent = 'Click the track to select, then drag to edit or use the sidebar for precise values.';
    }

    validateTrack(track) {
        if (!track || track.outer.length < 3 || track.inner.length < 3) {
            return 'walls are incomplete';
        }

        const points = [
            ...track.outer,
            ...track.inner,
            track.startLine?.p1,
            track.startLine?.p2,
            track.startPos,
            ...track.checkpoints.flatMap((checkpoint) => [checkpoint.p1, checkpoint.p2])
        ].filter(Boolean);

        const hasInvalidPoint = points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y));
        return hasInvalidPoint ? 'contains invalid coordinates' : null;
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
                { kind: 'startLine', endpoint: 'p2', point: this.track.startLine.p2 }
            ];
        }
        if (tool === 'startPos') {
            return [{ kind: 'startPos', point: this.track.startPos }];
        }
        if (tool === 'checkpoints') {
            return this.track.checkpoints.flatMap((checkpoint, checkpointIndex) => ([
                { kind: 'checkpoint', checkpointIndex, endpoint: 'p1', point: checkpoint.p1 },
                { kind: 'checkpoint', checkpointIndex, endpoint: 'p2', point: checkpoint.p2 }
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
            return a.endpoint === b.endpoint;
        }
        if (a.kind === 'startPos') {
            return true;
        }
        return a.checkpointIndex === b.checkpointIndex && a.endpoint === b.endpoint;
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
        const hitRadius = 9;
        let best = null;

        this.getSelectableSegments().forEach((segment) => {
            const start = this.worldToScreen(segment.a, viewport);
            const end = this.worldToScreen(segment.b, viewport);
            const match = distanceToSegment(canvasPoint, start, end);
            if (match.distance <= hitRadius && (!best || match.distance < best.distance)) {
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
            this.selectHandle({ kind: 'startLine', endpoint: nearestEndpoint });
            return true;
        }

        if (segment.kind === 'checkpointSegment') {
            this.selectHandle({
                kind: 'checkpoint',
                checkpointIndex: segment.checkpointIndex,
                endpoint: nearestEndpoint
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
        return distance(canvasPoint, screenPoint) <= 40 ? startPoint : null;
    }

    addDraftLoopPoint(point) {
        const lastPoint = this.state.draftLoop[this.state.draftLoop.length - 1];
        if (lastPoint && distance(lastPoint, point) < 0.35) {
            return;
        }
        this.state.draftLoop = [...this.state.draftLoop, clonePoint(point)];
        this.state.draftCursor = clonePoint(point);
        this.state.draftCloseHover = false;
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
        this.setStatus(this.state.draftLoop.length ? 'Removed last draft point.' : 'Cleared draft loop.');
        this.updateDrawMetricsLabel();
        this.updateCanvasHint();
        this.draw();
    }

    clearDraftLoop() {
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
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

        this.track.outer = generated.outer;
        this.track.inner = generated.inner;
        this.track.startLine = generated.startLine;
        this.track.startPos = generated.startPos;
        this.track.startAngle = generated.startAngle;
        this.track.checkpoints = generated.checkpoints;
        this.track.cornerRadius = generated.cornerRadius;
        this.track.lineSmoothing = lineSmoothing;
        this.syncCornerRadiusControl();
        this.syncLineSmoothingControl();
        this.startAngleInput.value = formatNumber(this.track.startAngle);
        this.state.draftLoop = [];
        this.state.draftCursor = null;
        this.state.draftCloseHover = false;
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
            return;
        }

        if ((this.state.tool === 'outer' || this.state.tool === 'inner') && event.shiftKey) {
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            this.insertPointNear(worldPoint);
            return;
        }

        if (this.state.tool === 'startPos') {
            const point = this.track.startPos;
            const worldPoint = this.screenToWorld(canvasPoint.x, canvasPoint.y, viewport);
            point.x = worldPoint.x;
            point.y = worldPoint.y;
            this.state.selectedHandle = { kind: 'startPos' };
            this.syncSelectedInputs();
            this.markDirty('Moved start position.');
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
            this.updateDrawMetricsLabel();
            this.updateCanvasHint();
            this.draw();
            return;
        }

        if (this.state.drag?.type === 'handle') {
            const handle = this.state.drag.handle;
            const crossTrackLine = handle?.kind === 'startLine' || handle?.kind === 'checkpoint'
                ? (
                    handle.kind === 'startLine'
                        ? this.track.startLine
                        : this.track.checkpoints[handle.checkpointIndex]
                )
                : null;
            if (crossTrackLine) {
                if (this.applyPerpendicularSnapToCrossTrackLine(crossTrackLine, worldPoint)) {
                    this.syncSelectedInputs();
                    this.markDirty(
                        handle.kind === 'startLine'
                            ? 'Moved start line (snapped across the track).'
                            : 'Moved checkpoint (snapped across the track).',
                        false,
                    );
                    this.draw();
                }
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

        this.state.hoverHandle = this.hitTest(canvasPoint, viewport);
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
        if (this.state.drag?.type === 'handle') {
            this.releaseViewBounds({ keepCameraSteady: true });
        }
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

        // Pinch-to-zoom (browsers synthesize ctrl+wheel for trackpad pinch).
        if (event.ctrlKey) {
            const zoomFactor = Math.exp((-event.deltaY * deltaModeScale) * 0.01);
            this.setZoom(this.state.view.zoom * zoomFactor, canvasPoint, viewport);
            return;
        }

        // Pixel-mode two-finger trackpad scrolls pan in both axes (including
        // vertical-only moves where deltaX is 0). Mouse wheels usually report
        // line/page mode and fall through to stepped zoom below.
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

        const point = this.getSelectedPointRef();
        if (!point) {
            return;
        }

        const step = event.shiftKey ? 1 : 0.25;
        let moved = false;
        if (event.key === 'ArrowLeft') {
            point.x -= step;
            moved = true;
        } else if (event.key === 'ArrowRight') {
            point.x += step;
            moved = true;
        } else if (event.key === 'ArrowUp') {
            point.y -= step;
            moved = true;
        } else if (event.key === 'ArrowDown') {
            point.y += step;
            moved = true;
        }

        if (moved) {
            event.preventDefault();
            const crossTrackLine = this.getSelectedCrossTrackLine();
            if (
                crossTrackLine
                && this.applyPerpendicularSnapToCrossTrackLine(crossTrackLine, {
                    x: point.x,
                    y: point.y,
                })
            ) {
                this.syncSelectedInputs();
                this.markDirty(
                    this.state.selectedHandle?.kind === 'startLine'
                        ? 'Nudged start line (snapped across the track).'
                        : 'Nudged checkpoint (snapped across the track).',
                );
                return;
            }
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
            this.setStatus('Build walls before adding checkpoints.', true);
            return;
        }
        const bounds = this.getTrackBounds();
        const center = {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
        };
        const span = buildPerpendicularWallSpan(center, this.track.outer, this.track.inner);
        const checkpoint = span || {
            p1: { x: center.x - 2, y: center.y },
            p2: { x: center.x + 2, y: center.y },
        };
        this.track.checkpoints.push({
            p1: clonePoint(checkpoint.p1),
            p2: clonePoint(checkpoint.p2),
        });
        this.state.checkpointIndex = this.track.checkpoints.length - 1;
        this.state.selectedHandle = {
            kind: 'checkpoint',
            checkpointIndex: this.state.checkpointIndex,
            endpoint: 'p1'
        };
        this.refreshCheckpointSelect();
        this.setTool('checkpoints');
        this.markDirty(
            span
                ? 'Added checkpoint (snapped across the track).'
                : 'Added checkpoint.',
        );
    }

    removeCheckpoint() {
        if (!this.track.checkpoints.length) {
            this.setStatus('There are no checkpoints to remove.', true);
            return;
        }
        this.track.checkpoints.splice(this.state.checkpointIndex, 1);
        this.state.checkpointIndex = Math.max(0, this.state.checkpointIndex - 1);
        this.refreshCheckpointSelect();
        this.state.selectedHandle = this.track.checkpoints.length
            ? {
                kind: 'checkpoint',
                checkpointIndex: this.state.checkpointIndex,
                endpoint: 'p1'
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

    markDirty(message, updateStatus = true) {
        this.state.dirtyTrackKeys.add(this.state.selectedTrackKey);
        this.syncTrackSelectText();
        this.syncDirtyBadge();
        if (updateStatus) {
            this.setStatus(message);
        }
        this.draw();
    }

    syncDirtyBadge() {
        const isDirty = this.state.dirtyTrackKeys.has(this.state.selectedTrackKey);
        this.dirtyBadge.textContent = isDirty ? 'Unsaved' : 'Saved';
        this.dirtyBadge.classList.toggle('pill-warn', isDirty);
    }

    markSaved(message) {
        this.state.dirtyTrackKeys.delete(this.state.selectedTrackKey);
        this.syncTrackSelectText();
        this.syncDirtyBadge();
        this.setStatus(message);
    }

    drawGrid(viewport) {
        const { ctx } = this;
        const minor = viewport.scale;
        const width = viewport.width;
        const height = viewport.height;
        const startX = viewport.offsetX % minor;
        const startY = viewport.offsetY % minor;

        ctx.save();
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

    drawPolygon(points, viewport, fillStyle, strokeStyle) {
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
        this.ctx.fillStyle = fillStyle;
        this.ctx.fill();
        this.ctx.lineWidth = 2;
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

    drawSegmentLengthLabel(a, b, viewport, text, active = false) {
        const start = this.worldToScreen(a, viewport);
        const end = this.worldToScreen(b, viewport);
        const screenLength = Math.hypot(end.x - start.x, end.y - start.y);
        if (screenLength < 56) {
            return;
        }

        const midpointX = (start.x + end.x) / 2;
        const midpointY = (start.y + end.y) / 2;
        const normal = normalizeVector(start.y - end.y, end.x - start.x);
        const labelX = midpointX + normal.x * (active ? 18 : 14);
        const labelY = midpointY + normal.y * (active ? 18 : 14);

        this.ctx.save();
        this.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        const metrics = this.ctx.measureText(text);
        const paddingX = 8;
        const boxWidth = metrics.width + paddingX * 2;
        const boxHeight = 22;
        this.ctx.fillStyle = active ? 'rgba(15, 23, 42, 0.96)' : 'rgba(15, 23, 42, 0.84)';
        this.ctx.strokeStyle = active ? 'rgba(251, 191, 36, 0.9)' : 'rgba(148, 163, 184, 0.35)';
        this.ctx.lineWidth = active ? 1.5 : 1;
        this.ctx.beginPath();
        this.ctx.rect(labelX - boxWidth / 2, labelY - boxHeight / 2, boxWidth, boxHeight);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.fillStyle = active ? '#fef3c7' : '#e2e8f0';
        this.ctx.fillText(text, labelX, labelY + 0.5);
        this.ctx.restore();
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
        if (!points.length) {
            return;
        }

        const { committed, preview } = this.getDraftSegments();
        const closeReady = points.length >= 3;
        const previewTarget = preview?.b ?? null;
        const drawWidth = this.getDrawWidth();

        this.ctx.save();
        this.ctx.beginPath();
        const first = this.worldToScreen(points[0], viewport);
        this.ctx.moveTo(first.x, first.y);
        for (let index = 1; index < points.length; index += 1) {
            const point = this.worldToScreen(points[index], viewport);
            this.ctx.lineTo(point.x, point.y);
        }
        if (previewTarget) {
            const previewScreen = this.worldToScreen(previewTarget, viewport);
            this.ctx.lineTo(previewScreen.x, previewScreen.y);
        }
        this.ctx.strokeStyle = 'rgba(251, 191, 36, 0.16)';
        this.ctx.lineWidth = Math.max(10, drawWidth * viewport.scale);
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(first.x, first.y);
        for (let index = 1; index < points.length; index += 1) {
            const point = this.worldToScreen(points[index], viewport);
            this.ctx.lineTo(point.x, point.y);
        }
        if (previewTarget) {
            const previewScreen = this.worldToScreen(previewTarget, viewport);
            this.ctx.lineTo(previewScreen.x, previewScreen.y);
        }
        this.ctx.strokeStyle = 'rgba(251, 191, 36, 0.92)';
        this.ctx.lineWidth = 3;
        this.ctx.lineJoin = 'round';
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        points.forEach((point, index) => {
            const screenPoint = this.worldToScreen(point, viewport);
            this.ctx.beginPath();
            this.ctx.fillStyle = index === 0 ? '#fbbf24' : '#f8fafc';
            this.ctx.strokeStyle = index === 0 && this.state.draftCloseHover ? '#ffffff' : 'rgba(15, 23, 42, 0.9)';
            this.ctx.lineWidth = index === 0 ? 3 : 2;
            this.ctx.arc(screenPoint.x, screenPoint.y, index === 0 ? 7 : 5, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
        });

        if (closeReady) {
            this.ctx.beginPath();
            this.ctx.strokeStyle = this.state.draftCloseHover ? 'rgba(255, 255, 255, 0.95)' : 'rgba(251, 191, 36, 0.55)';
            this.ctx.lineWidth = this.state.draftCloseHover ? 3 : 2;
            this.ctx.arc(first.x, first.y, this.state.draftCloseHover ? 13 : 11, 0, Math.PI * 2);
            this.ctx.stroke();
        }
        this.ctx.restore();

        committed.forEach((segment) => {
            this.drawSegmentLengthLabel(
                segment.a,
                segment.b,
                viewport,
                `${formatNumber(distance(segment.a, segment.b))}u`
            );
        });
        if (preview) {
            this.drawSegmentLengthLabel(
                preview.a,
                preview.b,
                viewport,
                `${formatNumber(distance(preview.a, preview.b))}u`,
                true
            );
        }
    }

    getDraftGhostHeading() {
        const points = this.state.draftLoop;
        const cursor = this.state.draftCursor;
        if (points.length >= 1 && cursor) {
            const from = points[points.length - 1];
            const to = this.state.draftCloseHover && points.length >= 3 ? points[0] : cursor;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            if (Math.hypot(dx, dy) > 0.001) {
                return Math.atan2(dy, dx);
            }
        }
        if (points.length >= 2) {
            const a = points[points.length - 2];
            const b = points[points.length - 1];
            return Math.atan2(b.y - a.y, b.x - a.x);
        }
        return Number(this.track.startAngle) || 0;
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

    drawCarScaleLegend(viewport) {
        const brush = this.getDrawWidth();
        const lines = [
            `Car ${formatNumber(CAR_WIDTH)}×${formatNumber(CAR_LENGTH)}u`,
            `Brush ${formatNumber(brush)}u ≈ ${formatCarWidths(brush)} cars wide`,
        ];
        this.ctx.save();
        this.ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        const paddingX = 10;
        const paddingY = 8;
        const lineHeight = 14;
        const textWidth = Math.max(...lines.map((line) => this.ctx.measureText(line).width));
        const boxWidth = textWidth + paddingX * 2;
        const boxHeight = paddingY * 2 + lineHeight * lines.length + 4;
        const x = 12;
        const y = 12;
        this.ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        this.ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.rect(x, y, boxWidth, boxHeight);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.fillStyle = '#e2e8f0';
        lines.forEach((line, index) => {
            this.ctx.fillText(line, x + paddingX, y + paddingY + index * lineHeight);
        });
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
            this.drawPolygon(this.track.outer, viewport, 'rgba(244, 63, 94, 0.10)', '#f43f5e');
            this.drawPolygon(this.track.inner, viewport, 'rgba(56, 189, 248, 0.12)', '#38bdf8');
            this.drawLineSegment(this.track.startLine.p1, this.track.startLine.p2, viewport, '#a78bfa', 4, true);
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

        this.drawDraftLoop(viewport);

        if (this.state.tool === 'draw' && this.state.draftCursor) {
            this.drawGhostCar(
                this.state.draftCursor,
                this.getDraftGhostHeading(),
                viewport,
                { muted: true },
            );
        }

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
        this.drawCarScaleLegend(viewport);
    }

    async copyCurrentTrack() {
        const invalidTrack = this.validateTrack(this.track);
        if (invalidTrack) {
            this.setStatus(`Finish ${this.track.name} before copying: ${invalidTrack}.`, true);
            return;
        }

        const text = generateTrackModuleSource(this.track);
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                this.setStatus(`Copied ${getTrackModuleFilename(this.state.selectedTrackKey)} module source.`);
                return;
            }
        } catch (error) {
            console.error(error);
        }
        this.setStatus('Clipboard write is not available here.', true);
    }

    async copyTrackIntegration() {
        const text = generateTrackIntegrationSnippet(this.state.selectedTrackKey, this.track.name);
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                this.setStatus('Copied catalog, import, and registry integration lines.');
                return;
            }
        } catch (error) {
            console.error(error);
        }
        this.setStatus('Clipboard write is not available here.', true);
    }

    downloadTrackModule() {
        const invalidTrack = this.validateTrack(this.track);
        if (invalidTrack) {
            this.setStatus(`Cannot export ${this.track.name}: ${invalidTrack}.`, true);
            return;
        }

        const filename = getTrackModuleFilename(this.state.selectedTrackKey);
        const blob = new Blob([generateTrackModuleSource(this.track)], { type: 'text/javascript;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.setStatus(
            `Downloaded ${filename}. Repository integration is still required.`,
        );
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
        if (
            destination === 'campaign'
            && currentlyScheduled
            && !window.confirm(
                `Move ${trackKey} off the Daily Challenge schedule? It will stay in the track catalog for Campaign use, but will not appear in future Daily GP days.`,
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
                    track: this.track,
                }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(result.error || `Save failed with status ${response.status}.`);
            }

            this.state.originalTrackKeyByKey.set(trackKey, trackKey);
            if (destination === 'daily') {
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
            const scheduleText = destination === 'daily'
                ? (
                    Number.isInteger(result.scheduleIndex) && result.scheduleIndex >= 0
                        ? ` Added to Daily Challenge at schedule position ${result.scheduleIndex + 1}.`
                        : ' Marked for Daily Challenge.'
                )
                : ' Saved as Campaign only (not on the Daily schedule).';
            const renameText = result.removedFilename
                ? ` Removed ${result.removedFilename}.`
                : '';
            this.markSaved(
                `Saved and integrated ${result.filename}.${scheduleText}${renameText}`,
            );
        } catch (error) {
            console.error(error);
            this.setStatus(
                `${error.message} Run Mapmaker through the local Vite server, or use Download Module and Copy Integration.`,
                true,
            );
        } finally {
            this.saveTrackBtn.disabled = false;
        }
    }
}

new MapmakerApp();
