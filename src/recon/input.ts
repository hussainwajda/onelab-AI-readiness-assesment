import { addCalendarDays, istDateFromTimestamp } from "../calendar.ts";
import { parseCsv } from "../csv.ts";
import { parseMinor } from "../money.ts";
import type { Credit, Transaction } from "./types.ts";

function readRows<T>(
  csv: string, columns: readonly string[], label: string, convert: (cells: string[], row: number) => T,
): T[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header || header.length !== columns.length || columns.some((name, i) => name !== header[i])) {
    throw new Error(`Invalid ${label} CSV header. Expected ${columns.join(",")}`);
  }
  return rows.map((cells, index) => {
    const row = index + 2;
    try {
      if (cells.length !== columns.length) throw new Error("Unexpected column count");
      return convert(cells, row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} CSV record ${row}: ${message}`, { cause: error });
    }
  });
}

export function readTransactions(csv: string): Transaction[] {
  return readRows(csv, [
    "txn_id", "created_at", "customer_id", "type", "gross_minor", "fee_minor", "net_minor",
    "currency", "payout_batch_id", "original_txn_id",
  ], "Platform", (cells, sourceRow) => {
    const [id, createdAt, customerId, type, gross, fee, net, currency, batchId, originalId] = cells;
    if (!id || !customerId || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Transaction ID, customer ID and three-letter currency are required");
    }
    if (type !== "payment" && type !== "refund") throw new Error(`Invalid transaction type ${type}`);
    const grossMinor = parseMinor(gross);
    const feeMinor = parseMinor(fee);
    const netMinor = parseMinor(net);
    if (grossMinor - feeMinor !== netMinor) throw new Error("Gross minus fee must equal net");
    if (type === "payment" ? grossMinor < 0n : grossMinor > 0n) {
      throw new Error("Payments must have nonnegative gross and refunds nonpositive gross");
    }
    return {
      id, sourceRow, createdAt, date: istDateFromTimestamp(createdAt), customerId, type,
      grossMinor, feeMinor, netMinor, currency, batchId, originalId,
    };
  });
}

export function readCredits(csv: string): Credit[] {
  return readRows(csv, ["bank_ref", "value_date", "credit_minor", "currency", "narration"],
    "Bank", (cells, sourceRow) => {
      const [ref, date, credit, currency, narration] = cells;
      if (!ref || !/^[A-Z]{3}$/.test(currency)) {
        throw new Error("Bank reference and three-letter currency are required");
      }
      return { ref, sourceRow, date: addCalendarDays(date, 0), creditMinor: parseMinor(credit), currency, narration };
    });
}
