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

- 95 JavaScript tests pass, including AI-investigation package/scope tests and
  evidence-graph schema, migration, relationship, comparability, traversal,
  modality-native shape, archive round-trip, checksum, raw-source, NaN, and
  non-mutation tests.
- 11 Origin bridge Python tests pass.
- 45 Rust tests pass, including a valid `.sflorigin` to LabTalk staging
  regression and the Origin 8.5/8.6 boundary.
- Frontend production build passes.
- macOS arm64 app bundle was verified and ad-hoc signed for local testing.
- Windows output is compiled in CI, but physical Windows/WebView2 tests and
  OriginPro 8.6 LabTalk plus OriginPro 2021+ Python save/close/reopen tests
  remain pending.

## Scientific integrity boundary

Raw CSV text or UFS bytes are retained as source data. NaNs, metadata, masks,
treatment provenance, merge lineage, and wavelength breaks are not silently
discarded. Smoothing used for diagnostics does not overwrite saved signals.

AI Investigation export is local and provider-neutral. Default packages omit
raw sources and full matrices; explicit Full-profile opt-in preserves exact
source bytes and little-endian Float64 NaNs. The package records stable evidence
IDs, file checksums, scope, omissions, and limitations. The current package
exports finite-only residual RMS profiles but marks residual SVD, uncertainty,
and fit-stability diagnostics unavailable.

Dataset Connections use `specflowlab.evidence_graph.v1`. Dataset identity,
conditions, proposed species/state hypotheses, authored factual/interpretive
relationships, and migrated Unicode sample-note annotations round-trip in the
project archive without duplicating numerical arrays. Connected investigations
traverse one explicit relationship hop, export inclusion reasons and a
matching/different/unknown condition table, and never infer a connection from
filenames, lifetimes, or spectral resemblance.

External evidence uses `specflowlab.evidence_asset.v1`. Imported spectra,
characterization files, figures, and documents retain byte-exact sources in
dedicated archive entries; citation-only literature carries no fabricated
document bytes. One-dimensional previews keep source row indices and explicit
missing-value policy and are marked non-authoritative. External source files
enter `.sflai` only with Full-profile raw-source opt-in; figure/document bytes
also require a reviewed rights state, while citation and relationship metadata
remain usable when bytes are omitted.

The fsTA Feature Monitor is deterministic but derived and non-authoritative. It
searches EAS and DAS independently for local positive and negative bands, then
reports a moment-based Gaussian R-squared and FWHM. The UI exposes a relative
peak threshold, minimum Gaussian R-squared, and minimum FWHM so a user can
deliberately inspect minor features. Stable feature codes annotate their source
plots and corresponding lifetime rows. Explicitly connected absorption and PL
previews can refine negative regions to GSB or SE candidates, but neither
spectral overlap nor Gaussian likeness proves an assignment. Asymmetric,
overlapping, clipped, or sparse bands can be under-scored or missed.

IRF-limited components are excluded unconditionally from interpreted lifetime
tables, EAS/DAS and comparison plots, feature candidates, Feature x Time maps,
AI feature evidence, legacy AI summaries, and Origin lifetime/component
outputs. Their original fit basis remains inside project provenance and the
full fitted/residual matrices so results can still be reconstructed and
audited.

`specflowlab.feature_time_map.v1` averages the treated matrix over each
candidate wavelength region at every measured time. It reports cell reduction,
wavelength coverage, reconstruction RMSE, and a zero-baseline reconstruction
score. It is a lossy derived view; the treated fsTA matrix remains
authoritative. Candidates remain `suggested-not-confirmed`; the workflow does
not yet provide validated uncertainty, peak deconvolution, model selection, or
species proof.

The current global-fit nonlinear core is a JavaScript coordinate-search
preview. It needs a validated variable-projection optimizer, uncertainty
estimates, and reference-dataset regressions before publication-grade fitting
claims. For merged VIS/NIR analysis, the recommended next numerical step is
simultaneous fitting of the original parent datasets with shared lifetimes,
separate amplitudes, and noise-based weights; equal segment balancing is a
robustness check rather than the default result.
