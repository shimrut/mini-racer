import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import { campaignProgressKey } from './campaign-progress-key.js';
import { readGuestPromotionTarget } from './car-unlock-store.js';

export type GuestIdentityStatus = 'active' | 'guest_promotion_pending' | 'guest_identity_retired';

function guestProgressSelectionPendingKey(canonicalGuestPlayerId: string): string {
    return `dailygp:guest-progress-selection-pending:v1:${createHash('sha256')
        .update(canonicalGuestPlayerId, 'utf8')
        .digest('base64url')}`;
}

export async function isGuestProgressSelectionPending(canonicalGuestPlayerId: string): Promise<boolean> {
    return Boolean(await redis.get(guestProgressSelectionPendingKey(canonicalGuestPlayerId)));
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

    const promotedPlayerId = await readGuestPromotionTarget(canonicalGuestPlayerId);
    if (!promotedPlayerId) {
        return { status: 'active', promotedPlayerId: null };
    }

    const migrationPending = Boolean(
        await redis.get(campaignProgressKey(canonicalGuestPlayerId))
        || await isGuestProgressSelectionPending(canonicalGuestPlayerId),
    );
    return {
        status: migrationPending ? 'guest_promotion_pending' : 'guest_identity_retired',
        promotedPlayerId,
    };
}

export async function isRetiredGuestPlayerId(canonicalGuestPlayerId: string): Promise<boolean> {
    return (await resolveGuestIdentityStatus(canonicalGuestPlayerId)).status === 'guest_identity_retired';
}
