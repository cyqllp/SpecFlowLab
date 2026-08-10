# Changelog

All notable changes to SpecFlowLab are recorded here.

## [1.0.3] - 2026-08-10

- **Batch Global Fitting** now scoped to the active dataset folder instead of
  processing every dataset in the project. The fit modal displays the folder
  name and unfitted count, and progress messages include the folder context.
- **Unified Compare and Merge selection** — Compare and Merge now appear
  side-by-side under Dataset Folders, and both use a shared dataset selection
  modal. Merge checkboxes are removed from the dataset tree. Merge requires
  exactly two treated datasets (selectable from different folders) and uses
  a selection-first workflow. A "Change Datasets" button in the merge workspace
  returns to the selection stage.
- **Dataset drag-and-drop reorder** — datasets can be reordered within a folder
  (before/after a target row) or moved between folders with visual drop
  indicators. Edge auto-scroll activates near the top and bottom of the tree.
  No-op drops do not mark the project dirty. Dataset order survives `.sflproj`
  save/reopen.
- **Origin version-selection architecture** — the Origin panel now shows the
  detected installation name, version, bitness, support level, and output
  format. Users can explicitly select, change, and browse for an Origin
  executable. The Rust backend resolves capabilities (worksheets, line plots,
  heatmaps) from the detected version and chooses `.opju` or `.opj` output
  accordingly. A pure capability resolver and JSON machine config replace the
  legacy `origin-executable.txt`. The completion dialog reports created and
  omitted graph types with reasons.
- **Pure helper modules** (`dataset-scope`, `dataset-order`, `dataset-selection`)
  with comprehensive unit tests, extracted from the main UI code.
- Updated Simplified Chinese translations for all new UI strings.

## [1.0.2] - 2026-08-10

- Added the Zenodo DOI to the in-app About panel, citation metadata, and README.
- Updated the Manual and application metadata for version 1.0.2.
- Consolidated the OriginPro output heading onto one row and widened the output
  mode selector so “Sheets and plots” remains fully visible.
- Added Simplified Chinese translations for the new OriginPro output labels.

## [1.0.1] - 2026-08-07

- Fluid CSS design system with `clamp()`-based layout tokens replacing fixed
  pixel dimensions; the workspace scales continuously from 1024 px viewports.
- Proportional plot margins in all canvases (line, heatmap, spectrum, kinetics)
  so charts adapt to window size without clipping axis labels.
- Window geometry relaxed: min 1220×760, max 1920×1200 (was 1360×840–1800×1100).
- Plot geometry cache is cleared on window resize so expanded/fitted views
  re-measure correctly instead of using stale coordinates.
- Resize debounce reduced from 120 ms to 100 ms.

## [1.0.0] - 2026-08-05

The first public-beta candidate:

- Tauri desktop shell for macOS and Windows.
- CSV/text and Ultrafast Systems Version2 UFS import with source preservation.
- Treatment-first VIS/NIR merge workspace with explicit provenance and wavelength breaks.
- Synchronized heatmap, spectra, kinetics, comparison, and global-fit preview workspaces.
- Portable .sflproj project archives and .sflorigin OriginPro bridge bundles.
- English and Simplified Chinese interface, Manual/About dialogs, and plot exports.
- 21 JavaScript, 11 Origin bridge, and 7 Rust regression tests passed locally.

Known limitations and the validation boundary are documented in
README.md and docs/REPRODUCIBILITY.md.
