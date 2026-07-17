export type DailyGpPodiumIdentityType = 'reddit' | 'private' | 'empty';

export type FinalDailyGpPodiumPosition = {
    rank: 1 | 2 | 3;
    displayName: string;
    identityType: DailyGpPodiumIdentityType;
    formattedTime: string | null;
};

export type FinalDailyGpPodium = {
    challengeId: string;
    challengeDate: string;
    trackKey: string;
    trackName: string;
    positions: readonly [
        FinalDailyGpPodiumPosition,
        FinalDailyGpPodiumPosition,
        FinalDailyGpPodiumPosition,
    ];
};

export type DailyGpPodiumPostData = Omit<FinalDailyGpPodium, 'trackKey'>;
