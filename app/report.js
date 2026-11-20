import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureConfig } from "../scripts/fixture-config.ts";
import { reconcileCsv } from "../src/recon/bridge.ts";

export async function readReport() {
  const [transactions, settlements] = await Promise.all([
    readFile(join(process.cwd(), "data", "transactions.csv"), "utf8"),
    readFile(join(process.cwd(), "data", "settlements.csv"), "utf8"),
  ]);
  const configuredHolidays = process.env.RECON_HOLIDAYS;
  return reconcileCsv(transactions, settlements, {
    periodStart: process.env.RECON_PERIOD_START ?? "2026-10-01",
    periodEndExclusive: process.env.RECON_PERIOD_END_EXCLUSIVE ?? "2026-11-01",
    currency: process.env.RECON_CURRENCY ?? fixtureConfig.currency,
    feeRateBps: BigInt(process.env.RECON_FEE_RATE_BPS ?? fixtureConfig.feeRateBps),
    holidays: configuredHolidays === undefined ? fixtureConfig.holidays : configuredHolidays.split(",").filter(Boolean),
  });
}
