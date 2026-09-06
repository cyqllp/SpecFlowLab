export function originVersionLabel(installation) {
  const major = Number(installation?.majorVersion);
  const minor = Number(installation?.minorVersion);
  if (Number.isFinite(major) && major >= 2000) return `Origin ${major}`;
  if (Number.isFinite(major) && major > 0) {
    return `Origin ${major}${Number.isFinite(minor) && minor > 0 ? `.${minor}` : ""}`;
  }
  if (installation?.productVersion) return `Origin ${installation.productVersion}`;
  const displayName = String(installation?.displayName ?? "").trim();
  const year = displayName.match(/Origin\s*(20\d{2})/i)?.[1];
  if (year) return `Origin ${year}`;
  return displayName || "OriginPro";
}
