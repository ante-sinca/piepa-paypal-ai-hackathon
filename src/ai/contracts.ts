import type { InstructionProposal } from "../proposals/contracts.js";

export interface InstructionDraftingAgent {
  readonly provenance: "AI_GENERATED" | "SYNTHETIC_AI_DEMO";
  draft(input: Readonly<{ instruction: string; now?: Date }>): Promise<InstructionProposal>;
}
