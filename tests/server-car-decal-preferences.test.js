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
const RED = 'drawn/formula-red';
const GOLD = 'drawn/formula-gold';
const CIRCUIT = 'drawn/mr_grip_circuit';
const CIRCUIT_BLUE = 'drawn/mr_grip_circuit-blue';

describe('durable paired decal style preferences', () => {
    it('stores explicit same-model choices and drops unknown or incompatible entries individually', () => {
        const carDecals = { [RED]: RED, [CIRCUIT]: CIRCUIT_BLUE };
        expect(normalizePlayerPreferences({
            ...BASE,
            carDecals: {
                ...carDecals,
                [GOLD]: CIRCUIT_BLUE,
                'drawn/missing': GOLD,
                'assets/cars/mr_mr_red.webp': GOLD,
            },
        })).toMatchObject({ ...BASE, carDecals });
        expect(normalizePlayerPreferences({ ...BASE, carDecals: [] })).not.toHaveProperty('carDecals');
        expect(normalizePlayerPreferences(BASE)).not.toHaveProperty('carDecals');
    });

    it('salvages decal choices independently of unrelated damaged stored settings', () => {
        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:decal-owner',
            preferences: { ...BASE, musicEnabled: 'damaged', carDecals: { [RED]: GOLD, [CIRCUIT]: GOLD } },
        })).preferences).toMatchObject({ musicEnabled: true, carDecals: { [RED]: GOLD } });
        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:decal-owner', preferences: { ...BASE, carDecals: null },
        })).preferences).not.toHaveProperty('carDecals');
    });

    it('keeps the account explicit original style and fills only unset skins from the guest', () => {
        const guest = { ...BASE, carDecals: { [RED]: GOLD, [CIRCUIT]: CIRCUIT_BLUE } };
        const account = { ...BASE, carDecals: { [RED]: RED } };
        expect(transferredSettings('merge', guest, account).carDecals).toEqual({ [RED]: RED, [CIRCUIT]: CIRCUIT_BLUE });
        expect(transferredSettings('account', guest, account)).toBe(account);
        expect(transferredSettings('merge', guest, null)).toBe(guest);
        expect(transferredSettings('merge', null, account)).toBe(account);
        expect(account.carDecals).toEqual({ [RED]: RED });
        expect(guest.carDecals).toEqual({ [RED]: GOLD, [CIRCUIT]: CIRCUIT_BLUE });
    });
});
