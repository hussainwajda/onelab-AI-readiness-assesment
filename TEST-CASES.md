# Test cases — how I verified the reconciliation works

The generator plants six known breaks and writes them to `data/ground_truth.json`.
The engine never reads that file — it rediscovers the breaks from the two CSVs alone.
That separation is what makes the tests meaningful, and it is itself checked below.

## 1. Automated suite — `npm test` (15/15 passing)

Run with Node's built-in test runner, no framework:

- the generator is byte-identical to itself and the checked-in exports
- all generated breaks exactly match the answer key and a second run is identical
- integer money parsing preserves signed and large values and rejects extra precision
- IST month-end preserves October 31 at 23:59:59 and converts UTC October to IST November
- the T+2 business-day window spans a holiday and weekend
- an all-refund cohort matches a negative bank debit
- empty exports have a zero bridge and an empty cohort cannot claim a bank entry
- one paise of low-volume tolerance is disclosed and a larger delta never goes to T1
- the high-volume tolerance cap applies and can be configured
- two bank entries inside tolerance are ambiguous even when one is exact
- a bank credit cannot claim either of two competing cohorts
- T2 finds one removal and then pairs, preserving removed amounts as open
- T2 can move an unreferenced transaction only inside its own date window
- T2 stops at two adjustments and keeps alternative subsets open
- a bank re-export is signed on the bank side and contradictory duplicates fail loudly

## 2. Each planted gap type, and the check that proves it was found

| Gap type required by the brief | Planted as | Verified by |
|---|---|---|
| Settled the following month | Oct 31 batch paid Nov 2 | Classified `TIMING_NEXT_PERIOD`, +Rs 43,365.00, tier T0 |
| Rounding difference visible only when summed | 520 fees rounded half-up per transaction vs once on the batch total | Classified `ROUNDING_ACCUMULATION`, -Rs 2.60; invisible on any single row |
| Duplicate entry in one dataset | `TXN-000221` exported twice | Classified `DUPLICATE_PLATFORM`, +Rs 1,300.46 |
| Refund with no matching original | refund whose `original_txn_id` is absent | Classified `ORPHAN_REFUND`, -Rs 1,225.00 |
| (extra) Bank credit with no platform rows | `BNK-0036` | Classified `BANK_ONLY_CREDIT`, -Rs 415.07 |
| (extra) Bank deducted a higher fee | `BNK-0019` | Classified `FEE_DRIFT`, +Rs 250.00 |

The six signed components sum to Rs 43,272.79, which is exactly the
platform-to-bank difference, leaving an unexplained residual of Rs 0.00.

## 3. Independent recomputation (not using the engine's own code)

Totals recomputed directly from the CSVs with a separate script:

- October platform net: 173,204,009 paise
- October bank cash: 168,876,730 paise
- Difference: 4,327,279 paise

These match the figures the UI reports, so the bridge is not reporting its own arithmetic back to itself.

## 4. Negative tests — deliberately corrupting the data

The risk with any reconciliation tool is a residual that is a balancing figure rather
than a real measurement. These checks prove it is measured:

| Corruption | Expected | Actual |
|---|---|---|
| Inflate one `net_minor` only | Rejected as internally inconsistent | Throws: "Gross minus fee must equal net" |
| Delete bank row `BNK-0008` | Residual becomes materially non-zero | Residual -Rs 40,871.88, new `UNEXPLAINED` line |
| Remove **1 paise** from a bank credit | Surfaced, not absorbed by tolerance | Residual -Rs 0.01, flagged `UNEXPLAINED` |
| Inflate gross and net together (valid row) | Named against the specific batch | Residual -Rs 500.00, `UNEXPLAINED` citing `BATCH-20261015-INR` / `BNK-0015` |

The one-paise case matters most: a tolerance that silently swallowed it would hide real cash differences at scale.

## 5. Structural checks

- `grep -rn "ground_truth" src app scripts` returns only the line in `scripts/generate.ts` that *writes* the file. The engine never reads it.
- `grep -rnE 'parseFloat|toFixed|Number\(|Math\.round' src app scripts` returns nothing. All money is `bigint` in integer paise.
- `npm run generate` twice produces byte-identical `transactions.csv`, `settlements.csv` and `ground_truth.json`.
- `npm run build` completes cleanly as a production build.

## 6. How to re-run any of this

```
npm test                 # the 15 automated tests
npm run generate         # regenerate fixtures; files must not change
npm run dev              # the UI at localhost:3000
```

Manual one-paise check:

```
sed -i '' 's/BNK-0008,2026-10-12,4087188/BNK-0008,2026-10-12,4087187/' data/settlements.csv
# reload the page: residual becomes -Rs 0.01 with an UNEXPLAINED row
sed -i '' 's/BNK-0008,2026-10-12,4087187/BNK-0008,2026-10-12,4087188/' data/settlements.csv
```
