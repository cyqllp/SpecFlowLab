// A save cancellation or error never authorizes replacement.
export async function protectUnsavedWork({ dirty, decide, save }) {
  if (!dirty) return true;
  const choice = await decide();
  if (choice === "discard") return true;
  if (choice !== "save") return false;
  try { return (await save()) === true; } catch { return false; }
}
