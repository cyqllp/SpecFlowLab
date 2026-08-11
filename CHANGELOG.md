# Changelog

All notable changes to SpecFlowLab are recorded here.

## [1.0.5] - 2026-08-11

- **OriginPro 8.6 direct automation** — a bitness-matched Windows PowerShell COM
  helper replaces the earlier command-line LabTalk transport. OriginPro
  8.6–2020 exports metadata, treated/selected data, and available fit/DAS/EAS
  worksheets to `.opj`; OriginPro 2021+ retains the embedded Python adapter.
  OriginPro 8.5 and older are rejected, and the app validates that COM launched
  the exact executable selected in SpecFlowLab.
- **Clean virtual-matrix worksheets** — `TreatedVM`, `FittedVM`, and
  `ResidualVM` now store the wavelength axis in the first column and the exact
  time coordinates in the first data row, so the sheet plots directly as a 2D
  heatmap instead of embedding time values in column names.
- **Explicit non-finite values** — staged worksheets preserve `NaN`,
  `Infinity`, and `-Infinity` as literal tokens, matching the documented
  `nanPolicy`, instead of silently blanking them.
- **OriginPro output panel** — the experimental backend is summarized compactly
  as “Origin 8.6+ · Worksheets only”, and sheets-only export no longer reports
  phantom graph omissions.
- Added regression coverage for a real `.sflorigin` staging pass, the
  virtual-matrix worksheet layout, non-finite token handling, 8.5 versus 8.6
  detection, custom-folder executable mappings, and the COM helper source.

## [1.0.4] - 2026-08-10

- **Windows CI packaging** — GitHub Actions now builds signed Windows installers
  (`.msi` and `.exe` via NSIS) on every push to `main`. Artifacts are retained
  for 30 days. The bundle targets now include `msi` in addition to `nsis`.
- **Rust clippy** added to CI lint gate alongside `cargo fmt` and `cargo test`.
- **`.opj` / `.opju` format selection** — the Origin panel adapts the file-save
  dialog filter to the selected output format. The Rust capability resolver
  determines the default format per detected Origin version, and the user can
  override it when the installation supports both.

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
