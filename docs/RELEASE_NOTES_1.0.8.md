# SpecFlowLab 1.0.8

SpecFlowLab 1.0.8 focuses the global-analysis presentation and makes the
Windows release smaller and more responsive.

## Highlights

- EAS and DAS component curves follow the classical Origin sequence: black,
  red, green, blue, cyan, and then the remaining traditional colors.
- Automatic EAS/DAS suggestions are limited to two per component. User-defined
  EAS signatures remain editable and are not removed by the automatic limit.
- The Global Fitting window uses one EAS-first preview with an EAS/DAS switch;
  DAS does not display signature labels.
- Baseline or chirp changes rebuild only datasets whose effective treatment
  changed, preserving unaffected sibling analyses and fits.
- Origin status shows the current release cleanly. A worksheets-only warning is
  shown only for a selected legacy executable without graph support.
- Folders can be reordered, symmetric sample connections are visible from both
  endpoints, and the evidence library is limited to imported evidence assets.
- Minified production assets and animation-frame chart scheduling reduce
  Windows startup and interaction work.

## Scientific boundary

Automatically detected peaks and ESA/GSB/SE interpretations remain
`suggested-not-confirmed`. The raw data, treatments, fit diagnostics, and
provenance remain the authoritative evidence.

## Packages

- macOS Apple-silicon portable application ZIP (ad-hoc signed; not notarized)
- Windows portable executable ZIP
- Windows NSIS and MSI installers
