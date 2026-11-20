export const BREAK_KINDS = [
  "TIMING_NEXT_PERIOD", "TIMING_PRIOR_PERIOD", "DUPLICATE_PLATFORM", "DUPLICATE_BANK",
  "ORPHAN_REFUND", "ROUNDING_ACCUMULATION", "FEE_DRIFT", "BANK_ONLY_CREDIT",
  "AMBIGUOUS_MATCH", "UNEXPLAINED",
] as const;

export type BreakKind = (typeof BREAK_KINDS)[number];
export type Tier = "T0" | "T1" | "T2" | "T3";

export type Transaction = {
  id: string;
  sourceRow: number;
  createdAt: string;
  date: string;
  customerId: string;
  type: "payment" | "refund";
  grossMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  currency: string;
  batchId: string;
  originalId: string;
};

export type Credit = {
  ref: string;
  sourceRow: number;
  date: string;
  creditMinor: bigint;
  currency: string;
  narration: string;
};

export type Options = {
  periodStart: string;
  periodEndExclusive: string;
  currency: string;
  feeRateBps: bigint;
  holidays?: readonly string[];
  tolerancePerTransactionMinor?: bigint;
  toleranceCapMinor?: bigint;
  residualCandidateCap?: number;
};

export type Evidence = {
  source: "platform" | "bank";
  row: number;
  id: string;
  date: string;
  type: string;
  amountMinor: string;
};

export type BreakLine = {
  kind: BreakKind;
  ids: string[];
  amountMinor: string;
  explanation: string;
  tier: Tier;
  evidence: Evidence[];
};

export type MatchRecord = {
  tier: Tier;
  batchId: string;
  bankRef: string;
  transactionIds: string[];
  addedIds: string[];
  removedIds: string[];
  initialDeltaMinor: string;
  deltaMinor: string;
  toleranceConsumedMinor: string;
};

export type Result = {
  periodStart: string;
  periodEndExclusive: string;
  currency: string;
  platformTotalMinor: string;
  bankTotalMinor: string;
  differenceMinor: string;
  explainedMinor: string;
  unexplainedResidualMinor: string;
  breaks: BreakLine[];
  matches: MatchRecord[];
};
