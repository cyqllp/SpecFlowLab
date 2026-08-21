# Changelog

All notable changes to SpecFlowLab are recorded here.

## [Unreleased]

## [1.0.6] - 2026-08-21

- **Variable-projection global-analysis core** — replaces coordinate-wise
  lifetime search with bounded deterministic multi-start optimization over
  shared lifetimes and a column-pivoted QR conditional spectral solve. The fit
  now models a smooth structured pre-zero envelope and selectable Gaussian
  coherent-artifact derivatives, supports robust noise weighting, and records
  convergence, rank/condition, and edge-range sensitivity diagnostics. EAS is
  labeled as a sequential-model preview rather than species proof.
- **Model-conditional lifetime uncertainty** — free lifetimes now report
  residual-variance-scaled standard errors, 95% log-space confidence intervals,
  covariance/correlation, effective Jacobian rank, residual degrees of freedom,
  and boundary or identifiability warnings. Fixed lifetimes are labeled fixed
  and never receive fabricated intervals; AI and Origin handoffs retain the
  uncertainty metadata while continuing to exclude IRF-limited components.
- **External Evidence Workspace** — Dataset Details now combines scientific
  identity, role, and high-value conditions in a compact upper panel and keeps
  less-used conditions in a disclosure. The lower panel adds a project evidence
  library for spectroscopy/characterization files, figures, manuscripts,
  documents, and citation-only literature, with checkbox bulk connection and a
  focused Obsidian-inspired one-hop relation map.
- **Exact-source external evidence** — `.sflproj` archives preserve imported
  evidence bytes, SHA-256, native non-authoritative previews, citation/figure,
  rights status, and provenance separately from graph metadata. Connected
  `.sflai` packages include external-evidence records and embed exact files only
  for Full-profile raw-source opt-in when the rights state permits it.
- **File-first evidence import** — a dedicated Evidence Import panel accepts
  Finder selection, drag-and-drop, and clipboard paste. Literature uses the
  same file-first route for papers, manuscripts, and figures instead of asking
  users to type a citation before importing its source.
- **Live fsTA Feature Monitor** — completed global analyses now produce
  deterministic EAS/DAS sign-region candidates. Positive regions are marked as
  possible ESA, while negative regions remain GSB/SE candidates and are refined
  only when explicitly connected absorption or PL evidence overlaps them. The
  monitor recomputes with current fit, treatment, and graph state and exports
  its `suggested-not-confirmed` observations into `.sflai` packages.
- **Integrated feature presentation** — the standalone monitor card has been
  removed. Stable feature codes now annotate EAS and DAS plots and repeat in
  their corresponding lifetime rows. A Feature × Time Map stores finite mean
  DeltaOD traces over candidate wavelength regions and reports compression,
  coverage, and reconstruction diagnostics while retaining the raw heatmap as
  authoritative.
- **Noise-aware Gaussian Lineshape Finder** — EAS/DAS feature discovery now
  fits signed multi-Gaussian models per component, requires robust local-noise
  amplitude SNR and BIC improvement for added peaks, and exposes minimum SNR,
  maximum peaks per component, and minimum FWHM. Regression coverage includes a
  5%-amplitude minor band, a low-amplitude later component, pure-noise rejection,
  and the explicit legacy local-threshold fallback.
- **Temporary Evidence Tray** — every chart can be pinned with its PNG,
  displayed numerical values, view state, and dataset/fit fingerprint. Selected
  in-scope captures become one checksummed `E###` PNG/TSV/JSON record in
  `.sflai`; captures remain session-only and do not dirty or enter `.sflproj`.
- **Permanent IRF-limit exclusion** — IRF-limited components no longer appear
  in interpreted lifetime tables, EAS/DAS plots, comparisons, feature labels,
  Feature x Time maps, AI evidence summaries, or Origin component outputs.
  They remain only in internal fit provenance and full fitted/residual matrices
  so the numerical result stays reproducible.
- **Simpler dataset metadata UI** — the dataset menu now opens Edit Dataset
  Details. Project label and sample note have one focused section; IDs, role,
  technique, and conditions use compact tag controls and a compact read-only
  tag summary on the main workspace.

- **AI Investigation Phase 2: Dataset Connections** — adds the versioned
  `specflowlab.evidence_graph.v1` project layer, structured technique/role/
  sample/preparation/condition metadata, proposed species/state entities, and
  lossless migration of sample notes into stable linked annotations. Dataset
  Details now provides auditable add/edit/remove connections with authored
  rationale and visibly separates factual from interpretive relationships.
- **Connected evidence packages** — investigations can start from a reviewed
  connection or selected root datasets and traverse exactly one explicit hop.
  `.sflai` packages include graph records, connection-specific inclusion
  reasons, and matching/different/unknown condition comparisons without
  declaring scientific equivalence or inferring links from filenames,
  lifetimes, or spectral similarity. A native-shape modality registry lays the
  foundation for later spectrum, trace, and table adapters.
- **Question-driven AI Investigation Phase 1** — replaces the sidebar's blind
  project-wide Markdown action with a required question, goal, explicit scope,
  evidence profile, privacy review, and local `.sflai` ZIP export. Packages use
  `specflowlab.ai_investigation.v1`, stable `E###` IDs, SHA-256 checksums, a
  concise brief and provider-neutral prompt, and separate CSV/JSON evidence.
  Exact raw sources and full little-endian Float64 matrices are opt-in only.
- **Honest AI diagnostics boundary** — deterministic comparable physical
  coordinates and finite-only residual RMS summaries are exported when
  available; unsupported residual SVD remains explicit rather than inferred,
  while later fits can export model-conditional uncertainty and stability
  diagnostics. The legacy Markdown exporter is
  retained under Advanced for compatibility, with no provider upload or
  automatic project mutation.
- **Reliable Origin COM server selection** — the COM helper no longer trusts the
  ambiguous `Origin.Application` ProgID. It resolves the CLSID whose
  `LocalServer32` targets the selected executable and instantiates that server
  directly. Selecting a 64-bit pre-2021 Origin (for example `origin86_64.exe`,
  whose build never registers a COM automation server) now falls back to the
  32-bit sibling in the same folder for the hidden worksheet import, records a
  clear warning, and still opens the saved project in the selected executable.
- **Import warnings surface to the user** — worksheet/COM bridge warnings from
  the Origin job status are included in the completion message instead of only
  reporting a count.

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
