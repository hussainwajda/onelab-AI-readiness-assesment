import { percentageFee } from "../money.ts";
import { sumNet } from "./match.ts";
import type { SettlementMatch } from "./match.ts";
import type { BreakKind, BreakLine, Credit, Evidence, Options, Tier, Transaction } from "./types.ts";

export function isInPeriod(date: string, options: Options): boolean {
  return date >= options.periodStart && date < options.periodEndExclusive;
}

export function breakLine(
  kind: BreakKind, amount: bigint, ids: string[], explanation: string,
  tier: Tier, transactions: readonly Transaction[] = [], credits: readonly Credit[] = [],
): BreakLine {
  const evidence: Evidence[] = [
    ...transactions.map((row): Evidence => ({
      source: "platform", row: row.sourceRow, id: row.id, date: row.date,
      type: row.type, amountMinor: row.netMinor.toString(),
    })),
    ...credits.map((row): Evidence => ({
      source: "bank", row: row.sourceRow, id: row.ref, date: row.date,
      type: row.creditMinor < 0n ? "debit" : "credit", amountMinor: row.creditMinor.toString(),
    })),
  ];
  return { kind, ids, amountMinor: amount.toString(), explanation, tier, evidence };
}

export function classifyMatch(match: SettlementMatch, options: Options): BreakLine[] {
  const { group, bank, rows, tier } = match;
  const ids = [group.id, bank.ref];
  const bankInPeriod = isInPeriod(bank.date, options);
  const capturesInPeriod = rows.filter((row) => isInPeriod(row.date, options));
  if (!bankInPeriod && capturesInPeriod.length === 0) return [];

  const result: BreakLine[] = [];
  if (bankInPeriod) {
    const priorCaptures = rows.filter((row) => row.date < options.periodStart);
    if (priorCaptures.length > 0) {
      result.push(breakLine("TIMING_PRIOR_PERIOD", -sumNet(priorCaptures), ids,
        `Prior-period captures appear on the bank statement on ${bank.date}.`, tier, priorCaptures, [bank]));
    }
  } else {
    result.push(breakLine("TIMING_NEXT_PERIOD", sumNet(capturesInPeriod), ids,
      `Current-period captures settled on ${bank.date}, after cutoff.`, tier, capturesInPeriod, [bank]));
  }

  const net = sumNet(rows);
  const delta = net - bank.creditMinor;
  if (delta === 0n) return result;

  const hasFeeModel = rows.every((row) => row.feeMinor === percentageFee(row.grossMinor, options.feeRateBps));
  const gross = rows.reduce((sum, row) => sum + row.grossMinor, 0n);
  const expectedBank = gross - percentageFee(gross, options.feeRateBps);
  const modeledRounding = net - expectedBank;
  const rounding = hasFeeModel && (match.anchored || modeledRounding === delta) ? modeledRounding : 0n;
  const differenceAfterRounding = delta - rounding;
  const nextPeriodNote = bankInPeriod ? "" : ` The amount posts in the bank period on ${bank.date}, so this close contribution is zero.`;
  if (rounding !== 0n) {
    result.push(breakLine("ROUNDING_ACCUMULATION", bankInPeriod ? rounding : 0n, ids,
      `Rounding each fee and rounding once on the batch differ by ${rounding} signed paise.${nextPeriodNote}`,
      tier, rows, [bank]));
  }
  if (differenceAfterRounding !== 0n) {
    const feeDrift = hasFeeModel && match.anchored;
    const explanation = feeDrift
      ? `The referenced payout differs from the modeled bank fee by ${differenceAfterRounding} signed paise.`
      : `The match consumed a ${differenceAfterRounding} paise difference without a verified fee explanation.`;
    result.push(breakLine(feeDrift ? "FEE_DRIFT" : "UNEXPLAINED",
      bankInPeriod ? differenceAfterRounding : 0n, ids, explanation + nextPeriodNote, tier, rows, [bank]));
  }
  return result;
}
