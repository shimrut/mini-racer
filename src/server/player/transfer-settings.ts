import type { DailyGpPlayerPreferences } from '../daily/daily-gp-model.js';
import { readPlayerProfile, upsertPlayerProfile } from '../competition/competition-identity.js';

export type TransferSettingsChoice = 'account' | 'merge';

const GROUND_SKIN_FIELDS = [
    'carSkinGrip',
    'carSkinDirt',
    'carSkinSnow',
    'carSkinWater',
    'carSkinSpace',
] as const;

// The settings the account keeps after a transfer: the account's, and with
// Merge the guest's fill what the account never set.
export function transferredSettings(
    choice: TransferSettingsChoice,
    guest: DailyGpPlayerPreferences | null,
    account: DailyGpPlayerPreferences | null,
): DailyGpPlayerPreferences | null {
    if (choice === 'account') return account ?? guest;
    if (!account) return guest;
    if (!guest) return account;
    const merged: DailyGpPlayerPreferences = { ...account };
    for (const field of GROUND_SKIN_FIELDS) {
        if (merged[field] === undefined && guest[field] !== undefined) merged[field] = guest[field];
    }
    return merged;
}

// Writes the chosen settings onto the account. It runs after the car unlocks
// moved, so every chosen skin is unlocked on the account; the account's next
// bootstrap checks the skins against its unlocks again. Running it twice
// writes the same settings.
export async function carryGuestSettings({
    guestPlayerId,
    redditPlayerId,
    choice,
}: {
    guestPlayerId: string;
    redditPlayerId: string;
    choice: TransferSettingsChoice;
}): Promise<void> {
    const [guestProfile, accountProfile] = await Promise.all([
        readPlayerProfile(guestPlayerId),
        readPlayerProfile(redditPlayerId),
    ]);
    const accountSettings = accountProfile?.preferences ?? null;
    const settings = transferredSettings(choice, guestProfile?.preferences ?? null, accountSettings);
    if (!settings || settings === accountSettings) return;
    await upsertPlayerProfile({ playerId: redditPlayerId, preferences: settings });
}
