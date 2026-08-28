# SpecFlowLab

SpecFlowLab is a desktop workspace for time-resolved spectroscopy. It keeps
raw measurements, processing choices, fitting results, feature labels, and
related evidence together in one reviewable project.

[Download the latest release](https://github.com/cyqllp/SpecFlowLab/releases/latest)
or follow the source instructions below.

![SpecFlowLab workflow](docs/workflow.svg)

## Quick start

### 1. Download the app

Choose a package from the
[latest GitHub release](https://github.com/cyqllp/SpecFlowLab/releases/latest):

- **macOS Apple silicon:** download the `macOS-arm64-portable.zip`, extract it,
  and move `SpecFlowLab.app` to Applications. The test build is ad-hoc signed
  but not notarized, so macOS may require **Control-click → Open** the first
  time.
- **Windows x64:** use the setup EXE or MSI for installation, or the portable
  EXE to run without installing. The current Windows packages are not
  Authenticode-signed, so Windows may show a SmartScreen notice.

Release downloads include `SHA256SUMS.txt` for file-integrity checks.

### 2. Create your first project

1. Create a project and import one or more CSV or UFS measurements.
2. Select a dataset and open **Edit Dataset Details** to set its name, sample
   information, role, and useful experimental conditions.
3. Set the wavelength and time range you want to analyze.
4. Apply **Baseline** or **Chirp** correction only when needed.
5. Explore the linked heatmap, spectrum, and kinetics views. Moving a selector
   in one view updates the others.

You can organize datasets into folders, compare several measurements, or merge
treated VIS and NIR datasets while keeping the original sources unchanged.

### 3. Run global analysis

1. Open **Global Fitting** and choose the number of components.
2. Adjust starting lifetimes if needed, then run the fit.
3. Review the fit summary and residual map side by side.
4. Inspect the EAS and DAS previews below them.
5. Review the two strongest suggested peaks for each EAS component.

A **signature** is simply a peak you want to track or discuss. Suggested
signatures appear as dashed lines at their peak wavelengths. Double-click or
right-click a label to rename it, change its type or position, add a note, or
delete it. You can also click an EAS curve to add your own signature.

### 4. Add related evidence

Open **Edit Dataset Details**, then use the Evidence Import panel to drag,
paste, or select:

- absorption, PL, or other spectroscopy data;
- characterization datasets;
- figures and images;
- manuscripts, papers, and supporting documents.

Select imported items to connect them to a dataset. The relation map shows
only the links you create. Connected absorption or PL data can help you review
whether a negative fsTA feature is more consistent with GSB or SE, but the app
keeps this as a suggestion for the user to confirm.

### 5. Save or share the work

- Save the full project as `.sflproj` and reopen it later.
- Use **AI Investigation** to choose a question, scope, and evidence before
  exporting a local `.sflai` package. SpecFlowLab does not upload it to an AI
  provider.
- On Windows, export a provenance bundle or create an OriginPro project with
  OriginPro 8.6 or later.
- Export individual plots as PNG or tab-delimited text from the plot menu.

## What SpecFlowLab can do

- Import CSV/text matrices and Ultrafast Systems `Version2` UFS files.
- Preserve original source data while recording ranges, baseline correction,
  chirp correction, merges, and fitting settings.
- Display coordinated heatmap, spectrum, and kinetics views.
- Compare datasets and join treated VIS/NIR measurements without hiding the
  wavelength boundary.
- Fit shared lifetimes and present the fit summary, residuals, DAS, and EAS
  preview in one workspace.
- Suggest spectral peaks, edit labels directly on EAS plots, and keep
  user-authored ESA, GSB, SE, and other assignments separate from the fit.
- Import external evidence and organize explicit dataset relationships in a
  focused relation map.
- Save portable projects and prepare selected, cited evidence for AI review or
  OriginPro.
- Switch the interface between English and Simplified Chinese.

## Main file types

| File | Purpose |
| --- | --- |
| CSV, TXT, UFS | Imported measurement data |
| `.sflproj` | Complete reusable SpecFlowLab project |
| `.sflai` | Selected evidence package for an AI investigation |
| `.sflorigin` | Data and provenance bundle for OriginPro |

## Scientific notes

- Automatic feature labels are starting points, not confirmed assignments.
- EAS is shown as a sequential-model preview; it is not independent proof of a
  molecular species.
- Very fast components that cannot be separated from the instrument response
  are kept in fit provenance but hidden from interpreted component plots and
  feature summaries.
- Raw measurements and residual data remain available for checking the result.

## Run from source

Install Node.js 22 or later, Rust stable, and the platform requirements for
[Tauri 2](https://v2.tauri.app/start/prerequisites/). Then run:

```bash
npm ci
npm run tauri:dev
```

To run only the browser-based interface:

```bash
npm run dev
```

Useful checks for contributors:

```bash
npm test
npm run test:origin
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Build the desktop package with:

```bash
npm run tauri:build
```

## Learn more

- [60-second example walkthrough](docs/DEMO.md)
- [Example datasets](examples/README.md)
- [Reproducibility and scientific limits](docs/REPRODUCIBILITY.md)
- [OriginPro integration](integrations/origin/README.md)
- [Release notes](CHANGELOG.md)

SpecFlowLab is released under the [MIT License](LICENSE). Citation information
is available in [CITATION.cff](CITATION.cff).
