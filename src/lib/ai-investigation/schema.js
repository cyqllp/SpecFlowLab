export const AI_INVESTIGATION_SCHEMA = "specflowlab.ai_investigation.v1";
export const AI_INVESTIGATION_SPEC_SCHEMA = "specflowlab.ai_investigation_spec.v1";

export const AI_EVIDENCE_PROFILES = Object.freeze(["brief", "diagnostic", "full"]);
export const AI_SCOPE_KINDS = Object.freeze([
  "active-dataset",
  "current-folder",
  "selected-datasets",
  "connected-evidence",
  "project",
]);

export const AI_PACKAGE_LIMITS = Object.freeze({
  markdownWarningCharacters: 100_000,
  packageWarningBytes: 25 * 1024 * 1024,
  packageConfirmationBytes: 100 * 1024 * 1024,
  maxDefaultSpectraPerDataset: 6,
  maxDefaultKineticsPerDataset: 6,
});

export function assertSafeAiPath(path) {
  const value = String(path ?? "").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`Unsafe AI investigation path: ${path || "empty"}.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe AI investigation path: ${path}.`);
  }
  return value;
}

export function validateAiInvestigationSpec(spec) {
  const errors = [];
  if (spec?.schema !== AI_INVESTIGATION_SPEC_SCHEMA) errors.push("The investigation specification schema is missing or unsupported.");
  if (!String(spec?.question ?? "").trim()) errors.push("Enter a scientific question before exporting.");
  if (!AI_SCOPE_KINDS.includes(spec?.scope?.kind)) errors.push("Choose a valid dataset scope.");
  if (!AI_EVIDENCE_PROFILES.includes(spec?.evidenceProfile)) errors.push("Choose Brief, Diagnostic, or Full evidence.");
  if (["selected-datasets", "connected-evidence"].includes(spec?.scope?.kind) && !(spec.scope.datasetIds?.length || spec.scope.focusEntityIds?.length)) {
    errors.push("Select at least one dataset for the selected-datasets scope.");
  }
  return errors;
}
