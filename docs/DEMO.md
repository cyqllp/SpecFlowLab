# 60-second demo

This workflow is intentionally small and deterministic so a reviewer can
run it without private experimental files.

## 1. Start the web workspace

    npm ci
    npm run dev

Open the printed local Vite URL. The same workspace is packaged in the
Tauri desktop shell with npm run tauri:dev.

## 2. Import the example pair

Import both files from examples/:

- examples/SF_vis_example.csv
- examples/SF_nir_example.csv

The files contain synthetic transient-absorption-like matrices with shared
time points and overlapping VIS/NIR wavelengths. They are safe demo data, not
a claim about a particular material.

## 3. Follow the treatment-first merge path

1. Select both datasets in the dataset rail.
2. Apply a treatment such as baseline or analysis-range selection.
3. Select the two treated datasets and choose Merge.
4. Inspect the diagnostic overlap preview and retain explicit wavelength
   ranges in the Join and output row.
5. Save the merged dataset. Parent data remain immutable and merge lineage
   is retained.

## 4. Reproduce the checks

    npm test
    npm run test:origin
    npm run build

The tests cover UFS parsing, archive round trips, VIS/NIR merge invariants,
internationalized labels, and Origin bundle generation. See
docs/REPRODUCIBILITY.md for the validation boundary.

## What to show in a job interview

A useful five-minute walkthrough is: raw-data preservation, explicit
treatment provenance, the VIS/NIR hard join with wavelength breaks, portable
project archives, and the thin .sflorigin adapter for OriginPro 2021.
