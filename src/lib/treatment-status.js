// Requested folder settings and successfully materialized treatments are distinct.
export function treatmentStatus(analysis, label) {
  const history = analysis?.provenance ?? [];
  const lastIndex = history.findLastIndex(item => item.label === label);
  if (history.slice(lastIndex + 1).some(item => item.label === `${label} review` && item.status === "review-required")) return "review-required";
  if (lastIndex >= 0) return history[lastIndex].status ?? "not-recorded";
  if (label === "Chirp" && analysis?.chirp) {
    if (analysis.chirp.model?.accepted === false) return "skipped";
    if (analysis.chirp.curve?.length) return "applied"; // Legacy archives.
  }
  return "not-recorded";
}

export function analysisNeedsReview(analysis) {
  return ["Chirp", "Baseline"].some(label => ["skipped", "review-required"].includes(treatmentStatus(analysis, label)));
}

export function treatmentIssue(analysis, label) {
  const status = treatmentStatus(analysis, label);
  if (!["skipped", "review-required"].includes(status)) return null;
  return analysis?.provenance?.findLast(item => [label, `${label} review`].includes(item.label) && ["skipped", "review-required"].includes(item.status))
    ?? { label, status, reason: analysis?.chirp?.model?.reason };
}

export function isAnalysisTreated(analysis) {
  return !analysisNeedsReview(analysis) && (analysis?.provenance ?? []).some(item => item.status === "applied");
}
