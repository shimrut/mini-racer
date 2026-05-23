import { describe, expect, it, vi } from 'vitest';
import { InteractionsUi } from '../game/race/ui-interactions.js';

function createEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener: vi.fn((eventName, handler) => {
            listeners.set(eventName, handler);
        })
    };
}

describe('ui interaction helpers', () => {
    it('routes the start button through the overlay handler', () => {
        const startBtn = createEventTarget();
        const handleStartAction = vi.fn();
        const ctx = {
            startBtn,
            startOverlay: { handleStartAction },
            onStartDailyChallenge: vi.fn()
        };

        InteractionsUi.prototype.bindPrimaryActions.call(ctx);

        expect(startBtn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        startBtn.listeners.get('click')();
        expect(handleStartAction).toHaveBeenCalledWith(ctx.onStartDailyChallenge);
    });

    it('routes mobile taps through pointer events when available', () => {
        const originalWindow = global.window;
        const element = createEventTarget();
        const onTap = vi.fn();
        global.window = {
            PointerEvent: class PointerEvent {}
        };

        InteractionsUi.prototype.bindTapAction.call({}, element, onTap);

        const preventDefault = vi.fn();
        element.listeners.get('pointerup')({
            button: 0,
            preventDefault
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onTap).toHaveBeenCalledTimes(1);

        global.window = originalWindow;
    });

    it('wires the bottom bar leaderboard and placeholder actions', () => {
        const paddockBtn = createEventTarget();
        const leaderboardBtn = createEventTarget();
        const achievementsBtn = createEventTarget();
        const closeModal = vi.fn();
        const openDailyChallengeLeaderboard = vi.fn();
        const showBottomNavPlaceholder = vi.fn();
        const ctx = {
            bottomNavPaddockBtn: paddockBtn,
            bottomNavLeaderboardBtn: leaderboardBtn,
            bottomNavAchievementsBtn: achievementsBtn,
            modal: {
                isModalActive: vi.fn(() => true),
                closeModal
            },
            leaderboards: { openDailyChallengeLeaderboard },
            showBottomNavPlaceholder
        };

        InteractionsUi.prototype.bindPrimaryActions.call(ctx);

        paddockBtn.listeners.get('click')();
        leaderboardBtn.listeners.get('click')();
        achievementsBtn.listeners.get('click')();

        expect(closeModal).toHaveBeenCalledTimes(1);
        expect(openDailyChallengeLeaderboard).toHaveBeenCalledTimes(1);
        expect(showBottomNavPlaceholder).toHaveBeenCalledWith(
            'Achievements',
            'Achievement tracking is planned, but it is not in this build yet.',
        );
    });


});
