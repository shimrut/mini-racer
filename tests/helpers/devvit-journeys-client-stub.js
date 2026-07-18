const receipt = {
  status: "JOURNEY_RECEIPT_UNSPECIFIED",
  message: "Test stub",
};

export const telemetry = Object.freeze({
  getActiveJourneyId: () => undefined,
  appReady: async () => ({ receipt }),
  startJourney: async () => ({ journeyId: "test-journey", receipt }),
  progress: async () => ({ receipt }),
  interaction: async () => ({ receipt }),
  endJourney: async () => ({ receipt }),
});
