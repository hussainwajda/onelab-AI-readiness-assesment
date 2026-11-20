import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateFixture } from "../scripts/generate.ts";
import { fixtureConfig } from "../scripts/fixture-config.ts";
import { addBusinessDays, istDateFromTimestamp } from "../src/calendar.ts";
import { formatCsv } from "../src/csv.ts";
import { parseDecimalToMinor, roundHalfUp } from "../src/money.ts";
import { reconcileCsv } from "../src/recon/bridge.ts";
import type { Options, Result } from "../src/recon/types.ts";

const transactionHeader = [
  "txn_id", "created_at", "customer_id", "type", "gross_minor", "fee_minor", "net_minor",
  "currency", "payout_batch_id", "original_txn_id",
];
const bankHeader = ["bank_ref", "value_date", "credit_minor", "currency", "narration"];
const october = { periodStart: "2026-10-01", periodEndExclusive: "2026-11-01", currency: "INR", feeRateBps: 0n };

function transaction(id: string, date: string, net: bigint, batch = "", parent = "") {
  return [id, date.includes("T") ? date : `${date}T12:00:00+05:30`, "C1",
    parent ? "refund" : "payment", String(net), "0", String(net), "INR", batch, parent];
}

function credit(ref: string, date: string, amount: bigint, narration = "NEFT CR") {
  return [ref, date, String(amount), "INR", narration];
}

function reconcile(rows: string[][], bank: string[][], options: Partial<Options> = {}) {
  const result = reconcileCsv(formatCsv([transactionHeader, ...rows]), formatCsv([bankHeader, ...bank]),
    { ...october, ...options });
  assertBridge(result);
  return result;
}

function assertBridge(result: Result) {
  const unexplained = result.breaks.filter(({ kind }) => kind === "UNEXPLAINED")
    .reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
  assert.equal(BigInt(result.unexplainedResidualMinor), -unexplained);
  assert.equal(BigInt(result.platformTotalMinor) - BigInt(result.explainedMinor),
    BigInt(result.bankTotalMinor) - BigInt(result.unexplainedResidualMinor));
}

test("the generator is byte-identical to itself and the checked-in exports", () => {
  const generated = generateFixture();
  assert.deepEqual(generated, generateFixture());
  for (const [filename, contents] of Object.entries(generated)) {
    assert.equal(contents, readFileSync(new URL(`../data/${filename}`, import.meta.url), "utf8"));
  }
});

test("all generated breaks exactly match the answer key and a second run is identical", () => {
  const files = generateFixture();
  const run = () => reconcileCsv(files["transactions.csv"], files["settlements.csv"], {
    ...october, feeRateBps: fixtureConfig.feeRateBps, holidays: fixtureConfig.holidays,
  });
  const result = run();
  const normalize = (rows: { kind: string; ids: string[]; amount_minor: string }[]) =>
    rows.map(({ kind, ids, amount_minor }) => ({ kind, ids, amount_minor }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  assert.deepEqual(normalize(result.breaks.map(({ kind, ids, amountMinor }) => ({ kind, ids, amount_minor: amountMinor }))),
    normalize(JSON.parse(files["ground_truth.json"])));
  assert.equal(result.unexplainedResidualMinor, "0");
  assert.equal(result.platformTotalMinor, "173204009");
  assert.equal(result.bankTotalMinor, "168876730");
  assert.equal(JSON.stringify(result), JSON.stringify(run()));
  const rounding = result.matches.find(({ bankRef }) => bankRef === "BNK-0014");
  assert.equal(rounding?.tier, "T1");
  assert.equal(rounding?.toleranceConsumedMinor, "-260");
  assert.equal(result.matches.find(({ bankRef }) => bankRef === "BNK-0019")?.tier, "T3");
  assertBridge(result);
});

test("integer money parsing preserves signed and large values and rejects extra precision", () => {
  assert.equal(parseDecimalToMinor("9007199254740993.99"), 900719925474099399n);
  assert.equal(parseDecimalToMinor("-0.04"), -4n);
  assert.equal(roundHalfUp(-5n, 2n), -3n);
  for (const value of ["1.005", "12.3.4", "2e3", "1,000.00", "1.", " 1"]) {
    assert.throws(() => parseDecimalToMinor(value), /Invalid decimal/);
  }
});

test("IST month-end preserves October 31 at 23:59:59 and converts UTC October to IST November", () => {
  assert.equal(istDateFromTimestamp("2026-10-31T23:59:59+05:30"), "2026-10-31");
  assert.equal(istDateFromTimestamp("2026-10-31T18:30:00Z"), "2026-11-01");
  const rows = [transaction("oct", "2026-10-31T23:59:59+05:30", 1000n, "A"),
    transaction("nov", "2026-10-31T18:30:00Z", 2000n, "B")];
  const banks = [credit("a", "2026-11-02", 1000n, "SETTLEMENT A"), credit("b", "2026-11-02", 2000n, "SETTLEMENT B")];
  const octoberResult = reconcile(rows, banks);
  assert.equal(octoberResult.platformTotalMinor, "1000");
  assert.deepEqual(octoberResult.breaks.map(({ kind, amountMinor }) => [kind, amountMinor]),
    [["TIMING_NEXT_PERIOD", "1000"]]);
  const november = reconcile(rows, banks, { periodStart: "2026-11-01", periodEndExclusive: "2026-12-01" });
  assert.deepEqual(november.breaks.map(({ kind, amountMinor }) => [kind, amountMinor]),
    [["TIMING_PRIOR_PERIOD", "-1000"]]);
});

test("the T+2 business-day window spans a holiday and weekend", () => {
  const holidays = ["2026-10-02"];
  assert.equal(addBusinessDays("2026-10-01", 2, new Set(holidays)), "2026-10-06");
  const rows = [transaction("A", "2026-10-01", 10000n)];
  const result = reconcile(rows, [credit("a", "2026-10-06", 10000n)], { holidays });
  assert.deepEqual(result.breaks, []);
  assert.equal(result.matches[0].tier, "T1");
  const late = reconcile(rows, [credit("a", "2026-10-07", 10000n)], { holidays });
  assert.equal(late.matches.length, 0);
});

test("an all-refund cohort matches a negative bank debit", () => {
  const result = reconcile([
    transaction("sale", "2026-09-25", 1500n, "OLD"),
    transaction("refund", "2026-10-05", -1500n, "REF", "sale"),
  ], [credit("old", "2026-09-28", 1500n, "OLD"), credit("bank-debit", "2026-10-06", -1500n)]);
  assert.equal(result.platformTotalMinor, "-1500");
  assert.equal(result.bankTotalMinor, "-1500");
  assert.deepEqual(result.breaks, []);
  assert.deepEqual(result.matches.map(({ bankRef, tier }) => [bankRef, tier]), [["bank-debit", "T1"]]);
});

test("empty exports have a zero bridge and an empty cohort cannot claim a bank entry", () => {
  const empty = reconcile([], []);
  assert.equal(empty.differenceMinor, "0");
  assert.deepEqual(empty.matches, []);
  assert.deepEqual(empty.breaks, []);
  const result = reconcile([], [credit("zero", "2026-10-06", 0n), credit("unrelated", "2026-10-06", 1500n)]);
  assert.deepEqual(result.matches, []);
  assert.equal(result.breaks.find(({ kind }) => kind === "BANK_ONLY_CREDIT")?.amountMinor, "-1500");
});

test("one paise of low-volume tolerance is disclosed and a larger delta never goes to T1", () => {
  const rows = [transaction("a", "2026-10-05", 10000n)];
  const within = reconcile(rows, [credit("a", "2026-10-06", 9999n)]);
  assert.equal(within.matches[0].toleranceConsumedMinor, "1");
  assert.deepEqual(within.breaks.map(({ kind, amountMinor }) => [kind, amountMinor]), [["UNEXPLAINED", "1"]]);
  assert.equal(within.unexplainedResidualMinor, "-1");
  assert.deepEqual(reconcile(rows, [credit("a", "2026-10-06", 9998n)]).matches, []);
});

test("the high-volume tolerance cap applies and can be configured", () => {
  const rows = Array.from({ length: 520 }, (_, i) => transaction(`txn${i}`, "2026-10-05", 1000n));
  const result = reconcile(rows, [credit("at-cap", "2026-10-06", 519500n)]);
  assert.equal(result.matches[0].toleranceConsumedMinor, "500");
  const above = [credit("beyond", "2026-10-06", 519499n)];
  assert.deepEqual(reconcile(rows, above).matches, []);
  assert.equal(reconcile(rows, above, { toleranceCapMinor: 501n }).matches[0].toleranceConsumedMinor, "501");
});

test("two bank entries inside tolerance are ambiguous even when one is exact", () => {
  const result = reconcile([transaction("a", "2026-10-05", 10000n)],
    [credit("exact", "2026-10-06", 10000n), credit("within", "2026-10-07", 9999n)]);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.breaks[0].ids, ["2026-10-05/INR", "exact", "within"]);
  assert.equal(result.breaks[0].kind, "AMBIGUOUS_MATCH");
  assert.equal(result.breaks.filter(({ kind }) => kind === "UNEXPLAINED").length, 3);
});

test("a bank credit cannot claim either of two competing cohorts", () => {
  const result = reconcile([transaction("a", "2026-10-05", 10000n), transaction("b", "2026-10-06", 10000n)],
    [credit("bank", "2026-10-07", 10000n)]);
  assert.deepEqual(result.matches, []);
  assert.equal(result.breaks[0].kind, "AMBIGUOUS_MATCH");
});

test("T2 finds one removal and then pairs, preserving removed amounts as open", () => {
  const base = [transaction("main", "2026-10-05", 10000n), transaction("extra-a", "2026-10-05", 600n)];
  const banks = [credit("a", "2026-10-06", 10000n)];
  const single = reconcile(base, banks);
  assert.deepEqual(single.matches[0].removedIds, ["extra-a"]);
  assert.equal(single.matches[0].initialDeltaMinor, "600");
  assert.equal(single.matches[0].tier, "T2");
  const pair = reconcile([...base, transaction("extra-b", "2026-10-05", 900n)], banks);
  assert.deepEqual(pair.matches[0].removedIds, ["extra-a", "extra-b"]);
  assert.equal(pair.unexplainedResidualMinor, "-1500");
  const capped = reconcile([...base, transaction("extra-b", "2026-10-05", 900n)], banks, { residualCandidateCap: 2 });
  assert.deepEqual(capped.matches, []);
  assert.match(capped.breaks.find(({ ids }) => ids.includes("a"))!.explanation, /candidate limit/);
});

test("T2 can move an unreferenced transaction only inside its own date window", () => {
  const base = transaction("base", "2026-10-05", 10000n, "BASE");
  const banks = [credit("bank", "2026-10-07", 10600n)];
  const moved = reconcile([base, transaction("move", "2026-10-06", 600n)], banks);
  assert.equal(moved.matches[0].tier, "T2");
  assert.deepEqual(moved.matches[0].addedIds, ["move"]);
  assert.equal(moved.unexplainedResidualMinor, "0");
  assert.deepEqual(reconcile([base, transaction("late", "2026-10-01", 600n)], banks).matches, []);
  assert.deepEqual(reconcile([base, transaction("reserved", "2026-10-06", 600n, "OTHER")], banks).matches, []);
  const anchored = reconcile([base, transaction("move", "2026-10-06", 600n)],
    [credit("bank", "2026-10-07", 10600n, "SETTLEMENT BASE")]);
  assert.equal(anchored.matches[0].tier, "T2");
  assert.deepEqual(anchored.matches[0].addedIds, ["move"]);
});

test("T2 stops at two adjustments and keeps alternative subsets open", () => {
  const base = transaction("base", "2026-10-05", 10000n);
  const other = [400n, 500n, 600n].map((amount, i) => transaction(`other${i}`, "2026-10-05", amount));
  assert.deepEqual(reconcile([base, ...other], [credit("bank", "2026-10-06", 10000n)]).matches, []);
  const alternative = reconcile([base, other[0], transaction("other-equal", "2026-10-05", 400n)],
    [credit("bank", "2026-10-06", 10400n)]);
  assert.deepEqual(alternative.matches, []);
  assert.equal(alternative.breaks[0].kind, "AMBIGUOUS_MATCH");
  assert.equal(alternative.breaks[0].tier, "T2");
});

test("a bank re-export is signed on the bank side and contradictory duplicates fail loudly", () => {
  const row = credit("bank", "2026-10-06", 1000n, "PAY-1");
  const transactions = [transaction("txn", "2026-10-05", 1000n, "PAY-1")];
  const result = reconcile(transactions, [row, row]);
  assert.deepEqual(result.breaks.map(({ kind, amountMinor }) => [kind, amountMinor]), [["DUPLICATE_BANK", "-1000"]]);
  assert.throws(() => reconcile(transactions, [row, credit("bank", "2026-10-07", 1000n)]), /Conflicting duplicate/);
});
