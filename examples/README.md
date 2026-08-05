# Example data

The CSV files in this folder are deterministic, synthetic demo matrices.
They are designed to exercise the import, treatment, and VIS/NIR merge path
without exposing private experimental data.

- SF_vis_example.csv: visible probe, 500-850 nm.
- SF_nir_example.csv: near-infrared probe, 780-1100 nm.

The matrix convention is one numeric header row with time in the first row
after the metadata, followed by one row per wavelength. The first column is
wavelength in nm and the remaining columns are signal values at time points
in ps. Metadata rows are retained by the parser.

Try the files through the workflow in docs/DEMO.md. The values are not
intended for chemical interpretation or benchmarking a scientific result.
