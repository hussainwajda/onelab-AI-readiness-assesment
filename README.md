# Month-end settlement reconciliation

One bank credit can settle many captures and refunds. The bank posts the net batch one or two business days after the capture cohort date. A payment-to-bank row join loses both batch membership and the reason a credit differs from the platform export. Reconciliation needs to compare group totals, then explain each signed difference for the period.

## Run the app

Use Node.js 24 or newer. The Next.js App Router reads the two CSVs on the server. React and React DOM support the app, and the standalone engine and tests use Node's built-in TypeScript support and test runner.

```sh
npm ci
npm test
npm run dev
```

Open `http://localhost:3000`. Expand a break reason to see contributing source records. **Export CSV** downloads period totals, signed break components, and evidence rows linked by `break_id`. Amount columns contain integer minor units.

Use `npm run build` followed by `npm start` for the production server.

For another close, replace `data/transactions.csv` and `data/settlements.csv` with files in the supplied format. Include the adjacent-period rows needed to support cutoff. Set these optional server environment variables in `.env.local` or the launching environment.

| Variable | Fixture default |
|---|---|
| `RECON_PERIOD_START` | `2026-10-01` |
| `RECON_PERIOD_END_EXCLUSIVE` | `2026-11-01` |
| `RECON_CURRENCY` | `INR` |
| `RECON_FEE_RATE_BPS` | `200` |
| `RECON_HOLIDAYS` | `2026-10-02`, with multiple dates separated by commas |

The standalone entry point is `reconcileCsv` in `src/recon/bridge.ts`. It accepts the two CSV texts and the close settings and exposes configurable T1 and T2 limits for callers. Its deterministic result includes the break lines, logical CSV record numbers, and match-tier deltas.

## Generate the fixtures

```sh
npm run generate
```

The command writes these three reproducible files. Pass a directory after `--` to generate a second copy for comparison.

| File | Contents |
|---|---|
| `data/transactions.csv` | 2,000 platform rows from October 1 through November 5, 2026 |
| `data/settlements.csv` | 35 batch credits and one unrelated bank credit. Twelve of the 35 batch narrations omit the batch reference. |
| `data/ground_truth.json` | Six expected October break components with source identifiers and signed paise amounts |

The seed, fee rate, fixture dates, and modeled holiday are in `scripts/fixture-config.ts`. Output is UTF-8 with LF line endings and stable ordering. The answer key is fixture data for verification. The reconciliation engine should derive findings from the CSVs.

The October fixture totals are 173,204,009 paise of exported platform net and 168,876,730 paise of bank cash. The six signed answer-key amounts sum to the 4,327,279 paise difference. The test suite checks the complete set of reasons, IDs, and amounts against the answer key.

## Matching rules for the engine

1. **T0** uses a batch reference extracted from narration with zero tolerance.
2. **T1** compares each available capture-date cohort and currency against credits in the one-to-two-business-day IST window. The default is one paise per transaction, capped at 500 paise, with both values configurable. Nearest-paise rounding can account for up to half a paise per fee line plus half a paise for rounding the batch fee. One paise per item covers that bound for a nonempty batch. The cap limits how much can be accepted by a candidate match. Every consumed delta is visible on its own break line. An amount requires evidence to receive a classification other than `UNEXPLAINED`. Competing settlements remain ambiguous.
3. **T2** checks an eligible single transaction by signed net amount, then two transactions by complement lookup. It can remove entries from an inferred cohort and move unreferenced entries from overlapping date windows. Full subset-sum is NP-hard. Search stops at two adjustments or 512 eligible candidates per near miss by default. A capped allocation leaves the residual open.
4. **T3** classifies remaining differences under the closed taxonomy. A unique explicit reference can support fee drift under the configured fee model. Timing components record cutoff balances. Each signed difference contributes once, including any explicit unexplained residual.

The bridge invariant is platform net minus explained components equals bank cash minus the signed unexplained residual. With this convention a cash shortage contributes positively to an explained line, while a remaining cash shortage has a negative residual on the bank side of the equation.
