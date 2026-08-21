# SpecFlowLab 1.0.6

SpecFlowLab 1.0.6 introduces a new global-analysis preview core intended for
direct experimental comparison with pyglotaran/Glotaran outputs.

## Global analysis

- Separable variable-projection architecture with wavelength-dependent
  conditional linear parameters solved by column-pivoted QR.
- Bounded deterministic multi-start optimization of shared lifetimes in log
  space.
- Analytic Gaussian-IRF-convolved causal exponential bases.
- Smooth wavelength-dependent pre-zero envelope and slope instead of forcing
  negative-time signal to constant zero.
- Selectable Gaussian coherent-artifact terms through second derivative.
- Robust noise weighting, rank and condition estimates, convergence metadata,
  near-equivalent-start checks, and time-range edge-omission refits.

## Lifetime uncertainty

- One-standard-error uncertainty from the finite-difference Jacobian of the
  profiled weighted residual in log-lifetime coordinates.
- Residual-variance scaling using explicitly reported residual degrees of
  freedom.
- 95% log-Wald confidence intervals, covariance, correlations, Jacobian rank,
  and condition estimate.
- Explicit fixed, unavailable, boundary-limited, high-correlation, and weak-
  identifiability states. Fixed lifetimes never receive fabricated intervals.
- Uncertainty metadata is retained in project, AI-investigation, and Origin
  handoffs while interpreted IRF-limited components remain excluded.

## Other included work

- Noise-aware signed multi-Gaussian EAS/DAS feature candidates using local
  noise and residual/BIC improvement rather than a global component maximum.
- Session-only chart Evidence Tray with explicit `.sflai` inclusion.
- External evidence workspace and evidence-graph packaging improvements.
- OriginPro executable-selection and legacy COM bridge hardening.

## Scientific and packaging limitations

- Lifetime intervals are local and conditional on the selected kinetic model,
  time/wavelength range, weights, IRF, preprocessing, and converged optimum.
  They have not yet passed an independent uncertainty-coverage study.
- This release is not yet feature-equivalent to TIMP or pyglotaran: profile
  likelihood, bootstrap coverage, residual SVD, target-model optimization, and
  simultaneous shared-parameter multi-dataset fitting remain future work.
- `EAS preview` assumes a sequential transform and is not species proof.
- macOS builds are arm64 and ad-hoc signed, not Apple-notarized.
- Windows builds are x86-64 and unsigned; Windows/WebView2 and licensed
  OriginPro behavior still require target-machine testing.

## Validation before release

- 108 JavaScript tests.
- 11 Python Origin bridge tests.
- 45 Rust/Tauri tests.
- Rust formatting and warning-free Clippy checks.
- Production frontend build.
- macOS arm64 application build, signature verification, ZIP extraction check,
  and packaged-application startup smoke test.
