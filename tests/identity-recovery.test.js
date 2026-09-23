import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
    getPlayerProgressState: vi.fn(),
}));

vi.mock('../game/player/progress-state.js', () => ({
    getPlayerProgressState: storageMocks.getPlayerProgressState,
}));

import { recoverPlayerIdentity, runAfterPlayerIdentityReady } from '../game/player/identity-recovery.js';

describe('player identity recovery', () => {
    beforeEach(() => {
        storageMocks.getPlayerProgressState.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does not fetch when this visit already has an authoritative profile', async () => {
        await recoverPlayerIdentity({ playerProfileAuthoritative: true });
        expect(storageMocks.getPlayerProgressState).not.toHaveBeenCalled();
    });

    it('applies an authoritative answer and shares one in-flight request', async () => {
        let resolveState;
        storageMocks.getPlayerProgressState.mockReturnValue(new Promise((resolve) => {
            resolveState = resolve;
        }));
        const engine = {
            playerProfileAuthoritative: false,
            stopPlayerProfileRecovery: vi.fn(),
            applyPlayerProgressState: vi.fn().mockResolvedValue(undefined),
        };

        const first = recoverPlayerIdentity(engine);
        const second = recoverPlayerIdentity(engine);
        resolveState({ authoritative: true, redditUsername: 'racer' });

        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
        expect(storageMocks.getPlayerProgressState).toHaveBeenCalledTimes(1);
        expect(engine.applyPlayerProgressState).toHaveBeenCalledTimes(1);
    });

    it('runs queued-finish work immediately when identity is already known', () => {
        const work = vi.fn();
        runAfterPlayerIdentityReady({ playerProfileAuthoritative: true }, work);
        expect(work).toHaveBeenCalledTimes(1);
        expect(storageMocks.getPlayerProgressState).not.toHaveBeenCalled();
    });

    it('waits for one recovery attempt before a queued PB finish when identity is unknown', async () => {
        storageMocks.getPlayerProgressState.mockResolvedValue({ authoritative: false });
        const work = vi.fn();
        const engine = {
            playerProfileAuthoritative: false,
            applyPlayerProgressState: vi.fn(),
        };

        runAfterPlayerIdentityReady(engine, work);
        expect(work).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(work).toHaveBeenCalledTimes(1);
        });
        expect(storageMocks.getPlayerProgressState).toHaveBeenCalledTimes(1);
    });
});
