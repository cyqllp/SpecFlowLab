/**
 * Pure helpers for determining dataset scope within folders.
 * No DOM or main.js imports.
 */

/**
 * Returns the folder ID of the active dataset, or null.
 * @param {Array<{id: string, folderId: string}>} datasets
 * @param {string|null|undefined} activeDatasetId
 * @returns {string|null}
 */
export function getActiveFolderId(datasets, activeDatasetId) {
  if (!activeDatasetId || !datasets.length) return null;
  const active = datasets.find((d) => d.id === activeDatasetId);
  return active ? (active.folderId ?? null) : null;
}

/**
 * Returns datasets in the given folder that do not have a fit result.
 * @param {Array<{id: string, folderId: string, fit?: object|null}>} datasets
 * @param {string|null|undefined} folderId
 * @returns {Array} unfitted datasets in the folder (same object references)
 */
export function getUnfittedDatasetsInFolder(datasets, folderId) {
  if (!datasets.length) return [];
  return datasets.filter((d) => d.folderId === folderId && !d.fit);
}
