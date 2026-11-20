# Assumptions and fixture choices

## Period and calendar

- The fixture period is October 2026 in IST. October platform totals use the capture timestamp converted to IST. Bank totals use the statement's `value_date`. November rows supply evidence for the October cutoff.
- The calendar accepts a supplied set of date-only holidays and excludes Saturdays and Sundays. This fixture uses October 2, 2026 as its single modeled holiday. Its list represents the fixture's settlement account calendar.
- Business-day counting begins on the day after the cohort date. Captures can happen on weekends or holidays. October 31 is a Saturday in the fixture and its T+1 is Monday, November 2. October 30 has no captures and the October 29 batch settles on October 30, leaving October 31 as the sole October cohort that settles in November.
- The export has no separate payout-date field. Each nonempty IST capture date and currency is one fixture cohort, and its date is the starting point for the settlement window. Batch references use `BATCH-YYYYMMDD-INR`.
- Both requested timestamps are included. October 31 at 23:59:59 IST stays in October when expressed in UTC. November 1 at 00:00:00 IST is October 31 at 18:30:00 UTC and must fall in November for the IST close.

## Money and inputs

- Amounts are signed integer paise. CSV amount fields contain integer text. The decimal parser accepts an optional sign and up to two fractional digits using a period, and rejects grouping separators, exponent notation, and excess precision. In-memory money and the fee rate use `bigint`.
- The fixture uses one currency and a 200-basis-point fee. A normal refund reverses its principal and the associated proportional fee. Half-up ties round away from zero for signed values. A negative `credit_minor` represents a bank debit, including an all-refund batch.
- Platform period totals are raw exported `net_minor`, including the extra duplicate and the orphan refund. Modeled fees are already in net. The bank period total is the signed sum of statement amounts. The answer key uses platform net minus bank cash signs and encodes integer amounts as JSON strings to preserve precision.
- The CSV utility uses comma-separated fields, doubled quotes within quoted fields, and preserves field text and empty cells. It accepts a UTF-8 BOM and common line endings. The files use empty cells for nullable identifiers.

## Planted cases and verification

- The seed and all special inputs are fixed. Ordinary rows use gross amounts divisible by 50 paise, so their 2% fees are whole paise. The rounding cohort has 520 charges with half-paise fee tails, yielding a 260-paise platform-net shortfall relative to the bank credit. Its narration omits the batch reference.
- The duplicate is a second byte-identical export row. The bank settles one copy. The orphan refund points to a deliberately absent capture and, as agreed, is excluded from the bank settlement. Its signed platform net is a bridge component.
- The higher bank fee is 25,000 paise above the modeled fee. Its narration includes a full reference, so the case has known identity with a real amount difference. The unrelated bank credit is smaller than any legitimate batch and has generic narration.
- Twelve of the 35 legitimate credits omit their batch reference. The bank-only credit also has no batch reference. Transaction rows keep the fixture's batch IDs.
- The answer key is an array with one record for each of the six planted cases. Batch-related cases list the batch ID and bank reference. Transaction cases list the transaction ID and, for the orphan, the missing parent ID. The timing amount uses the settled net cohort value.
- This fixture includes exactly the six October breaks requested. The test suite supplies separate inputs for the other edge cases.

## Engine and app decisions

- Each report covers one configured currency. Both CSVs are validated against the stated headers in order. Evidence uses logical CSV record numbers, including the header as record 1, so quoted line breaks do not change a record's identity.
- Exact duplicate export rows contribute once as an adjustment for each extra copy in the period. Conflicting rows with the same ID are input errors because the engine has no basis to choose which payload is valid.
- A complete, known batch ID appearing as a narration token reserves its source rows. Tokens can contain letters, digits, underscores, and hyphens. A unique exact reference can match outside the inferred window when the bank date is on or after the latest capture. Inferred matches always use business-day windows. A multi-date reference group measures its window from its latest capture date.
- T1 tolerance is one paise per transaction with a 500-paise default cap. T2 allows up to two adjustments and 512 eligible candidates per near miss by default. It may remove inferred members or add unallocated, unreferenced captures whose own windows cover the bank date. Explicitly referenced members stay in their group. An orphan can be reinstated when an exact bounded adjustment supports its inclusion.
- Ambiguity is flagged with a zero-value finding. Unallocated amounts stay visible under `UNEXPLAINED`, even when opposing signs net to zero. An unpaired positive bank entry is bank-only when it has neither a reference claim nor a plausible near-miss candidate.
- The fixture model has one fee rate and no other bank deductions. An independently referenced payout with modeled platform fees can support `FEE_DRIFT`. An inferred match with a delta needs a reproduced rounding difference to classify that difference, so other deltas stay open. Match deltas affect the bridge in the bank's posting period. A relevant cross-cutoff delta stays visible as evidence in the capture period with zero current-period contribution.
- The App Router page and CSV endpoint read local exports on request. The default period and fee settings come from the fixture scenario and can be overridden through server environment variables. Only Next.js, React, and React DOM are direct dependencies. The UI shell uses JavaScript and the standalone reconciliation modules use TypeScript.
