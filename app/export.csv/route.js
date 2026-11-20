import { formatCsv } from "../../src/csv.ts";
import { readReport } from "../report.js";

function spreadsheetText(value) {
  return /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
}

export async function GET() {
  const report = await readReport();
  const period = [report.periodStart, report.periodEndExclusive, report.currency];
  const rows = [[
    "record_type", "period_start", "period_end_exclusive", "currency", "break_id", "reason", "tier", "ids", "amount_minor",
    "explanation", "source", "source_row", "source_id", "source_date", "source_type", "source_amount_minor",
  ]];

  for (const [name, amount] of [
    ["PLATFORM_NET", report.platformTotalMinor], ["BANK_CASH", report.bankTotalMinor],
    ["DIFFERENCE", report.differenceMinor], ["EXPLAINED", report.explainedMinor],
    ["UNEXPLAINED_RESIDUAL_BANK_SIDE", report.unexplainedResidualMinor],
  ]) {
    rows.push(["total", ...period, "", name, "", "", amount, "", "", "", "", "", "", ""]);
  }
  for (const [index, item] of report.breaks.entries()) {
    const reason = [`B${index + 1}`, item.kind, item.tier, spreadsheetText(item.ids.join(" | "))];
    rows.push(["break", ...period, ...reason, item.amountMinor, spreadsheetText(item.explanation), "", "", "", "", "", ""]);
    for (const row of item.evidence) {
      rows.push(["source", ...period, ...reason, "", "", row.source, String(row.row), spreadsheetText(row.id),
        row.date, row.type, row.amountMinor]);
    }
  }

  return new Response(formatCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="reconciliation-${report.periodStart}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
