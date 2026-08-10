# SpecFlowLab Origin Compatibility and Dataset Workflow Implementation Plan

Status: implementation handoff  
Repository: `SpecFlowLab/SpecFlowLab-app`  
Baseline reviewed: `main` at `e17ce7a` / SpecFlowLab 1.0.2  
Audience: Claude Code or another implementation agent  
Scope: plan only; do not treat any compatibility row as verified until its acceptance gate passes

## 1. Required outcome

Implement one coherent release that:

1. lets a Windows user select the installed Origin or OriginPro executable;
2. detects the actual Origin version and resolves a safe export backend, project format, and plot capability;
3. exports worksheets for every supported version and creates only the graphs that the selected Origin version can reliably reproduce;
4. scopes Batch Global Fitting to the active dataset folder;
5. moves Merge beside Compare and gives both actions the same selection-first workflow;
6. removes merge-selection checkboxes from the dataset tree; and
7. lets drag-and-drop reorder datasets within a folder as well as move them between folders.

The implementation must preserve SpecFlowLab's existing scientific guarantees: immutable source CSV/UFS data, treated-data provenance, merge lineage, NaNs, exact irregular axes, and the portable `.sflorigin` sidecar. Do not make an old Origin version appear compatible by interpolating an irregular axis, dropping data silently, or creating an empty project file.

## 2. Product decisions to use unless the maintainer explicitly changes them

### 2.1 Meaning of “current folder”

The current folder is the folder containing the active dataset. Batch Global Fitting processes only unfitted datasets in that folder. It preserves existing fits both inside and outside the folder. If there is no active dataset/folder, the action is unavailable.

### 2.2 Merge and Compare placement

Show two sibling commands directly below the Dataset Folders tree:

```text
[ Compare... ] [ Merge... ]
```

They share a reusable selection-stage layout and interaction model, but remain separate actions:

- Compare accepts two or more datasets.
- Merge accepts exactly two treated datasets.
- Merge may select treated datasets from different folders, because VIS and NIR are commonly organized separately.
- Clicking Merge opens dataset selection first; it does not require preselection in the tree.
- The existing merge workspace remains the second stage after valid selection.

This interpretation keeps the main workspace sparse and retains the existing “treat first, merge second” rule.

### 2.3 Dataset order

`state.datasets` remains the canonical persisted dataset order for this release. `folderDatasets(folderId)` continues to filter that array without sorting. Reordering therefore round-trips through the existing `.sflproj` archive without a schema change.

Do not add `folder.datasetIds` or a second competing order source unless migration work is explicitly approved. Any array splice must preserve the active dataset by ID, not by its old numeric index.

### 2.4 Origin behavior

Origin integration is capability-driven, not a single `if version >= ...` switch.

- The user explicitly selects an installation on first use. Automatic discovery may offer suggestions but must not silently select a different installation later.
- SpecFlowLab detects the executable's real product/file version. A folder-name guess is only a low-confidence fallback.
- The UI defaults to **Sheets and supported plots** when the selected version has a verified plot backend; otherwise it defaults to **Only sheets**.
- Unsupported graph types are disabled or omitted with a visible explanation and a structured warning. Never silently claim “sheets and plots” if only sheets were created.
- Output extension is chosen from the detected capability: `.opju` for modern versions and `.opj` for versions that require the legacy format.
- The installation path and license-specific information are machine settings. Do not serialize them into `.sflproj`.

## 3. Current implementation map

Use this map before editing; re-run searches because line numbers will move.

| Area | Current implementation | Problem to correct |
| --- | --- | --- |
| Origin UI | `src/main.js`, `state.origin`, `origin-output-mode`, `createInOrigin()` | Only a manual sheets/plots choice; no installation/version/capability display |
| Native Origin launcher | `src-tauri/src/lib.rs`, `create_origin_project`, `resolve_origin_executable` | Remembers only a path, forces `.opju`, and launches the modern Python bridge for every executable |
| Modern Origin adapter | `integrations/origin/specflowlab_origin.py` | Correct thin adapter for the `.sflorigin` contract, but depends on the modern `originpro` API path |
| Portable contract | `src/lib/origin-bundle.js` | Keep this as the common source for every backend |
| Batch fitting | `src/main.js`, `renderFitModal()`, `runBatchFit()` | Counts and processes `state.datasets`, so it crosses folder boundaries |
| Compare selection | `renderCompareSelection()`, `openCompareSelection()` | Already has the desired selection-first shape and should be generalized |
| Merge selection | dataset-row `.merge-check`, `updateMergeSelection()`, `openMergeWorkspace()` | Selection is embedded in the tree and the workspace button depends on preselection |
| Dataset drag | pointer handlers in `bindDom()`, `moveDatasetToFolder()` | Drop target resolves only to `[data-folder-drop]`; same-folder drops are no-ops |
| Archive order | `src/lib/project-archive.js` | Dataset array order already persists; add regression coverage |
| Localization | `src/lib/i18n.js` | Every new visible string needs English and Simplified Chinese coverage |
| User documentation | `README.md`, `integrations/origin/README.md`, in-app Manual | Currently describes OriginPro 2021 and `.opju` only |

## 4. Implementation sequence

Implement in the following order. Keep each stage independently testable and do not combine the legacy Origin adapter with unrelated UI refactors in one commit.

### Phase A — Extract pure workflow helpers

Add small, DOM-independent modules before changing UI behavior:

1. `src/lib/dataset-scope.js`
   - `getActiveFolderId(datasets, activeDatasetId)` or an equivalent ID-based helper;
   - `getUnfittedDatasetsInFolder(datasets, folderId)`;
   - no imports from `main.js` and no DOM access.
2. `src/lib/dataset-order.js`
   - `moveDataset(datasets, { datasetId, targetFolderId, targetDatasetId, placement })`;
   - accepted placements: `before`, `after`, and `end`;
   - returns a new order description or mutates in one clearly documented way;
   - reports whether the operation changed anything;
   - never clones large matrices.
3. A shared selection model, either in `src/lib/dataset-selection.js` or as pure helpers near the existing modal renderer:
   - mode-specific eligibility;
   - required selection counts;
   - selection toggle and select-all behavior;
   - human-readable validation reason.

Add unit tests before wiring these helpers into `main.js`.

### Phase B — Correct Batch Global Fitting scope

#### State and UI changes

1. In `renderFitModal()`, derive:
   - `folder = activeFolder()`;
   - `folderTargets = folderDatasets(folder.id).filter(item => !item.fit)`;
   - the button label from `folderTargets.length`, not all project datasets.
2. Show the folder context in the modal, for example:

   ```text
   Batch fit unfitted datasets in “VIS” (4)
   ```

3. Disable the batch button when there is no current folder or no unfitted dataset in it.
4. Replace “All Datasets Fitted” with a folder-specific message such as “Current Folder Fitted”.

#### Execution changes

1. At the start of `runBatchFit()`, capture the active dataset ID and active folder ID.
2. Resolve targets once from that folder and keep that fixed list for the running job.
3. Fit only targets without an existing `fit` result.
4. Preserve the existing active-fit editor synchronization only when the active dataset was one of the targets.
5. Make job progress and completion text include the folder name and target count.
6. Do not change optimizer math, starting lifetime semantics, weighting, or fit result serialization in this work item.

#### Acceptance tests

- Folder A has two unfitted datasets; Folder B has three. Running Batch from A creates exactly two fits.
- A fitted dataset in Folder A is not recomputed.
- No dataset or fit in Folder B changes byte-for-byte/structurally.
- Switching the active dataset to Folder B changes the displayed count to three.
- A folder with no unfitted datasets gives a folder-specific no-op notice.
- The active dataset remains active after the batch job.

### Phase C — Unify Compare and Merge selection workflow

#### Sidebar and tree

1. Replace the single wide Compare command with a two-button command row containing Compare and Merge.
2. Remove from dataset rows:
   - `.dataset-merge-select`;
   - `.merge-check`;
   - `data-merge-id`;
   - corresponding CSS and DOM listeners.
3. Remove the merge selection count from the active dataset heading.
4. Remove the Merge button from the Baseline / Chirp / Reset treatment action row.
5. Keep the tree focused on activation, status, drag, details, and removal.

#### Shared selection stage

Generalize the comparison selection modal instead of copying it:

```js
renderDatasetSelection({
  mode: "compare" | "merge",
  datasets,
  selectedIds,
  minCount,
  maxCount,
  eligibility,
  continueLabel,
});
```

Behavior by mode:

| Behavior | Compare | Merge |
| --- | --- | --- |
| Eligible datasets | all datasets; retain current comparison rules | treated datasets only |
| Required selection | at least 2 | exactly 2 |
| Select all | yes | no, because exactly two are required |
| Continue action | opens comparison workspace | prepares merge plan, then opens merge workspace |
| Invalid dataset | allowed if current comparison supports it; label fit availability | disabled with “Treat before merging” explanation |

Additional requirements:

- Group or label the selection list by folder while retaining `state.datasets` order.
- The selection row must show dataset name, folder, treated/raw state, wavelength range, time range, and fit state.
- For Merge, selecting a third item should either be blocked with a clear maximum-two rule or replace the oldest selection consistently. Prefer blocking; it is easier to understand.
- Cancel closes the modal without partially changing a prepared merge plan.
- “Change datasets” from either workspace returns to its corresponding selection stage.
- After dataset deletion/import/project open, prune stale selection IDs in both modes.
- Do not call `prepareMergePlan()` until Continue is pressed with exactly two eligible datasets.

#### State cleanup

Keep `state.compare.selectedIds` and `state.merge.selectedIds` separate. Add an explicit selection stage for merge if helpful, but do not persist an open modal. Clear `state.merge.plan` and `state.merge.draft` whenever the selected pair changes.

#### Acceptance tests

- No checkbox appears in the dataset tree.
- Compare and Merge appear together under Dataset Folders in English and Chinese.
- Merge opens a selection window even when nothing was previously selected.
- Raw/untreated datasets are visible but disabled in Merge with an explanation.
- Exactly two treated datasets enable Continue and open the existing merge workspace.
- Compare still accepts two or more datasets and retains line-style settings.
- A VIS dataset and a NIR dataset in separate folders can be selected for Merge.
- Source parents remain unchanged after creating the merged derived dataset.

### Phase D — Dataset reorder and cross-folder drag

#### Drop model

Replace folder-only hit testing with explicit row and folder-end targets:

- Each `.dataset-row` is a target with `data-dataset-drop`.
- Pointer position above/below the row midpoint resolves to `before` or `after`.
- The folder heading/list background resolves to `end`.
- An empty folder resolves to `end`.
- A drag may stay in the same folder or cross to another folder.

Show visible insertion feedback with separate classes such as `drop-before`, `drop-after`, and `drop-end`. Remove every class on pointer up, pointer cancel, modal open, and rerender.

#### Ordering algorithm

Use one tested helper for pointer drag and any future keyboard command:

1. capture `activeDatasetId`;
2. remove the dragged object from `state.datasets` without cloning it;
3. update its `folderId`;
4. calculate the insertion index in the array after removal;
5. insert before/after the target dataset, or at the target folder's end;
6. restore `state.activeIndex` by searching for `activeDatasetId`;
7. expand the target folder;
8. mark dirty only if folder or position changed;
9. preserve treatment, fit, merge lineage, notes, and matrices by object identity.

For an empty target folder, derive its canonical array insertion point from `state.folders` order: after the last dataset in the nearest preceding non-empty folder, otherwise before the first dataset in the nearest following folder.

#### Interaction details

- Change the drag handle accessible label to “Drag to reorder or move dataset”.
- Preserve the existing four-pixel movement threshold so a click does not start a drag.
- Preserve the dataset-tree scroll position during rerender.
- Add edge auto-scroll when the pointer is near the top or bottom of the dataset tree.
- Do not activate a dataset merely because its handle was dragged.
- Keep context-menu “Move to folder” as a non-drag fallback, but route it through the same ordering helper with `placement: "end"`.
- Add keyboard-accessible “Move up” and “Move down” context actions if feasible in the same release; at minimum record this as an accessibility follow-up.

#### Acceptance tests

- Reorder first to last and last to first within one folder.
- Drop before and after a middle row.
- Move into an empty folder.
- Move between non-empty folders before a chosen row and at folder end.
- A no-op drop does not mark the project dirty.
- The active dataset remains active after its own move and after another dataset moves around it.
- Save `.sflproj`, reopen it, and confirm folder membership and within-folder order are identical.
- Large matrices are not copied during reorder.

## 5. Origin version-selection and compatibility architecture

This is the largest workstream. Implement it behind a small capability model so older-version support does not turn the modern adapter into version-condition spaghetti.

### 5.1 Support levels

Every installation/capability row must carry one of these statuses:

- `verified`: passed a physical Windows + licensed Origin smoke test for this version family;
- `experimental`: adapter exists and automated tests pass, but the physical version has not completed the matrix;
- `unsupported`: SpecFlowLab will not launch an incompatible adapter; portable bundle/export remains available.

Marketing, Manual, About, README, and UI badges must use these states honestly. A build/test on macOS or validation of a Windows PE file is not a physical Origin test.

### 5.2 Native data model

Add serializable Rust types, preferably in a new `src-tauri/src/origin.rs` module:

```rust
struct OriginInstallationInfo {
    executable_path: String,
    display_name: String,
    product_version: Option<String>,
    major_version: Option<u32>,
    minor_version: Option<u32>,
    bitness: Option<u32>,
    detection_confidence: DetectionConfidence,
    backend: OriginBackendKind,
    project_formats: Vec<OriginProjectFormat>,
    default_project_format: OriginProjectFormat,
    support_level: SupportLevel,
    capabilities: OriginCapabilities,
    warnings: Vec<String>,
}

struct OriginCapabilities {
    worksheets: bool,
    line_plots: bool,
    virtual_matrix_heatmap: bool,
    residual_heatmap: bool,
    unicode_metadata: bool,
}
```

Add equivalent request/result types. The create request should contain a selected installation identity/path, requested output policy, and optional format only when multiple formats are supported. The result/status must report the resolved backend and actual output, not only `create_plots: bool`.

Suggested commands:

- `list_origin_installations()` — discover and inspect candidates without changing the saved choice;
- `select_origin_installation()` — file picker plus validation/version inspection;
- `get_origin_installation()` — revalidate the saved choice;
- `set_origin_installation(path)` — explicit selection from discovered candidates;
- revised `create_origin_project(request, bytes)` — resolve capabilities again before launch.

### 5.3 Version detection

On Windows, read `FileVersion` and `ProductVersion` from the executable's version resource using Win32 version APIs through the Rust `windows` crate or another direct native implementation. Do not make PowerShell a runtime dependency.

Detection order:

1. signed/file metadata product version;
2. known Origin executable/version mapping;
3. install-directory year/name heuristic with `detection_confidence = heuristic`;
4. unknown — do not launch a version-specific backend until the user confirms or chooses another executable.

Revalidate the saved executable on each app start and before each export. Store a versioned JSON machine configuration instead of `origin-executable.txt`. Migrate the existing text file once, then retain or remove it only after the JSON write succeeds.

Never store this machine configuration in a project archive. Environment overrides may remain for advanced/test use, but they must pass the same inspection and capability resolver.

### 5.4 Initial capability matrix

Treat this as the implementation target, not proof of support:

| Origin family | Project format | Adapter target | Initial output policy | Release gate |
| --- | --- | --- | --- | --- |
| 2023 and newer | `.opju` | existing `originpro` Python adapter | worksheets + all currently supported plots | physical smoke test for one current release; regression fixtures |
| 2021–2022b | `.opju` default; `.opj` optional where verified | existing `originpro` Python adapter | worksheets + all currently supported plots | physical tests for 2021 and one 2022-family version |
| 2018–2020b | `.opju` default; `.opj` compatibility option | separate legacy PyOrigin adapter | worksheets first; enable supported line plots only after physical verification | PyOrigin API spike plus one physical version test |
| 2016–2017 | `.opj` | separate legacy PyOrigin adapter | worksheets first; basic line plots only after verification | physical test and save/reopen validation |
| 9.x–2015 | `.opj` | LabTalk staging adapter | worksheets; optionally basic 2D lines after verification | per-family experimental badge and physical test |
| 8.6 | `.opj` | LabTalk staging adapter | worksheets plus verified basic line graphs; no promised exact heatmap | physical OriginPro 8.6 save/reopen test |
| older or unknown | portable `.sflorigin`/interoperable files only | none | no automatic Origin launch | explicit unsupported message |

Notes:

- Origin 2018 introduced `.opju`; older releases require `.opj`.
- Origin 2018 through 2022b can provide an older `.opj` compatibility path, while newer releases should default to `.opju`.
- The public `originpro` package path is for Origin 2021 and newer. Do not assume the same API in 2016–2020; isolate PyOrigin work.
- “All currently supported plots” means treated/residual heatmaps, selected spectra/kinetics, DAS, and EAS only when the backend reports and demonstrates those capabilities.
- Heatmaps with irregular time/wavelength axes require the existing worksheet-backed Virtual Matrix strategy. Never create a regular Origin matrix by pretending irregular coordinates are linear.

Before coding against a legacy API, verify these version boundaries against current OriginLab documentation and record the checked URLs/date in `integrations/origin/README.md`.

### 5.5 Adapter boundaries

Keep `.sflorigin` as the shared, versioned input. Create three isolated backend paths:

1. `ModernOriginProBackend` (2021+)
   - reuse `integrations/origin/specflowlab_origin.py`;
   - retain current embedded-Python startup, atomic status file, log, timeout, and non-empty-output validation;
   - make output suffix and actual created/omitted graphs part of the result.
2. `LegacyPyOriginBackend` (2016–2020)
   - add a separate adapter module/script;
   - map the portable bundle to the older API explicitly;
   - begin with worksheets and basic lines; do not fork the entire parser;
   - share the standard-library archive parser and naming helpers where possible.
3. `LabTalkBackend` (8.6–2015)
   - materialize a deterministic, trusted temporary staging directory from `.sflorigin`;
   - use ASCII-safe filenames plus a manifest mapping back to full Unicode display names;
   - write axes/matrices as tab-delimited files that old Origin can import;
   - generate a LabTalk `.ogs` script that creates worksheets, designations, long names/units where supported, and only verified basic graphs;
   - launch with the documented command-line execution path and create a status/sentinel file;
   - save `.opj`, close/flush as required, and validate a non-empty output file;
   - preserve full UTF-8 metadata in the `.sflorigin` sidecar and notes/manifest when the old OPJ code page cannot represent it.

The LabTalk spike is a hard gate. If Origin 8.6 cannot reliably signal completion or save the required project in an automated physical test, ship it as **Export legacy staging package** rather than falsely labeling it one-click compatible.

### 5.6 Plot degradation policy

Resolve requested output to actual output before launch:

```text
requested: sheets-and-supported-plots
capabilities: worksheets + line plots; no virtual-matrix heatmap
actual: worksheets + spectra/kinetics/DAS/EAS line plots
omitted: treated heatmap, residual heatmap
reason: selected Origin backend has no verified irregular-axis heatmap path
```

The completion dialog and `.origin-status.json` must include:

- detected Origin name/version/bitness;
- backend and support level;
- `.opj` or `.opju` output path;
- workbook/sheet count;
- graph count;
- requested graph types;
- created graph types;
- omitted graph types and reasons;
- `.sflorigin`, log, and status paths;
- output byte count;
- warnings.

An output is successful only if the adapter reports completion and the expected non-empty project exists. For a sheets-only request, a zero graph count is correct, not a warning.

### 5.7 Origin UI workflow

Replace the current static Origin panel with:

```text
OriginPro Output
[ OriginPro 2021 (64-bit) ] [Change...]
Verified · Python adapter · OPJU
[ Sheets and supported plots       v]
[ Create in OriginPro...             ]
```

Rules:

1. If no installation is saved, **Select Origin...** is the primary action.
2. **Change...** opens discovered installations plus **Browse...**.
3. Show version, bitness, support level, backend, and output format in one compact status block.
4. Generate output options from capabilities:
   - **Only sheets** is enabled whenever worksheet export is supported;
   - **Sheets and supported plots** is enabled only when at least one plot capability is supported;
   - list omitted plot types in the confirmation/preview, not in a hidden tooltip only.
5. If both `.opj` and `.opju` are supported, keep format choice under an Advanced disclosure and default to `.opju`.
6. File dialog filter and enforced suffix must follow the resolved format. Remove every hard-coded `.opju` assumption from generic launcher errors.
7. On cancellation, do not alter the current project or write a partial output.
8. Keep installation choice out of project dirty-state and project serialization.

Update all English/Chinese strings and verify the Origin panel remains one-row/compact at the minimum supported window width.

### 5.8 Origin security and reliability requirements

- Validate that the chosen file is a local main Origin executable, not Viewer, updater, crash reporter, or uninstaller.
- Escape every path crossing Rust, LabTalk, and Python boundaries. Prefer a short generated temp directory for legacy scripts.
- Staging extraction must reject absolute paths, drive-letter entries, `..`, and unexpected filenames just like project archive extraction.
- Sanitize worksheet/graph short names separately from user-visible long names; preserve a deterministic collision map.
- Never run scripts taken from an imported project. Only execute scripts generated by SpecFlowLab code.
- Use backend-specific startup/completion timeouts and surface the startup log/status path on failure.
- Clean temporary files only after success and only when diagnostic retention policy allows it; never delete the `.sflorigin` sidecar.
- If Origin is already running, define and test whether the backend attaches, opens a new instance, or requires the user to close it. The behavior must be explicit per backend.

## 6. Test and verification matrix

### 6.1 Automated JavaScript tests

Add:

- `tests/dataset-scope.test.js` for folder-only batch target selection;
- `tests/dataset-order.test.js` for reorder/move/no-op/active-ID behavior;
- `tests/dataset-selection.test.js` for compare/merge eligibility and counts;
- archive regression in `tests/project-archive.test.js` proving dataset order survives save/open;
- i18n coverage for every new visible key;
- existing merge, UFS, Origin bundle, and archive tests unchanged and passing.

### 6.2 Rust tests

Add tests for:

- version-resource parsing through fixtures or an injectable inspection boundary;
- capability resolution for every matrix row and boundary version;
- `.opj`/`.opju` extension selection;
- legacy `origin-executable.txt` migration;
- rejecting helper executables and unknown versions;
- structured Origin status parsing, including created/omitted plots;
- generated LabTalk/Python path escaping;
- cancellation and timeout behavior;
- non-Windows compilation through `cfg` boundaries.

### 6.3 Python and legacy-adapter tests

- Keep `npm run test:origin` green for the modern parser/adapter.
- Share bundle parsing fixtures between modern and legacy adapters.
- Golden-test staged tabular files, Unicode-name mapping, NaN representation, irregular axes, and generated LabTalk commands.
- Do not count script-generation tests as proof that Origin 8.6 executed them.

### 6.4 Physical Windows/Origin matrix

For each version claimed as verified:

1. install/run the packaged Windows SpecFlowLab build;
2. select the Origin executable and confirm displayed version/bitness;
3. export **Only sheets**;
4. export **Sheets and supported plots**;
5. verify workbook/sheet names, time/wavelength axes, units, selected traces, DAS/EAS, matrices, warnings, and graph ranges;
6. save, close Origin completely, reopen `.opj`/`.opju`, and repeat checks;
7. compare sampled cell values against the `.sflorigin` bundle;
8. test spaces, non-ASCII characters, and OneDrive paths;
9. test with Origin already open and fully closed;
10. retain status/log files and record the exact Origin build number.

Minimum release matrix:

- OriginPro 2021, because it is the currently demonstrated user environment;
- one current Origin release (2023+);
- one 2018–2020 PyOrigin-family release before marking that family verified;
- OriginPro 8.6 before advertising one-click 8.6 support.

Unrun rows must remain experimental or unsupported in the UI and documentation.

### 6.5 Standard repository checks

Run from the repository root:

```bash
node --check src/main.js
npm test
npm run test:origin
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Then build the Windows package in GitHub Actions or Windows and perform the physical matrix. A macOS Tauri build checks cross-platform regressions but cannot validate Origin.

## 7. Documentation changes

Update together with code:

- `README.md`: capability-driven workflow, support table, support-level definitions, and portable fallback;
- `integrations/origin/README.md`: backend architecture, format rules, diagnostic files, legacy staging details, and exact official references checked;
- in-app Manual: selecting/changing Origin, why graphs can be omitted, `.opj` versus `.opju`, and legacy limitations;
- `docs/REPRODUCIBILITY.md`: how to verify value preservation across adapters;
- `docs/RELEASE_CHECKLIST.md`: physical version matrix and save/reopen gate;
- `CHANGELOG.md`: user-visible batch, merge/compare, reorder, and Origin changes only when implementation is complete.

Useful primary references to re-check during implementation:

- Origin project format compatibility: <https://docs.originlab.com/quick-help/view-opj-in-oldver/>
- Converting OPJU to older OPJ: <https://docs.originlab.com/quick-help/convert-opju-project-file-format-to-older-opj>
- Official `originpro` package: <https://pypi.org/project/originpro/>
- PyOrigin documentation: <https://docs.originlab.com/python/pyorigin/global-functions/getprojectinfo/>
- Python availability in Origin: <https://docs.originlab.com/quick-help/use-python-in-origin/>
- Origin command-line/LabTalk startup: <https://docs.originlab.com/origin-help/startup-adjustbycomline/>
- Origin 8.6 Getting Started guide: <https://www.originlab.com/pdfs/GettingStartedBooklet86.pdf>

## 8. Recommended commit sequence

1. `test: add folder scope and dataset ordering specifications`
2. `fix: scope batch global fitting to active folder`
3. `refactor: share compare and merge dataset selection`
4. `feat: support within-folder dataset reordering`
5. `refactor: add Origin installation and capability model`
6. `feat: select Origin installation and resolve OPJ or OPJU output`
7. `feat: add legacy PyOrigin worksheet adapter`
8. `feat: add experimental LabTalk OPJ adapter`
9. `docs: document verified Origin compatibility matrix`

Each commit must leave `npm test` and relevant language tests passing. Do not bump the public version, tag a release, or claim 8.6 support until the Definition of Done and physical gates are met.

## 9. Definition of Done

The work is complete only when all of the following are true:

- [ ] Batch Global Fitting changes only unfitted datasets in the active folder.
- [ ] The fit modal displays the active folder and correct target count.
- [ ] Compare and Merge are grouped under Dataset Folders.
- [ ] Merge uses a selection-first modal and no merge checkbox remains in the tree.
- [ ] Merge still requires exactly two treated datasets and preserves parent data/lineage.
- [ ] Drag-and-drop reorders within a folder and moves/repositions across folders.
- [ ] Dataset order survives `.sflproj` save/reopen and the active dataset remains stable.
- [ ] The user can explicitly select and later change the Origin executable.
- [ ] SpecFlowLab detects version/bitness with a recorded confidence level.
- [ ] A pure capability resolver chooses backend, output mode, and `.opj`/`.opju`.
- [ ] Unsupported plots are omitted visibly and recorded in status, never silently.
- [ ] `.sflorigin` remains beside every Origin project as the lossless provenance source.
- [ ] Modern Origin 2021+ behavior remains regression-tested.
- [ ] Every advertised legacy version has a physical save/close/reopen test record.
- [ ] Origin 8.6 is labeled experimental until the LabTalk OPJ path passes that record.
- [ ] English and Simplified Chinese UI/manual strings are complete.
- [ ] JavaScript, Python, Rust, build, archive, and i18n checks pass.
- [ ] README and in-app Manual match actual verified capabilities.

## 10. Explicit non-goals for this implementation

- Do not change global-fit mathematics, add weighting, or reinterpret lifetimes.
- Do not replace `.sflorigin` with an Origin-specific source format.
- Do not interpolate irregular axes merely to unlock an old heatmap type.
- Do not modify or discard raw CSV/UFS bytes, NaNs, noisy regions, or parent datasets.
- Do not promise macOS Origin automation; Origin integration remains a Windows runtime feature, while portable bundle generation remains cross-platform.
- Do not mark a version family verified based only on unit tests, CI compilation, file headers, or a non-empty project file.

## 11. Final handoff report expected from Claude Code

When implementation finishes, report:

1. files changed, grouped by the four user-facing outcomes;
2. the final Origin capability matrix with `verified` / `experimental` / `unsupported` evidence;
3. automated commands and exact pass counts;
4. physical Windows/Origin versions actually tested, including full build numbers;
5. generated package paths and checksums, if packaging was authorized;
6. remaining risks, especially untested legacy versions;
7. confirmation that no release/tag/push occurred unless separately requested.
