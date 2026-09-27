import { describe, expect, it } from 'vitest';
import { runTrackBotCheck } from '../tools/runner.js';

describe('runTrackBotCheck', () => {
    it('reports an open road and does not run the bots', () => {
        const report = runTrackBotCheck({
            name: 'Open',
            outer: [{ x: 0, y: 0 }],
            inner: [],
            checkpoints: [],
        });

        expect(report.structure.fatal).toBe(true);
        expect(report.simulation).toBeNull();
        expect(report.issues.some((issue) => issue.code === 'outer-too-small')).toBe(true);
        expect(report.summary).toContain('Open');
        expect(report.summary).toContain('0/18 finishers');
    });
});
