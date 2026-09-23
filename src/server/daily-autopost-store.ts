import {
    createAutopostSubscriptionStore,
    parseAutopostSubscription,
    type AutopostSubscription,
} from './autopost-subscription-store.js';

export const DAILY_AUTPOST_SUBREDDITS_KEY = 'dailygp:autopost:subreddits';

export type DailyAutopostSubscription = AutopostSubscription;

const store = createAutopostSubscriptionStore({
    subredditsKey: DAILY_AUTPOST_SUBREDDITS_KEY,
    lockKeyPrefix: 'dailygp:autopost:subscription-lock:',
    label: 'Daily autopost',
});

export const parseDailyAutopostSubscription = parseAutopostSubscription;
export const readDailyAutopostSubscription = store.readSubscription;
export const readAllDailyAutopostSubscriptions = store.readAllSubscriptions;
export const deleteDailyAutopostSubscription = store.deleteSubscription;
export const upsertDailyAutopostSubscription = store.upsertSubscription;
