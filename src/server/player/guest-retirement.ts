import { redis } from '@devvit/redis';
import { createHash } from 'node:crypto';
import { campaignProgressKeys } from '../campaign/campaign-progress-key.js';
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

export function guestProgressTransferReceiptKey(transferId: string): string {
    return `dailygp:guest-progress-transfer-receipt:v1:${createHash('sha256')
        .update(transferId, 'utf8')
        .digest('base64url')}`;
}

export function guestProgressTransferIndexKey(redditPlayerId: string): string {
    return `dailygp:guest-progress-transfer-index:v1:${createHash('sha256')
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

export async function resolveGuestIdentityStatus(
    canonicalGuestPlayerId: string,
): Promise<{
    status: GuestIdentityStatus;
    promotedPlayerId: string | null;
    selectionPending: boolean;
}> {
    if (!canonicalGuestPlayerId.startsWith('guest:')) {
        return { status: 'active', promotedPlayerId: null, selectionPending: false };
    }

    const selectionPending = await isGuestProgressSelectionPending(canonicalGuestPlayerId);
    const promotedPlayerId = await readGuestPromotionTarget(canonicalGuestPlayerId);
    if (!promotedPlayerId) {
        return {
            status: selectionPending ? 'guest_promotion_pending' : 'active',
            promotedPlayerId: null,
            selectionPending,
        };
    }

    // A guest is retired only when no Campaign series still holds its progress.
    const progressValues = await Promise.all(
        campaignProgressKeys(canonicalGuestPlayerId).map((key) => redis.get(key)),
    );
    const migrationPending = Boolean(progressValues.some(Boolean) || selectionPending);
    return {
        status: migrationPending ? 'guest_promotion_pending' : 'guest_identity_retired',
        promotedPlayerId,
        selectionPending,
    };
}
