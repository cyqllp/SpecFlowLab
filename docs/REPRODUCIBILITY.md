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
exports finite-only residual RMS profiles, deterministic multi-start/range
diagnostics, and model-conditional lifetime covariance when estimable. Residual
SVD remains explicitly unavailable.

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
fits a signed Gaussian mixture independently to each EAS or DAS component. A
constant/linear baseline and Gaussian amplitudes are solved together; candidate
centers and widths are refined deterministically, and additional peaks require
both a minimum robust local-noise SNR and BIC improvement. This avoids gating a
minor or late-component band against the strongest peak. The UI exposes minimum
amplitude SNR, maximum peaks per component, and minimum FWHM, while preserving
the prior local-threshold method as an explicit fallback. Stable feature codes
annotate their source plots and corresponding lifetime rows. Explicitly
connected absorption and PL previews can refine negative regions to GSB or SE
candidates, but neither spectral overlap nor fitted Gaussian decomposition
proves an assignment. Asymmetric, overlapping, clipped, sparse, or non-Gaussian
bands can remain unstable or be missed. Spectra longer than 360 finite points
use deterministic adjacent-bin means for lineshape fitting only; the diagnostics
record input and fitted point counts, and the original EAS/DAS arrays remain
unchanged and authoritative.

`specflowlab.chart_capture.v1` is temporary session evidence. A chart capture
freezes its PNG, the numerical values represented by the current physical view,
the plot/view configuration, dataset IDs, and a lightweight analysis/fit
fingerprint. Captures do not enter `.sflproj` or mark it dirty. Selected captures
whose datasets are inside the investigation scope enter `.sflai` as one `E###`
record with separately checksummed PNG, TSV, and JSON files. Out-of-scope or
missing captures are recorded as omissions and never widen scope silently.

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
authoritative. Candidates remain `suggested-not-confirmed`; lifetime covariance
does not provide Gaussian-band uncertainty, independent reference-dataset
confirmation, or species proof.

The current global-fit core uses separable nonlinear least squares: lifetimes
are optimized in bounded log space with deterministic multi-start quasi-Newton
search, while wavelength-dependent spectra and nuisance terms are solved by
column-pivoted QR. The design matrix contains analytic Gaussian-IRF-convolved
causal exponentials, a smooth negative-time envelope and slope, and selectable
Gaussian coherent-artifact derivatives. Thus, pre-zero observations are fitted
as measured structure rather than forced to constant zero. Robust noise weights,
rank/condition estimates, convergence metadata, and early/late edge-omission
refits are stored with the result. For each free lifetime, the fitted result
also stores the finite-difference Jacobian of the profiled weighted residual in
log-lifetime coordinates, residual-variance-scaled covariance, one-standard-
error uncertainty, a 95% log-Wald interval, correlations, degrees of freedom,
and bound/rank warnings. These intervals are conditional on the selected model,
range, weights, IRF, and local optimum.

This implementation is still a public-beta numerical core, not a publication-
grade replacement for TIMP or pyglotaran. Synthetic recovery and range tests
cover the implementation, but independent reference-dataset regression,
profile-likelihood or bootstrap uncertainty-coverage validation, residual-SVD diagnostics, and
simultaneous multi-dataset fitting remain required. `EAS preview` is only the
algebraic transform implied by a sequential model; it must not be interpreted
as model-independent species proof. For merged VIS/NIR analysis, the recommended
next step remains simultaneous fitting of the original parent datasets with
shared lifetimes, separate amplitudes, and noise-based weights; equal segment
balancing is a robustness check rather than the default result.
