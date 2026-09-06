/**
 * Reorder one-level project folders without cloning their records.
 *
 * @param {Array} folders state.folders, mutated in place
 * @param {{ folderId: string, targetFolderId: string, placement: "before"|"after" }} options
 * @returns {{ folders: Array, changed: boolean }}
 */
export function moveFolder(folders, { folderId, targetFolderId, placement }) {
  const sourceIndex = folders.findIndex((folder) => folder.id === folderId);
  if (sourceIndex < 0) throw new Error(`Folder not found: ${folderId}`);
  const originalTargetIndex = folders.findIndex((folder) => folder.id === targetFolderId);
  if (originalTargetIndex < 0) throw new Error(`Target folder not found: ${targetFolderId}`);
  if (folderId === targetFolderId) return { folders, changed: false };
  if (!["before", "after"].includes(placement)) throw new Error(`Unsupported folder placement: ${placement}`);

  const before = folders.map((folder) => folder.id).join("\u0000");
  const [moved] = folders.splice(sourceIndex, 1);
  const targetIndex = folders.findIndex((folder) => folder.id === targetFolderId);
  const insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
  folders.splice(insertIndex, 0, moved);
  const after = folders.map((folder) => folder.id).join("\u0000");
  return { folders, changed: before !== after };
}
