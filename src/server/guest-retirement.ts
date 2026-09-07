import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import { campaignProgressKey } from './campaign-progress-key.js';
import { readGuestPromotionTarget } from './car-unlock-store.js';

export type GuestIdentityStatus = 'active' | 'guest_promotion_pending' | 'guest_identity_retired';

export function guestProgressSelectionPendingKey(canonicalGuestPlayerId: string): string {
    return `dailygp:guest-progress-selection-pending:v1:${createHash('sha256')
        .update(canonicalGuestPlayerId, 'utf8')
        .digest('base64url')}`;
}

export function guestProgressSelectionAccountPendingKey(redditPlayerId: string): string {
    return `dailygp:guest-progress-selection-account-pending:v1:${createHash('sha256')
        .update(redditPlayerId, 'utf8')
        .digest('base64url')}`;
}

export async function isGuestProgressSelectionPending(canonicalGuestPlayerId: string): Promise<boolean> {
    return Boolean(await redis.get(guestProgressSelectionPendingKey(canonicalGuestPlayerId)));
}

export async function isPlayerProgressSelectionPending(redditPlayerId: string): Promise<boolean> {
    if (!redditPlayerId.startsWith('reddit:')) return false;
    return Boolean(await redis.get(guestProgressSelectionAccountPendingKey(redditPlayerId)));
}

export async function isProgressTransferPending(playerId: string): Promise<boolean> {
    if (playerId.startsWith('guest:')) {
        return isGuestProgressSelectionPending(playerId);
    }
    return isPlayerProgressSelectionPending(playerId);
}

/**
 * Guest tokens are unexpiring signatures over a guest id, so a promoted guest stays authorizable
 * forever unless the server refuses it. The promotion pointer is written inside the promotion
 * transaction and is proof it committed; leftover Campaign progress under that guest is proof the
 * migration did not finish, and until it does the guest must keep working so it can be completed.
 */
export async function resolveGuestIdentityStatus(
    canonicalGuestPlayerId: string,
): Promise<{ status: GuestIdentityStatus; promotedPlayerId: string | null }> {
    if (!canonicalGuestPlayerId.startsWith('guest:')) {
        return { status: 'active', promotedPlayerId: null };
    }

    const selectionPending = await isGuestProgressSelectionPending(canonicalGuestPlayerId);
    const promotedPlayerId = await readGuestPromotionTarget(canonicalGuestPlayerId);
    if (!promotedPlayerId) {
        return {
            status: selectionPending ? 'guest_promotion_pending' : 'active',
            promotedPlayerId: null,
        };
    }

    const migrationPending = Boolean(
        await redis.get(campaignProgressKey(canonicalGuestPlayerId))
        || selectionPending,
    );
    return {
        status: migrationPending ? 'guest_promotion_pending' : 'guest_identity_retired',
        promotedPlayerId,
    };
}

export async function isRetiredGuestPlayerId(canonicalGuestPlayerId: string): Promise<boolean> {
    return (await resolveGuestIdentityStatus(canonicalGuestPlayerId)).status === 'guest_identity_retired';
}
