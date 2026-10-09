import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACKS } from '../game/track/tracks.js';
import { createShowcaseReplay, getShowcaseLayout, renderShowcaseCar, renderShowcaseRaceTrack, renderShowcaseTrack, syncLpShowcaseUi } from '../tools/generate-lp-showcase.js';

describe('landing showcase assets', () => {
    it('ships authoritative game components with standalone font paths', () => {
        const output = mkdtempSync(join(tmpdir(), 'lp-showcase-ui-'));
        try {
            syncLpShowcaseUi(output);
            for (const name of ['foundation', 'race-hud-and-medals', 'lobby-and-garage', 'lobby-modes', 'garage-workshop']) {
                expect(readFileSync(join(output, 'ui', `${name}.css`), 'utf8')).toBe(readFileSync(new URL(`../styles/${name}.css`, import.meta.url), 'utf8'));
            }
            expect(readFileSync(join(output, 'ui', 'medal-icon.js'), 'utf8')).toBe(readFileSync(new URL('../game/medals/medal-icon.js', import.meta.url), 'utf8'));
            const fonts = readFileSync(join(output, 'ui', 'fonts.css'), 'utf8');
            expect(fonts).toContain('../../fonts/outfit.woff2');
            expect(fonts).not.toContain('../public/fonts/');
        } finally {
            rmSync(output, { recursive: true, force: true });
        }
    });

    it('renders visibly different paint choices at Garage showcase resolution', async () => {
        const red = renderShowcaseCar('#ff303e');
        const blue = renderShowcaseCar('#246bff');
        expect(red.equals(blue)).toBe(false);
        const image = await loadImage(red);
        expect(image.width).toBeGreaterThan(600);
        expect(image.height).toBeGreaterThan(300);
        expect(image.width).toBeLessThan(990);
    });

    it('records two complete checkpoint-valid laps ending on the visible finish line', () => {
        const replay = createShowcaseReplay();
        const layout = getShowcaseLayout(TRACKS.circuit, replay.width, replay.height);
        const line = TRACKS.circuit.startLine;
        const p1 = layout.mapPoint(line.p1);
        const p2 = layout.mapPoint(line.p2);
        for (const [frames, duration, checkpoints] of [
            [replay.frames, replay.durationMs, replay.completedCheckpoints],
            [replay.ghostFrames, replay.ghostDurationMs, replay.ghostCompletedCheckpoints],
        ]) {
            expect(checkpoints).toBe(TRACKS.circuit.checkpoints.length);
            expect(frames[0].t).toBe(0);
            expect(frames.at(-1).t).toBe(duration);
            for (let index = 1; index < frames.length; index += 1) {
                expect(frames[index].t).toBeGreaterThan(frames[index - 1].t);
                expect(frames[index].x).toBeGreaterThan(0);
                expect(frames[index].x).toBeLessThan(replay.width);
                expect(frames[index].y).toBeGreaterThan(0);
                expect(frames[index].y).toBeLessThan(replay.height);
            }
            const finish = frames.at(-1);
            const distanceToLine = Math.abs((p2.x - p1.x) * (p1.y - finish.y) - (p1.x - finish.x) * (p2.y - p1.y)) / Math.hypot(p2.x - p1.x, p2.y - p1.y);
            expect(distanceToLine).toBeLessThan(0.001);
        }
        expect(replay.wallImpacts).toBe(0);
        expect(replay.durationMs).toBeLessThan(replay.ghostDurationMs);
    });

    it('renders the requested image dimensions through the shared schematic renderer', async () => {
        const image = await loadImage(renderShowcaseTrack('squareRoot', 700, 500));
        expect(image.width).toBe(700);
        expect(image.height).toBe(500);
    });

    it('keeps the actual race artwork aligned with the existing replay start pose', async () => {
        const replay = createShowcaseReplay();
        const image = await loadImage(renderShowcaseRaceTrack('circuit', replay.width, replay.height));
        const canvas = createCanvas(replay.width, replay.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const start = replay.frames[0];
        expect(context.getImageData(Math.round(start.x), Math.round(start.y), 1, 1).data[3]).toBe(255);
        expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
        expect(image.width).toBe(replay.width);
        expect(image.height).toBe(replay.height);
    });

    it('aligns the starting replay pose to asphalt and leaves the image background transparent', async () => {
        const width = 1400;
        const height = 1000;
        const image = await loadImage(renderShowcaseTrack('circuit', width, height));
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const start = getShowcaseLayout(TRACKS.circuit, width, height).mapPoint(TRACKS.circuit.startPos);
        const pixel = [...context.getImageData(Math.round(start.x), Math.round(start.y), 1, 1).data];
        expect(pixel).toEqual([71, 85, 105, 255]);
        expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
    });
});
