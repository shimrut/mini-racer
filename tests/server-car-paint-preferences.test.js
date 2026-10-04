import { describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/redis', () => ({ redis: {} }));

const {
    normalizePlayerPreferences,
    parseStoredPlayerProfile,
} = await import('../src/server/competition/competition-identity.ts');
const { transferredSettings } = await import('../src/server/player/transfer-settings.ts');

const BASE = {
    carSkin: 'assets/cars/mr_mr_red.webp',
    trailId: 'gold',
    musicEnabled: false,
    carAudioEnabled: true,
    crashAutoRestartEnabled: false,
    crashRestartDelaySec: 0.8,
};
const CAR = 'drawn/mr_grip_circuit';
const OTHER_CAR = 'drawn/mr_dirt_rally';

describe('durable server car paint preferences', () => {
    it('normalizes valid paint without admitting arbitrary assets or colors', () => {
        expect(normalizePlayerPreferences({
            ...BASE,
            carPaints: {
                [CAR]: { main: '#246bff', accent: '#000000' },
                'drawn/custom-car': { main: '#ff303e' },
            },
        })).toMatchObject({ ...BASE, carPaints: { [CAR]: { main: '#246bff' } } });
        expect(normalizePlayerPreferences({ ...BASE, carPaints: 'broken' }))
            .not.toHaveProperty('carPaints');
        expect(normalizePlayerPreferences(BASE)).not.toHaveProperty('carPaints');
    });

    it('salvages paint independently of unrelated damaged stored settings', () => {
        const profile = parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:paint-owner',
            preferences: {
                ...BASE,
                musicEnabled: 'damaged',
                carPaints: { [CAR]: { main: '#246bff', accent: 'damaged', tertiary: '#252936' } },
            },
        }));
        expect(profile.preferences).toMatchObject({
            trailId: 'gold',
            musicEnabled: true,
            carPaints: { [CAR]: { main: '#246bff', tertiary: '#252936' } },
        });
        const damagedPaint = parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:paint-owner',
            preferences: { ...BASE, carPaints: [] },
        }));
        expect(damagedPaint.preferences).toMatchObject(BASE);
        expect(damagedPaint.preferences).not.toHaveProperty('carPaints');
    });

    it('keeps account paint and fills unset car channels from a merged guest', () => {
        const guest = {
            ...BASE,
            carPaints: {
                [CAR]: { main: '#ff303e', accent: '#ffe34a' },
                [OTHER_CAR]: { tertiary: '#252936' },
            },
        };
        const account = { ...BASE, carPaints: { [CAR]: { main: '#246bff' } } };
        expect(transferredSettings('account', guest, account)).toBe(account);
        expect(transferredSettings('merge', guest, account).carPaints).toEqual({
            [CAR]: { main: '#246bff', accent: '#ffe34a' },
            [OTHER_CAR]: { tertiary: '#252936' },
        });
        expect(transferredSettings('merge', guest, null)).toBe(guest);
        expect(transferredSettings('merge', null, account)).toBe(account);
        expect(account.carPaints).toEqual({ [CAR]: { main: '#246bff' } });
        expect(guest.carPaints[CAR].main).toBe('#ff303e');
    });
});

describe('durable per-skin trail preferences', () => {
    it('stores drawn and Legacy choices, dropping only invalid assets or trail ids', () => {
        const carTrails = { [CAR]: 'none', 'assets/cars/mr_mr_red.webp': 'gold' };
        const normalized = normalizePlayerPreferences({
            ...BASE, carTrails: { ...carTrails, 'drawn/missing': 'white', [OTHER_CAR]: 'broken' },
        });
        expect(normalized).toMatchObject({ ...BASE, carTrails });
        expect(normalizePlayerPreferences({ ...BASE, carTrails: [] })).not.toHaveProperty('carTrails');
        expect(normalizePlayerPreferences(BASE)).not.toHaveProperty('carTrails');
        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:trail-owner', preferences: { ...BASE, carTrails, musicEnabled: 'damaged' },
        })).preferences).toMatchObject({ carTrails, musicEnabled: true });
    });

    it('merges guest choices only for skins the account has not customized, preserving explicit No Trail', () => {
        const guest = { ...BASE, carTrails: { [CAR]: 'coral', [OTHER_CAR]: 'gold' } };
        const account = { ...BASE, carTrails: { [CAR]: 'none' } };
        expect(transferredSettings('merge', guest, account).carTrails).toEqual({ [CAR]: 'none', [OTHER_CAR]: 'gold' });
        expect(transferredSettings('account', guest, account)).toBe(account);
        expect(transferredSettings('merge', guest, null)).toBe(guest);
        expect(account.carTrails).toEqual({ [CAR]: 'none' });
        expect(guest.carTrails[CAR]).toBe('coral');
    });
});
