# Energy Baseline: evidence validation

[![Tests](https://github.com/paulovillalobos/energy-baseline-public/actions/workflows/test.yml/badge.svg)](https://github.com/paulovillalobos/energy-baseline-public/actions/workflows/test.yml)

A runnable extraction of the deterministic validation layer from Energy Baseline. A model supplies a claim and verbatim quotes; code derives source offsets, validates the envelope and computes a semantic fingerprint. Candidates remain candidates until reviewed.

## Run it

Requires Node.js 22 or 24. No account, API key, database or model call.

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

The demo uses an explicitly synthetic tariff. It shows accepted exact evidence, rejected missing evidence and rejected model-supplied offsets. It does not call a language model or assert anything about energy regulation.

## Trust boundary

1. Validate the model payload against a closed JSON schema. Model-supplied offsets and pipeline identity are rejected.
2. Find each verbatim quote exactly once in the immutable source text. Zero matches or ambiguous matches produce errors.
3. Derive `[start, end)` offsets using JavaScript UTF-16 string indices.
4. Build a pipeline-owned candidate and validate schema, spans, date order, unit compatibility and null bytes.
5. Fingerprint semantic fields for idempotency. Confidence changes do not create a new claim; changed evidence does.

An exact match establishes provenance; it does not establish that the claim is true. The test suite deliberately shows that a wrong numeric interpretation can still pass provenance checks. This layer does not replace semantic review, source authentication or legal reasoning.

## Source and scope

`lib/validate_candidate.mjs`, the schema loader and three contracts were extracted from the private Energy Baseline implementation. This public edition adds a schema-first guard so malformed candidate envelopes return errors rather than throwing. The source schemas retain their original `$id` identifiers; Ajv resolves them locally, without fetching private URLs.

Included: validator, schemas, deterministic example, regression tests and CI. Excluded: ingestion jobs, database migrations, raw documents, model requests, credentials, private configuration and original Git history. There is no production endpoint in this repository.

## Tests

The suite covers missing and duplicate quotes, overlapping matches, Unicode offsets, malicious model fields, malformed envelopes, changed source spans, date ranges, value/unit mismatches, fingerprint stability and the limits of provenance. CI runs the same commands on Node 22 and 24.

No production reliability or dataset coverage is inferred from this isolated test suite. The envelope builder expects a schema-validated payload and already anchored spans; follow the example pipeline when integrating it.
