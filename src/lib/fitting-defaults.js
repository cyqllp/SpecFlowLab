export const DEFAULT_FITTING_INPUTS = Object.freeze({
  components: 3,
  irfFwhm: 0.25,
  preZeroModel: "smooth",
  coherentArtifactOrder: 1,
  weighting: "robust-noise",
  optimizerStarts: 3,
  maximumIterations: 55,
  rangeSensitivity: true,
});

export function restoreDefaultFittingInputs(fitting, activeDatasetId = null) {
  Object.assign(fitting, DEFAULT_FITTING_INPUTS, {
    editorDatasetId: activeDatasetId,
    lifetimeValues: Array.from({ length: DEFAULT_FITTING_INPUTS.components }, () => ""),
    fixedLifetimes: Array.from({ length: DEFAULT_FITTING_INPUTS.components }, () => false),
  });
  return fitting;
}
