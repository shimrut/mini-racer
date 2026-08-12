import { getPlayerProgressState } from '../storage.js';
import { queuePlayerPreferencesSave } from './preferences.js';

const PROFILE_RECOVERY_DELAYS_MS = [5_000, 30_000, 120_000];

export const playerProfileEngineMethods = {
    /**
     * A bootstrap that never answered is not an answer: it may not lock cars, rewrite the selected
     * car, or push a preference the player never chose. Cached state stands in for presentation only.
     */
    async applyPlayerProgressState({
        hasAnyData,
        isReturningPlayer,
        playerPreferences,
        redditUsername,
        carUnlocks,
        authoritative = true,
    } = {}) {
        this.hasAnyData = Boolean(hasAnyData);
        this.isReturningPlayer = Boolean(isReturningPlayer);
        this.redditUsername = typeof redditUsername === 'string' && redditUsername.trim()
            ? redditUsername.trim()
            : null;
        this.applyCarUnlockSnapshot?.(carUnlocks, { authoritative });
        if (authoritative) {
            if (playerPreferences) {
                await this.applyPersistedPlayerPreferences(playerPreferences);
            } else {
                queuePlayerPreferencesSave();
            }
        }
        return {
            hasAnyData: this.hasAnyData,
            isReturningPlayer: this.isReturningPlayer,
        };
    },

    /** Fallback state is temporary by definition, so the real profile is chased until it answers. */
    schedulePlayerProfileRecovery() {
        if (this._playerProfileRecovery) return null;

        const recovery = { timer: null, attempt: 0, running: false, listeners: [] };
        this._playerProfileRecovery = recovery;

        const scheduleNext = () => {
            if (this._playerProfileRecovery !== recovery) return;
            const delayMs = PROFILE_RECOVERY_DELAYS_MS[recovery.attempt];
            recovery.attempt += 1;
            // Past the timed attempts, only a reconnect or a return to the foreground earns another request.
            if (delayMs === undefined) return;
            recovery.timer = setTimeout(() => {
                recovery.timer = null;
                void attempt();
            }, delayMs);
        };

        const attempt = async () => {
            if (recovery.running || this._playerProfileRecovery !== recovery) return;
            recovery.running = true;
            try {
                const state = await getPlayerProgressState();
                if (state?.authoritative === true) {
                    this.stopPlayerProfileRecovery();
                    await this.applyPlayerProgressState(state);
                    return;
                }
            } catch (error) {
                console.error('Error recovering player profile state:', error);
            } finally {
                recovery.running = false;
            }
            scheduleNext();
        };

        const bind = (target, type, shouldAttempt = () => true) => {
            if (typeof target?.addEventListener !== 'function') return;
            const handler = () => {
                if (shouldAttempt()) void attempt();
            };
            target.addEventListener(type, handler);
            recovery.listeners.push([target, type, handler]);
        };
        bind(typeof window === 'undefined' ? null : window, 'online');
        bind(
            typeof document === 'undefined' ? null : document,
            'visibilitychange',
            () => document.visibilityState === 'visible',
        );
        scheduleNext();
        return recovery;
    },

    stopPlayerProfileRecovery() {
        const recovery = this._playerProfileRecovery;
        if (!recovery) return false;
        this._playerProfileRecovery = null;
        if (recovery.timer !== null) clearTimeout(recovery.timer);
        recovery.timer = null;
        for (const [target, type, handler] of recovery.listeners) {
            target.removeEventListener?.(type, handler);
        }
        recovery.listeners = [];
        return true;
    },
};
