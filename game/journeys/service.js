import { telemetry } from "@devvit/analytics/client/reddit";

const JOURNEY_INTERACTIONS = new Set(["pause", "resume"]);

function logReceipt(eventName, receipt) {
  if (!receipt || typeof receipt.status !== "string") return;
  console.info(`[Devvit Journeys] ${eventName}: ${receipt.status}`);
}

export class JourneyService {
  constructor({ client = telemetry, receiptLogger = logReceipt } = {}) {
    this.client = client;
    this.receiptLogger = receiptLogger;
    this.appReadyReported = false;
    this.attemptActive = false;
    this.hasStartedAttemptOnPage = false;
    this.highestProgress = 0;
    this.operationQueue = Promise.resolve();
  }

  enqueue(eventName, operation) {
    const result = this.operationQueue
      .then(operation)
      .then((response) => {
        this.receiptLogger(eventName, response?.receipt);
        return response;
      })
      .catch((error) => {
        console.warn(`[Devvit Journeys] ${eventName} failed.`, error);
        return null;
      });
    this.operationQueue = result.then(() => undefined);
    return result;
  }

  appReady() {
    if (this.appReadyReported) return this.operationQueue;
    this.appReadyReported = true;
    return this.enqueue("app_ready", () => this.client.appReady());
  }

  startAttempt() {
    if (this.attemptActive) return this.operationQueue;

    this.attemptActive = true;
    this.highestProgress = 0;
    const closeStaleJourney = !this.hasStartedAttemptOnPage;
    this.hasStartedAttemptOnPage = true;

    return this.enqueue("journey_start", async () => {
      if (closeStaleJourney && this.client.getActiveJourneyId?.()) {
        const response = await this.client.endJourney({ complete: false });
        this.receiptLogger("stale_journey_end", response?.receipt);
      }
      return this.client.startJourney();
    });
  }

  progressCheckpoint(checkpointIndex, checkpointCount) {
    if (!this.attemptActive) return this.operationQueue;
    if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0) return this.operationQueue;
    if (!Number.isInteger(checkpointCount) || checkpointCount <= 0) return this.operationQueue;

    const progress = Math.min(1, (checkpointIndex + 1) / (checkpointCount + 1));
    if (progress <= this.highestProgress) return this.operationQueue;

    this.highestProgress = progress;
    return this.enqueue("journey_progress", () => this.client.progress({
      progress,
      action: "checkpoint",
    }));
  }

  interaction(action) {
    if (!this.attemptActive || !JOURNEY_INTERACTIONS.has(action)) {
      return this.operationQueue;
    }
    return this.enqueue("journey_interaction", () => this.client.interaction({ action }));
  }

  endAttempt({ complete = false } = {}) {
    if (!this.attemptActive) return this.operationQueue;

    this.attemptActive = false;
    this.highestProgress = 0;
    return this.enqueue("journey_end", () => this.client.endJourney({
      complete: complete === true,
    }));
  }
}
