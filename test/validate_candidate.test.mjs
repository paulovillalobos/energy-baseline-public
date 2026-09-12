import test from "node:test";
import assert from "node:assert/strict";
import { anchorQuotes, countOccurrences, computeCandidateSha256, canonicalJson, validateModelResponseShape, validateModelPayloadObject, validateCandidateFull, normalizeUnit } from "../lib/validate_candidate.mjs";
import { makeCandidate, payload, source } from "../examples/provenance.mjs";

test("unique evidence derives offsets from the source", () => {
  const raw = "Intro. The tariff is 87.50 EUR/MWh. End.";
  const result = anchorQuotes(["The tariff is 87.50 EUR/MWh."], raw);
  assert.deepEqual(result.errors, []);
  for (const span of result.spans) assert.equal(raw.slice(span.start, span.end), span.text);
  assert.equal(result.spans[0].start, 7);
});
test("missing and ambiguous quotes fail closed", () => {
  assert.match(anchorQuotes(["other"], "text").errors[0], /quote_not_found/);
  assert.match(anchorQuotes(["same"], "same then same").errors[0], /ambiguous_quote/);
  assert.equal(countOccurrences("aaaa", "aaa"), 2);
});
test("empty evidence cannot be accepted", () => {
  for (const input of [[], null, [""], [3]]) assert.ok(anchorQuotes(input, source).errors.length);
});
test("offsets use JavaScript UTF-16 indices even after emoji", () => {
  const raw = "⚡🙂 café rate";
  const {spans} = anchorQuotes(["café"], raw);
  assert.equal(spans[0].start, 4);
  assert.equal(raw.slice(spans[0].start, spans[0].end), "café");
});
test("model cannot provide trusted offsets or pipeline identity", () => {
  for (const [key, value] of [["source_spans", []], ["candidate_id", "chosen-by-model"], ["candidate_sha256", "a".repeat(64)]]) {
    assert.equal(validateModelPayloadObject({...payload, [key]: value}).valid, false);
  }
});
test("top-level response contract rejects arrays, extras and scalar candidates", () => {
  for (const input of [[], null, {}, {candidates: [3]}, {candidates: [], approved: true}]) assert.ok(validateModelResponseShape(input).length);
  assert.deepEqual(validateModelResponseShape({candidates: []}), []);
});
test("complete synthetic candidate passes every deterministic check", () => {
  const result = makeCandidate();
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.checks.length, 5);
});
test("mutating evidence after anchoring invalidates the candidate", () => {
  const {candidate} = makeCandidate();
  candidate.source_spans[0].text = "The price is different.";
  assert.equal(validateCandidateFull(candidate, source).valid, false);
});
test("out-of-bounds and overlapping spans are rejected", () => {
  const {candidate} = makeCandidate();
  candidate.source_spans[0].end = source.length + 10;
  assert.equal(validateCandidateFull(candidate, source).valid, false);
  const overlap = makeCandidate().candidate;
  overlap.source_spans.push({...overlap.source_spans[0]});
  assert.equal(validateCandidateFull(overlap, source).valid, false);
});
test("malformed envelopes return validation errors rather than throwing", () => {
  for (const input of [null, [], {}, {source_spans: [null]}, {...makeCandidate().candidate, source_spans: [null]}]) {
    const result = validateCandidateFull(input, source);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length);
  }
});
test("invalid date ranges and incompatible units fail", () => {
  const {candidate} = makeCandidate();
  assert.equal(validateCandidateFull({...candidate, valid_from:"2026-09-12", valid_to:"2026-09-01"}, source).valid, false);
  assert.equal(validateCandidateFull({...candidate, unit_canonical:"text"}, source).valid, false);
  assert.equal(normalizeUnit(" €/MWh "), "EUR/MWh");
  assert.equal(normalizeUnit("guessed unit"), null);
});
test("semantic fingerprint ignores confidence but changes with evidence or value", () => {
  const {candidate} = makeCandidate();
  const original = computeCandidateSha256(candidate);
  assert.equal(computeCandidateSha256({...candidate, confidence:0.1}), original);
  assert.notEqual(computeCandidateSha256({...candidate, value:88}), original);
  assert.notEqual(computeCandidateSha256({...candidate, source_spans:[{start:1,end:2,text:"x"}]}), original);
  assert.equal(canonicalJson({b:[2,1], a:{y:2,x:1}}), canonicalJson({a:{x:1,y:2},b:[2,1]}));
});
test("provenance alone does not verify the meaning of a claim", () => {
  const result = makeCandidate({...payload, value:999});
  assert.equal(result.valid, true);
  // This deliberate limit needs semantic/human review, not a stronger marketing claim.
});
