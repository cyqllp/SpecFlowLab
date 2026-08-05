# Reproducibility and validation

SpecFlowLab is a public beta. The commands below are the minimum reproducible
check set for a clean checkout.

## Clean checkout

    node --version
    npm ci
    npm test
    npm run test:origin
    npm run build

For the native shell, install Rust and platform prerequisites, then run:

    npm run tauri -- --version
    npm run tauri -- build --bundles app

The exact dependency graph is pinned by package-lock.json and
src-tauri/Cargo.lock.

## Current local evidence

- 21 JavaScript tests pass.
- 11 Origin bridge Python tests pass.
- 7 Rust tests pass.
- Frontend production build passes.
- macOS arm64 app bundle was verified and ad-hoc signed for local testing.
- Windows portable output was structurally checked as PE32+ x86-64, but
  physical Windows, WebView2, and OriginPro 2021 runtime tests remain pending.

## Scientific integrity boundary

Raw CSV text or UFS bytes are retained as source data. NaNs, metadata, masks,
treatment provenance, merge lineage, and wavelength breaks are not silently
discarded. Smoothing used for diagnostics does not overwrite saved signals.

The current global-fit nonlinear core is a JavaScript coordinate-search
preview. It needs a validated variable-projection optimizer, uncertainty
estimates, and reference-dataset regressions before publication-grade fitting
claims. For merged VIS/NIR analysis, the recommended next numerical step is
simultaneous fitting of the original parent datasets with shared lifetimes,
separate amplitudes, and noise-based weights; equal segment balancing is a
robustness check rather than the default result.
