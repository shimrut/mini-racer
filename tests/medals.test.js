import { describe, expect, it } from 'vitest';
import { TRACK_CATALOG } from '../game/track/catalog.js';
import {
    TRACK_MEDAL_THRESHOLDS,
    getAuthorMedalSeconds,
    getMedalForLapTime,
    getMedalForRaceTime,
    getNextMedalTarget,
    getRaceMedalThresholds,
    getTimeToBeatSeconds,
    getTrackMedalThresholds,
    formatMedalTargetsLine,
    getCombinedMedalStackTiers,
    getMedalRowSlots,
    getWinOverlayAllMedalsUnlocked,
    maxMedalTier,
    allStandardMedalsUnlocked,
    shouldCelebrateMedalTier,
    shouldShowPersonalBestMedalHero,
    planFirstUnlockMedalRevealDelays,
    FIRST_UNLOCK_MEDAL_HOLD_MS,
    isPersonalBestTimeImprovement,
    isStandardMedalTier,
    resolveCombinedFinishHeadline,
} from '../game/medals/medals.js';

describe('medals', () => {
    it('exports a medal icon factory for the browser', async () => {
        const { createMedalIconSvg } = await import('../game/medals/medal-icon.js');
        expect(typeof createMedalIconSvg).toBe('function');
    });

    it('formats a readable medal tier line', () => {
        const line = formatMedalTargetsLine('circuit');
        expect(line).toContain('Gold');
        expect(line).toContain('Silver');
        expect(line).toContain('Bronze');
    });

    it('defines ordered thresholds for every track', () => {
        const keys = Object.keys(TRACK_CATALOG).sort();
        const thresholdKeys = Object.keys(TRACK_MEDAL_THRESHOLDS).sort();
        for (const trackKey of keys) {
            expect(thresholdKeys).toContain(trackKey);
        }

        for (const trackKey of keys) {
            const t = getTrackMedalThresholds(trackKey);
            expect(t).toBeTruthy();
            expect(t.gold).toBeLessThanOrEqual(t.silver);
            expect(t.silver).toBeLessThanOrEqual(t.bronze);
        }
    });

    it('assigns the best medal for faster laps', () => {
        const t = getTrackMedalThresholds('circuit');
        expect(getMedalForLapTime('circuit', t.gold - 0.5)).toBe('author');
        expect(getMedalForLapTime('circuit', t.gold + 0.01)).toBe('silver');
        expect(getMedalForLapTime('circuit', t.silver + 0.01)).toBe('bronze');
        expect(getMedalForLapTime('circuit', t.bronze + 10)).toBe(null);
    });

    it('scales every available race medal threshold by a valid lap count', () => {
        const oneLap = getRaceMedalThresholds('circuit', 1);
        const threeLaps = getRaceMedalThresholds('circuit', 3);

        expect(threeLaps).toEqual({
            author: oneLap.author == null ? null : oneLap.author * 3,
            gold: oneLap.gold * 3,
            silver: oneLap.silver * 3,
            bronze: oneLap.bronze * 3,
        });
    });

    it('falls back to one lap for invalid race lap counts', () => {
        const oneLap = getRaceMedalThresholds('circuit', 1);
        expect(getRaceMedalThresholds('circuit', 0)).toEqual(oneLap);
        expect(getRaceMedalThresholds('circuit', 4)).toEqual(oneLap);
        expect(getRaceMedalThresholds('circuit', 2.5)).toEqual(oneLap);
        expect(getRaceMedalThresholds('circuit', '3')).toEqual(oneLap);
    });

    it('awards race medals against scaled total times', () => {
        const thresholds = getRaceMedalThresholds('circuit', 2);
        if (thresholds.author != null) {
            expect(getMedalForRaceTime('circuit', thresholds.author, 2)).toBe('author');
        }
        expect(getMedalForRaceTime('circuit', thresholds.gold, 2)).toBe(
            thresholds.author === thresholds.gold ? 'author' : 'gold',
        );
        expect(getMedalForRaceTime('circuit', thresholds.gold + 0.01, 2)).toBe('silver');
        expect(getMedalForRaceTime('circuit', thresholds.silver + 0.01, 2)).toBe('bronze');
        expect(getMedalForRaceTime('circuit', thresholds.bronze + 0.01, 2)).toBe(null);
        expect(getMedalForRaceTime('missing-track', 10, 2)).toBe(null);
        expect(getMedalForRaceTime('circuit', Number.NaN, 2)).toBe(null);
    });

    it('maxMedalTier picks the stronger tier', () => {
        expect(maxMedalTier(null, null)).toBe(null);
        expect(maxMedalTier('bronze', null)).toBe('bronze');
        expect(maxMedalTier(null, 'gold')).toBe('gold');
        expect(maxMedalTier('silver', 'gold')).toBe('gold');
        expect(maxMedalTier('gold', 'bronze')).toBe('gold');
        expect(maxMedalTier('gold', 'author')).toBe('author');
    });

    it('next medal target steps white → bronze → silver → gold (→ author when set)', () => {
        const tk = 'circuit';
        const th = getTrackMedalThresholds(tk);
        const authorSec = getAuthorMedalSeconds(tk);
        expect(getNextMedalTarget(tk, null)).toEqual({ tier: 'bronze', maxSeconds: th.bronze });
        expect(getNextMedalTarget(tk, 'bronze')).toEqual({ tier: 'silver', maxSeconds: th.silver });
        expect(getNextMedalTarget(tk, 'silver')).toEqual({ tier: 'gold', maxSeconds: th.gold });
        if (authorSec != null) {
            expect(getNextMedalTarget(tk, 'gold')).toEqual({ tier: 'author', maxSeconds: authorSec });
            expect(getNextMedalTarget(tk, 'author')).toBe(null);
        } else {
            expect(getNextMedalTarget(tk, 'gold')).toBe(null);
        }
    });

    it('time to beat follows next medal ceiling (gold bar or author when set)', () => {
        const tk = 'circuit';
        const th = getTrackMedalThresholds(tk);
        const authorSec = getAuthorMedalSeconds(tk);
        expect(getTimeToBeatSeconds(tk, null)).toBe(th.bronze);
        expect(getTimeToBeatSeconds(tk, 'bronze')).toBe(th.silver);
        expect(getTimeToBeatSeconds(tk, 'silver')).toBe(th.gold);
        expect(getTimeToBeatSeconds(tk, 'gold')).toBe(authorSec != null ? authorSec : th.gold);
    });

    it('win overlay layout: large medal is best unlocked on track; small row is all other unlocked tiers', () => {
        const tk = 'circuit';
        const th = getTrackMedalThresholds(tk);
        expect(th).toBeTruthy();
        const authorSec = getAuthorMedalSeconds(tk);
        const goldTime = authorSec != null ? authorSec + 0.05 : th.gold - 0.2;
        const lapMedal = getMedalForLapTime(tk, goldTime);
        expect(lapMedal).toBe('gold');
        const slots = getMedalRowSlots(tk, lapMedal);
        const filled = slots.filter((s) => s.filled).map((s) => s.tier);
        expect(filled).toEqual(['bronze', 'silver', 'gold']);
        expect(getWinOverlayAllMedalsUnlocked(tk, lapMedal)).toBe(false);
        if (authorSec != null) {
            expect(getNextMedalTarget(tk, lapMedal)).toEqual({ tier: 'author', maxSeconds: authorSec });
        } else {
            expect(getNextMedalTarget(tk, lapMedal)).toBe(null);
        }
    });

    it.skipIf(getAuthorMedalSeconds('circuit') == null)(
        'win overlay layout: slower gold lap still shows author when author already unlocked',
        () => {
            const tk = 'circuit';
            const th = getTrackMedalThresholds(tk);
            const authorSec = getAuthorMedalSeconds(tk);
            const goldTime = authorSec != null ? authorSec + 0.05 : th.gold - 0.2;
            const lapMedal = getMedalForLapTime(tk, goldTime);
            expect(lapMedal).toBe('gold');
            const bestStored = maxMedalTier(lapMedal, 'author');
            expect(bestStored).toBe('author');
            expect(getWinOverlayAllMedalsUnlocked(tk, bestStored)).toBe(true);
            expect(getNextMedalTarget(tk, bestStored)).toBe(null);
            const slots = getMedalRowSlots(tk, bestStored);
            expect(slots.map((s) => s.tier)).toEqual(['bronze', 'silver', 'gold', 'author']);
            expect(slots.every((s) => s.filled)).toBe(true);
        },
    );

    it.skipIf(getAuthorMedalSeconds('circuit') == null)(
        'win overlay layout: all tiers unlocked marks complete',
        () => {
            const tk = 'circuit';
            const bestStored = maxMedalTier('author', null);
            expect(bestStored).toBe('author');
            expect(getWinOverlayAllMedalsUnlocked(tk, bestStored)).toBe(true);
            expect(getNextMedalTarget(tk, bestStored)).toBe(null);
        },
    );

    it('win overlay layout: no weaker medals when center is lowest earned', () => {
        const tk = 'circuit';
        const th = getTrackMedalThresholds(tk);
        expect(th).toBeTruthy();
        const bronzeTime = th.bronze - 0.01;
        const lapMedal = getMedalForLapTime(tk, bronzeTime);
        expect(lapMedal).toBe('bronze');
        const slots = getMedalRowSlots(tk, lapMedal);
        const filled = slots.filter((s) => s.filled).map((s) => s.tier);
        expect(filled).toEqual(['bronze']);
    });

    it('combined stack: fills tiers up to earned medal', () => {
        const authorSec = getAuthorMedalSeconds('circuit');
        if (authorSec != null) {
            expect(getCombinedMedalStackTiers('circuit', 'gold')).toEqual([
                { tier: 'bronze', filled: true },
                { tier: 'silver', filled: true },
                { tier: 'gold', filled: true },
                { tier: 'author', filled: false }
            ]);
        } else {
            expect(getCombinedMedalStackTiers('circuit', 'gold')).toEqual([
                { tier: 'bronze', filled: true },
                { tier: 'silver', filled: true },
                { tier: 'gold', filled: true }
            ]);
        }
        expect(getCombinedMedalStackTiers('circuit', 'silver')).toEqual(
            authorSec != null
                ? [
                    { tier: 'bronze', filled: true },
                    { tier: 'silver', filled: true },
                    { tier: 'gold', filled: false },
                    { tier: 'author', filled: false }
                ]
                : [
                    { tier: 'bronze', filled: true },
                    { tier: 'silver', filled: true },
                    { tier: 'gold', filled: false }
                ]
        );
        expect(getCombinedMedalStackTiers('circuit', null)).toEqual(
            authorSec != null
                ? [
                    { tier: 'bronze', filled: false },
                    { tier: 'silver', filled: false },
                    { tier: 'gold', filled: false },
                    { tier: 'author', filled: false }
                ]
                : [
                    { tier: 'bronze', filled: false },
                    { tier: 'silver', filled: false },
                    { tier: 'gold', filled: false }
                ]
        );
    });

    it.skipIf(getAuthorMedalSeconds('circuit') == null)(
        'win overlay: PB hero only after creator already unlocked and lap beats saved PB',
        () => {
            const tk = 'circuit';
            const a = /** @type {number} */ (getAuthorMedalSeconds(tk));
            const lap = a - 0.1;
            const pbOpts = { previousPersonalBestSec: a + 0.5 };

            expect(shouldShowPersonalBestMedalHero(tk, lap, {
                ...pbOpts,
                previousTrackMedal: 'gold',
            })).toBe(false);

            expect(shouldShowPersonalBestMedalHero(tk, lap, {
                ...pbOpts,
                previousTrackMedal: 'author',
            })).toBe(true);

            expect(shouldShowPersonalBestMedalHero(tk, a - 0.05, {
                previousPersonalBestSec: a - 0.2,
                previousTrackMedal: 'author',
            })).toBe(false);
        },
    );

    it.skipIf(getAuthorMedalSeconds('circuit') == null)('shouldShowPersonalBestMedalHero matches PB layout gate', () => {
        const tk = 'circuit';
        const a = /** @type {number} */ (getAuthorMedalSeconds(tk));
        const lap = a - 0.1;
        const opts = { previousPersonalBestSec: a + 0.5 };
        expect(shouldShowPersonalBestMedalHero(tk, lap, { ...opts, previousTrackMedal: 'gold' })).toBe(false);
        expect(shouldShowPersonalBestMedalHero(tk, lap, { ...opts, previousTrackMedal: 'author' })).toBe(true);
        expect(shouldShowPersonalBestMedalHero(tk, lap, { previousTrackMedal: 'author' })).toBe(false);
    });
    it('allStandardMedalsUnlocked mirrors combined stack fill state', () => {
        const tk = 'circuit';
        const authorSec = getAuthorMedalSeconds(tk);
        expect(allStandardMedalsUnlocked(tk, null)).toBe(false);
        if (authorSec != null) {
            expect(allStandardMedalsUnlocked(tk, 'gold')).toBe(false);
            expect(allStandardMedalsUnlocked(tk, 'author')).toBe(true);
        } else {
            expect(allStandardMedalsUnlocked(tk, 'silver')).toBe(false);
            expect(allStandardMedalsUnlocked(tk, 'gold')).toBe(true);
        }
    });

    it('planFirstUnlockMedalRevealDelays: 250ms between celebrates when multiple first-unlocks', () => {
        const celebrate = (tier) => shouldCelebrateMedalTier(tier, null);
        expect(planFirstUnlockMedalRevealDelays(['bronze', 'silver', 'gold'], celebrate)).toEqual([
            { tier: 'bronze', delayMs: 0, celebrate: true },
            { tier: 'silver', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS, celebrate: true },
            { tier: 'gold', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS * 2, celebrate: true },
        ]);
        expect(planFirstUnlockMedalRevealDelays(['gold'], celebrate)).toEqual([
            { tier: 'gold', delayMs: 0, celebrate: true },
        ]);
        const afterBronze = (tier) => shouldCelebrateMedalTier(tier, 'bronze');
        expect(planFirstUnlockMedalRevealDelays(['bronze', 'silver', 'gold'], afterBronze)).toEqual([
            { tier: 'bronze', delayMs: 0, celebrate: false },
            { tier: 'silver', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS, celebrate: true },
            { tier: 'gold', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS * 2, celebrate: true },
        ]);
        const afterGold = (tier) => shouldCelebrateMedalTier(tier, 'gold');
        expect(planFirstUnlockMedalRevealDelays(['bronze', 'silver', 'gold', 'author'], afterGold)).toEqual([
            { tier: 'bronze', delayMs: 0, celebrate: false },
            { tier: 'silver', delayMs: 0, celebrate: false },
            { tier: 'gold', delayMs: 0, celebrate: false },
            { tier: 'author', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS, celebrate: true },
        ]);
        expect(
            planFirstUnlockMedalRevealDelays(
                ['bronze', 'silver', 'gold', 'author', 'personal-best'],
                (tier) => tier === 'personal-best',
            ),
        ).toEqual([
            { tier: 'bronze', delayMs: 0, celebrate: false },
            { tier: 'silver', delayMs: 0, celebrate: false },
            { tier: 'gold', delayMs: 0, celebrate: false },
            { tier: 'author', delayMs: 0, celebrate: false },
            { tier: 'personal-best', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS, celebrate: true },
        ]);
        const afterGoldTwoCelebrates = (tier) => tier === 'silver' || tier === 'gold';
        expect(planFirstUnlockMedalRevealDelays(['bronze', 'silver', 'gold'], afterGoldTwoCelebrates)).toEqual([
            { tier: 'bronze', delayMs: 0, celebrate: false },
            { tier: 'silver', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS, celebrate: true },
            { tier: 'gold', delayMs: FIRST_UNLOCK_MEDAL_HOLD_MS * 2, celebrate: true },
        ]);
    });

    it('shouldCelebrateMedalTier: standard medals only on first step-up; PB when hero qualifies', () => {
        expect(shouldCelebrateMedalTier('bronze', null)).toBe(true);
        expect(shouldCelebrateMedalTier('silver', null)).toBe(true);
        expect(shouldCelebrateMedalTier('gold', null)).toBe(true);
        expect(shouldCelebrateMedalTier('bronze', 'bronze')).toBe(false);
        expect(shouldCelebrateMedalTier('silver', 'bronze')).toBe(true);
        expect(shouldCelebrateMedalTier('gold', 'bronze')).toBe(true);
        expect(shouldCelebrateMedalTier('gold', 'gold')).toBe(false);
        expect(shouldCelebrateMedalTier('author', 'gold')).toBe(true);
        expect(shouldCelebrateMedalTier('author', 'author')).toBe(false);
        const tk = 'circuit';
        const a = getAuthorMedalSeconds(tk);
        const pbContext = a != null
            ? {
                trackKey: tk,
                lapTimeSec: a - 0.1,
                previousPersonalBestSec: a + 0.5,
            }
            : null;
        if (pbContext) {
            expect(shouldCelebrateMedalTier('personal-best', 'gold', pbContext)).toBe(false);
            expect(shouldCelebrateMedalTier('personal-best', 'author', pbContext)).toBe(true);
        }
        expect(shouldCelebrateMedalTier('white', null)).toBe(false);
        expect(shouldCelebrateMedalTier('challenge', null)).toBe(true);
        expect(shouldCelebrateMedalTier('challenge', 'author')).toBe(true);
    });

    it('resolveCombinedFinishHeadline prefers a new medal, then a new best, else finished', () => {
        expect(resolveCombinedFinishHeadline({
            lapMedal: 'bronze',
            previousTrackMedal: null,
            lapTimeSec: 20,
            previousPersonalBestSec: null,
        })).toEqual({ kind: 'bronze', text: 'bronze' });
        expect(resolveCombinedFinishHeadline({
            lapMedal: 'gold',
            previousTrackMedal: 'gold',
            lapTimeSec: 10,
            previousPersonalBestSec: 11,
            deltaToPersonalBest: -1,
        })).toEqual({ kind: 'new-best', text: 'new best' });
        expect(resolveCombinedFinishHeadline({
            lapMedal: 'gold',
            previousTrackMedal: 'gold',
            lapTimeSec: 12,
            previousPersonalBestSec: 11,
            deltaToPersonalBest: 1,
        })).toEqual({ kind: 'finished', text: 'finished' });
        expect(resolveCombinedFinishHeadline({
            lapMedal: null,
            previousTrackMedal: null,
            lapTimeSec: 18.5,
            previousPersonalBestSec: null,
        })).toEqual({ kind: 'new-best', text: 'new best' });
        expect(resolveCombinedFinishHeadline({
            lapMedal: 'author',
            previousTrackMedal: 'gold',
            lapTimeSec: 8,
            previousPersonalBestSec: 9,
            deltaToPersonalBest: -1,
        })).toEqual({ kind: 'author', text: 'author' });
        expect(resolveCombinedFinishHeadline({
            lapMedal: 'gold',
            previousTrackMedal: 'gold',
            lapTimeSec: 11,
            previousPersonalBestSec: 11,
            deltaToPersonalBest: 0,
        })).toEqual({ kind: 'finished', text: 'finished' });
    });

    it('labels the challenge display medal without treating it as a Campaign tier', async () => {
        const { formatMedalLabel } = await import('../game/medals/medal-timing.js');
        expect(formatMedalLabel('challenge')).toBe('Challenge beaten');
        expect(isStandardMedalTier('challenge')).toBe(false);
    });

    it('renderChallengeFinishHero covers pending, won, and error phases', async () => {
        const { renderChallengeFinishHero } = await import('../game/medals/medals.js');
        const children = [];
        const overlay = {
            replaceChildren() {
                children.length = 0;
            },
            appendChild(child) {
                children.push(child);
                return child;
            },
        };

        const originalDocument = global.document;
        global.document = {
            createElement: (tag) => {
                const el = {
                    tagName: tag,
                    className: '',
                    classList: {
                        classes: new Set(),
                        add(cls) {
                            this.classes.add(cls);
                            el.className = Array.from(this.classes).join(' ');
                        },
                        toggle(cls, force) {
                            const on = force === undefined ? !this.classes.has(cls) : force;
                            if (on) this.classes.add(cls);
                            else this.classes.delete(cls);
                            el.className = Array.from(this.classes).join(' ');
                            return on;
                        },
                    },
                    children: [],
                    dataset: {},
                    textContent: '',
                    setAttribute() {},
                    appendChild(child) {
                        this.children.push(child);
                        return child;
                    },
                };
                el.classList.classes = new Set();
                return el;
            },
            createElementNS: (_ns, tag) => global.document.createElement(tag),
        };

        try {
            renderChallengeFinishHero(overlay, {
                phase: 'pending',
                statusText: 'Submitting...',
            });
            expect(children[0].dataset.challengePhase).toBe('pending');
            expect(children[0].children[0].children[0].textContent).toBe('VERIFYING');
            expect(children[0].textContent).not.toContain('CHALLENGE');
            expect(children[0].children[1].textContent).toBe('Submitting...');

            renderChallengeFinishHero(overlay, { phase: 'won' });
            expect(children[0].dataset.challengePhase).toBe('won');
            expect(children[0].children[0].children[0].textContent).toBe('YOU WON');

            renderChallengeFinishHero(overlay, {
                phase: 'won',
                verdict: { opponentName: 'shimroot', deltaSec: -0.305 },
            });
            expect(children[0].children[0].children[0].textContent).toBe('YOU WON');
            expect(children[0].children).toHaveLength(1);

            renderChallengeFinishHero(overlay, {
                phase: 'lost',
                verdict: { opponentName: 'shimroot', deltaSec: 0.546 },
            });
            expect(children[0].children[0].children[0].textContent).toBe('YOU LOST');
            expect(children[0].children).toHaveLength(1);

            renderChallengeFinishHero(overlay, {
                phase: 'won',
                avatarUrl: 'https://i.redd.it/snoo.png',
            });
            const wonRoot = children[0];
            expect(wonRoot.children[0].children[0].textContent).toBe('YOU WON');
            expect(wonRoot.children).toHaveLength(1);

            renderChallengeFinishHero(overlay, {
                phase: 'error',
                error: 'Could not confirm.',
            });
            expect(children[0].dataset.challengePhase).toBe('error');
            expect(children[0].children[0].children[0].textContent).toBe('UNVERIFIED');
            expect(children[0].children[1].textContent).toBe('Could not confirm.');

            renderChallengeFinishHero(overlay, { phase: 'lost' });
            expect(children[0].dataset.challengePhase).toBe('lost');
            expect(children[0].children[0].children[0].textContent).toBe('YOU LOST');

            renderChallengeFinishHero(overlay, { phase: 'tie' });
            expect(children[0].children[0].children[0].textContent).toBe('YOU TIED');
        } finally {
            global.document = originalDocument;
        }
    });

    it('isPersonalBestTimeImprovement is strict on the clock', () => {
        expect(isPersonalBestTimeImprovement(3, null)).toBe(true);
        expect(isPersonalBestTimeImprovement(3, { bestTime: 4 })).toBe(true);
        expect(isPersonalBestTimeImprovement(4, { bestTime: 4 })).toBe(false);
        expect(isPersonalBestTimeImprovement(4, { bestTime: 3 })).toBe(false);
    });
});
