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
    lapCount: 1 | 2 | 3;
    positions: readonly [
        FinalDailyGpPodiumPosition,
        FinalDailyGpPodiumPosition,
        FinalDailyGpPodiumPosition,
    ];
};

export type DailyGpPodiumPostPosition = FinalDailyGpPodiumPosition & {
    avatarUrl: string | null;
};

export type DailyGpPodiumPostData = {
    challengeId: string;
    challengeDate: string;
    trackName: string;
    lapCount: 1 | 2 | 3;
    positions: [
        DailyGpPodiumPostPosition,
        DailyGpPodiumPostPosition,
        DailyGpPodiumPostPosition,
    ];
};
