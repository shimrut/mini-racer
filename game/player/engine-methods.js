import { getPlayerProgressState } from '../storage.js';
import { queuePlayerPreferencesSave } from './preferences.js';
import { getActivePlayerOwnerId } from './active-owner.js';
import { claimVerificationEntriesForOwner } from '../scoreboard/verification-queue.js';
import { rollbackLocalBestForFailedVerificationEntry } from '../scoreboard/engine-methods.js';

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
    } = {}, { loadCar = true } = {}) {
        this.hasAnyData = Boolean(hasAnyData);
        this.isReturningPlayer = Boolean(isReturningPlayer);
        this.redditUsername = typeof redditUsername === 'string' && redditUsername.trim()
            ? redditUsername.trim()
            : null;
        this.playerProfileAuthoritative = Boolean(authoritative);
        this.applyCarUnlockSnapshot?.(carUnlocks, { authoritative });
        if (authoritative) {
            this.claimQueuedResultsForOwner();
            if (playerPreferences) {
                await this.applyPersistedPlayerPreferences(playerPreferences, { loadCar });
            } else {
                queuePlayerPreferencesSave();
            }
        }
        return {
            hasAnyData: this.hasAnyData,
            isReturningPlayer: this.isReturningPlayer,
        };
    },

    /**
     * Results raced before the account was known belong to whoever this device's next bootstrap names.
     * Owned results stay with that owner. Claiming also starts the sender so a recovered identity
     * uploads the waiting run instead of leaving the finish screen on Submitting.
     */
    claimQueuedResultsForOwner() {
        const { claimed, orphaned } = claimVerificationEntriesForOwner(getActivePlayerOwnerId());
        for (const { bucket, entry } of orphaned) {
            if (bucket !== 'daily' || !entry) continue;
            rollbackLocalBestForFailedVerificationEntry(this, entry);
            this.dailyChallengeUi?.refreshDailyChallengeVerificationState?.(entry.challengeId);
        }
        if (orphaned.length) this.refreshCampaignVerificationOverlay?.();
        if (claimed.length) {
            for (const { bucket, entryId } of claimed) {
                if (bucket === 'daily') {
                    this.dailyChallengeUi?.refreshDailyChallengeVerificationState?.(entryId);
                }
            }
            this.refreshCampaignVerificationOverlay?.();
            const processing = this.processVerificationQueue?.();
            if (processing && typeof processing.catch === 'function') {
                processing.catch((error) => {
                    console.error('Error processing claimed verification entries:', error);
                });
            }
        }
        return orphaned;
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
