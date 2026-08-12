export const AI_INVESTIGATION_GOALS = Object.freeze({
  "fit-quality": {
    label: "Diagnose fit quality",
    minimumDatasets: 1,
    requiresFit: true,
    scaffold: "Is the fitted model supported by the data, and where do structured residuals remain?",
  },
  compare: {
    label: "Compare samples or conditions",
    minimumDatasets: 2,
    scaffold: "What reproducible differences are present between these samples or conditions?",
  },
  preprocessing: {
    label: "Audit preprocessing",
    minimumDatasets: 1,
    scaffold: "Could preprocessing choices create or obscure the observed features?",
  },
  "kinetic-model": {
    label: "Evaluate kinetic models",
    minimumDatasets: 1,
    requiresFit: true,
    scaffold: "Which kinetic-model alternatives remain consistent with the available evidence?",
  },
  "spectral-interpretation": {
    label: "Interpret spectral features",
    minimumDatasets: 1,
    scaffold: "Which spectral features are directly supported, and which assignments require external evidence?",
  },
  "merge-consistency": {
    label: "Check VIS/NIR merge consistency",
    minimumDatasets: 1,
    requiresMergeContext: true,
    scaffold: "Does the merged result preserve consistent VIS/NIR evidence without one segment dominating?",
  },
  "species-assignment": {
    label: "Evaluate a species or state assignment",
    minimumDatasets: 1,
    requiresSpeciesHypothesis: true,
    scaffold: "Which observations support or challenge the proposed species/state assignment, and which alternatives remain?",
  },
  "multimodal-consistency": {
    label: "Compare connected multimodal evidence",
    minimumDatasets: 2,
    requiresMultipleTechniques: true,
    scaffold: "Where do the explicitly connected measurements agree, conflict, or remain incomparable?",
  },
  "experiment-planning": {
    label: "Suggest discriminating experiments",
    minimumDatasets: 1,
    scaffold: "Which feasible experiments would best distinguish the leading explanations?",
  },
  custom: {
    label: "Custom investigation",
    minimumDatasets: 1,
    scaffold: "",
  },
});

export function validateAiGoal(goalId, datasets, project = {}) {
  const goal = AI_INVESTIGATION_GOALS[goalId];
  if (!goal) return [`Unknown investigation goal: ${goalId || "missing"}.`];
  const errors = [];
  if (datasets.length < goal.minimumDatasets) {
    errors.push(`${goal.label} requires at least ${goal.minimumDatasets} dataset${goal.minimumDatasets === 1 ? "" : "s"}.`);
  }
  if (goal.requiresFit && !datasets.some((dataset) => dataset.fit)) {
    errors.push(`${goal.label} requires at least one fitted dataset.`);
  }
  if (goal.requiresMergeContext && !hasMergeContext(datasets)) {
    errors.push(`${goal.label} requires a merged dataset or at least two possible parent datasets.`);
  }
  if (goal.requiresSpeciesHypothesis && !hasSpeciesHypothesis(datasets, project.evidenceGraph)) {
    errors.push(`${goal.label} requires at least one recorded species/state hypothesis.`);
  }
  if (goal.requiresMultipleTechniques && new Set(datasets.map((dataset) => dataset.evidenceMetadata?.technique?.id).filter(Boolean)).size < 2) {
    errors.push(`${goal.label} requires at least two connected techniques.`);
  }
  return errors;
}

function hasSpeciesHypothesis(datasets, graph) {
  if ((graph?.entities ?? []).some((entity) => entity.kind === "species-hypothesis")) return true;
  return datasets.some((dataset) => dataset.evidenceMetadata?.speciesStateIds?.length);
}

function hasMergeContext(datasets) {
  return datasets.some((dataset) => dataset.kind === "merged" || dataset.merge) || datasets.length >= 2;
}
