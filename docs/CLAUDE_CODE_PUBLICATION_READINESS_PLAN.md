# SpecFlowLab Publication-Readiness and Glotaran-Maturity Implementation Plan

Status: implementation handoff
Repository: `SpecFlowLab/SpecFlowLab-app`
Baseline reviewed: `main` at `5cdc37b`, application version `1.0.4`
Audience: Claude Code and human reviewers
Plan date: 2026-08-10
Authority: this plan specializes `../SOFTWARE_ENGINEERING_SPECIFICATION.md`; the specification wins if they conflict

Implementation update (2026-08-21): the JavaScript preview core now uses
separable variable projection with column-pivoted QR, deterministic multi-start
bounded optimization, structured pre-zero/time-zero bases, convergence and
range diagnostics, and local profiled-residual Jacobian covariance for free
lifetimes. Sections describing the original coordinate-search baseline remain
as historical audit context. Profile likelihood, bootstrap coverage,
independent pyglotaran/TIMP parity, residual SVD, and simultaneous multi-dataset
fitting remain open publication-readiness gates.

## 1. Annotation 1 - The Main Publication Blocker

The main publication blocker is not the absence of another GUI feature. It is
that SpecFlowLab currently presents a scientifically useful but insufficiently
validated global-fitting preview as if it were close to a production inference
engine.

The current implementation in `src/lib/parser-core.js`:

- perturbs one lifetime at a time with a hand-written coordinate search;
- solves linear amplitudes through normal equations;
- has no optimizer success contract or termination reason;
- has no Jacobian, rank, covariance, profile likelihood, or bootstrap analysis;
- has no residual SVD or quantitative residual-structure diagnostics;
- classifies IRF-limited components mainly from `tau <= 1.05 * IRF FWHM`;
- uses a discontinuous pre-zero-only constant basis;
- derives a sequential EAS transformation even when no sequential model was
  fitted;
- recomputes archived fit products with the current JavaScript implementation;
- scores target candidates with fixed lifetimes and a capped RK4 population
  integrator, which can make distinct topologies appear nearly identical; and
- has no independent regression suite against pyglotaran, Glotaran/TIMP, or a
  second implementation.

This is acceptable for a visibly labeled preview. It is not sufficient for a
paper claiming publication-grade global or target analysis. The critical path
is therefore numerical correctness, identifiability, reproducibility, and
independent validation. Product polish remains important but cannot substitute
for these gates.

## 2. Required Outcome

Deliver a release in which a spectroscopy researcher can:

1. fit one or many datasets with a true separable nonlinear least-squares
   engine using all selected wavelengths and times;
2. explicitly define fixed, free, bounded, shared, and dataset-specific
   parameters;
3. model Gaussian IRF, time zero, wavelength-dependent center dispersion,
   constant background, and optional coherent-artifact terms without forcing a
   lifetime to the IRF width;
4. inspect convergence, objective history, residual maps and profiles,
   residual SVD, parameter correlations, bounds, and uncertainty intervals;
5. distinguish DAS, model-defined EAS, and target-model SAS correctly;
6. run a sequential or user-defined compartmental target model through the
   same validated engine;
7. save and reopen the exact analysis scheme and result provenance without
   silently refitting it with a different engine;
8. reproduce benchmark results on macOS and Windows;
9. compare identifiable synthetic and experimental benchmark results with
   pyglotaran and, where practical, TIMP/Glotaran legacy; and
10. export a complete, traceable evidence package suitable for a Digital
    Discovery software manuscript and independent review.

"As mature as Glotaran" means comparable scientific discipline, not a clone or
immediate one-to-one feature count. The required maturity dimensions are:

- validated mathematics;
- explicit models and parameter constraints;
- reliable optimization and failure reporting;
- diagnostics and uncertainty;
- reproducible projects and examples;
- regression-tested releases;
- honest terminology and claim boundaries;
- cross-platform reliability; and
- documentation that lets another laboratory reproduce the work.

## 3. Non-Negotiable Rules

1. Preserve source CSV text and UFS bytes exactly. Never write treatment or fit
   output back into source data.
2. Keep NaN and mask semantics. Never replace missing measurements with zero in
   an objective, SVD, exported scientific table, or archive.
3. Do not label a fixed-grid or coordinate-search result as production global
   analysis.
4. Do not label a transformed decay basis as EAS unless a sequential evolution
   model defines it. Use `EAS preview` until that condition is satisfied.
5. Do not label spectra as SAS unless an explicit target model defines species
   concentrations.
6. Do not define a lifetime lower bound from IRF FWHM. Instrument resolution is
   a diagnostic and identifiability issue, not a lifetime value.
7. Do not use normal equations as the primary linear least-squares solver.
8. Do not return a normal-looking result after optimizer failure, rank
   deficiency, cancellation, non-finite arithmetic, or invalid bounds.
9. Preserve the last valid fit until a replacement fit completes successfully.
10. Keep the current JavaScript fitter available only as a legacy preview while
    the new engine is being validated. Remove it from production paths only
    after the parity and migration gates pass.
11. Use public synthetic or explicitly redistributable data in the repository.
    Private laboratory datasets may be used locally but must not be committed.
12. Do not push, tag, publish, upload data, or create a release without explicit
    maintainer authorization.

## 4. Current Baseline and Gap Inventory

### 4.1 Existing strengths to preserve

- Tauri v2 desktop shell and local-first workflow.
- Immutable source preservation and separate treated matrices.
- CSV and UFS import.
- Dataset folders, notes, drag/reorder, batch processing, comparison, and merge.
- Baseline and polynomial chirp correction with provenance.
- Linked heatmap, spectrum, and kinetic views.
- Compressed `.sflproj` project archive.
- Origin interoperability bundle and Windows integration.
- AI-ready Markdown/project summary direction.
- macOS and Windows build automation.
- Existing JavaScript, Rust shell, Origin bridge, archive, and workflow tests.

### 4.2 Scientific blockers

| Blocker | Current state | Required state |
| --- | --- | --- |
| Nonlinear optimization | Coordinate search in JavaScript | Bounded trust-region/LM-class separable nonlinear least squares |
| Linear solve | Normal equations | Pivoted QR with SVD fallback and rank diagnostics |
| IRF/time zero | Fixed IRF input and heuristic artifact | Fixed/free IRF and time zero, explicit bounds, analytic Gaussian convolution |
| Dispersion | Preprocessing polynomial only | Optional fit-level center-dispersion model with explicit coefficients |
| Pre-zero model | Indicator active only for `t < 0` | Explicit full-range background plus optional localized artifact |
| Multi-dataset fit | Per-dataset batch fits | Simultaneous joint objective with shared and local parameters |
| Weights/masks | Finite-value filtering | Explicit mask and noise-weight contract |
| Convergence | Iteration count only | Success flag, reason, evaluations, tolerances, objective history |
| Uncertainty | None | Covariance/rank warning plus profile or bootstrap intervals |
| Identifiability | IRF ratio heuristic | Bounds, rank, correlation, profile, restart, and resolution diagnostics |
| Residual analysis | Residual matrix and RMSE | Profiles, whitened residuals, SVD, autocorrelation, hotspot evidence |
| EAS/SAS semantics | Sequential transform always offered | Model-defined outputs and explicit preview labels |
| Target analysis | Fixed-lifetime candidate preview | Validated rate-matrix model fitted through the production engine |
| Archive fidelity | Fit products rebuilt by JS | Versioned scheme/result snapshots with engine fingerprint and checksums |
| Independent validation | None | Locked pyglotaran reference harness plus synthetic truth suite |

### 4.3 Software-engineering blockers

- `parser-core.js` mixes parsing, preprocessing, fitting, target scoring, and AI
  summaries in one file.
- Scientific jobs execute from the frontend and do not have a native job,
  cancellation, or progress contract.
- The current Rust crate contains shell and Origin responsibilities but no
  scientific domain library.
- `package.json` is version `1.0.4`, while user-facing documentation and citation
  metadata may still describe `1.0.2`; release metadata needs one source of
  truth.
- CI has no numerical reference job, no visual regression job, and no physical
  Windows runtime evidence.
- The release remains unsigned/not notarized where noted in current docs.

## 5. Reference Maturity Model

Use Glotaran as a scientific workflow and validation benchmark, not as code to
copy. Also use current pyglotaran as the primary living reference because it is
the supported successor to Glotaran legacy.

Reference capabilities to match or deliberately defer:

| Capability | Publication release | Later maturity |
| --- | --- | --- |
| Partitioned/variable-projection fitting | Required | - |
| Multiple datasets with linked parameters | Required | Rich grouping/linking DSL |
| Gaussian IRF and center dispersion | Required | Multi-Gaussian/measured IRF and width dispersion |
| Constant background and coherent artifact | Required basic model | Damped oscillations, PFID, richer megacomplexes |
| Sequential and parallel decay models | Required | Extensible plugin models |
| User-defined target rate matrix | Required | Large megacomplex composition |
| DAS, model-defined EAS, SAS | Required | Guidance spectra and area constraints |
| Residual map, SVD, convergence history | Required | Extended publication plotting ecosystem |
| Standard errors and rank warnings | Required | Profile likelihood and bootstrap at scale |
| Gold-standard result regression | Required | Broad external example gallery |
| Declarative, versionable model | Required JSON first | Optional YAML and plugin API |
| GUI workflow | Required | Notebook/API companion later |

Primary references for design and validation:

- Glotaran ecosystem and current pyglotaran positioning:
  <https://glotaran.github.io/>
- pyglotaran source and gold-standard validation history:
  <https://github.com/glotaran/pyglotaran>
- pyglotaran paper and scientific-discovery cycle:
  <https://doi.org/10.1007/s43630-023-00460-y>
- Glotaran legacy capability description:
  <https://glotaran.github.io/software/glotaran-legacy/>
- TIMP examples and foundational implementation:
  <https://glotaran.github.io/TIMP/examples.html>

Record exact dependency versions and reference commit/tag in every generated
benchmark report. Do not compare only screenshots or rounded table values.

## 6. Target Architecture

### 6.1 Dependency direction

```text
UI and focused workspaces
        |
        v
frontend scientific adapter and job client
        |
        v
Tauri commands and native job service
        |
        v
Rust scientific domain crate
        |
        +-- model and parameter contracts
        +-- stable linear algebra
        +-- IRF and artifact basis
        +-- variable projection
        +-- nonlinear optimizer
        +-- diagnostics and uncertainty
        +-- target rate-matrix models
        +-- result serialization

Independent Python reference harness
        |
        +-- synthetic-data generator
        +-- SciPy reference calculations
        +-- pinned pyglotaran comparison
        +-- optional TIMP comparison
```

The production scientific engine must not depend on DOM state, Tauri window
objects, project UI state, or Origin. Tauri commands adapt native types to the
engine. The Python harness validates but is never bundled as the user-facing
runtime.

### 6.2 Proposed repository layout

```text
src/
  lib/
    scientific-client.js
    fit-result-adapter.js
    analysis-scheme.js
    diagnostics-view-model.js

src-tauri/src/
  scientific/
    mod.rs
    error.rs
    types.rs
    parameters.rs
    dataset.rs
    weights.rs
    linear.rs
    irf.rs
    artifacts.rs
    decay_model.rs
    target_model.rs
    varpro.rs
    optimizer.rs
    diagnostics.rs
    uncertainty.rs
    result.rs
    registry.rs
    job.rs
  commands/
    scientific.rs

src-tauri/tests/
  scientific_*.rs

validation/
  README.md
  pyproject.toml
  uv.lock
  references/
    generate_synthetic.py
    run_scipy_reference.py
    run_pyglotaran_reference.py
    compare_results.py
  fixtures/
    manifest.json
  expected/
  reports/

tests/
  analysis-scheme.test.js
  fit-result-adapter.test.js
  project-fit-migration.test.js
  diagnostics-view-model.test.js
```

If Claude Code chooses different filenames, keep these ownership boundaries and
document the deviation in an ADR.

### 6.3 Dependency selection rule

Before adding numerical crates, create
`docs/adr/0007-rust-numerical-stack.md`. Evaluate at least:

- matrix ownership and contiguous column/row access;
- pivoted QR and SVD availability;
- nonlinear least-squares support;
- special functions needed for stable ex-Gaussian evaluation;
- Windows/macOS build behavior;
- deterministic behavior and thread controls;
- maintenance status;
- license compatibility with MIT distribution; and
- binary size and compile-time cost.

Possible candidates include `nalgebra`, `faer`, `argmin`, a maintained
Levenberg-Marquardt crate, and a maintained special-functions crate. Do not
choose a dependency solely because its API is convenient. Pin versions in
`Cargo.lock`, add license evidence, and add a clean Windows CI build before the
ADR is accepted.

## 7. Canonical Scientific Contracts

### 7.1 Dataset view

The engine receives a flattened contiguous matrix with explicit orientation:

```rust
pub struct FitDataset {
    pub dataset_id: String,
    pub spectral_axis: Vec<f64>,
    pub time_axis: Vec<f64>,
    pub signal: Vec<f64>,          // row-major: spectral rows x time columns
    pub valid_mask: Vec<bool>,
    pub weights: WeightSpecification,
    pub spectral_segments: Vec<SpectralSegment>,
    pub analysis_revision: String,
}
```

Validate axis lengths, monotonicity, units, matrix size, masks, finite weights,
and segment boundaries before optimization. Reject mismatches with structured
errors. Never infer orientation from shape after import.

### 7.2 Analysis scheme v2

Add a versioned serializable scheme. At minimum:

```json
{
  "schema": "specflowlab.analysis_scheme.v2",
  "model": {
    "kind": "decay" ,
    "components": 4,
    "evolution": "parallel"
  },
  "datasets": [
    {
      "datasetId": "...",
      "range": {"timePs": [-2, 5500], "spectral": [480, 780]},
      "weighting": {"kind": "uniform"},
      "timeZeroParameter": "dataset.vis.t0",
      "irfWidthParameter": "instrument.vis.irfFwhm"
    }
  ],
  "parameters": [
    {
      "id": "kinetics.tau1",
      "unit": "ps",
      "start": 0.5,
      "lower": 0.001,
      "upper": 10.0,
      "fixed": false,
      "transform": "log"
    }
  ],
  "irf": {
    "kind": "gaussian",
    "centerDispersion": {
      "kind": "polynomial",
      "referenceSpectralCoordinate": 600,
      "coefficientParameterIds": ["irf.c0", "irf.c1", "irf.c2", "irf.c3"]
    }
  },
  "background": {"kind": "constant"},
  "coherentArtifact": {"kind": "gaussian_derivatives", "orders": [0, 1]},
  "optimizer": {
    "algorithm": "trust_region_varpro",
    "maximumEvaluations": 2000,
    "objectiveTolerance": 1e-10,
    "parameterTolerance": 1e-8,
    "gradientTolerance": 1e-8,
    "multiStartCount": 12,
    "seed": 1729
  }
}
```

Rules:

- parameter IDs are stable and meaningful;
- fixed parameters are removed from the optimizer vector;
- shared parameters use the same ID, not duplicated synchronized values;
- dataset-local parameters have distinct IDs;
- bounds are physical and independent of current start values;
- every transform is reversible and tested at bounds;
- changing component count creates unspecified free starts, not fixed values;
- the scheme contains no UI-only state;
- JSON validation errors identify an exact field path; and
- project archives store the complete scheme snapshot used by each fit.

### 7.3 Fit result v2

Add `specflowlab.fit_result.v2` containing:

- fit ID and parent analysis-revision IDs;
- scheme snapshot and canonical scheme hash;
- engine name, semantic version, git commit, build target, and numerical crate
  versions;
- start and optimized physical parameters;
- bounds, transforms, fixed/shared states, standard errors/intervals;
- success flag, termination reason, iterations, function/Jacobian evaluations,
  elapsed time, and cancellation state;
- weighted and unweighted SSE/RMSE with explicit definitions;
- degrees of freedom and exact parameter-count definition;
- objective history and per-start summary;
- rank, singular values, condition warnings, boundary hits, and correlations;
- CLP amplitudes, DAS, model-defined EAS or SAS;
- residual diagnostics and residual-SVD metadata;
- masks, weights, fitted ranges, and effective point counts;
- IRF/time-zero resolution warnings;
- deterministic seed; and
- checksums for materialized result arrays.

Do not serialize an unsuccessful trial as a completed fit. Store it as a
`FitAttempt` that can be inspected separately.

## 8. Numerical Model Requirements

### 8.1 Separable model

For each dataset `d`, use:

```text
D_d(lambda, t) = sum_j C_d,j(t; theta) S_d,j(lambda)
                 + background_d(lambda)
                 + artifact_d(lambda, t; theta)
                 + error_d(lambda, t)
```

`theta` contains nonlinear parameters. Spectral coefficients and permitted
background/artifact amplitudes are conditionally linear. The objective is the
weighted residual across every valid selected point in every dataset.

### 8.2 Stable linear solve

For each nonlinear proposal:

1. construct the kinetic/artifact design matrix;
2. apply masks and square-root weights;
3. solve conditional linear parameters with column-pivoted QR;
4. use SVD as a rank-revealing fallback;
5. report numerical rank and singular values;
6. reject or warn on rank deficiency according to an explicit tolerance; and
7. never form `X^T X` as the production solution path.

If many wavelengths share a mask pattern, cache the factorization by immutable
design hash and mask pattern. Do not cache across different nonlinear
parameters.

### 8.3 Gaussian IRF convolution

Implement the causal exponential convolved with a normalized Gaussian using an
analytic ex-Gaussian expression, evaluated with overflow-safe branches. Test
against high-accuracy numerical quadrature over:

- negative and positive time;
- `tau / sigma` from `1e-3` to `1e6`;
- zero and non-zero time center;
- very small and large FWHM; and
- limits approaching an un-convolved exponential.

Do not use a fixed 48-step convolution in the production engine.

IRF features required for the publication release:

- Gaussian FWHM fixed or free within bounds;
- time-zero center fixed or free within bounds;
- polynomial center dispersion up to third order around a reference wavelength;
- independent center offsets for dataset groups where instruments differ; and
- an explicit option to turn each term off.

Width dispersion, measured IRF, and multi-Gaussian IRF may be deferred only if
the UI and schema make the limitation explicit.

### 8.4 Background and coherent artifact

Default background is a wavelength-dependent constant over the entire selected
time range. The current `time < 0 ? 1 : 0` step must not be the production
default because it creates an artificial discontinuity at zero.

Support optional localized Gaussian derivative terms at time zero. The model
must record derivative orders and parameter links. Artifact amplitudes are
linear; center/width/dispersion may share the IRF nonlinear parameters.

Provide a user-selectable near-zero exclusion or down-weighting window, but
report its point count and exclude it consistently from all stated fit metrics.

### 8.5 Parameter transforms and constraints

Implement tested transforms for:

- positive parameters;
- finite lower/upper bounds;
- optional ordered lifetimes through positive increments;
- unconstrained centers; and
- fixed parameters removed from optimization.

Never sort lifetime values after an optimizer step. Sorting changes parameter
identity and makes derivatives discontinuous. If ordering is required, encode
it in the parameterization or explicit constraints.

### 8.6 Variable projection and nonlinear optimizer

Implement a residual/Jacobian interface that supports separable nonlinear least
squares. Initial production implementation may use accurate central finite
differences in transformed coordinates if analytic derivatives are not ready,
provided:

- step sizes scale with parameter magnitude and machine precision;
- one-sided differences are used safely near bounds;
- Jacobians are regression-tested against complex-step or high-accuracy
  reference derivatives where applicable;
- evaluation counts are reported; and
- later analytic derivatives can replace it without changing schemas.

Use a bounded trust-region or Levenberg-Marquardt-class optimizer. Required
termination states:

- converged by gradient;
- converged by objective change;
- converged by parameter change;
- maximum evaluations;
- invalid model or non-finite evaluation;
- rank deficient;
- cancelled; and
- internal error.

Only the first three are normal success states, and even they may carry
identifiability warnings.

### 8.7 Multiple starts

Support deterministic multi-start:

- user start plus log-spaced/SVD-informed perturbations;
- stored random seed;
- fixed parameters unchanged;
- starts respecting bounds and ordering;
- independent result summary per start;
- best converged result selected by weighted objective; and
- warning if distinct parameter sets occupy statistically equivalent minima.

Do not hide failed starts. Summarize them in diagnostics.

### 8.8 Simultaneous multi-dataset fitting

Implement a joint objective, not a loop of independent fits. Required linking:

- shared lifetimes across selected datasets;
- shared or dataset-group IRF width;
- dataset-specific time-zero offsets;
- dataset-specific spectral amplitudes/backgrounds/artifacts;
- explicit per-dataset weights; and
- optional shared target rate constants.

Default weighting is per valid observation after defensible noise scaling. Do
not equalize VIS and NIR segment influence silently. Record per-dataset and
per-segment SSE, point count, estimated noise, and objective contribution.

### 8.9 Preprocessing validation

Baseline and chirp are publication-critical because fit correctness depends on
them. Add independent tests for:

- mean, median, and robust pre-zero baseline estimators;
- selected-range-only chirp estimation;
- polynomial coefficient recovery;
- batch correction to one shared physical time-zero target;
- interpolation without extrapolation;
- NaN propagation;
- no mutation outside the derived analysis dataset; and
- correct chirp curve and operation provenance.

The fit-level center-dispersion model must allow fitting uncorrected data or
small residual dispersion. It must not silently duplicate an already applied
chirp correction.

## 9. Diagnostics and Uncertainty

### 9.1 Residual diagnostics

Every valid fit must produce:

- residual matrix with original mask;
- RMS, mean, and maximum absolute residual by wavelength;
- RMS, mean, and maximum absolute residual by time;
- hotspot coordinates resolved in physical units;
- per-dataset and per-segment residual contribution;
- lag-one autocorrelation or runs diagnostic per representative trace; and
- optional residual normalized by a recorded noise model.

### 9.2 Residual SVD

Do not zero-fill missing residuals and call the result an SVD. Initial supported
strategies:

1. exact SVD on a declared fully observed submatrix; or
2. a separately validated masked/iterative method with convergence metadata.

The result must include method, coverage, selected rows/columns, scaling,
singular values, and unavailable reason. Use residual SVD as a structure
diagnostic, not an automatic component-count oracle.

### 9.3 Local covariance and rank

At the optimum:

- compute the weighted Jacobian of the projected residual;
- report singular values and effective rank;
- estimate covariance only when assumptions and rank permit;
- scale covariance by the stated residual variance estimate;
- transform uncertainty back to physical parameter units;
- report the correlation matrix; and
- warn on rank deficiency, high correlation, boundary contact, and non-positive
  covariance.

### 9.4 Profile likelihood

Implement one-dimensional profile intervals for nonlinear parameters:

- fix one parameter at profile points;
- re-optimize all other free parameters;
- use an explicit likelihood/objective threshold;
- expand adaptively until both bounds are found or a physical bound is reached;
- preserve each profile trace for inspection; and
- mark open or multi-modal intervals honestly.

This is the minimum robust interval for the publication release. Bootstrap is
also desirable and becomes required before claims about uncertainty coverage.

### 9.5 Bootstrap

Provide an offline/cancellable bootstrap job with deterministic seed. Support
at least residual bootstrap and parametric Gaussian-noise bootstrap. Record
method, replicate count, success count, failed replicate reasons, and interval
definition. Do not run expensive bootstrap automatically after every fit.

### 9.6 IRF-limited and unresolved classification

Replace the single ratio heuristic with evidence-based status:

- `potentially IRF-limited` when the fitted lifetime is at or below the
  instrumental response scale;
- `IRF-correlated` when absolute correlation with IRF width or time zero exceeds
  a documented threshold;
- `boundary-limited` when the interval reaches a bound;
- `unresolved` when profile/bootstrap width, rank, or restart variation cannot
  support a finite estimate; and
- `resolved` only when interval and stability criteria pass.

Store the evidence and thresholds with the result. Do not hide a component by
default; visualization may offer reversible filtering.

## 10. DAS, EAS, SAS, and Target Analysis

### 10.1 Correct naming

- Parallel exponential decay fit -> DAS.
- Explicit sequential evolution model -> EAS and corresponding concentrations.
- Explicit compartmental target model -> SAS and species concentrations.
- Algebraic transformation without the defining model -> `EAS preview`, never
  definitive EAS.

Update UI, archive, Origin export, AI handoff, and Markdown together. Add schema
tests that reject mislabeled output.

### 10.2 Sequential model

Implement the sequential model directly through its rate matrix and initial
population. Compute concentrations from the matrix exponential and IRF
convolution; solve spectra by variable projection. Validate against analytical
two- and three-state solutions and pyglotaran.

Near-degenerate rates require a stable matrix-exponential path. Do not rely on
the current denominator formula that returns no result near equal lifetimes.

### 10.3 User-defined target model

Add a serializable graph/rate-matrix model:

```text
nodes: species/compartments
edges: first-order transfers with rate parameter IDs
loss edges: explicit sink or ground state
initial population: explicit vector
spectral output: one SAS per observable species
```

Compile the graph to a rate matrix `K`, validate conservation/loss semantics,
and evaluate `C(t) = exp(K t) C(0)` before IRF convolution. Reject disconnected,
dimensionally invalid, population-creating, or non-finite models unless a
documented model type permits them.

### 10.4 Candidate model search

Do not enumerate every arbitrary matrix. Generate candidates under user-defined
constraints:

- component count and initially populated species;
- allowed/forbidden edges;
- maximum edge count;
- reversible-edge policy;
- sink/loss policy;
- rate bounds and shared parameters; and
- known temporal ordering.

Canonicalize graph isomorphisms before fitting. Group candidates that produce
statistically indistinguishable fitted responses or observable subspaces.
Rank shortlists with convergence, weighted objective, AICc/BIC where valid,
residual structure, parameter identifiability, restart/bootstrap stability,
complexity, and held-out prediction. Never rank by rounded RMSE alone.

Target candidate search starts only after the global/target engine and
uncertainty gates pass.

## 11. Project, Job, and UI Integration

### 11.1 Native dataset registry

Avoid repeatedly sending large nested matrices through Tauri JSON IPC. Add a
native dataset registry keyed by dataset ID plus `analysisRevision`. Register a
flattened matrix only when the treated analysis changes. Fit commands refer to
registered dataset IDs and reject stale revisions.

The registry is a cache, not the project source of truth. It may be rebuilt
after project open and must never own the only copy of source or treated data.

### 11.2 Background job contract

Add Tauri commands equivalent to:

```text
register_analysis_dataset
remove_analysis_dataset
start_fit_job
cancel_scientific_job
get_scientific_job_status
start_profile_job
start_bootstrap_job
```

Run numerical work off the UI thread. Emit throttled progress containing stage,
start index, evaluation count, current objective, best objective, and elapsed
time. Cancellation is cooperative and checked at safe boundaries. A cancelled
job must leave no partial fit attached to the dataset.

### 11.3 Fitting workspace

The focused workspace must provide:

- model type: parallel decay, sequential, or target model;
- component count;
- one parameter row per lifetime/rate with start, bounds, fix, and share scope;
- IRF width and time-zero controls;
- center-dispersion controls under Advanced;
- background/artifact model controls under Advanced;
- weighting and selected-range summary;
- multi-start count and seed under Advanced;
- Run, Cancel, and Restore previous result commands;
- progress and exact terminal state; and
- result tabs for summary, residuals, component spectra, convergence,
  correlations, profiles, and multi-starts.

Keep defaults conservative. Hide mathematical detail through progressive
disclosure, not through missing provenance.

### 11.4 Main result panels

After a successful fit:

- show lifetime/rate values with uncertainty and resolution status;
- show a subdued convergence/warning summary;
- default to EAS only when a sequential model defines EAS;
- otherwise default to DAS for a decay model or SAS for a target model;
- keep hide-IRF-limited as a plot-only option; and
- mark results stale when treatment, range, mask, weighting, or scheme changes.

### 11.5 Archive v2 migration

Create a project schema migration that stores:

- scheme and result v2;
- engine fingerprint;
- compact nonlinear and linear result arrays;
- exact component spectra and concentrations needed to inspect the archived
  result;
- diagnostics, uncertainty, objective history, and checksums; and
- parent analysis-revision hash.

Do not silently recompute an archived production fit with a newer engine during
open. If reconstruction is necessary, make it an explicit action and preserve
the archived result. Legacy v1 fits open as `legacy-preview` and remain visibly
labeled until the user refits them with the production engine.

Add semantic round-trip tests. Compression must not duplicate raw sources or
treated matrices.

### 11.6 Export integration

Update CSV/TXT, PNG, Origin, Markdown, and AI packages so every result carries:

- scheme/model name;
- engine/version;
- parameter values and intervals;
- data ranges, masks, and weights;
- convergence and warnings;
- correct DAS/EAS/SAS terminology; and
- provenance IDs linking evidence to datasets and fits.

## 12. Independent Validation Program

### 12.1 Separate generator and fitter

Synthetic data must be generated by independent Python code, not by importing
the Rust model implementation. Store generator version, exact parameters,
random seed, axes, masks, noise model, and expected identifiability class.

### 12.2 Fixture matrix

Generate public fixtures covering:

1. one to six parallel exponentials;
2. two to five sequential states;
3. branched and converging target models;
4. resolved, near-degenerate, and unresolvable lifetimes;
5. lifetimes below, near, and above IRF width;
6. non-zero fixed/free time zero;
7. first- to third-order center dispersion;
8. constant background and Gaussian derivative artifacts;
9. homoscedastic and heteroscedastic noise;
10. random and contiguous missing values;
11. irregular time axes and segmented wavelength axes;
12. fixed, bounded, shared, and dataset-local parameters;
13. simultaneous datasets with different grids and amplitudes;
14. deliberately wrong component counts; and
15. adversarial starts, boundary hits, and cancellation.

### 12.3 Synthetic acceptance thresholds

Use fixture-specific tolerances and justify any exception. Default gates for
well-conditioned high-SNR fixtures:

- median relative lifetime/rate error <= 2%;
- maximum relative lifetime/rate error <= 5%;
- time-zero absolute error <= max(0.02 ps, 0.1 * IRF FWHM);
- fitted IRF FWHM relative error <= 5% when declared identifiable;
- dispersion curve RMS error <= 0.02 ps over the fitted wavelength range;
- objective relative difference from independent reference <= 1e-5;
- fitted matrix relative Frobenius difference <= 1e-4;
- DAS/EAS/SAS correlation with truth >= 0.999 after documented component
  matching and scale convention; and
- repeated run with same seed is deterministic within stored floating-point
  tolerance.

For intentionally unresolvable fixtures, passing means correct warning or open
interval, not forced recovery. A first lifetime exactly equal to IRF because of
a bound or initialization is an explicit regression failure.

### 12.4 pyglotaran parity suite

Pin a specific pyglotaran release and Python environment in `validation/uv.lock`.
For models expressible in both tools:

1. use identical axes, data, masks where supported, IRF convention, starts,
   bounds, and model topology;
2. save full precision parameters and residual metrics;
3. align component labels by model identity, not sorting after the fact;
4. compare objective, fitted matrix, residual, nonlinear parameters, and
   component spectra;
5. record unavoidable convention differences; and
6. fail CI/nightly validation on unexplained drift.

Default parity gates for well-conditioned shared models:

- nonlinear parameters within 1% relative or fixture-specific absolute
  tolerance;
- weighted objective within 1e-4 relative;
- fitted matrix correlation >= 0.99999;
- component spectra correlation >= 0.999 after scale/sign convention; and
- matching qualitative identifiability/boundary warnings.

Do not claim pyglotaran parity for unsupported model features.

### 12.5 Optional TIMP/Glotaran legacy validation

Where a redistributable scripted TIMP example exists, add a second reference
result. Keep R and Java out of the SpecFlowLab runtime. Record exact R, TIMP,
and dependency versions. A manual Glotaran GUI screenshot is supporting
evidence only; the numerical tables and residuals are the comparison source.

### 12.6 Real-data benchmark

Use at least:

- one redistributable public ultrafast TA dataset;
- one sequential-model example from the pyglotaran ecosystem if its license
  permits redistribution or automated download; and
- a local private group dataset for non-committed manual validation.

For private data, commit only a manifest of the validation procedure and a
redacted aggregate report if permission permits.

### 12.7 Uncertainty coverage

For well-conditioned synthetic scenarios, run at least 200 deterministic Monte
Carlo replicates outside per-push CI. For nominal 95% intervals, require a
documented empirical coverage target such as 90-98%, or explain and correct the
method. CI may run a smaller smoke sample; the publication report uses the full
study.

### 12.8 Performance benchmarks

Benchmark:

- 512 x 200, four-component single dataset;
- ten datasets with shared lifetimes;
- profile likelihood for four nonlinear parameters;
- 100-replicate bootstrap; and
- project open/reconstruction with twenty datasets.

Record CPU, OS, thread count, peak resident memory, elapsed time, and engine
commit. Fit jobs must remain cancellable and the UI responsive. Performance
does not relax numerical tolerances.

## 13. Implementation Phases

Implement phases in order. Every phase has its own branch/commit series and
must pass its exit gate before the next phase becomes the active work item.

### Phase 0 - Evidence freeze and ADRs

Tasks:

1. Re-run and record the existing test/build baseline.
2. Capture current JavaScript fitter outputs for safe synthetic and local test
   datasets as `legacy-preview` fixtures; do not bless them as truth.
3. Write ADRs for numerical stack, scheme/result schema, native dataset
   registry, and independent validation environment.
4. Align or explicitly record current version metadata drift.
5. Add a publication-blocker issue checklist linked to this plan.

Exit gate:

- existing behavior is reproducibly captured;
- no private data is committed;
- ADRs are reviewed; and
- no production-fit claim was added.

### Phase 1 - Scientific types, schema, and stable linear algebra

Tasks:

1. Create Rust scientific module boundaries and structured errors.
2. Implement dataset validation, masks, weights, parameters, transforms,
   scheme v2, and result v2 types.
3. Implement pivoted QR and SVD fallback with rank diagnostics.
4. Add JSON schema validation and JS adapters.
5. Add archive migration tests without changing the default fit engine.

Exit gate:

- known linear systems, rank-deficient systems, masks, and weights match NumPy
  references;
- no normal-equation production path exists; and
- schemas round-trip losslessly.

### Phase 2 - IRF, artifacts, and model basis

Tasks:

1. Implement overflow-safe analytic Gaussian/exponential convolution.
2. Implement parallel decay, constant background, Gaussian derivative
   artifact, time zero, and center-dispersion basis.
3. Implement sequential and general target concentration evaluation through a
   stable matrix exponential.
4. Add high-accuracy quadrature and analytical reference tests.
5. Validate baseline/chirp preprocessing independently.

Exit gate:

- basis functions pass the full parameter-range suite;
- near-zero and near-degenerate cases remain finite; and
- chirp/baseline recovery tolerances pass.

### Phase 3 - Production variable-projection optimizer

Tasks:

1. Implement projected residual and weighted objective.
2. Implement transformed finite-difference Jacobian and derivative tests.
3. Integrate bounded trust-region/LM optimization.
4. Add deterministic multi-start, progress, cancellation, and failure states.
5. Run the first synthetic recovery suite.

Exit gate:

- production global decay fits pass synthetic tolerances;
- IRF-pinning regression passes;
- convergence/failure reasons are correct; and
- same seed reproduces the same selected result.

### Phase 4 - Simultaneous datasets and scientific diagnostics

Tasks:

1. Add shared/local parameter graph and joint multi-dataset objective.
2. Add dataset/segment weighting and contribution reports.
3. Add residual profiles, hotspots, exact finite-submatrix residual SVD, and
   autocorrelation diagnostics.
4. Add covariance, rank, correlations, boundary warnings, and resolution
   classification.
5. Add profile likelihood.

Exit gate:

- simultaneous synthetic fits recover shared truth;
- changing dataset order does not change results beyond tolerance;
- residual diagnostics match NumPy; and
- unresolved cases are flagged rather than made plausible.

### Phase 5 - Target models and correct spectra

Tasks:

1. Wire parallel decay to DAS only.
2. Wire sequential rate-matrix fit to model-defined EAS.
3. Wire target graph/rate-matrix fit to SAS.
4. Add graph validation and population/conservation tests.
5. Retire the current fixed-lifetime RK4 target scorer from production UI.

Exit gate:

- known sequential and branched truth fixtures pass;
- near-degenerate sequential rates remain stable;
- terminology tests pass across UI/archive/export; and
- pyglotaran shared-model comparison is within tolerance.

### Phase 6 - Native jobs, UI, and project migration

Tasks:

1. Implement dataset registry and native scientific job commands.
2. Connect fitting workspace with progress/cancel/restore behavior.
3. Add diagnostics, convergence, correlation, and profile views.
4. Add archive v2 migration and legacy-preview labeling.
5. Update Origin and AI exports.
6. Preserve previous valid results on failed/cancelled refit.

Exit gate:

- end-to-end import -> treat -> fit -> save -> open -> inspect -> export passes;
- open does not silently refit archived production results;
- stale result detection passes; and
- UI remains responsive during fit and profile jobs.

### Phase 7 - Independent parity and uncertainty validation

Tasks:

1. Lock the Python reference environment.
2. Implement SciPy and pyglotaran reference runners.
3. Generate gold-standard expected results and machine-readable reports.
4. Implement profile/bootstrap coverage study.
5. Add real public dataset examples and one complete reproducible tutorial.

Exit gate:

- all shared-model parity gates pass or differences are scientifically
  explained and delimited;
- uncertainty coverage report passes;
- no expected result is generated by SpecFlowLab itself; and
- a clean checkout can reproduce the benchmark report.

### Phase 8 - Target candidate search

Tasks:

1. Implement constrained graph generation and canonicalization.
2. Fit candidates with the production target engine.
3. Group observationally/statistically equivalent candidates.
4. Add multi-criterion ranking and held-out validation.
5. Add an expert report explaining why close RMSE values do not prove topology.

Exit gate:

- known synthetic models appear in the supported shortlist;
- equivalent models are grouped;
- incorrect complex models do not win solely from extra parameters; and
- no UI language promises a unique mechanism.

### Phase 9 - Platform, security, and release hardening

Tasks:

1. Add Linux architecture build if feasible, without delaying validated
   macOS/Windows publication evidence.
2. Run physical Windows and macOS clean-machine smoke suites.
3. Add macOS Developer ID signing/notarization and Windows signing plan.
4. Add dependency license/SBOM and vulnerability review.
5. Add project recovery, corrupted archive, out-of-memory, and cancellation
   tests.
6. Add visual regression at minimum supported, common laptop, and full-screen
   sizes.

Exit gate:

- no open critical/high defect;
- clean-machine workflow passes;
- security/recovery checks pass; and
- release limitations are accurate.

### Phase 10 - Expert group pilot and manuscript evidence

Tasks:

1. Recruit 3-6 experienced Glotaran users, ideally from the established
   spectroscopy group relationship.
2. Present SpecFlowLab as a companion workflow first and direct competitor only
   where numerical parity is demonstrated.
3. Run existing datasets through preprocessing, SpecFlowLab fit, and
   Glotaran/pyglotaran reference fit.
4. Measure import success, preprocessing agreement, setup time, batch time,
   fit agreement, diagnostic usefulness, project reopen success, and usability
   defects.
5. Record protocol, anonymized findings, fixes, and remaining limitations.
6. Freeze a versioned code/data/environment snapshot with DOI.

Exit gate:

- independent expert users reproduce at least two complete workflows;
- major scientific discrepancies are resolved or disclosed;
- paper figures/tables are generated from scripts; and
- archived data/code can reproduce the manuscript results.

## 14. Test and CI Matrix

### 14.1 Per-push CI

- JavaScript unit/integration tests.
- Rust format, clippy, unit, property, and integration tests.
- Frontend production build.
- macOS and Windows compilation.
- reduced synthetic numerical suite.
- archive migration/round-trip suite.
- schema and terminology tests.
- no-private-fixture/path scan.

### 14.2 Scheduled/nightly CI

- full synthetic fixture matrix;
- pyglotaran parity suite;
- uncertainty smoke study;
- multi-start robustness;
- performance regression;
- sanitizer/memory checks where supported; and
- dependency/security scan.

### 14.3 Release CI/manual gates

- full 200-replicate uncertainty study;
- clean macOS/Windows installation and WebView2 test;
- save/open/export with a 20-dataset project;
- physical cancellation/recovery test;
- Origin interoperability smoke on supported Windows/Origin versions;
- signed artifact verification and checksums;
- exact version consistency across package, Cargo, Tauri config, README,
  changelog, citation metadata, and in-app About; and
- reproducibility report regenerated from the release tag.

## 15. Publication Evidence Package

Create `publication/` only after Phase 7 begins:

```text
publication/
  README.md
  environment/
  scripts/
  synthetic/
  reference-comparison/
  real-data-case-studies/
  usability-pilot/
  tables/
  figures/
  reports/
```

Required evidence:

1. Architecture and data/provenance workflow diagram.
2. Synthetic recovery table across resolution/noise/missingness conditions.
3. SpecFlowLab versus pyglotaran/TIMP parameter and objective comparison.
4. IRF-pinning regression showing that `tau1` is not forced to FWHM.
5. Residual map, profiles, and residual SVD for correct and underfit models.
6. Multi-start and profile-likelihood evidence.
7. Multi-dataset shared-parameter case study.
8. Sequential EAS and target SAS case studies with correct terminology.
9. Save/open provenance and archive-size benchmark.
10. macOS/Windows workflow evidence.
11. Expert-user pilot protocol and results.
12. Machine-readable limitations and claim table.

Every figure and table must be generated by a script from archived inputs. No
manual spreadsheet transcription is allowed for manuscript numbers.

## 16. Publication Claim Gate

The following claims are forbidden until their evidence row passes:

| Claim | Minimum evidence |
| --- | --- |
| Publication-grade global analysis | Phases 1-7 complete; parity and uncertainty gates pass |
| Comparable to Glotaran for supported global models | Shared-model pyglotaran/TIMP parity report plus expert pilot |
| Target analysis | Validated rate-matrix engine and known-truth target fixtures |
| Automated target-model ranking | Equivalence grouping, identifiability, and multi-criterion validation |
| Cross-platform | Physical clean-machine workflow on each named platform |
| Reproducible projects | Archive v2 migration, semantic round-trip, engine/result provenance |
| Reliable uncertainty | Coverage study, not only local covariance output |
| AI-ready scientific reasoning | Evidence package traceability and no unsupported automatic interpretation |

Until then, use terms such as `preview`, `experimental`, `supported subset`, or
`validation in progress` exactly where applicable.

## 17. Commit and Review Strategy

Prefer small scientific commits with one main responsibility:

```text
test: add independent ex-Gaussian reference vectors
feat(science): add stable Gaussian-exponential convolution
test: add masked pivoted-QR rank fixtures
feat(science): add variable-projection linear solve
feat(science): add bounded nonlinear optimizer
feat(project): add analysis scheme and fit result v2
feat(ui): connect native fit job progress and cancellation
docs: add pyglotaran parity report
```

For every numerical change, the test/reference commit should be reviewable
separately or included in the same commit. Do not mix numerical changes with
large CSS or unrelated workflow refactors. Do not regenerate golden reference
files merely to make failing tests green; explain every reference change.

## 18. Claude Code Execution Protocol

Claude Code must work one phase at a time. The active task is the first phase
whose exit gate is not satisfied. Do not attempt all phases in one uncontrolled
patch.

Before editing:

1. read `../SOFTWARE_ENGINEERING_SPECIFICATION.md`;
2. read this plan;
3. read `docs/REPRODUCIBILITY.md` and relevant current tests;
4. inspect `git status` and preserve unrelated changes;
5. identify the exact phase, requirements, files, and scientific risks;
6. run the narrow baseline tests; and
7. state assumptions without asking the user unless execution is impossible or
   destructive.

Use this loop:

```text
SELF-CHECKING LOOP: SPECFLOWLAB PUBLICATION READINESS

TASK:
Implement the active phase or one explicitly assigned work item from
docs/CLAUDE_CODE_PUBLICATION_READINESS_PLAN.md.

SUCCESS CRITERIA (strict, no soft passes):
- The phase's stated deliverables and exit gate are satisfied.
- Scientific equations, units, masks, weights, and parameter semantics are explicit.
- Independent reference tests exist for numerical behavior.
- Source data and project provenance invariants remain intact.
- Failure, cancellation, bounds, rank deficiency, and non-finite cases are tested.
- Existing tests and builds remain green.
- Documentation describes only implemented and verified behavior.

LOOP PROTOCOL:
1. PLAN
   - State the single next step.
   - Name the protected requirement/invariant.
   - Identify the weakest score from the last pass.
2. DO
   - Implement one coherent increment.
   - Keep scientific logic outside UI handlers.
   - Add the smallest independent test that can falsify the implementation.
3. VERIFY
   Score 1-10 and state exact weaknesses for:
   - scientific correctness;
   - independent numerical validation;
   - identifiability and uncertainty;
   - data integrity and provenance;
   - architecture and maintainability;
   - failure/cancellation behavior;
   - project migration and reproducibility;
   - cross-platform behavior;
   - automated test evidence;
   - documentation and claim honesty.
4. DECIDE
   - If every applicable score is 8+ and the active exit gate passes, print
     PHASE FINAL and stop that phase.
   - Otherwise print ITERATING and fix the weakest score first.

RULES:
- Never call a plausible plot numerical validation.
- Never bless SpecFlowLab-generated data as an independent reference.
- Never update a golden result without explaining the scientific difference.
- Never hide an optimizer failure behind a rounded RMSE.
- Never replace NaN with zero.
- Never silently refit an archived production result during project open.
- Never export definitive EAS or SAS without its defining model.
- Never push, tag, release, or upload without explicit approval.
- Do not ask routine questions. Make the most conservative documented assumption.
```

## 19. Required Phase Completion Report

For every completed phase, Claude Code must report:

1. phase and exit gate;
2. changed files;
3. scientific equations or conventions implemented;
4. dependency/ADR changes;
5. test commands and exact pass counts;
6. independent reference source and version;
7. maximum numerical errors against tolerance;
8. masks/NaNs/weights behavior;
9. project schema or migration behavior;
10. cancellation/failure evidence;
11. platform builds actually run versus only structurally inferred;
12. remaining limitations and next active phase; and
13. confirmation that no private data, push, tag, release, or upload occurred.

## 20. Final Definition of Done

Do not call the publication-readiness program complete until all are true:

- [ ] Production fit path uses validated variable projection and stable linear algebra.
- [ ] Single- and multi-dataset models support explicit fixed/free/bounded/shared parameters.
- [ ] IRF, time zero, center dispersion, background, and artifact semantics are tested.
- [ ] First lifetime is never mathematically pinned to IRF FWHM.
- [ ] Convergence and failure states are explicit.
- [ ] Residual profiles and residual SVD are available with honest mask handling.
- [ ] Rank, correlations, profile intervals, and bootstrap evidence exist.
- [ ] DAS, EAS, and SAS labels follow their defining models.
- [ ] Sequential and user target models pass known-truth fixtures.
- [ ] Candidate search groups equivalent/indistinguishable models and uses more than RMSE.
- [ ] Project archives preserve scheme, result, engine, diagnostics, and checksums.
- [ ] Legacy preview fits remain identifiable and are never silently promoted.
- [ ] pyglotaran parity gates pass for every claimed shared model.
- [ ] At least one public real-data workflow is fully reproducible.
- [ ] macOS and Windows clean-machine workflows pass.
- [ ] Expert Glotaran users complete the pilot and discrepancies are resolved or disclosed.
- [ ] Release metadata is consistent and artifacts are signed/notarized as claimed.
- [ ] Manuscript figures/tables regenerate from the archived release snapshot.
- [ ] `docs/REPRODUCIBILITY.md`, README, in-app Manual, and citation metadata match reality.
- [ ] No critical/high defect or unsupported scientific claim remains.

Only then may the manuscript describe SpecFlowLab as a mature,
publication-grade analysis environment for its explicitly supported model set.
