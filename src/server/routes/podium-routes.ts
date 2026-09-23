import type { Application } from 'express';
import type { DailyGpPodiumAvatarPosition } from '../podium/daily-podium-avatar-backfill.js';
import type { DailyPodiumReplayEnvelope } from '../podium/daily-podium-replay.js';

export type PodiumRouteDependencies = {
    readContextPostId(): string | null;
    readContextPostData(): Record<string, unknown> | null;
    resolveLegacyDailyGpPodiumAvatars(
        postId: string,
        podium: unknown,
    ): Promise<DailyGpPodiumAvatarPosition[]>;
    resolveDailyPodiumReplay(
        postId: string,
        postData: Record<string, unknown> | null,
    ): Promise<DailyPodiumReplayEnvelope | null>;
};

export function registerPodiumRoutes(
    app: Application,
    dependencies: PodiumRouteDependencies,
): void {
    app.get('/api/podium/avatars', async (_req, res) => {
        const postId = dependencies.readContextPostId();
        const postData = dependencies.readContextPostData();
        if (!postId || postData?.postType !== 'daily-podium' || !postData.podium) {
            res.status(404).json({ positions: [] });
            return;
        }

        try {
            res.status(200).json({
                positions: await dependencies.resolveLegacyDailyGpPodiumAvatars(
                    postId,
                    postData.podium,
                ),
            });
        } catch (error) {
            console.error('Failed to resolve legacy Mini Racer podium avatars:', error);
            res.status(500).json({ positions: [] });
        }
    });

    app.get('/api/podium/replays', async (_req, res) => {
        const postId = dependencies.readContextPostId();
        const postData = dependencies.readContextPostData();
        if (!postId || postData?.postType !== 'daily-podium') {
            res.status(404).json({ ghosts: [] });
            return;
        }

        try {
            const envelope = await dependencies.resolveDailyPodiumReplay(postId, postData);
            if (!envelope) {
                res.status(200).json({ trackKey: null, ghosts: [] });
                return;
            }
            res.status(200).json({
                trackKey: envelope.trackKey,
                ghosts: envelope.ghosts.map((slot) => ({
                    rank: slot.rank,
                    ghost: slot.ghost,
                })),
            });
        } catch (error) {
            console.error('Failed to resolve Mini Racer podium replays:', error);
            res.status(500).json({ trackKey: null, ghosts: [] });
        }
    });
}
