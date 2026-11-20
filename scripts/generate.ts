import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addBusinessDays, addCalendarDays } from "../src/calendar.ts";
import { formatCsv } from "../src/csv.ts";
import { percentageFee } from "../src/money.ts";
import { fixtureConfig as config } from "./fixture-config.ts";

const TRANSACTION_HEADER = [
  "txn_id", "created_at", "customer_id", "type", "gross_minor", "fee_minor",
  "net_minor", "currency", "payout_batch_id", "original_txn_id",
];
const SETTLEMENT_HEADER = ["bank_ref", "value_date", "credit_minor", "currency", "narration"];
const GENERIC_NARRATION = "NEFT CR, ACQUIRER SETTLEMENT";
// At 2%, 50 paise adds one exact paise of fee and the next 25 paise adds half.
const HALFWAY_GROSS_MINOR = 25n;
const EXACT_FEE_GROSS_INCREMENT = 50n;

type Transaction = {
  id: string;
  timestamp: string;
  customerId: string;
  grossMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  batchId: string;
  originalId?: string;
};

type Settlement = {
  ref: string;
  date: string;
  creditMinor: bigint;
  narration: string;
};

type Batch = {
  day: string;
  id: string;
  transactions: Transaction[];
  netMinor: bigint;
  settlement: Settlement;
};

type PlantedKind =
  | "TIMING_NEXT_PERIOD"
  | "ROUNDING_ACCUMULATION"
  | "DUPLICATE_PLATFORM"
  | "ORPHAN_REFUND"
  | "BANK_ONLY_CREDIT"
  | "FEE_DRIFT";

function createRandom(seed: bigint): (limit: bigint) => bigint {
  let state = BigInt.asUintN(64, seed);
  if (state === 0n) throw new Error("Fixture seed must be nonzero");

  return (limit) => {
    state = BigInt.asUintN(64, state ^ (state << 13n));
    state ^= state >> 7n;
    state = BigInt.asUintN(64, state ^ (state << 17n));
    return state % limit;
  };
}

function makeTransaction(input: Omit<Transaction, "feeMinor" | "netMinor">): Transaction {
  const feeMinor = percentageFee(input.grossMinor, config.feeRateBps);
  return { ...input, feeMinor, netMinor: input.grossMinor - feeMinor };
}

function id(prefix: string, sequence: number, width: number): string {
  return `${prefix}-${String(sequence).padStart(width, "0")}`;
}

function captureTimestamp(day: string, index: number): string {
  const minutes = 9 * 60 + index;
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${day}T${hour}:${minute}:00+05:30`;
}

function plantedBreak(
  kind: PlantedKind,
  ids: string[],
  amountMinor: bigint,
  explanation: string,
) {
  return { kind, ids, amount_minor: amountMinor.toString(), explanation };
}

export function generateFixture(): Record<string, string> {
  const random = createRandom(config.seed);
  const holidays = new Set<string>(config.holidays);
  const days: string[] = [];
  for (
    let day: string = config.firstCaptureDate;
    day <= config.lastCaptureDate;
    day = addCalendarDays(day, 1)
  ) {
    if (day !== config.withoutCaptures) days.push(day);
  }

  // One extra export row is a duplicate, and one is the orphan refund.
  const ordinaryCount = config.transactionCount - config.roundingBatchSize - 2;
  const ordinaryDays = days.length - 1;
  const minPerDay = Math.floor(ordinaryCount / ordinaryDays);
  let extraOrdinaryDays = ordinaryCount % ordinaryDays;
  let txnSequence = 0;

  const batches = days.map((day, batchIndex): Batch => {
    const batchId = `BATCH-${day.replaceAll("-", "")}-${config.currency}`;
    const isRoundingBatch = day === config.roundingCaptureDate;
    let count: number = config.roundingBatchSize;
    if (!isRoundingBatch) {
      count = minPerDay;
      if (extraOrdinaryDays > 0) {
        count += 1;
        extraOrdinaryDays -= 1;
      }
    }

    const transactions: Transaction[] = [];
    let grossMinor = 0n;
    let netMinor = 0n;
    for (let index = 0; index < count; index += 1) {
      const original = !isRoundingBatch && batchIndex % 4 === 0 && index === 12
        ? transactions[0]
        : undefined;
      const principal = original
        ? -original.grossMinor
        : 50_100n + random(2_000n) * EXACT_FEE_GROSS_INCREMENT
          + (isRoundingBatch ? HALFWAY_GROSS_MINOR : 0n);
      let timestamp = captureTimestamp(day, index);
      if (day === config.timingCaptureDate && index === count - 1) {
        timestamp = `${day}T23:59:59+05:30`;
      }
      if (day === "2026-11-01" && index === 0) {
        timestamp = `${day}T00:00:00+05:30`;
      }

      const transaction = makeTransaction({
        id: id("TXN", ++txnSequence, 6),
        timestamp,
        customerId: original?.customerId ?? `CUS-${String(random(600n) + 1n).padStart(4, "0")}`,
        grossMinor: principal,
        batchId,
        originalId: original?.id,
      });
      transactions.push(transaction);
      grossMinor += transaction.grossMinor;
      netMinor += transaction.netMinor;
    }

    // Keep October 31 as the only October cohort paid in November.
    const lag = day === config.firstCaptureDate || day === "2026-10-29" ||
      day === config.timingCaptureDate ? 1 : 1 + (batchIndex % 2);
    const extraFee = day === config.feeDriftCaptureDate ? config.extraBankFeeMinor : 0n;
    const bankFee = percentageFee(grossMinor, config.feeRateBps) + extraFee;
    return {
      day,
      id: batchId,
      transactions,
      netMinor,
      settlement: {
        ref: id("BNK", batchIndex + 1, 4),
        date: addBusinessDays(day, lag, holidays),
        creditMinor: grossMinor - bankFee,
        narration: batchIndex % 3 === 1 ? GENERIC_NARRATION : `NEFT CR ${batchId}`,
      },
    };
  });

  function batchOn(day: string): Batch {
    const batch = batches.find((candidate) => candidate.day === day);
    if (!batch) throw new Error(`Missing fixture batch on ${day}`);
    return batch;
  }

  const timingBatch = batchOn(config.timingCaptureDate);
  const roundingBatch = batchOn(config.roundingCaptureDate);
  const duplicate = batchOn(config.duplicateCaptureDate).transactions[0];
  const orphanBatch = batchOn(config.orphanRefundDate);
  const orphan = makeTransaction({
    id: id("TXN", ++txnSequence, 6),
    timestamp: captureTimestamp(orphanBatch.day, orphanBatch.transactions.length),
    customerId: "CUS-0601",
    grossMinor: config.orphanRefundGrossMinor,
    batchId: orphanBatch.id,
    originalId: config.absentParentId,
  });
  const bankOnly: Settlement = {
    ref: id("BNK", batches.length + 1, 4),
    date: config.bankOnlyValueDate,
    creditMinor: config.bankOnlyCreditMinor,
    narration: GENERIC_NARRATION,
  };
  const feeDriftBatch = batchOn(config.feeDriftCaptureDate);

  const platformRows = batches.flatMap((batch) => {
    const rows = batch.transactions.flatMap((transaction) =>
      transaction === duplicate ? [transaction, transaction] : [transaction]);
    if (batch === orphanBatch) rows.push(orphan);
    return rows;
  });
  const bankRows = [...batches.map((batch) => batch.settlement), bankOnly]
    .sort((left, right) => {
      const leftKey = `${left.date}/${left.ref}`;
      const rightKey = `${right.date}/${right.ref}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  const groundTruth = [
    plantedBreak("TIMING_NEXT_PERIOD", [timingBatch.id, timingBatch.settlement.ref],
      timingBatch.netMinor,
      `October 31 captures paid on ${timingBatch.settlement.date}, after the October cutoff.`),
    plantedBreak("ROUNDING_ACCUMULATION", [roundingBatch.id, roundingBatch.settlement.ref],
      roundingBatch.netMinor - roundingBatch.settlement.creditMinor,
      `${roundingBatch.transactions.length} fees round up by half a paise per capture. The bank rounds the batch fee once.`),
    plantedBreak("DUPLICATE_PLATFORM", [duplicate.id], duplicate.netMinor,
      "One capture occurs twice in the export; its bank batch contains one copy."),
    plantedBreak("ORPHAN_REFUND", [orphan.id, config.absentParentId], orphan.netMinor,
      "The refund has no original capture in the export and was excluded from bank settlement."),
    plantedBreak("BANK_ONLY_CREDIT", [bankOnly.ref], -bankOnly.creditMinor,
      "Bank credit has no platform activity or settlement batch behind it."),
    plantedBreak("FEE_DRIFT", [feeDriftBatch.id, feeDriftBatch.settlement.ref],
      feeDriftBatch.netMinor - feeDriftBatch.settlement.creditMinor,
      `The bank deducted ${config.extraBankFeeMinor} paise more than the modeled batch fee.`),
  ];

  return {
    "transactions.csv": formatCsv([
      TRANSACTION_HEADER,
      ...platformRows.map((transaction) => [
        transaction.id, transaction.timestamp, transaction.customerId,
        transaction.originalId === undefined ? "payment" : "refund",
        transaction.grossMinor.toString(), transaction.feeMinor.toString(),
        transaction.netMinor.toString(), config.currency, transaction.batchId,
        transaction.originalId ?? "",
      ]),
    ]),
    "settlements.csv": formatCsv([
      SETTLEMENT_HEADER,
      ...bankRows.map((settlement) => [
        settlement.ref, settlement.date, settlement.creditMinor.toString(),
        config.currency, settlement.narration,
      ]),
    ]),
    "ground_truth.json": `${JSON.stringify(groundTruth, null, 2)}\n`,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const directory = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL("../data/", import.meta.url));
  const files = generateFixture();
  mkdirSync(directory, { recursive: true });
  for (const [filename, contents] of Object.entries(files)) {
    writeFileSync(join(directory, filename), contents, "utf8");
  }
}
