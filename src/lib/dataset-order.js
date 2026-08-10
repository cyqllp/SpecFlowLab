/**
 * Pure helpers for reordering datasets within and across folders.
 * No DOM or main.js imports. Mutates the array in place while preserving
 * object identity (no cloning of large matrices).
 */

/**
 * Moves a dataset within or across folders.
 *
 * @param {Array} datasets — the state.datasets array (mutated in place)
 * @param {{ datasetId: string, targetFolderId: string, targetDatasetId: string|null, placement: "before"|"after"|"end" }} opts
 * @param {string} [activeDatasetId] — optional ID to track for activeIndex
 * @returns {{ datasets: Array, activeIndex: number, changed: boolean }}
 */
export function moveDataset(datasets, folders, opts, activeDatasetId = null) {
  const { datasetId, targetFolderId, targetDatasetId, placement } = opts;

  const sourceIndex = datasets.findIndex((d) => d.id === datasetId);
  if (sourceIndex < 0) {
    throw new Error(`Dataset not found: ${datasetId}`);
  }

  // Resolve the active ID we need to preserve (default to the moved dataset)
  const preserveId = activeDatasetId ?? datasetId;

  const sourceFolderId = datasets[sourceIndex].folderId;

  // Remove the moved dataset from the array
  const [moved] = datasets.splice(sourceIndex, 1);

  // Determine the insertion index (computed on the array AFTER removal)
  let insertIndex;
  if (placement === "end" || !targetDatasetId) {
    insertIndex = findFolderEndIndex(datasets, folders, targetFolderId);
  } else {
    const targetIndex = datasets.findIndex((d) => d.id === targetDatasetId);
    if (targetIndex < 0) {
      throw new Error(`Target dataset not found: ${targetDatasetId}`);
    }
    insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
  }

  // Update folder membership
  moved.folderId = targetFolderId;

  // Insert at the computed position
  datasets.splice(insertIndex, 0, moved);

  // Detect no-op: same folder and the effective position didn't change.
  // After removal, "before"/"after" the same neighbor or "end" of the same
  // folder all produce insertIndex === sourceIndex when it's a true no-op.
  const sameFolderAndPosition =
    sourceFolderId === targetFolderId && insertIndex === sourceIndex;

  // Restore active index by finding the preserved dataset
  const activeIndex = datasets.findIndex((d) => d.id === preserveId);

  return {
    datasets,
    activeIndex: activeIndex >= 0 ? activeIndex : 0,
    changed: !sameFolderAndPosition,
  };
}

/**
 * Finds the insertion index for placing a dataset at the end of a target folder.
 * For empty folders: derives from nearest non-empty folder.
 *
 * @param {Array} datasets — array AFTER the moved dataset has been removed
 * @param {string} targetFolderId
 * @param {number} sourceIndex — the index the dataset was at before removal
 * @returns {number} insertion index
 */
function findFolderEndIndex(datasets, folders, targetFolderId) {
  // Find the last dataset already in the target folder
  const lastInFolder = datasets.reduce((lastIdx, d, idx) =>
    d.folderId === targetFolderId ? idx : lastIdx, -1);

  if (lastInFolder >= 0) {
    return lastInFolder + 1;
  }

  // Target folder is empty. Derive insertion point from folder order:
  // after the last dataset of the nearest preceding non-empty folder,
  // otherwise before the first dataset of the nearest following folder.
  const targetPos = folders.findIndex((f) => f.id === targetFolderId);
  if (targetPos < 0) return datasets.length;

  // Search preceding folders in reverse order
  for (let fi = targetPos - 1; fi >= 0; fi -= 1) {
    for (let di = datasets.length - 1; di >= 0; di -= 1) {
      if (datasets[di].folderId === folders[fi].id) {
        return di + 1;
      }
    }
  }

  // Search following folders in forward order
  for (let fi = targetPos + 1; fi < folders.length; fi += 1) {
    for (let di = 0; di < datasets.length; di += 1) {
      if (datasets[di].folderId === folders[fi].id) {
        return di;
      }
    }
  }

  return datasets.length;
}
