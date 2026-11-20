import { addCalendarDays } from "../calendar.ts";
import { breakLine, classifyMatch, isInPeriod } from "./classify.ts";
import { readCredits, readTransactions } from "./input.ts";
import { matchSettlements, sumNet } from "./match.ts";
import { BREAK_KINDS } from "./types.ts";
import type { BreakLine, Credit, Options, Result, Transaction } from "./types.ts";

function deduplicate<T extends { sourceRow: number }>(rows: T[], keyOf: (row: T) => string) {
  const unique = new Map<string, T>();
  const duplicates: [T, T][] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const first = unique.get(key);
    if (!first) {
      unique.set(key, row);
      continue;
    }
    const keys = Object.keys(row) as (keyof T)[];
    if (keys.some((field) => field !== "sourceRow" && row[field] !== first[field])) {
      throw new Error(`Conflicting duplicate identifier ${key} at records ${first.sourceRow} and ${row.sourceRow}`);
    }
    duplicates.push([first, row]);
  }
  return { rows: [...unique.values()], duplicates };
}

export function reconcileCsv(transactionCsv: string, bankCsv: string, options: Options): Result {
  const start = addCalendarDays(options.periodStart, 0);
  const end = addCalendarDays(options.periodEndExclusive, 0);
  for (const date of options.holidays ?? []) addCalendarDays(date, 0);
  if (start >= end || !/^[A-Z]{3}$/.test(options.currency) || options.feeRateBps < 0n) {
    throw new Error("Use an increasing period, a three-letter currency, and a nonnegative fee rate");
  }
  const inPeriod = (row: Transaction | Credit) => isInPeriod(row.date, options);
  const transactionRows = readTransactions(transactionCsv).filter((row) => row.currency === options.currency);
  const bankRows = readCredits(bankCsv).filter((row) => row.currency === options.currency);
  const platformTotal = sumNet(transactionRows.filter(inPeriod));
  const bankTotal = bankRows.filter(inPeriod).reduce((sum, row) => sum + row.creditMinor, 0n);

  const platform = deduplicate(transactionRows, (row) => row.id);
  const bank = deduplicate(bankRows, (row) => row.ref);
  const captures = new Set(platform.rows.filter((row) => row.type === "payment").map((row) => row.id));
  const orphans = new Set(platform.rows.filter((row) => row.type === "refund" && !captures.has(row.originalId)));
  const cleanRows = platform.rows.filter((row) => !orphans.has(row));
  const matching = matchSettlements(cleanRows, bank.rows, [...orphans], options);
  const breaks: BreakLine[] = [];

  for (const [first, row] of platform.duplicates) {
    if (inPeriod(row)) breaks.push(breakLine("DUPLICATE_PLATFORM", row.netMinor, [row.id],
      "This capture or refund appears more than once in the platform export.", "T3", [first, row]));
  }
  for (const [first, row] of bank.duplicates) {
    if (inPeriod(row)) breaks.push(breakLine("DUPLICATE_BANK", -row.creditMinor, [row.ref],
      "This bank entry appears more than once in the statement export.", "T3", [], [first, row]));
  }
  for (const row of orphans) {
    if (!inPeriod(row)) continue;
    const matched = matching.allocatedRows.has(row);
    breaks.push(breakLine("ORPHAN_REFUND", matched ? 0n : row.netMinor,
      row.originalId ? [row.id, row.originalId] : [row.id],
      matched ? "Bank evidence covers the refund, but the original capture is missing from the export."
        : "The original capture is missing and the refund has no confirmed bank allocation.", "T3", [row]));
  }
  for (const match of matching.matches) breaks.push(...classifyMatch(match, options));
  for (const issue of matching.ambiguities) {
    if (issue.rows.some(inPeriod) || issue.banks.some(inPeriod)) {
      breaks.push(breakLine("AMBIGUOUS_MATCH", 0n, [...issue.groupIds, ...issue.banks.map((row) => row.ref)],
        "Competing allocations share a batch, bank entry, or transaction. Review the source rows before allocating.",
        issue.tier, issue.rows, issue.banks));
    }
  }

  const unmatchedCohorts = new Map<string, Transaction[]>();
  for (const row of cleanRows) {
    if (!inPeriod(row) || matching.allocatedRows.has(row)) continue;
    const key = row.batchId || `${row.date}/${row.currency}`;
    const cohort = unmatchedCohorts.get(key) ?? [];
    cohort.push(row);
    unmatchedCohorts.set(key, cohort);
  }
  for (const [id, rows] of unmatchedCohorts) {
    breaks.push(breakLine("UNEXPLAINED", sumNet(rows), [id],
      "Platform net has no confirmed destination in the bank statement.", "T3", rows));
  }
  for (const row of bank.rows) {
    if (!inPeriod(row) || matching.allocatedBanks.has(row)) continue;
    const pending = matching.referencedBanks.has(row) || matching.plausibleBanks.has(row) || row.creditMinor <= 0n;
    const explanation = matching.cappedBanks.has(row)
      ? "The near-miss search exceeded its candidate limit. The bank amount remains open."
      : pending ? "Bank amount has no confirmed platform allocation." : "No eligible platform cohort supports this bank credit.";
    breaks.push(breakLine(pending ? "UNEXPLAINED" : "BANK_ONLY_CREDIT", -row.creditMinor,
      [row.ref], explanation, "T3", [], [row]));
  }
  breaks.sort((a, b) => BREAK_KINDS.indexOf(a.kind) - BREAK_KINDS.indexOf(b.kind));

  let explained = 0n;
  let residual = 0n;
  for (const item of breaks) {
    if (item.kind === "UNEXPLAINED") residual -= BigInt(item.amountMinor);
    else explained += BigInt(item.amountMinor);
  }
  if (platformTotal - explained !== bankTotal - residual) {
    throw new Error(`Bridge imbalance: platform ${platformTotal} - explained ${explained} does not equal bank ${bankTotal} - residual ${residual}`);
  }

  const matches = matching.matches.filter(({ rows, bank: credit }) => rows.some(inPeriod) || inPeriod(credit))
    .map(({ group, bank: credit, rows, tier, added, removed }) => {
      const delta = sumNet(rows) - credit.creditMinor;
      return {
        tier, batchId: group.id, bankRef: credit.ref, transactionIds: rows.map((row) => row.id),
        addedIds: added.map((row) => row.id), removedIds: removed.map((row) => row.id),
        initialDeltaMinor: (group.net - credit.creditMinor).toString(), deltaMinor: delta.toString(),
        toleranceConsumedMinor: (tier === "T1" ? delta : 0n).toString(),
      };
    });
  return {
    periodStart: start, periodEndExclusive: end, currency: options.currency,
    platformTotalMinor: platformTotal.toString(), bankTotalMinor: bankTotal.toString(),
    differenceMinor: (platformTotal - bankTotal).toString(), explainedMinor: explained.toString(),
    unexplainedResidualMinor: residual.toString(), breaks, matches,
  };
}
