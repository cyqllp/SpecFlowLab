export const SIGNATURE_TYPES = Object.freeze(["ESA", "GSB", "SE", "GSB or SE"]);

export function mergeFeatureSignatures(dataset, monitor, entities = []) {
  const spectrumMode = monitor?.spectrumMode
    ?? ((monitor?.candidates ?? []).some((candidate) => candidate.id?.includes(":das:")) ? "DAS" : "EAS");
  const featureEntities = (entities ?? []).filter((entity) => (
    entity.kind === "feature"
    && entity.datasetId === dataset?.id
    && String(entity.mode ?? "EAS").toUpperCase() === spectrumMode
  ));
  const entityById = new Map(featureEntities.map((entity) => [entity.id, entity]));
  const automatic = (monitor?.candidates ?? []).flatMap((candidate) => {
    const override = entityById.get(candidate.id);
    entityById.delete(candidate.id);
    if (override?.signatureDeleted) return [];
    return [mergeAutomaticSignature(dataset, candidate, override)];
  });
  const manual = [...entityById.values()]
    .filter((entity) => entity.signatureSource === "manual" && !entity.signatureDeleted)
    .map(signatureFromEntity);
  return [...automatic, ...manual]
    .filter((signature) => Number.isFinite(signature.wavelengthCenter) && Number.isInteger(signature.componentIndex))
    .sort((left, right) => left.componentIndex - right.componentIndex || left.wavelengthCenter - right.wavelengthCenter);
}

export function createManualSignature(dataset, componentIndex, wavelengthCenter, signal, options = {}) {
  const mode = String(options.mode ?? "EAS").toUpperCase() === "DAS" ? "DAS" : "EAS";
  const sequence = Math.max(1, Number(options.sequence) || 1);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const idSuffix = String(options.idSuffix ?? createdAt).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const assignment = signal >= 0 ? "ESA" : "GSB or SE";
  const sign = signal >= 0 ? "positive" : "negative";
  return {
    id: `feature-signature:${dataset.id}:${mode.toLowerCase()}:c${String(componentIndex + 1).padStart(2, "0")}:${idSuffix}`,
    datasetId: dataset.id,
    featureCode: `S${componentIndex + 1}.${sequence}`,
    componentIndex,
    componentLabel: `${mode} ${componentIndex + 1}`,
    wavelengthCenter,
    peakWavelength: wavelengthCenter,
    wavelengthMin: wavelengthCenter,
    wavelengthMax: wavelengthCenter,
    sign,
    assignment,
    candidateType: `${assignment} signature`,
    note: "",
    mode,
    signatureSource: "manual",
    status: "user-defined",
  };
}

export function automaticSignatureType(candidate) {
  if (candidate.sign === "positive") return "ESA";
  if (candidate.candidateType === "GSB candidate") return "GSB";
  if (candidate.candidateType === "SE candidate") return "SE";
  return "GSB or SE";
}

function mergeAutomaticSignature(dataset, candidate, override) {
  const assignment = override?.assignment && override.assignment !== "unassigned"
    ? override.assignment
    : automaticSignatureType(candidate);
  const center = Number.isFinite(override?.wavelengthCenter) ? override.wavelengthCenter : candidate.wavelengthCenter;
  const componentIndex = Number.isInteger(override?.componentIndex) ? override.componentIndex : candidate.componentIndex;
  return {
    ...candidate,
    ...(override ?? {}),
    id: candidate.id,
    datasetId: override?.datasetId ?? candidate.datasetId ?? dataset?.id,
    mode: override?.mode ?? (candidate.id?.includes(":das:") ? "DAS" : "EAS"),
    componentIndex,
    wavelengthCenter: center,
    peakWavelength: center,
    assignment,
    note: override?.note ?? "",
    signatureSource: "automatic",
    status: override ? "user-edited" : "auto-generated",
  };
}

function signatureFromEntity(entity) {
  const center = Number(entity.wavelengthCenter);
  return {
    ...entity,
    wavelengthCenter: center,
    peakWavelength: center,
    wavelengthMin: Number.isFinite(entity.wavelengthMin) ? entity.wavelengthMin : center,
    wavelengthMax: Number.isFinite(entity.wavelengthMax) ? entity.wavelengthMax : center,
    assignment: entity.assignment === "unassigned" ? "GSB or SE" : entity.assignment,
    candidateType: entity.automaticType || `${entity.assignment ?? "Unassigned"} signature`,
    sign: entity.sign ?? (entity.assignment === "ESA" ? "positive" : "negative"),
    status: "user-defined",
  };
}
