// lib/schemas.mjs
// Loads and compiles JSON Schemas using Ajv (Draft 2020-12).
// Both the model payload schema and the full candidate envelope schema
// are compiled once and reused across the pipeline.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";


const root = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(root, "..", "contracts");

// --- Load schema files --------------------------------------------------------
const modelPayloadSchema = JSON.parse(
  readFileSync(join(contractsDir, "model-extraction-payload.schema.json"), "utf8")
);
const candidateSchema = JSON.parse(
  readFileSync(join(contractsDir, "extraction-candidate.schema.json"), "utf8")
);
const modelResponseSchema = JSON.parse(
  readFileSync(join(contractsDir, "model-response.schema.json"), "utf8")
);

// --- Compile with Ajv ----------------------------------------------------------
const ajv = new Ajv2020({ allErrors: true, strict: false });

addFormats(ajv);

// Compiling registers each schema under its $id; the payload schema must be
// compiled BEFORE the response schema so the $ref in the latter resolves.
const validateModelPayload = ajv.compile(modelPayloadSchema);
const validateCandidate = ajv.compile(candidateSchema);
const validateModelResponse = ajv.compile(modelResponseSchema);

// --- Export compiled validators and raw schemas --------------------------------
export {
  modelPayloadSchema,
  candidateSchema,
  modelResponseSchema,
  validateModelPayload,
  validateCandidate,
  validateModelResponse,
};

// --- Helper: format Ajv errors into readable strings ---------------------------
export function formatAjvErrors(errors) {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => {
    const path = e.instancePath || "/";
    return `${path}: ${e.message}`;
  });
}
