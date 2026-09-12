// lib/validate_candidate.mjs
// Importable pure validation functions for the extraction-candidate workflow.
// This is the SINGLE SOURCE OF TRUTH for validation logic.
// The public demo and regression tests import this module directly.
// No database access, no API calls — pure deterministic functions.

import { createHash } from "node:crypto";

import { validateModelPayload, validateCandidate, formatAjvErrors } from "./schemas.mjs";

// --- Canonical JSON serialization -------------------------------------------------
// Deterministic: object keys are sorted recursively; arrays preserve order.
// Two semantically identical values always serialize to the same string,
// regardless of key insertion order. Used for the idempotency fingerprint.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

// --- Semantic idempotency fingerprint ----------------------------------------------
// candidate_sha256 = sha256(document_id + "\n" + request_sha256 + "\n" +
//                            canonicalJson(semantic fields)).
// Pipeline-generated ONLY — the model can never supply it (the response schema
// rejects unknown fields). confidence is deliberately EXCLUDED: it is a model
// self-assessment, and the same claim at a different confidence is the same
// claim. Changed value, unit, dates, definition, geography, or source spans
// produce a different fingerprint.
export function computeCandidateSha256(candidate) {
  const semantic = {
    subject: candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    value_raw: candidate.value_raw,
    unit_raw: candidate.unit_raw,
    unit_canonical: candidate.unit_canonical,
    definition: candidate.definition,
    geography: candidate.geography,
    valid_from: candidate.valid_from,
    valid_to: candidate.valid_to,
    source_spans: candidate.source_spans,
  };
  const input =
    String(candidate.document_id) + "\n" +
    candidate.request_sha256 + "\n" +
    canonicalJson(semantic);
  return createHash("sha256").update(input).digest("hex");
}

// --- Deterministic quote anchoring ---------------------------------------------------
// The model provides UNTRUSTED exact verbatim quotes (evidence_quotes). This
// function derives the TRUSTED source_spans from them: exact string search in
// rawText (JS string indices, the same coordinate system used by
// validateSourceSpans and Array.prototype.slice). No fuzzy matching, no
// normalization, no paraphrase tolerance — a quote either occurs exactly once
// or the candidate's evidence is rejected.
//
// Returns { spans: [{start, end, text}], errors: [string] }.
//   - quote occurs exactly once  → span derived and included
//   - quote occurs zero times    → error "quote_not_found: ..."
//   - quote occurs more than once → error "ambiguous_quote: ..." (the current
//     contract carries no disambiguating context, so ambiguity is a rejection)
export function countOccurrences(rawText, quote) {
  if (typeof rawText !== "string" || typeof quote !== "string" || quote.length === 0) return 0;
  let count = 0;
  let idx = rawText.indexOf(quote);
  while (idx !== -1) {
    count++;
    if (count > 1) return count; // 2+ is enough to know it is ambiguous
    idx = rawText.indexOf(quote, idx + 1);
  }
  return count;
}

export function anchorQuotes(quotes, rawText) {
  const spans = [];
  const errors = [];
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return { spans, errors: ["evidence_quotes must be a non-empty array"] };
  }
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    if (typeof q !== "string" || q.length === 0) {
      errors.push(`evidence_quotes[${i}] must be a non-empty string`);
      continue;
    }
    const n = countOccurrences(rawText, q);
    if (n === 0) {
      errors.push(`quote_not_found: evidence_quotes[${i}] ${JSON.stringify(q.slice(0, 60))}`);
    } else if (n > 1) {
      errors.push(`ambiguous_quote: evidence_quotes[${i}] occurs ${n}+ times ${JSON.stringify(q.slice(0, 60))}`);
    } else {
      const start = rawText.indexOf(q);
      spans.push({ start, end: start + q.length, text: q });
    }
  }
  return { spans, errors };
}

// --- Model response shape validation ------------------------------------------------
// The ONE model response contract: a JSON object whose only key is
// "candidates", an array of candidate objects. {"candidates": []} means the
// document contains no extractable claims. A bare object or a top-level array
// is NOT silently converted — it is rejected.
export function validateModelResponseShape(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ['model response must be a JSON object of the form {"candidates": [...]}'];
  }
  const errors = [];
  for (const k of Object.keys(parsed)) {
    if (k !== "candidates") errors.push(`unknown top-level field "${k}"`);
  }
  if (!("candidates" in parsed)) {
    errors.push('missing required top-level field "candidates"');
  } else if (!Array.isArray(parsed.candidates)) {
    errors.push('"candidates" must be an array');
  } else {
    parsed.candidates.forEach((c, i) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        errors.push(`candidates[${i}] must be an object`);
      }
    });
  }
  return errors;
}

// --- Unit normalization ---------------------------------------------------------
// Maps raw unit strings from documents to canonical units.
// This is deterministic and does NOT use world knowledge — it only maps
// explicit textual variants to canonical forms.
const UNIT_NORMALIZATION = {
  "EUR/MWh": "EUR/MWh",
  "€/MWh": "EUR/MWh",
  "eur/mwh": "EUR/MWh",
  "EUR": "EUR",
  "€": "EUR",
  "euros": "EUR",
  "MWh": "MWh",
  "mwh": "MWh",
  "GWh": "GWh",
  "gwh": "GWh",
  "TWh": "TWh",
  "twh": "TWh",
  "MW": "MW",
  "mw": "MW",
  "GW": "GW",
  "gw": "GW",
  "MW/h": "MW/h",
  "GW/h": "GW/h",
  "percent": "percent",
  "%": "percent",
  "percentage": "percent",
  "date": "date",
  "text": "text",
  "gCO2/kWh": "gCO2/kWh",
  "kgCO2/MWh": "kgCO2/MWh",
  "kV": "kV",
  "MWp": "MWp",
  "bcm": "bcm",
  "MtCO2": "MtCO2",
  "pp": "pp",
  "percentage points": "pp",
};

export function normalizeUnit(rawUnit) {
  if (rawUnit === null || rawUnit === undefined) return null;
  const trimmed = String(rawUnit).trim();
  if (trimmed === "") return null;
  return UNIT_NORMALIZATION[trimmed] || null;
}

// --- Value/unit compatibility check ---------------------------------------------
// Determines whether a value and unit combination is semantically coherent.
// Returns an array of error strings (empty if compatible).
export function checkValueUnitCompatibility(value, unitCanonical) {
  const errors = [];

  if (value === null || value === undefined) {
    // Null value with a unit is suspicious but not necessarily wrong.
    // The document might say "the price was not disclosed" with a unit context.
    return errors;
  }

  const valueType = typeof value;

  if (valueType === "number") {
    if (unitCanonical === null) {
      errors.push("numeric value has no unit");
    } else if (unitCanonical === "text" || unitCanonical === "date") {
      errors.push(`numeric value incompatible with unit "${unitCanonical}"`);
    }
  } else if (valueType === "boolean") {
    if (unitCanonical !== null && unitCanonical !== "text") {
      errors.push(`boolean value incompatible with unit "${unitCanonical}"`);
    }
  } else if (valueType === "string") {
    // String values can be dates, text, or numbers-as-strings.
    // We don't over-constrain here — the model may return "87.50" as a string.
    if (unitCanonical === "date") {
      if (isNaN(Date.parse(value))) {
        errors.push(`string value "${value}" is not a valid date`);
      }
    }
  }

  return errors;
}

// --- Source span validation ------------------------------------------------------
// Validates that source spans are structurally sound and match the document text.
// Returns an array of error strings (empty if valid).
export function validateSourceSpans(spans, rawText) {
  const errors = [];

  if (!Array.isArray(spans) || spans.length === 0) {
    return ["source_spans must be a non-empty array"];
  }

  // Check each span
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];

    if (typeof span.start !== "number" || !Number.isInteger(span.start)) {
      errors.push(`span[${i}].start must be an integer`);
      continue;
    }
    if (typeof span.end !== "number" || !Number.isInteger(span.end)) {
      errors.push(`span[${i}].end must be an integer`);
      continue;
    }
    if (span.start < 0) {
      errors.push(`span[${i}].start must be >= 0`);
    }
    if (span.end <= span.start) {
      errors.push(`span[${i}].end must be > start`);
    }
    if (typeof span.text !== "string" || span.text.length === 0) {
      errors.push(`span[${i}].text must be a non-empty string`);
    }

    // Check bounds against document
    if (rawText !== undefined && rawText !== null) {
      if (span.end > rawText.length) {
        errors.push(`span[${i}] [${span.start}, ${span.end}) exceeds document length ${rawText.length}`);
      }
      // Check text matches
      if (span.start >= 0 && span.end <= rawText.length) {
        const actualText = rawText.slice(span.start, span.end);
        if (actualText !== span.text) {
          errors.push(`span[${i}] text mismatch: expected "${actualText.slice(0, 50)}..." got "${span.text.slice(0, 50)}..."`);
        }
      }
    }

    // Reject null bytes
    if (span.text && span.text.includes("\u0000")) {
      errors.push(`span[${i}].text contains null byte`);
    }
  }

  // Check spans are sorted and non-overlapping
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      errors.push(`spans overlap: span[${i}] starts at ${sorted[i].start} but previous ends at ${sorted[i - 1].end}`);
    }
  }

  return errors;
}

// --- Date validation --------------------------------------------------------------
export function validateDates(validFrom, validTo) {
  const errors = [];

  if (validFrom !== null && validFrom !== undefined) {
    if (typeof validFrom !== "string" || isNaN(Date.parse(validFrom))) {
      errors.push(`valid_from is not a valid date: ${validFrom}`);
    }
  }
  if (validTo !== null && validTo !== undefined) {
    if (typeof validTo !== "string" || isNaN(Date.parse(validTo))) {
      errors.push(`valid_to is not a valid date: ${validTo}`);
    }
  }
  if (validFrom && validTo && !isNaN(Date.parse(validFrom)) && !isNaN(Date.parse(validTo))) {
    if (new Date(validTo) < new Date(validFrom)) {
      errors.push(`valid_to (${validTo}) is before valid_from (${validFrom})`);
    }
  }

  return errors;
}

// --- Model payload validation ------------------------------------------------------
// Validates a model-extraction-payload against the model schema.
// Returns { valid: boolean, errors: string[] }
export function validateModelPayloadObject(payload) {
  const valid = validateModelPayload(payload);
  if (valid) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: formatAjvErrors(validateModelPayload.errors) };
}

// --- Candidate envelope validation --------------------------------------------------
// Validates a full extraction-candidate envelope against the candidate schema.
// Returns { valid: boolean, errors: string[] }
export function validateCandidateObject(candidate) {
  const valid = validateCandidate(candidate);
  if (valid) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: formatAjvErrors(validateCandidate.errors) };
}

// --- Full candidate validation (schema + spans + dates + value/unit) ----------------
// Runs all deterministic checks on a candidate envelope.
// Returns { valid: boolean, errors: string[], checks: [{name, passed, detail}] }
export function validateCandidateFull(candidate, rawText) {
  const checks = [];

  // 1. JSON Schema validation
  const schemaResult = validateCandidateObject(candidate);
  checks.push({
    name: "json_schema",
    passed: schemaResult.valid,
    detail: schemaResult.valid ? "ok" : schemaResult.errors.join("; "),
  });

  // Malformed envelopes stop at the schema boundary; do not dereference them.
  if (!schemaResult.valid) {
    return { valid: false, errors: [`json_schema: ${checks[0].detail}`], checks };
  }

  // 2. Source span validation
  const spanErrors = validateSourceSpans(candidate.source_spans, rawText);
  checks.push({
    name: "source_spans",
    passed: spanErrors.length === 0,
    detail: spanErrors.length === 0 ? "ok" : spanErrors.join("; "),
  });

  // 3. Date validation
  const dateErrors = validateDates(candidate.valid_from, candidate.valid_to);
  checks.push({
    name: "dates",
    passed: dateErrors.length === 0,
    detail: dateErrors.length === 0 ? "ok" : dateErrors.join("; "),
  });

  // 4. Value/unit compatibility
  const unitErrors = checkValueUnitCompatibility(candidate.value, candidate.unit_canonical);
  checks.push({
    name: "value_unit",
    passed: unitErrors.length === 0,
    detail: unitErrors.length === 0 ? "ok" : unitErrors.join("; "),
  });

  // 5. Null byte check on all string fields
  const nullByteFields = [];
  for (const field of ["subject", "predicate", "definition", "geography"]) {
    if (typeof candidate[field] === "string" && candidate[field].includes("\u0000")) {
      nullByteFields.push(field);
    }
  }
  checks.push({
    name: "null_bytes",
    passed: nullByteFields.length === 0,
    detail: nullByteFields.length === 0 ? "ok" : `null bytes in: ${nullByteFields.join(", ")}`,
  });

  const allPassed = checks.every((c) => c.passed);
  const allErrors = checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);

  return { valid: allPassed, errors: allErrors, checks };
}

// --- Pipeline envelope construction ---------------------------------------------------
// Wraps a validated model payload into a full candidate envelope.
// The pipeline generates: candidate_id, candidate_sha256, document_id,
// model_name, model_version, prompt_template_sha256, request_sha256,
// extracted_at, AND source_spans (derived via anchorQuotes from the model's
// untrusted evidence_quotes — model-supplied offsets can never reach here:
// the payload schema rejects a source_spans field outright).
export function buildCandidateEnvelope(payload, {
  documentId,
  modelName,
  modelVersion,
  promptTemplateSha256,
  requestSha256,
  extractedAt,
  candidateId,
  sourceSpans,
}) {
  const candidate = {
    candidate_id: candidateId,
    document_id: documentId,
    subject: payload.subject,
    predicate: payload.predicate,
    value: payload.value !== undefined ? payload.value : null,
    value_raw: payload.value_raw ?? null,
    unit_raw: payload.unit_raw ?? null,
    unit_canonical: payload.unit_canonical ?? normalizeUnit(payload.unit_raw),
    definition: payload.definition ?? null,
    geography: payload.geography ?? null,
    valid_from: payload.valid_from ?? null,
    valid_to: payload.valid_to ?? null,
    source_spans: sourceSpans || [],
    confidence: payload.confidence ?? 0.5,
    model_name: modelName,
    model_version: modelVersion,
    prompt_template_sha256: promptTemplateSha256,
    request_sha256: requestSha256,
    extracted_at: extractedAt,
  };
  // Deterministic semantic fingerprint — computed from the normalized envelope,
  // never supplied by the model. See computeCandidateSha256 for the definition.
  candidate.candidate_sha256 = computeCandidateSha256(candidate);
  return candidate;
}
