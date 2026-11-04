/** Labels must be rendered verbatim in demo UI and receipts. */
export type SimulationLabel = "SIMULATED_PAYOUT_OUTCOME" | "SYNTHETIC_WEBHOOK";

export type SimulatedPayoutOutcome = Readonly<{
  label: "SIMULATED_PAYOUT_OUTCOME";
  scenarioId: string;
  result: "SUCCESS" | "FAILURE" | "AMBIGUOUS";
  generatedAt: string;
}>;
