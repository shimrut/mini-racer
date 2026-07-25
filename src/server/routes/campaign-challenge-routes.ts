import type { Application } from 'express';
import type {
    CampaignChallengeRequestContext,
    CampaignChallengeServiceResult,
} from '../campaign-challenge-service.js';

export type CampaignChallengeRouteDependencies = {
    getCampaignChallengeRequestContext(): Promise<CampaignChallengeRequestContext>
        | CampaignChallengeRequestContext;
    readContextPostData(): Record<string, unknown> | null;
    previewCampaignChallenge(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult>;
    createCampaignChallenge(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult>;
    getCampaignChallenge(
        challengeId: string | null,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult>;
    submitCampaignChallenge(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult>;
    previewCampaignChallengeBrag(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult>;
    confirmCampaignChallengeBrag(
        input: Record<string, unknown>,
        context: CampaignChallengeRequestContext,
    ): Promise<CampaignChallengeServiceResult>;
};

function postChallengeId(postData: Record<string, unknown> | null): string | null {
    return postData?.postType === 'campaign-challenge'
        && typeof postData.challengeId === 'string'
        ? postData.challengeId
        : null;
}
export function registerCampaignChallengeRoutes(
    app: Application,
    dependencies: CampaignChallengeRouteDependencies,
): void {
    app.post('/api/campaign/challenge/preview', async (req, res) => {
        try {
            const result = await dependencies.previewCampaignChallenge(
                req.body ?? {},
                await dependencies.getCampaignChallengeRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to preview Mini Racer campaign challenge:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not prepare this challenge.' });
        }
    });

    app.post('/api/campaign/challenge/create', async (req, res) => {
        try {
            const result = await dependencies.createCampaignChallenge(
                req.body ?? {},
                await dependencies.getCampaignChallengeRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to create Mini Racer campaign challenge:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not create this challenge.' });
        }
    });

    app.get('/api/campaign/challenge', async (req, res) => {
        try {
            const queryId = typeof req.query?.challengeId === 'string'
                ? req.query.challengeId
                : null;
            const result = await dependencies.getCampaignChallenge(
                queryId || postChallengeId(dependencies.readContextPostData()),
                await dependencies.getCampaignChallengeRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to load Mini Racer campaign challenge:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not load this challenge.' });
        }
    });

    app.post('/api/campaign/challenge/submit', async (req, res) => {
        try {
            const body = req.body ?? {};
            const result = await dependencies.submitCampaignChallenge(
                {
                    ...body,
                    challengeId: typeof body.challengeId === 'string'
                        ? body.challengeId
                        : postChallengeId(dependencies.readContextPostData()),
                },
                await dependencies.getCampaignChallengeRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to submit Mini Racer campaign challenge:', error);
            res.status(500).json({ accepted: false, status: 'challenge_failed', error: 'Could not verify this challenge run.' });
        }
    });

    app.post('/api/campaign/challenge/brag/preview', async (req, res) => {
        try {
            const result = await dependencies.previewCampaignChallengeBrag(
                req.body ?? {},
                await dependencies.getCampaignChallengeRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to preview Mini Racer challenge brag:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not prepare this brag.' });
        }
    });

    app.post('/api/campaign/challenge/brag/confirm', async (req, res) => {
        try {
            const result = await dependencies.confirmCampaignChallengeBrag(
                req.body ?? {},
                await dependencies.getCampaignChallengeRequestContext(),
            );
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('Failed to confirm Mini Racer challenge brag:', error);
            res.status(500).json({ status: 'challenge_failed', error: 'Could not post this brag.' });
        }
    });
}
