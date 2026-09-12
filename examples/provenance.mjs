import { anchorQuotes, buildCandidateEnvelope, validateModelPayloadObject, validateCandidateFull } from "../lib/validate_candidate.mjs";

// Synthetic source text. This is not a legal claim or a production extraction.
export const source = "The demonstration tariff is 87.50 EUR/MWh. Review is required before acceptance.";
export const payload = {
  subject: "Demonstration tariff", predicate: "has_price", value: 87.5,
  value_raw: "87.50", unit_raw: "EUR/MWh",
  evidence_quotes: ["The demonstration tariff is 87.50 EUR/MWh."]
};
export function makeCandidate(input = payload, rawText = source) {
  const shape = validateModelPayloadObject(input);
  if (!shape.valid) return { valid: false, errors: shape.errors };
  const evidence = anchorQuotes(input.evidence_quotes, rawText);
  if (evidence.errors.length) return { valid: false, errors: evidence.errors };
  const candidate = buildCandidateEnvelope(input, {
    documentId: 1, modelName: "synthetic-fixture", modelVersion: "1",
    promptTemplateSha256: "a".repeat(64), requestSha256: "b".repeat(64),
    extractedAt: "2026-09-12T12:00:00.000Z", candidateId: "00000000-0000-4000-8000-000000000001",
    sourceSpans: evidence.spans
  });
  return { ...validateCandidateFull(candidate, rawText), candidate };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  for (const [label, input] of [
    ["Exact evidence", payload],
    ["Missing evidence", { ...payload, evidence_quotes: ["The price is 50 EUR/MWh."] }],
    ["Model-supplied offsets", { ...payload, source_spans: [{ start: 0, end: 10, text: "invented" }] }]
  ]) console.log(label, JSON.stringify(makeCandidate(input), null, 2));
}
