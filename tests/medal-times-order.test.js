import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The game silently raises an out-of-order medal, so this test reads the file as written.
const MEDAL_TIMES = JSON.parse(readFileSync(join(process.cwd(), 'game/medals/medal-times.json'), 'utf8'));

describe('medal times file', () => {
    it('writes every row in order: author, gold, silver, bronze', () => {
        const outOfOrder = Object.entries(MEDAL_TIMES)
            .filter(([, row]) => !(row.author < row.gold && row.gold <= row.silver && row.silver <= row.bronze))
            .map(([trackKey, row]) => `${trackKey} ${JSON.stringify(row)}`);

        expect(outOfOrder).toEqual([]);
    });
});
