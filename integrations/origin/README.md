# SpecFlowLab OriginPro Bridge

This integration imports SpecFlowLab datasets into OriginPro without mouse or
keyboard automation. OriginPro 8.6 is the minimum supported version.

| Origin version | Backend | Output | Current validation level |
| --- | --- | --- | --- |
| 2021+ | embedded Python and `originpro` | `.opju` by default; `.opj` where offered | automated bridge tests; physical Windows/Origin smoke test required |
| 8.6–2020 | bitness-matched COM | `.opj`, full data worksheets; no automatic graphs | physical Origin 8.6 eight-sheet save/close/reopen passed |
| 8.5 and older | none | portable `.sflorigin` fallback | unsupported for direct automation |

The implementation has three intentionally separate parts:

- `src/lib/origin-bundle.js` is the app-side exporter. It has no DOM or Tauri
  dependency and can be called directly by the Windows app, tests, or a future
  native command.
- `specflowlab_origin.py` is the archive/parser and Origin adapter. Its parser
  uses only the Python standard library; `originpro` is imported only when an
  actual Origin import is requested.
- `src-tauri/src/labtalk.rs` decodes the same bundle for OriginPro 8.6–2020,
  stages the complete worksheet set for each dataset, and writes the manifest
  consumed by the bitness-matched COM helper.

The separation keeps the file contract testable on every platform and confines
Origin-specific behavior to one small adapter.

## Preferred workflow

1. In SpecFlowLab, open or prepare the project and run any required treatment
   and fitting.
2. In the Windows app, click **Create in OriginPro...**, choose the project
   destination, and let
   SpecFlowLab launch Origin. The app retains the exact
   `.sflorigin` input beside the Origin project and writes
   `.origin-status.json` plus `.origin-startup.log` diagnostics beside it.
   SpecFlowLab reports success only after the expected workbooks exist and the
   project is non-empty. OriginPro 8.6–2020 offers sheets-only `.opj` output;
   OriginPro 2021+ also offers the modern Python plots supported by its adapter.

The first use searches the normal `Program Files\OriginLab` installation
folders. If Origin is installed elsewhere, choose its main executable once;
SpecFlowLab remembers that location. Set `SPECFLOWLAB_ORIGIN_EXE` to override
the saved location.

### Portable/manual fallback

The one-click workflow always retains its `.sflorigin` input beside the
selected `.opju`. To generate that bundle manually from an existing project,
run:

```bash
npm run origin:bundle -- project.sflproj project.sflorigin
```

Then:

1. On the Windows machine with Origin installed, copy
   `specflowlab_origin.py` to a stable location.
2. Run the importer from Origin's Script Window:

```text
run -pyf "C:\SpecFlowLab\specflowlab_origin.py" "C:\Data\project.sflorigin" --origin;
```

To save the generated Origin project in the same operation:

```text
run -pyf "C:\SpecFlowLab\specflowlab_origin.py" "C:\Data\project.sflorigin" --origin --save "C:\Data\project.opju";
```

Origin's embedded Python already provides the official `originpro` package.
The script can also run from external Python on Windows after installing
`originpro`:

```powershell
py -m pip install originpro
py specflowlab_origin.py project.sflorigin --origin --save project.opju
```

External `originpro` automation requires a local licensed Origin installation.

## Validation and CSV conversion without Origin

Inspect and validate an archive:

```bash
python3 specflowlab_origin.py project.sflorigin --inspect
```

Convert every dataset to interoperable CSV/JSON files:

```bash
python3 specflowlab_origin.py project.sflorigin --extract converted
```

Existing output files are not replaced unless `--overwrite` is supplied.
For UFS-backed datasets, extraction writes the exact `source.ufs` binary plus
the Origin-compatible `source.csv` matrix. Metadata JSON records the SHA-256
of the exact raw source.

Convert an existing saved project to the richer plot-ready bundle without
opening the app:

```bash
npm run origin:bundle -- project.sflproj project.sflorigin
```

This command hydrates the project through SpecFlowLab's own parser/numerical
core before exporting fitted matrices, residuals, DAS, and EAS. It therefore
uses the same reconstruction path as opening the project in the app.

## Input formats

### `.sflorigin` (preferred)

Schema: `specflowlab.origin_bundle.v1`

The bundle is a ZIP archive containing:

```text
manifest.json
datasets/0001/source.csv                 # exact CSV or UFS-derived compatibility matrix
datasets/0001/source.ufs                 # exact raw input when the source is UFS
datasets/0001/treated-time.f64
datasets/0001/treated-wavelength.f64
datasets/0001/treated-matrix.f64
datasets/0001/fitted-matrix.f64       # when a fit exists
datasets/0001/residual-matrix.f64     # when a fit exists
datasets/0001/das-spectra.f64         # when available
datasets/0001/eas-spectra.f64         # when available
...
```

All `.f64` entries contain portable little-endian IEEE-754 Float64 values in
row-major order. `NaN` remains `NaN`. Matrix dimensions, labels, units,
selection coordinates, provenance, and plotting intent are recorded in
`manifest.json`.

For CSV input, `source.csv` is the exact imported text. For UFS input,
`source.ufs` is the exact imported binary and `source.csv` is a lossless
matrix representation used by the OriginPro 2021 bridge. UFS metadata is also
carried in the dataset note and manifest. The bundle does not replace the
canonical `.sflproj` project.

### `.sflproj` (supported)

The converter can read the existing `specflowlab.project_archive.v1` format
directly. It imports exact source and treated data plus fit metadata. Since
`.sflproj` deliberately omits reconstructable fitted/residual/DAS/EAS arrays,
those derived plots are available only from `.sflorigin`.

## Origin data layout

Each SpecFlowLab dataset becomes one Origin workbook with:

- `Metadata`: source path/hash, dataset identity, selection, treatment
  metadata, and units.
- `TreatedVM`: wavelength in the first column and one treated-signal Y column
  per measured time, with exact time coordinates in column Long Names.
- `Selected`: the current selection plus five evenly distributed measured
  positions from each axis, producing five or six explicit spectral and
  kinetic XY traces without interpolation.
- `FitSummary`: fit parameters and diagnostics when a fit exists.
- `FittedVM` and `ResidualVM`: the fitted and residual matrices in the same
  exact-coordinate layout when a fit exists.
- `DAS` and `EAS`: wavelength plus one Y column per component.

Origin regular Matrix objects support only linear X/Y mapping, while transient
spectroscopy time axes are commonly uneven. The bridge therefore uses an
Origin **Virtual Matrix** worksheet and `plotvm` for heatmaps on the 2021+
plotting path. This retains the actual time and wavelength coordinates without
interpolation. Heatmap graph
pages use wavelength on X and log10 time on Y, beginning at 0.1 ps and ending
at the largest measured positive time. Pre-zero and sub-0.1 ps values remain
unchanged in the worksheet and provenance bundle; only the displayed graph
range excludes them.

The importer lets `from_list()` grow worksheet rows automatically because
`originpro.WSheet.rows` is a read-only property. It preallocates only columns,
which `originpro` exposes as writable.

The OriginPro 2021 plotting path deliberately avoids `WSheet.activate()` and
`GLayer.group()`, because early embedded `originpro` builds may not expose
those convenience methods. Heatmaps use their fully qualified worksheet
ranges; multi-curve spectra, kinetics, DAS, and EAS graphs each use a newly
created standard one-layer graph page, add every curve directly, and call
`rescale()` only after all curves are present. Thus the axes follow the actual
finite data range rather than a template default.

No source or treated values are normalized, zero-filled, interpolated, or
silently cropped. When **Hide IRF-limited** is enabled in SpecFlowLab, Origin
omits those component columns and curves. Their full numeric arrays remain in
the retained `.sflorigin` bundle for reproducibility.

## Security and provenance

The Python reader:

- rejects absolute, parent-relative, backslash, duplicate, and encrypted ZIP
  entries;
- enforces compressed, expanded, entry-count, and matrix-value limits;
- checks every binary length against its manifest descriptor;
- requires monotone finite axes;
- verifies matrix dimensions against both axes;
- records the source archive SHA-256 and source-text SHA-256 in output
  metadata.

It reads archive entries directly and never extracts untrusted paths.

## Tests

From the app directory:

```bash
npm test
npm run test:origin
python3 -m py_compile integrations/origin/specflowlab_origin.py
```

The tests cover the JavaScript bundle writer, Python reader, cross-format
shape/NaN preservation, CSV conversion, overwrite refusal, and unsafe ZIP
paths. Actual Origin workbook/graph creation must still be smoke-tested on the
Windows Origin installation.

## Windows app integration

The one-click action selects a backend from the detected Origin version:

- OriginPro 2021+ embeds the Python adapter inside SpecFlowLab, writes an
  isolated launcher, and invokes `run.python(path, 2)` through Origin's
  embedded Python. No system Python installation is required.
- OriginPro 8.6–2020 decodes the bundle in Rust, writes exact-precision wide
  worksheets under an isolated temporary directory, transfers them as
  numeric or string two-dimensional SAFEARRAYs with `Worksheet.SetData`, adds
  sheets through `newsheet`, and saves with the COM `Application.Save` method.
  The helper validates the exact Origin executable, closes its hidden
  automation instance, and reopens the saved `.opj` normally.

The modern route retains its command-line startup path. The legacy route uses
COM because physical Origin 8.6 testing proved that `-RS` and `-SLOG` are
ignored. Both routes wait up to 30 minutes and validate the expected workbook
count plus a non-empty project instead of treating process creation as success.
