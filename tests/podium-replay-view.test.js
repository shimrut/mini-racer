import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
    createPodiumReplayController,
    formatPodiumReplayClock,
    normalizePodiumReplayGhosts,
    PODIUM_REPLAY_CAR_ASSETS,
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
            <button id="podium-replay-play" type="button">Play</button>
            <button id="podium-replay-pause" type="button">Pause</button>
            <button id="podium-replay-stop" type="button">Stop</button>
            <button class="podium-replay__speed" data-rate="0.5" type="button">0.5×</button>
            <button class="podium-replay__speed" data-rate="1" type="button">1×</button>
            <button class="podium-replay__speed" data-rate="2" type="button">2×</button>
        </section>
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

    it('plays, pauses, stops, and changes speed without leaving the post', async () => {
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
        expect(documentRef.getElementById('podium-shell').dataset.mode).toBe('replay');
        expect(documentRef.getElementById('podium-results').hasAttribute('inert')).toBe(true);
        expect(documentRef.getElementById('podium-play').hidden).toBe(true);
        expect(documentRef.getElementById('podium-replay-back').hidden).toBe(false);

        controller.pause();
        expect(controller.playing).toBe(false);
        controller.setRate(2);
        controller.advance(50);
        expect(controller.rate).toBe(2);
        controller.stop();
        expect(controller.timeMs).toBe(0);
        controller.exit();
        expect(documentRef.getElementById('podium-shell').dataset.mode).toBe('podium');
        expect(documentRef.getElementById('podium-play').hidden).toBe(false);
        globalThis.Path2D = OriginalPath2D;
    });
});
