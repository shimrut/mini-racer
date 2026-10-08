import type { Application, Response } from 'express';
import type { MenuItemRequest } from '@devvit/web/shared';
import type { DailyGhostArchiveReport } from '../daily/daily-ghost-archive.js';
import type { GhostCompactionReport } from '../competition/ghost-compaction.js';
import type { DailyGpChallenge } from '../daily/daily-gp-model.js';
import type { FinalDailyGpPodium } from '../podium/daily-podium-model.js';
import type { LauncherPostKind } from '../posts/launcher-post-store.js';
import { isDailyGpPodiumPublicationOpen } from '../podium/daily-podium-service.js';

type DailyAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
};

type DailyPodiumAutopostSubscription = {
    subredditName: string;
    enabled: boolean;
};

type PostResult = {
    created: boolean;
    postUrl: string | null;
};

type MenuActionOptions = {
    missingContextMessage: string;
    failureLogMessage: string;
    failureToastPrefix: string;
};

export type InternalRouteDependencies = {
    resolveMenuTargetSubredditName(targetId: string): Promise<string | null>;
    getServerDailyGpChallenge(): Promise<DailyGpChallenge>;
    getServerFinalDailyGpPodium(): Promise<FinalDailyGpPodium | null>;
    ensureDailyMiniRacerPostForSubreddit(
        subredditName: string,
        challenge: DailyGpChallenge,
    ): Promise<PostResult>;
    ensureMiniRacerLauncherPostForSubreddit(
        subredditName: string,
        kind: LauncherPostKind,
    ): Promise<PostResult>;
    enableDailyAutopost(subredditName: string): Promise<void>;
    deleteDailyAutopostSubscription(subredditName: string): Promise<void>;
    ensureDailyMiniRacerPodiumPostForSubreddit(
        subredditName: string,
        podium: FinalDailyGpPodium,
    ): Promise<PostResult>;
    enableDailyPodiumAutopost(subredditName: string): Promise<void>;
    deleteDailyPodiumAutopostSubscription(subredditName: string): Promise<void>;
    readAllDailyAutopostSubscriptions(): Promise<DailyAutopostSubscription[]>;
    readAllDailyPodiumAutopostSubscriptions(): Promise<DailyPodiumAutopostSubscription[]>;
    ensureModeratorAnalyticsPostForSubreddit(subredditName: string): Promise<PostResult>;
    assertModeratorForSubreddit(subredditName: string): Promise<string>;
    ensureCommunityCreatorPostForSubreddit(subredditName: string): Promise<PostResult>;
    runRacedListFill(): Promise<{ status: 'ready' | 'busy' | 'working'; rows: number }>;
    runDailyGhostArchive(): Promise<DailyGhostArchiveReport>;
    runGhostCompaction(): Promise<GhostCompactionReport>;
    sweepHeadToHeadCatalog(subredditName: string): Promise<{
        scanned: number;
        saved: number;
        skipped: number;
        status?: 'locked' | 'partial' | 'done';
    }>;
};

function createMenuToast(text: string, appearance: 'neutral' | 'success' = 'neutral') {
    return {
        showToast: {
            text,
            appearance,
        },
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'Unknown error';
}

function registerMenuAction(
    app: Application,
    dependencies: InternalRouteDependencies,
    path: string,
    options: MenuActionOptions,
    handler: (subredditName: string, res: Response) => Promise<void>,
): void {
    app.post(path, async (req, res) => {
        try {
            const input = (req.body ?? {}) as Partial<MenuItemRequest>;
            const targetId = typeof input.targetId === 'string' ? input.targetId : '';
            const subredditName = await dependencies.resolveMenuTargetSubredditName(targetId);

            if (!subredditName) {
                res.json(createMenuToast(options.missingContextMessage));
                return;
            }

            await handler(subredditName, res);
        } catch (error) {
            console.error(options.failureLogMessage, error);
            res.json(createMenuToast(
                `${options.failureToastPrefix}: ${getErrorMessage(error)}`,
            ));
        }
    });
}

export function registerInternalRoutes(
    app: Application,
    dependencies: InternalRouteDependencies,
): void {
    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/post-create',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
            failureLogMessage: 'Failed to create Mini Racer post:',
            failureToastPrefix: 'Could not create the Mini Racer post',
        },
        async (subredditName, res) => {
            const challenge = await dependencies.getServerDailyGpChallenge();
            const result = await dependencies.ensureDailyMiniRacerPostForSubreddit(
                subredditName,
                challenge,
            );
            res.json({ navigateTo: result.postUrl });
        },
    );

    const registerLauncherCreateAction = (
        path: string,
        kind: LauncherPostKind,
        label: string,
    ) => {
        registerMenuAction(
            app,
            dependencies,
            path,
            {
                missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
                failureLogMessage: `Failed to create Mini Racer ${kind} launcher post:`,
                failureToastPrefix: `Could not create the Mini Racer ${kind} launcher post`,
            },
            async (subredditName, res) => {
                const result = await dependencies.ensureMiniRacerLauncherPostForSubreddit(
                    subredditName,
                    kind,
                );
                res.json({
                    showToast: {
                        text: result.created
                            ? `${label} created for r/${subredditName}.`
                            : `${label} already exists for r/${subredditName}.`,
                        appearance: 'success',
                    },
                    navigateTo: result.postUrl,
                });
            },
        );
    };

    registerLauncherCreateAction(
        '/internal/menu/launcher-daily-create',
        'daily',
        'Current Daily launcher post',
    );
    registerLauncherCreateAction(
        '/internal/menu/launcher-campaign-create',
        'campaign',
        'Campaign launcher post',
    );
    registerLauncherCreateAction(
        '/internal/menu/launcher-lobby-create',
        'lobby',
        'Lobby launcher post',
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/head-to-head-catalog-sweep',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this collect.',
            failureLogMessage: 'Failed to collect Mini Racer challenges:',
            failureToastPrefix: 'Could not collect Mini Racer challenges',
        },
        async (subredditName, res) => {
            const result = await dependencies.sweepHeadToHeadCatalog(subredditName);
            const countLabel = `${result.saved} Mini Racer challenge${result.saved === 1 ? '' : 's'}`;
            const text = result.status === 'locked'
                ? `Already collecting challenges for r/${subredditName}. Try again in a moment.`
                : result.status === 'partial'
                    ? (result.saved > 0
                        ? `Collected ${countLabel} for r/${subredditName}. Click again to keep going through the month.`
                        : `Still collecting challenges for r/${subredditName}. Click again to keep going.`)
                    : (result.saved > 0
                        ? `Collected ${countLabel} for r/${subredditName}.`
                        : `No new Mini Racer challenges to collect for r/${subredditName}.`);
            res.json(createMenuToast(text, 'success'));
        },
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/mod-analytics-open',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this tool.',
            failureLogMessage: 'Failed to open moderator analytics tool:',
            failureToastPrefix: 'Could not open Mini Racer analytics',
        },
        async (subredditName, res) => {
            const result = await dependencies.ensureModeratorAnalyticsPostForSubreddit(
                subredditName,
            );

            if (!result.postUrl) {
                res.json(createMenuToast(
                    `Mini Racer analytics could not open for r/${subredditName}.`,
                ));
                return;
            }

            res.json({
                showToast: {
                    text: result.created
                        ? `Mini Racer analytics is ready for r/${subredditName}.`
                        : `Opening Mini Racer analytics for r/${subredditName}.`,
                    appearance: 'success',
                },
                navigateTo: result.postUrl,
            });
        },
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/community-creator-open',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for Creator.',
            failureLogMessage: 'Failed to open Mini Racer Creator:',
            failureToastPrefix: 'Could not open Mini Racer Creator',
        },
        async (subredditName, res) => {
            await dependencies.assertModeratorForSubreddit(subredditName);
            const result = await dependencies.ensureCommunityCreatorPostForSubreddit(subredditName);
            if (!result.postUrl) {
                res.json(createMenuToast(`Mini Racer Creator could not open for r/${subredditName}.`));
                return;
            }
            res.json({
                showToast: {
                    text: result.created
                        ? `Mini Racer Creator is ready for r/${subredditName}.`
                        : `Opening Mini Racer Creator for r/${subredditName}.`,
                    appearance: 'success',
                },
                navigateTo: result.postUrl,
            });
        },
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/podium-enable-daily',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
            failureLogMessage: 'Failed to enable daily Mini Racer podium posts:',
            failureToastPrefix: 'Could not enable daily Mini Racer podium posts',
        },
        async (subredditName, res) => {
            await dependencies.enableDailyPodiumAutopost(subredditName);
            const podium = await dependencies.getServerFinalDailyGpPodium();
            if (!podium || !isDailyGpPodiumPublicationOpen(podium)) {
                res.json(createMenuToast(
                    `Daily Mini Racer podium posts enabled for r/${subredditName}. No expired track is available yet.`,
                    'success',
                ));
                return;
            }

            const result = await dependencies.ensureDailyMiniRacerPodiumPostForSubreddit(
                subredditName,
                podium,
            );
            res.json({
                showToast: {
                    text: result.created
                        ? `Daily Mini Racer podium posts enabled for r/${subredditName}. The latest podium is live.`
                        : `Daily Mini Racer podium posts enabled for r/${subredditName}. The latest podium already exists.`,
                    appearance: 'success',
                },
                ...(result.created && result.postUrl ? { navigateTo: result.postUrl } : {}),
            });
        },
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/podium-disable-daily',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
            failureLogMessage: 'Failed to disable daily Mini Racer podium posts:',
            failureToastPrefix: 'Could not disable daily Mini Racer podium posts',
        },
        async (subredditName, res) => {
            await dependencies.deleteDailyPodiumAutopostSubscription(subredditName);
            res.json(createMenuToast(
                `Daily Mini Racer podium posts disabled for r/${subredditName}.`,
                'success',
            ));
        },
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/post-enable-daily',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
            failureLogMessage: 'Failed to enable daily Mini Racer posts:',
            failureToastPrefix: 'Could not enable daily Mini Racer posts',
        },
        async (subredditName, res) => {
            await dependencies.enableDailyAutopost(subredditName);
            const challenge = await dependencies.getServerDailyGpChallenge();
            const result = await dependencies.ensureDailyMiniRacerPostForSubreddit(
                subredditName,
                challenge,
            );

            res.json({
                showToast: {
                    text: result.created
                        ? `Daily Mini Racer posts enabled for r/${subredditName}. Today's post is live.`
                        : `Daily Mini Racer posts enabled for r/${subredditName}. Today's post already exists.`,
                    appearance: 'success',
                },
                ...(result.created && result.postUrl ? { navigateTo: result.postUrl } : {}),
            });
        },
    );

    registerMenuAction(
        app,
        dependencies,
        '/internal/menu/post-disable-daily',
        {
            missingContextMessage: 'Reddit did not provide a subreddit context for this install.',
            failureLogMessage: 'Failed to disable daily Mini Racer posts:',
            failureToastPrefix: 'Could not disable daily Mini Racer posts',
        },
        async (subredditName, res) => {
            await dependencies.deleteDailyAutopostSubscription(subredditName);
            res.json(createMenuToast(
                `Daily Mini Racer posts disabled for r/${subredditName}.`,
                'success',
            ));
        },
    );

    app.post('/internal/scheduler/daily-posts', async (_req, res) => {
        try {
            const challenge = await dependencies.getServerDailyGpChallenge();
            const subscriptions = await dependencies.readAllDailyAutopostSubscriptions();
            let createdCount = 0;

            for (const subscription of subscriptions) {
                if (!subscription.enabled) {
                    continue;
                }

                try {
                    const result = await dependencies.ensureDailyMiniRacerPostForSubreddit(
                        subscription.subredditName,
                        challenge,
                    );
                    if (result.created) {
                        createdCount += 1;
                    }
                } catch (error) {
                    console.error(
                        `Failed scheduled Mini Racer post for r/${subscription.subredditName}:`,
                        error,
                    );
                }
            }

            res.status(200).json({
                ok: true,
                challengeId: challenge.id,
                createdCount,
            });
        } catch (error) {
            console.error('Failed scheduled Mini Racer daily post run:', error);
            res.status(500).json({ ok: false, error: 'Scheduled daily post run failed' });
        }
    });

    // Fills the raced lists once; after that a run only reads the ready record.
    app.post('/internal/scheduler/raced-list-fill', async (_req, res) => {
        try {
            const result = await dependencies.runRacedListFill();
            res.status(200).json({ ok: true, ...result });
        } catch (error) {
            console.error('Failed scheduled raced list fill run:', error);
            res.status(500).json({ ok: false, error: 'Scheduled raced list fill run failed' });
        }
    });

    // Moves old Daily ghosts to blob storage as the moderator chose; Off does nothing.
    app.post('/internal/scheduler/daily-ghost-archive', async (_req, res) => {
        try {
            const result = await dependencies.runDailyGhostArchive();
            res.status(200).json({ ok: true, ...result });
        } catch (error) {
            console.error('Failed scheduled Daily ghost archive run:', error);
            res.status(500).json({ ok: false, error: 'Scheduled Daily ghost archive run failed' });
        }
    });

    // Packs ghosts while a compaction step runs; otherwise only reads the state.
    app.post('/internal/scheduler/ghost-compaction', async (_req, res) => {
        try {
            const result = await dependencies.runGhostCompaction();
            res.status(200).json({ ok: true, ...result });
        } catch (error) {
            console.error('Failed scheduled ghost compaction run:', error);
            res.status(500).json({ ok: false, error: 'Scheduled ghost compaction run failed' });
        }
    });

    app.post('/internal/scheduler/daily-podium-posts', async (_req, res) => {
        try {
            const podium = await dependencies.getServerFinalDailyGpPodium();
            if (!podium || !isDailyGpPodiumPublicationOpen(podium)) {
                res.status(200).json({ ok: true, challengeId: null, createdCount: 0 });
                return;
            }

            const subscriptions = await dependencies.readAllDailyPodiumAutopostSubscriptions();
            let createdCount = 0;
            for (const subscription of subscriptions) {
                if (!subscription.enabled) continue;
                try {
                    const result = await dependencies.ensureDailyMiniRacerPodiumPostForSubreddit(
                        subscription.subredditName,
                        podium,
                    );
                    if (result.created) createdCount += 1;
                } catch (error) {
                    console.error(
                        `Failed scheduled Mini Racer podium post for r/${subscription.subredditName}:`,
                        error,
                    );
                }
            }

            res.status(200).json({
                ok: true,
                challengeId: podium.challengeId,
                createdCount,
            });
        } catch (error) {
            console.error('Failed scheduled Mini Racer daily podium post run:', error);
            res.status(500).json({ ok: false, error: 'Scheduled daily podium post run failed' });
        }
    });
}
