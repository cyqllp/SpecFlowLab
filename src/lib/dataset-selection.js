/**
 * Shared selection model for Compare and Merge dataset pickers.
 * No DOM or main.js imports.
 */

export const SELECTION_MODES = Object.freeze({
  compare: {
    minCount: 2,
    maxCount: Infinity,
    eligibility: "all",
    supportsSelectAll: true,
  },
  merge: {
    minCount: 2,
    maxCount: 2,
    eligibility: "treated",
    supportsSelectAll: false,
  },
});

const VALID_MODES = new Set(Object.keys(SELECTION_MODES));

function requireMode(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown selection mode: ${mode}. Valid modes: ${[...VALID_MODES].join(", ")}`);
  }
  return SELECTION_MODES[mode];
}

/**
 * Returns whether a dataset is eligible for the given selection mode.
 * @param {{ analysis?: { provenance?: Array } }} dataset
 * @param {"compare"|"merge"} mode
 * @returns {boolean}
 */
export function isEligibleForMode(dataset, mode) {
  const config = requireMode(mode);
  if (config.eligibility === "all") return true;
  if (config.eligibility === "treated") {
    return Boolean(dataset?.analysis?.provenance?.length);
  }
  return false;
}

/**
 * Toggles a dataset ID in the selection, respecting mode limits.
 * @param {string[]} selectedIds — current selection
 * @param {string} datasetId — dataset to toggle
 * @param {"compare"|"merge"} mode
 * @returns {string[]} new selection array
 */
export function toggleSelection(selectedIds, datasetId, mode) {
  const config = requireMode(mode);
  const alreadySelected = selectedIds.includes(datasetId);

  if (alreadySelected) {
    return selectedIds.filter((id) => id !== datasetId);
  }

  // At max count: block (prefer blocking over silent replacement)
  if (selectedIds.length >= config.maxCount) {
    return selectedIds;
  }

  return [...selectedIds, datasetId];
}

/**
 * Validates whether a selection meets the mode's requirements.
 * @param {string[]} selectedIds
 * @param {"compare"|"merge"} mode
 * @returns {{ valid: boolean, reason: string }}
 */
export function validateSelection(selectedIds, mode) {
  const config = requireMode(mode);
  const count = selectedIds.length;

  if (count < config.minCount) {
    const exactly = config.minCount === config.maxCount;
    return {
      valid: false,
      reason: exactly
        ? `Select exactly ${config.minCount} dataset${config.minCount > 1 ? "s" : ""}.`
        : `Select at least ${config.minCount} dataset${config.minCount > 1 ? "s" : ""}.`,
    };
  }

  if (count > config.maxCount) {
    return {
      valid: false,
      reason: `Select exactly ${config.maxCount} dataset${config.maxCount > 1 ? "s" : ""}.`,
    };
  }

  return { valid: true, reason: "" };
}

/**
 * Returns a human-readable summary of the current selection.
 * @param {Array<{id: string, projectLabel?: string}>} datasets — all datasets
 * @param {string[]} selectedIds
 * @param {"compare"|"merge"} mode
 * @returns {string}
 */
export function selectionSummary(datasets, selectedIds, mode) {
  const count = selectedIds.length;
  if (count === 0) return `0 selected`;

  if (mode === "merge" && count > 0) {
    const names = selectedIds
      .map((id) => datasets.find((d) => d.id === id))
      .filter(Boolean)
      .map((d) => d.projectLabel || d.id)
      .join(", ");
    return `${count} selected (${names})`;
  }

  return `${count} selected`;
}
