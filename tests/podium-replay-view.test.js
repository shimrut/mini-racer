import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { interpolatePbGhostPose } from '../game/ghost/pb-ghost.js';
import { TRACKS } from '../game/track/tracks.js';
import {
    createLocalPodiumPreview,
    createPodiumReplayController,
    formatPodiumReplayClock,
    normalizePodiumReplayGhosts,
    PODIUM_REPLAY_CAR_ASSETS,
    shouldUseLocalPodiumPreview,
} from '../podium-replay-view.js';

const ghost = {
    schemaVersion: 2,
    sampleIntervalMs: 50,
    finishTimeMs: 200,
    origin: [0, 0, 0],
    deltas: [100, 0, 0, 100, 0, 0, 100, 0, 0, 100, 0, 0],
};

function replayDocument() {
    return new JSDOM(`
        <main id="podium-shell" data-mode="podium"></main>
        <section id="podium-results"></section>
        <section id="podium-replay" hidden>
            <span id="podium-replay-time">0:00.000</span>
            <input id="podium-replay-seek" type="range" min="0" max="1" value="0">
            <button id="podium-replay-toggle" type="button" data-playing="false" aria-label="Play">Play</button>
            <button class="podium-replay__speed" data-rate="0.5" type="button">0.5×</button>
            <button class="podium-replay__speed" data-rate="1" type="button">1×</button>
            <button class="podium-replay__speed" data-rate="2" type="button">2×</button>
            <button class="podium-replay__car" data-rank="1" type="button" aria-pressed="true">Gold</button>
            <button class="podium-replay__car" data-rank="2" type="button" aria-pressed="true">Silver</button>
            <button class="podium-replay__car" data-rank="3" type="button" aria-pressed="true">Bronze</button>
        </section>
        <button id="podium-view-replays" type="button" hidden>View Replays</button>
        <button id="podium-play" type="button">Play Now</button>
        <button id="podium-replay-back" type="button" hidden>Back</button>
        <canvas id="podium-track"></canvas>
    `).window.document;
}

describe('podium in-post replay', () => {
    it('keeps only valid ghosts and reports duration from the slowest finish', () => {
        const normalized = normalizePodiumReplayGhosts({
            trackKey: 'circuit',
            ghosts: [
                { rank: 1, ghost },
                { rank: 2, ghost: { schemaVersion: 1 } },
                { rank: 9, ghost },
            ],
        });
        expect(normalized.records.size).toBe(1);
        expect(normalized.durationMs).toBe(200);
        expect(normalized.trackKey).toBe('circuit');
    });

    it('formats the replay clock like podium times', () => {
        expect(formatPodiumReplayClock(10193)).toBe('0:10.193');
    });

    it('assigns gold, arctic, and blaze cars by place', () => {
        expect(PODIUM_REPLAY_CAR_ASSETS[1]).toContain('gold');
        expect(PODIUM_REPLAY_CAR_ASSETS[2]).toContain('arctic');
        expect(PODIUM_REPLAY_CAR_ASSETS[3]).toContain('blaze');
    });

    it('builds a local preview only when preview=1 on a local host', () => {
        const originalWindow = globalThis.window;
        globalThis.window = { location: { hostname: '127.0.0.1', protocol: 'http:', search: '?preview=1' } };
        expect(shouldUseLocalPodiumPreview({ location: { search: '?preview=1' } })).toBe(true);
        expect(shouldUseLocalPodiumPreview({ location: { search: '' } })).toBe(false);
        const preview = createLocalPodiumPreview();
        expect(preview.replays.ghosts).toHaveLength(3);
        const normalized = normalizePodiumReplayGhosts(preview.replays);
        expect(normalized.records.size).toBe(3);
        expect(normalized.durationMs).toBeGreaterThan(10000);
        const goldStart = interpolatePbGhostPose(normalized.records.get(1).samples, 0);
        const goldMid = interpolatePbGhostPose(normalized.records.get(1).samples, 5000);
        expect(Math.hypot(goldStart.x - TRACKS.circuit.startPos.x, goldStart.y - TRACKS.circuit.startPos.y)).toBeLessThan(3);
        expect(Math.hypot(goldMid.x - goldStart.x, goldMid.y - goldStart.y)).toBeGreaterThan(2);
        globalThis.window = { location: { hostname: 'reddit.com', protocol: 'https:', search: '?preview=1' } };
        expect(shouldUseLocalPodiumPreview({ location: { search: '?preview=1' } })).toBe(false);
        globalThis.window = originalWindow;
    });

    it('plays, pauses, and scrubs without leaving the post', async () => {
        const OriginalPath2D = globalThis.Path2D;
        globalThis.Path2D = class Path2DMock {
            addPath() {}
            moveTo() {}
            lineTo() {}
            closePath() {}
        };
        const documentRef = replayDocument();
        const canvas = documentRef.getElementById('podium-track');
        canvas.getBoundingClientRect = () => ({ width: 320, height: 180, top: 0, left: 0, right: 320, bottom: 180 });
        canvas.getContext = () => ({
            clearRect: vi.fn(),
            fillRect: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            translate: vi.fn(),
            rotate: vi.fn(),
            clip: vi.fn(),
            drawImage: vi.fn(),
            setLineDash: vi.fn(),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            closePath: vi.fn(),
            fillStyle: '',
            strokeStyle: '',
            lineJoin: 'round',
            lineCap: 'round',
            globalCompositeOperation: 'source-over',
        });
        const controller = createPodiumReplayController({
            documentRef,
            canvas,
            getTrackName: () => 'Circuit ProMax',
            requestFrame: () => 1,
            cancelFrame: vi.fn(),
        });

        await controller.prepare({
            trackKey: 'circuit',
            ghosts: [{ rank: 1, ghost }],
        }, 'Circuit ProMax');

        expect(controller.enter()).toBe(true);
        expect(controller.playing).toBe(false);
        expect(documentRef.getElementById('podium-replay-toggle').dataset.playing).toBe('false');
        expect(documentRef.getElementById('podium-replay-toggle').getAttribute('aria-label')).toBe('Play');
        expect(documentRef.getElementById('podium-replay-seek').max).toBe('200');
        expect(documentRef.getElementById('podium-shell').dataset.mode).toBe('replay');
        expect(documentRef.getElementById('podium-results').hasAttribute('inert')).toBe(true);
        expect(documentRef.getElementById('podium-play').hidden).toBe(true);
        expect(documentRef.getElementById('podium-replay-back').hidden).toBe(false);
        expect(controller.isVisible(1)).toBe(true);
        expect(controller.isVisible(2)).toBe(false);

        controller.setVisible(1, false);
        expect(controller.isVisible(1)).toBe(false);
        controller.setVisible(1, true);

        controller.play();
        expect(controller.playing).toBe(true);
        expect(documentRef.getElementById('podium-replay-toggle').dataset.playing).toBe('true');
        expect(documentRef.getElementById('podium-replay-toggle').getAttribute('aria-label')).toBe('Pause');
        controller.pause();
        expect(controller.playing).toBe(false);
        expect(documentRef.getElementById('podium-replay-toggle').dataset.playing).toBe('false');
        expect(documentRef.getElementById('podium-replay-toggle').getAttribute('aria-label')).toBe('Play');
        controller.setRate(2);
        controller.advance(50);
        expect(controller.rate).toBe(2);
        controller.seek(80);
        expect(controller.timeMs).toBe(80);
        expect(documentRef.getElementById('podium-replay-seek').value).toBe('80');
        expect(documentRef.getElementById('podium-replay-seek').style.getPropertyValue('--progress')).toBe('40%');
        controller.exit();
        expect(documentRef.getElementById('podium-shell').dataset.mode).toBe('podium');
        expect(documentRef.getElementById('podium-play').hidden).toBe(false);
        globalThis.Path2D = OriginalPath2D;
    });
});
