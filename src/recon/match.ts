import { addBusinessDays } from "../calendar.ts";
import type { Credit, Options, Tier, Transaction } from "./types.ts";

type Group = { key: string; id: string; date: string; rows: Transaction[]; net: bigint };
type Proposal = {
  group: Group;
  bank: Credit;
  anchored: boolean;
  rows: Transaction[];
  added: Transaction[];
  removed: Transaction[];
  extraClaims?: Transaction[];
};
type Adjustment = { row: Transaction; effect: bigint; action: "add" | "remove" };
export type SettlementMatch = Proposal & { tier: Tier };
export type Ambiguity = { tier: Tier; groupIds: string[]; banks: Credit[]; rows: Transaction[] };

export function sumNet(rows: readonly Transaction[]): bigint {
  return rows.reduce((total, row) => total + row.netMinor, 0n);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function groupsBy(rows: Transaction[], mode: "reference" | "date"): Group[] {
  const groups = new Map<string, Transaction[]>();
  for (const row of rows) {
    const key = mode === "reference" ? row.batchId : row.date;
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => {
    const date = group.reduce((latest, row) => row.date > latest ? row.date : latest, group[0].date);
    const firstId = group[0].batchId;
    const id = firstId && group.every((row) => row.batchId === firstId) ? firstId : `${date}/${group[0].currency}`;
    return { key: `${mode}:${key}`, id, date, rows: group, net: sumNet(group) };
  });
}

function proposal(group: Group, bank: Credit, anchored: boolean): Proposal {
  return { group, bank, anchored, rows: group.rows, added: [], removed: [] };
}

function overlaps(proposals: Proposal[]): Set<Proposal> {
  const claims = new Map<string, Proposal>();
  const contested = new Set<Proposal>();
  for (const candidate of proposals) {
    const rows = new Set([...candidate.group.rows, ...candidate.added, ...(candidate.extraClaims ?? [])]);
    const keys = [candidate.group.key, `bank:${candidate.bank.ref}`, ...[...rows].map((row) => `row:${row.id}`)];
    for (const key of keys) {
      const existing = claims.get(key);
      if (existing) {
        contested.add(existing);
        contested.add(candidate);
      } else {
        claims.set(key, candidate);
      }
    }
  }
  return contested;
}

function findAdjustments(options: Adjustment[], target: bigint, size: number): Adjustment[][] {
  const byAmount = new Map<bigint, Adjustment[]>();
  for (const option of options) {
    const sameAmount = byAmount.get(option.effect) ?? [];
    sameAmount.push(option);
    byAmount.set(option.effect, sameAmount);
  }

  const singles = (byAmount.get(target) ?? []).filter((option) => size > 1 || option.action === "add");
  if (singles.length > 0) return singles.slice(0, 2).map((option) => [option]);

  const pairs: Adjustment[][] = [];
  const visited = new Set<Adjustment>();
  for (const first of options) {
    visited.add(first);
    for (const second of byAmount.get(target - first.effect) ?? []) {
      if (visited.has(second)) continue;
      const finalSize = size + (first.action === "add" ? 1 : -1) + (second.action === "add" ? 1 : -1);
      if (finalSize <= 0) continue;
      pairs.push([first, second]);
      if (pairs.length === 2) return pairs;
    }
  }
  return pairs;
}

export function matchSettlements(
  rows: Transaction[], banks: Credit[], orphans: Transaction[], options: Options,
) {
  const perTransaction = options.tolerancePerTransactionMinor ?? 1n;
  const cap = options.toleranceCapMinor ?? 500n;
  const candidateCap = options.residualCandidateCap ?? 512;
  if (perTransaction < 0n || cap < 0n || !Number.isSafeInteger(candidateCap) || candidateCap < 0) {
    throw new Error("Matching limits must be nonnegative integers");
  }

  const holidays = new Set(options.holidays ?? []);
  const windows = new Map<string, [string, string]>();
  function inWindow(origin: string, valueDate: string): boolean {
    let window = windows.get(origin);
    if (!window) {
      window = [addBusinessDays(origin, 1, holidays), addBusinessDays(origin, 2, holidays)];
      windows.set(origin, window);
    }
    return valueDate >= window[0] && valueDate <= window[1];
  }

  function tolerance(group: Group): bigint {
    // One paise per item covers half a paise per fee plus the batch's half-paise rounding bound.
    const scaled = BigInt(group.rows.length) * perTransaction;
    return scaled < cap ? scaled : cap;
  }

  const matches: SettlementMatch[] = [];
  const ambiguities: Ambiguity[] = [];
  const allocatedRows = new Set<Transaction>();
  const allocatedBanks = new Set<Credit>();
  const blockedRows = new Set<Transaction>();
  const blockedBanks = new Set<Credit>();
  const plausibleBanks = new Set<Credit>();
  const cappedBanks = new Set<Credit>();
  const rowOpen = (row: Transaction) => !allocatedRows.has(row) && !blockedRows.has(row);
  const bankOpen = (bank: Credit) => !allocatedBanks.has(bank) && !blockedBanks.has(bank);

  function resolve(proposals: Proposal[], tier: Tier, accept = (_candidate: Proposal) => true): void {
    const contested = overlaps(proposals);
    if (contested.size > 0) {
      const rows = new Set<Transaction>();
      const banks = new Set<Credit>();
      const groupIds = new Set<string>();
      for (const candidate of contested) {
        for (const row of [...candidate.group.rows, ...candidate.added, ...(candidate.extraClaims ?? [])]) {
          rows.add(row);
          blockedRows.add(row);
        }
        banks.add(candidate.bank);
        blockedBanks.add(candidate.bank);
        plausibleBanks.add(candidate.bank);
        groupIds.add(candidate.group.id);
      }
      ambiguities.push({ tier, groupIds: [...groupIds], rows: [...rows], banks: [...banks] });
    }

    for (const candidate of proposals) {
      if (contested.has(candidate) || !accept(candidate)) continue;
      if (!bankOpen(candidate.bank) || !candidate.rows.every(rowOpen)) {
        throw new Error("A match attempted to reuse a reserved source record");
      }
      allocatedBanks.add(candidate.bank);
      for (const row of candidate.rows) allocatedRows.add(row);
      matches.push({ ...candidate, tier });
    }
  }

  const byReference = new Map(groupsBy(rows, "reference").map((group) => [group.id, group]));
  const anchored: Proposal[] = [];
  for (const bank of banks) {
    const tokens = new Set(bank.narration.match(/[\p{L}\p{N}_-]+/gu) ?? []);
    for (const token of tokens) {
      const group = byReference.get(token);
      if (group) anchored.push(proposal(group, bank, true));
    }
  }
  const reserved = new Set(anchored.flatMap(({ group }) => group.rows));
  const referencedBanks = new Set(anchored.map(({ bank }) => bank));
  resolve(anchored, "T0", ({ group, bank }) => group.date <= bank.date && group.net === bank.creditMinor);

  function windowCandidates(): Proposal[] {
    const freeBanks = banks.filter((bank) => bankOpen(bank) && !referencedBanks.has(bank));
    const groups = groupsBy(rows.filter((row) => rowOpen(row) && !reserved.has(row)), "date");
    const available = anchored.filter(({ group, bank }) =>
      bankOpen(bank) && group.rows.every(rowOpen) && inWindow(group.date, bank.date));
    for (const group of groups) {
      for (const bank of freeBanks) {
        if (inWindow(group.date, bank.date)) available.push(proposal(group, bank, false));
      }
    }
    return available;
  }

  resolve(windowCandidates().filter(({ group, bank }) => abs(group.net - bank.creditMinor) <= tolerance(group)), "T1");

  const unreferenced = rows.filter((row) => rowOpen(row) && !row.batchId);
  const residualCandidates: Proposal[] = [];
  for (const candidate of windowCandidates()) {
    const { group, bank } = candidate;
    const target = bank.creditMinor - group.net;
    const baseRows = new Set(group.rows);
    const possible: Adjustment[] = [];
    if (!candidate.anchored) {
      for (const row of group.rows) possible.push({ row, effect: -row.netMinor, action: "remove" });
    }
    for (const row of unreferenced) {
      if (!baseRows.has(row) && inWindow(row.date, bank.date)) {
        possible.push({ row, effect: row.netMinor, action: "add" });
      }
    }
    for (const row of orphans) {
      if (rowOpen(row) && row.date === group.date && (!row.batchId || row.batchId === group.id)) {
        possible.push({ row, effect: row.netMinor, action: "add" });
      }
    }

    let largest = 0n;
    let secondLargest = 0n;
    for (const option of possible) {
      const magnitude = abs(option.effect);
      if (magnitude >= largest) {
        secondLargest = largest;
        largest = magnitude;
      } else if (magnitude > secondLargest) {
        secondLargest = magnitude;
      }
    }
    if (target === 0n || abs(target) > largest + secondLargest) continue;
    plausibleBanks.add(bank);
    if (possible.length > candidateCap) {
      cappedBanks.add(bank);
      continue;
    }

    const solutions = findAdjustments(possible, target, group.rows.length);
    for (const solution of solutions) {
      const added = solution.filter(({ action }) => action === "add").map(({ row }) => row);
      const removed = solution.filter(({ action }) => action === "remove").map(({ row }) => row);
      residualCandidates.push({
        ...candidate, added, removed,
        rows: [...group.rows.filter((row) => !removed.includes(row)), ...added],
        extraClaims: solutions.length > 1 ? possible.map(({ row }) => row) : undefined,
      });
    }
  }
  // A capped alternative leaves the bank allocation provisional even if a different pool found a solution.
  resolve(residualCandidates.filter(({ bank }) => !cappedBanks.has(bank)), "T2");

  resolve(anchored.filter(({ bank, group }) => bankOpen(bank) && !cappedBanks.has(bank) &&
    group.date <= bank.date && group.rows.every(rowOpen)), "T3");

  return {
    matches, ambiguities, allocatedRows, allocatedBanks, plausibleBanks, cappedBanks, referencedBanks,
  };
}
