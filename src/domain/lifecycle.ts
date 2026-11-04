export type InstructionState =
  | "DRAFT"
  | "VALIDATED"
  | "SIGNED"
  | "PAYMENT_PENDING"
  | "PAYMENT_VERIFIED"
  | "ELIGIBILITY_PENDING"
  | "AUTHORISED"
  | "EXECUTION_PENDING"
  | "EXECUTED"
  | "RECONCILED"
  | "REJECTED"
  | "EXPIRED"
  | "EXCEPTION";

const transitions: Readonly<Record<InstructionState, readonly InstructionState[]>> = {
  DRAFT: ["VALIDATED", "REJECTED", "EXPIRED"],
  VALIDATED: ["SIGNED", "REJECTED", "EXPIRED"],
  SIGNED: ["PAYMENT_PENDING", "REJECTED", "EXPIRED"],
  PAYMENT_PENDING: ["PAYMENT_VERIFIED", "REJECTED", "EXPIRED", "EXCEPTION"],
  PAYMENT_VERIFIED: ["ELIGIBILITY_PENDING", "REJECTED", "EXPIRED", "EXCEPTION"],
  ELIGIBILITY_PENDING: ["AUTHORISED", "REJECTED", "EXPIRED", "EXCEPTION"],
  AUTHORISED: ["EXECUTION_PENDING", "EXPIRED", "EXCEPTION"],
  EXECUTION_PENDING: ["EXECUTED", "EXCEPTION"],
  EXECUTED: ["RECONCILED", "EXCEPTION"],
  RECONCILED: [],
  REJECTED: [],
  EXPIRED: [],
  EXCEPTION: ["RECONCILED", "REJECTED"],
};

export function canTransition(from: InstructionState, to: InstructionState): boolean {
  return transitions[from].includes(to);
}

export function transition(from: InstructionState, to: InstructionState): InstructionState {
  if (!canTransition(from, to)) throw new Error(`Illegal state transition: ${from} -> ${to}`);
  return to;
}

export { transitions };
