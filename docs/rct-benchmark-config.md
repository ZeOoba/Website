# RCT benchmark: runtime config

The broker scorecard's basis category compares an OM's implied $/SF against a replacement-cost floor built from
the ratified RCT table (LOW $/SF per market, a vintage-floor ramp, and the proxy-market flags). That table is
governor-level data, and this repository is public, so the table is **not in source**. Before 2026-11-13 it lived in
`netlify/functions/_shared/rct-benchmark.json`; those values remain in git history (no history rewrite was
approved).

## Where it lives

One Netlify environment variable, `RCT_BENCHMARK_JSON`, scoped to **Functions**. The authoritative table is
oxford-command-center `config/replacement-cost.v3.json` and the acquisition-underwriting skill; this variable is a
copy, and a re-ratified RCT version must be copied into it by hand.

`netlify/functions/_shared/rct-benchmark.js` reads and validates it on every scoring run. It then checks it
against `RATIFIED_RCT_HMAC`: an HMAC-SHA256 over the whole table in canonical form (version, markets in order,
proxies, ramp, hints). The HMAC key is a second Functions-scoped variable, `RCT_BENCHMARK_PIN_KEY` (a random
string of at least 32 characters).

The pin is keyed because this repo is public. A plain hash would let anyone confirm the values in git
history, and brute-force a future re-ratification by starting from them. Without the key the pin reveals
nothing. With it, any of these fails closed: a typo, a stale version, a pasted test value, a hand edit, or a
missing key.

## Shape

Minified JSON. `<...>` marks where a number goes; the real value is a JSON number, not a string. (The leak test
rejects any `marketToRctLowPerSF` literal with figures outside `tests/`, so this example has none.)

```text
{
  "rctVersion": "replacement-cost.vX.Y",
  "marketToRctLowPerSF": { "Market A": <LOW $/SF>, "Market B": <LOW $/SF> },
  "proxyMarkets": ["Market B"],
  "vintageFloor": { "earlyYear": <year>, "earlyPct": <0..1>, "lateYear": <year>, "latePct": <0..1> },
  "marketHints": { "Market A": "Market A, ST (geography hint for the extractor)" }
}
```

A complete synthetic example with invented figures is `tests/functions/fixtures/rct-benchmark.synthetic.json`.

- `marketToRctLowPerSF` (required): site market key → RCT LOW $/SF, each a number from 50 to 1,000. Key order
  is the extractor's `matchedRctMarket` enum order.
- `vintageFloor` (required): integer years from 1900 to 2100 with `earlyYear < lateYear`; percentages strictly
  between 0 and 1, with `earlyPct >= latePct`.
- `proxyMarkets` (optional): markets whose figure is a proxy, which is flagged in the internal note only.
- `marketHints` (optional): geography text that helps the model. A market with no hint is shown by its name.
- `rctVersion` (required): the RCT version the copy was taken from.

## Fail closed

The scoring run writes `{ status: 'unavailable', reason: 'benchmark_unavailable' }` when the variable:

- is missing or not JSON,
- fails the schema,
- is the synthetic fixture (`_synthetic: true` or `rctVersion: "synthetic-test-fixture"`),
- does not match the pinned HMAC,
- or `RCT_BENCHMARK_PIN_KEY` is missing or shorter than 32 characters.

It writes that result before it marks the item scored, downloads the OM or calls the model, so a submission
made while the variable was wrong can be re-scored once it is fixed. A `pipeline-failures` row with
`error-code: benchmark_unavailable` names the problem, without any figures. The broker sees the same "score
unavailable" as for any other scoring failure. The Gabriel/Eric intake email from `broker-finalize` is
unaffected. There is no partial score: without the table there is also no market list, so every OM would fail
the market gate and be capped.

## Tests and the leak test

- Tests use `tests/functions/fixtures/rct-benchmark.synthetic.json`, which has invented figures, through
  `tests/functions/fixtures/rct-test-env.js`. Only code can bypass the HMAC pin and the synthetic refusal
  (`pinnedHmac: null`, `allowSynthetic: true`), never the environment. Never paste real figures into the
  fixture, or anywhere else in the tree.
- `tests/functions/rct-public-leak.test.js` always runs two structural checks: the old file is gone, and no
  non-test source has a `marketToRctLowPerSF` literal with figures. Its value scan covers every tracked or
  untracked-not-ignored file and `dist/`. It looks for the LOW $/SF figures, the vintage ramp (all four values
  in one object), and two or more entry markets named together. The scan needs the real table locally, from
  `RCT_BENCHMARK_JSON` or the gitignored `/.rct-benchmark.local.json`:

  ```bash
  netlify env:get RCT_BENCHMARK_JSON > .rct-benchmark.local.json
  ```

  Without either, the scan skips and says why. CI currently has neither, so it runs only the structural checks.

## Changing a value

The table is a governor constant (ORA Hard Invariant 4): change it only with Gabriel's approval. A change needs
both:

1. the new value in the Netlify UI (Site configuration → Environment variables → `RCT_BENCHMARK_JSON`,
   Functions scope), and
2. a PR that updates `RATIFIED_RCT_HMAC`. Compute it from local copies of the table and the key
   (`netlify env:get RCT_BENCHMARK_PIN_KEY > .rct-benchmark-pin-key.local`; both files are gitignored):
   `node -e "console.log(require('./netlify/functions/_shared/rct-benchmark.js').rctTableHmac(require('./.rct-benchmark.local.json'), require('fs').readFileSync('.rct-benchmark-pin-key.local','utf8').trim()))"`.

Set the env value first, then merge the pin PR, so a single deploy picks up both. Until they match, every score
is withheld. Rotating the key means a new key in the env and a recomputed pin in the same way.
