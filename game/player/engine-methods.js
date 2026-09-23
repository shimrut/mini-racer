import { queuePlayerPreferencesSave } from './preferences.js';
import { getActivePlayerOwnerId } from './active-owner.js';
import { claimVerificationEntriesForOwner } from '../scoreboard/verification-queue-transfer.js';
import { recoverPlayerIdentity as chasePlayerIdentity } from './identity-recovery.js';

const PROFILE_RECOVERY_DELAYS_MS = [0, 30_000, 120_000];

export const playerProfileEngineMethods = {
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

    claimQueuedResultsForOwner() {
        const { claimed } = claimVerificationEntriesForOwner(getActivePlayerOwnerId());
        for (const { bucket, entryId } of claimed) {
            if (bucket === 'daily') {
                this.dailyChallengeUi?.refreshDailyChallengeVerificationState?.(entryId);
            }
        }
        if (claimed.length) this.refreshCampaignVerificationOverlay?.();
        const processing = this.processVerificationQueue?.();
        if (processing && typeof processing.catch === 'function') {
            processing.catch((error) => {
                console.error('Error processing claimed verification entries:', error);
            });
        }
        return claimed;
    },

    recoverPlayerIdentity() {
        return chasePlayerIdentity(this);
    },

    schedulePlayerProfileRecovery() {
        if (this._playerProfileRecovery) return null;

        const recovery = { timer: null, attempt: 0, running: false, listeners: [] };
        this._playerProfileRecovery = recovery;

        const scheduleNext = () => {
            if (this._playerProfileRecovery !== recovery) return;
            const delayMs = PROFILE_RECOVERY_DELAYS_MS[recovery.attempt];
            recovery.attempt += 1;
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
                if (await this.recoverPlayerIdentity()) return;
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
