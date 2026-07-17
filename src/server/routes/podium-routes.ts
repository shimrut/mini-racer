import type { Application } from 'express';
import type { DailyGpPodiumAvatarPosition } from '../daily-podium-avatar-backfill.js';

export type PodiumRouteDependencies = {
    readContextPostId(): string | null;
    readContextPostData(): Record<string, unknown> | null;
    resolveLegacyDailyGpPodiumAvatars(
        postId: string,
        podium: unknown,
    ): Promise<DailyGpPodiumAvatarPosition[]>;
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
}
