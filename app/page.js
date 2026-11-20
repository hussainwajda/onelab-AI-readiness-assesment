import { connection } from "next/server";
import { addCalendarDays } from "../src/calendar.ts";
import { readReport } from "./report.js";

const labels = {
  TIMING_NEXT_PERIOD: "Next-period settlement",
  TIMING_PRIOR_PERIOD: "Prior-period settlement",
  DUPLICATE_PLATFORM: "Duplicate platform entry",
  DUPLICATE_BANK: "Duplicate bank entry",
  ORPHAN_REFUND: "Orphan refund",
  ROUNDING_ACCUMULATION: "Fee rounding",
  FEE_DRIFT: "Fee drift",
  BANK_ONLY_CREDIT: "Bank-only credit",
  AMBIGUOUS_MATCH: "Ambiguous match",
  UNEXPLAINED: "Unexplained amount",
};
const digits = new Intl.NumberFormat("en-IN");
const dates = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" });

function Money({ amount, currency, signed = false }) {
  const minor = BigInt(amount);
  const magnitude = minor < 0n ? -minor : minor;
  const sign = minor < 0n ? "−" : signed && minor > 0n ? "+" : "";
  const symbol = currency === "INR" ? "₹" : "";
  return <span className="money">{sign}{symbol}{digits.format(magnitude / 100n)}.{String(magnitude % 100n).padStart(2, "0")}</span>;
}

function SourceRows({ evidence, currency }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Contributing source records">
      <table>
        <thead><tr>
          <th scope="col">Source · row</th><th scope="col">Reference</th><th scope="col">Date</th>
          <th scope="col">Type</th><th scope="col" className="amount-cell">Source amount</th>
        </tr></thead>
        <tbody>{evidence.map((row) => (
          <tr key={`${row.source}-${row.row}`}>
            <td>{row.source === "bank" ? "Bank" : "Platform"} · {row.row}</td>
            <td className="reference">{row.id}</td><td>{row.date}</td><td>{row.type}</td>
            <td className="amount-cell"><Money amount={row.amountMinor} currency={currency} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default async function Page() {
  await connection();
  const report = await readReport();
  const groups = Object.entries(Object.groupBy(report.breaks, (item) => item.kind)).map(([kind, items]) => ({
    kind, items, amount: items.reduce((total, item) => total + BigInt(item.amountMinor), 0n),
  }));
  const hasOpen = report.breaks.some((item) => item.kind === "UNEXPLAINED" || item.kind === "AMBIGUOUS_MATCH");
  const closeDays = dates.formatRange(new Date(report.periodStart), new Date(addCalendarDays(report.periodEndExclusive, -1)));
  const money = (amount, signed = false) => <Money amount={amount} currency={report.currency} signed={signed} />;

  return (
    <main className="workspace">
      <header className="page-header">
        <div>
          <h1>Month-end reconciliation</h1>
          <p className="period">{closeDays} <span>·</span> {report.currency} <span>·</span> IST</p>
        </div>
        <a className="export" href="/export.csv" download><span aria-hidden="true" className="download-arrow" />Export CSV</a>
      </header>

      <section className="panel bridge" aria-labelledby="bridge-heading">
        <div className="section-bar">
          <h2 id="bridge-heading">Reconciliation bridge</h2>
          <span className={`status${hasOpen ? " status-open" : ""}`}>
            <span className="status-dot" aria-hidden="true" />{hasOpen ? "Review required" : "Fully explained"}
          </span>
        </div>
        <dl className="totals">
          <div><dt>Platform net</dt><dd>{money(report.platformTotalMinor)}</dd></div>
          <div><dt>Bank cash</dt><dd>{money(report.bankTotalMinor)}</dd></div>
          <div className="difference"><dt>Difference to explain</dt><dd>{money(report.differenceMinor)}</dd></div>
        </dl>
        {groups.some(({ kind }) => kind !== "UNEXPLAINED" && kind !== "AMBIGUOUS_MATCH") && (
          <dl className="components">
            {groups.filter(({ kind }) => kind !== "UNEXPLAINED" && kind !== "AMBIGUOUS_MATCH").map(({ kind, amount }) => (
              <div className="bridge-row" key={kind}><dt>{labels[kind]}</dt><dd>{money(amount, true)}</dd></div>
            ))}
          </dl>
        )}
        <dl className="bridge-footer">
          <div className="bridge-row"><dt>Explained difference</dt><dd>{money(report.explainedMinor, true)}</dd></div>
          <div className="bridge-row"><dt>Unexplained residual <span className="qualifier">· bank side</span></dt>
            <dd className={hasOpen ? "open-amount" : "clear-amount"}>{money(report.unexplainedResidualMinor, true)}</dd></div>
        </dl>
      </section>

      <section className="break-section" aria-labelledby="break-heading">
        <div className="break-heading"><h2 id="break-heading">Break details</h2><span>{groups.length} {groups.length === 1 ? "reason" : "reasons"}</span></div>
        {groups.length === 0 ? <p className="empty">No breaks for this period.</p> : (
          <div className="panel details-panel">
            {groups.map(({ kind, items, amount }) => (
              <details className="reason" key={kind}>
                <summary>
                  <span className="chevron" aria-hidden="true" />
                  <span className="reason-label">{labels[kind]}</span>
                  <span className="item-count">{items.length} {items.length === 1 ? "item" : "items"}</span>
                  <span className="reason-amount">{money(amount, true)}</span>
                </summary>
                <div className="reason-evidence">
                  {items.map((item, index) => (
                    <article className="evidence" key={index}>
                      <div className="evidence-title">
                        <span className="reference">{item.ids.join(" · ")}</span>
                        <span className="evidence-amount">
                          <span className="tier" aria-label={`Matching tier ${item.tier}`}>{item.tier}</span>
                          {money(item.amountMinor, true)}
                        </span>
                      </div>
                      <p>{item.explanation}</p>
                      <SourceRows evidence={item.evidence} currency={report.currency} />
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
