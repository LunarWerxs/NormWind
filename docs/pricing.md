# Pricing - NormWind

NormWind is free and open source. There is no paid tier, no usage limits, and no account
required.

## Free (the only tier)

- Price: $0
- License: MIT, https://github.com/LunarWerxs/NormWind/blob/main/LICENSE
- Requires: Node.js 20+
- Limits: none imposed by NormWind itself. The GitHub Action caps a single run at 1,000
  unique cache misses through the live canonicalizer, a safety bound against
  out-of-memory crashes on huge or untrusted diffs, not a pricing limit.
- Features included: the full CLI (audit, `--fix`, `--fixall`, `--dry-run`, `--json`,
  `--reporter sarif`), the first-party GitHub Action with inline PR annotations, and CI
  enforcement via exit codes. Nothing is held back for a paid version, because there isn't
  one.

## Costs the user actually bears

NormWind does not call any third-party API and has no bring-your-own-API-key requirement.
The only real-world costs are ones a user would already have regardless of NormWind:

- GitHub Actions compute minutes, if run in CI: billed by GitHub under your existing plan,
  not by NormWind or LunarWerx.
- Ordinary npm/network bandwidth to install the package (a one-time `npm install` or
  per-run `npx` fetch).

## Not affiliated

NormWind is not affiliated with, endorsed by, or sponsored by Tailwind Labs.

## Machine-readable summary

```
product: NormWind
vendor: LunarWerx Studios
price: 0
currency: USD
billing_model: free-forever, open-source
license: MIT
byo_api_key_required: false
byo_api_key_costs: none
paid_tier: none
homepage: https://normwind.lunarwerx.com/
source: https://github.com/LunarWerxs/NormWind
package: https://www.npmjs.com/package/@lunawerx/normwind
last_updated: 2026-08-23
```
