import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The game quietly raises a bronze or silver time that is below the tier
// before it, so a typo in the file does not show in the medal tests. This test
// reads the file as it is written.
const MEDAL_TIMES = JSON.parse(readFileSync(join(process.cwd(), 'game/medals/medal-times.json'), 'utf8'));

describe('medal times file', () => {
    it('writes every row in order: author, gold, silver, bronze', () => {
        const outOfOrder = Object.entries(MEDAL_TIMES)
            .filter(([, row]) => !(row.author < row.gold && row.gold <= row.silver && row.silver <= row.bronze))
            .map(([trackKey, row]) => `${trackKey} ${JSON.stringify(row)}`);

        expect(outOfOrder).toEqual([]);
    });
});
