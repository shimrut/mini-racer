import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
    prepareLeaderboardOpponentRace: vi.fn(),
}));
vi.mock('../game/scoreboard/opponent-race-service.js', () => service);

const { opponentRaceEngineMethods } = await import(
    '../game/scoreboard/opponent-race-engine-methods.js'
);

describe('opponent race engine orchestration', () => {
    beforeEach(() => vi.clearAllMocks());

    it('closes standings and starts a canonical Daily race', async () => {
        service.prepareLeaderboardOpponentRace.mockResolvedValue({
            ok: true,
            status: 200,
            body: {
                race: { id: 'daily-1', trackKey: 'circuit' },
                target: { displayName: 'Rival', bestTimeMs: 12_345, ghost: {} },
            },
        });
        const context = {
            modal: { closeModal: vi.fn() },
            startDailyChallengeAgainstOpponent: vi.fn().mockResolvedValue(true),
        };

        const result = await opponentRaceEngineMethods.prepareAndStartLeaderboardOpponent.call(
            context,
            { mode: 'daily', competitionId: 'daily-1', entry: { rank: 2 } },
        );

        expect(result.ok).toBe(true);
        expect(context.modal.closeModal).toHaveBeenCalled();
        expect(context.startDailyChallengeAgainstOpponent).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'daily-1' }),
            expect.objectContaining({
                mode: 'daily',
                competitionId: 'daily-1',
                displayName: 'Rival',
            }),
        );
    });

    it('normalizes no faster ghost to the personal-best fallback', async () => {
        service.prepareLeaderboardOpponentRace.mockResolvedValue({
            ok: false,
            status: 404,
            body: { reason: 'no_faster_opponent' },
        });

        await expect(
            opponentRaceEngineMethods.prepareNextLeaderboardOpponent({
                mode: 'campaign',
                competitionId: 'numbered-v1-00',
                benchmarkTimeMs: 9_000,
            }),
        ).resolves.toEqual({ ok: true, kind: 'personal-best' });
    });

    it('starts a prepared Campaign opponent without another request', async () => {
        const context = {
            startCampaignStageAgainstOpponent: vi.fn().mockResolvedValue(true),
        };
        await expect(
            opponentRaceEngineMethods.startPreparedLeaderboardOpponent.call(context, {
                kind: 'opponent',
                race: { raceId: 'numbered-v1-00' },
                target: { mode: 'campaign' },
            }),
        ).resolves.toBe(true);
        expect(service.prepareLeaderboardOpponentRace).not.toHaveBeenCalled();
    });

    it('keeps the same opponent after a loss', () => {
        const setCombinedPrimaryAction = vi.fn();
        const restartDailyChallenge = vi.fn();
        const context = {
            modal: { setCombinedPrimaryAction },
            restartDailyChallenge,
        };

        opponentRaceEngineMethods.configureLeaderboardOpponentFinish.call(context, {
            mode: 'daily',
            race: { id: 'daily-1' },
            finalTime: 10,
            comparison: {
                outcome: 'lost',
                target: { competitionId: 'daily-1', displayName: 'Rival' },
            },
        });

        const action = setCombinedPrimaryAction.mock.calls[0][0];
        expect(action.label).toBe('Retry');
        action.action();
        expect(restartDailyChallenge).toHaveBeenCalledWith({ reason: 'opponent-retry' });
    });

    it('offers the next verified rival after a win', async () => {
        service.prepareLeaderboardOpponentRace.mockResolvedValue({
            ok: true,
            status: 200,
            body: {
                race: { id: 'daily-1', trackKey: 'circuit' },
                target: { rank: 4, displayName: 'Next Rival', ghost: {} },
            },
        });
        const setCombinedPrimaryAction = vi.fn();
        const context = {
            modal: { setCombinedPrimaryAction },
            prepareNextLeaderboardOpponent:
                opponentRaceEngineMethods.prepareNextLeaderboardOpponent,
            startPreparedLeaderboardOpponent: vi.fn(),
        };

        opponentRaceEngineMethods.configureLeaderboardOpponentFinish.call(context, {
            mode: 'daily',
            race: { id: 'daily-1' },
            finalTime: 9,
            comparison: {
                outcome: 'won',
                target: { competitionId: 'daily-1', displayName: 'Rival' },
            },
            waitForVerification: true,
        });
        await opponentRaceEngineMethods.resolveLeaderboardOpponentAdvanceAfterVerification.call(
            context,
            { mode: 'daily', competitionId: 'daily-1', benchmarkTimeMs: 9_000 },
        );

        const action = setCombinedPrimaryAction.mock.calls.at(-1)[0];
        expect(action.label).toBe('Next rival');
        expect(action.ariaLabel).toBe('Next rival: #4 Next Rival');
        action.action();
        expect(context.startPreparedLeaderboardOpponent).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'opponent' }),
        );
    });

    it('reads as an ordinary Improve until a rival is confirmed', async () => {
        service.prepareLeaderboardOpponentRace.mockResolvedValue({
            ok: false,
            status: 404,
            body: { reason: 'no_faster_opponent' },
        });
        const setCombinedPrimaryAction = vi.fn();
        const handleStartDailyChallenge = vi.fn();
        const race = { id: 'daily-1' };
        const context = {
            modal: { setCombinedPrimaryAction },
            prepareNextLeaderboardOpponent:
                opponentRaceEngineMethods.prepareNextLeaderboardOpponent,
            handleStartDailyChallenge,
        };

        opponentRaceEngineMethods.configureLeaderboardOpponentFinish.call(context, {
            mode: 'daily',
            race,
            finalTime: 9,
            comparison: {
                outcome: 'won',
                target: { competitionId: 'daily-1', displayName: 'Rival' },
            },
            waitForVerification: true,
        });

        // No rival has been looked up yet, so nothing may promise one.
        expect(setCombinedPrimaryAction.mock.calls[0][0].label).toBe('Improve');

        await opponentRaceEngineMethods.resolveLeaderboardOpponentAdvanceAfterVerification.call(
            context,
            { mode: 'daily', competitionId: 'daily-1', benchmarkTimeMs: 9_000 },
        );

        const action = setCombinedPrimaryAction.mock.calls.at(-1)[0];
        expect(action.label).toBe('Improve');
        action.action();
        // Improve races the player's own PB again, not the beaten opponent.
        expect(handleStartDailyChallenge).toHaveBeenCalledWith(race);
    });

    it('keeps the finish action when the next-rival lookup fails', async () => {
        service.prepareLeaderboardOpponentRace.mockResolvedValue({
            ok: false,
            status: 503,
            body: { error: 'Opponent race preparation failed' },
        });
        const setCombinedPrimaryAction = vi.fn();
        const context = {
            modal: { setCombinedPrimaryAction },
            prepareNextLeaderboardOpponent:
                opponentRaceEngineMethods.prepareNextLeaderboardOpponent,
            _leaderboardOpponentFinish: {
                mode: 'campaign',
                race: { raceId: 'numbered-v1-00' },
                competitionId: 'numbered-v1-00',
                outcome: 'won',
            },
        };

        await expect(
            opponentRaceEngineMethods.resolveLeaderboardOpponentAdvanceAfterVerification.call(
                context,
                {
                    mode: 'campaign',
                    competitionId: 'numbered-v1-00',
                    benchmarkTimeMs: 9_000,
                },
            ),
        ).resolves.toBe(false);
        expect(setCombinedPrimaryAction).not.toHaveBeenCalled();
    });
});
