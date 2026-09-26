import { createAutopostSubscriptionStore } from '../posts/autopost-subscription-store.js';

export const DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY = 'dailygp:podium-autopost:subreddits';

const store = createAutopostSubscriptionStore({
    subredditsKey: DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY,
    lockKeyPrefix: 'dailygp:podium-autopost:subscription-lock:',
    label: 'Daily podium autopost',
});

export const readDailyPodiumAutopostSubscription = store.readSubscription;
export const readAllDailyPodiumAutopostSubscriptions = store.readAllSubscriptions;
export const deleteDailyPodiumAutopostSubscription = store.deleteSubscription;
export const upsertDailyPodiumAutopostSubscription = store.upsertSubscription;
