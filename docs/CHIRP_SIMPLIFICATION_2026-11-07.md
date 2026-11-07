# Chirp simplification: plan and implementation

This Astra plan and Terra implementation supersede the earlier quality-gate plan.

The analysis cursor supplies the initial original-axis time and reference wavelength on each dialog opening. For a corrected display the actual applied shift is added back. Dataset-only is the default; folder application remains explicit. Both values can be edited independently.

The current crop is fitted using sign-insensitive local slopes and a free-intercept low-order polynomial at the selected reference. Narrow-window search widens when arrivals are insufficient or cluster at the window edge. Reduced-degree and seed-only fallbacks allow weak signals to proceed; residual and signal-support concerns are advisory, not qualification gates. Reference wavelength is a polynomial parameterization choice, not a claim of Glotaran-equivalent joint optimization. A seed-only result estimates no wavelength dependence.

Rebuilds always start from base analysis. Non-finite models, malformed data, and zero finite overlap remain hard failures; partial overlap is allowed, and interpolation never bridges missing values. A retry replaces the affected analysis and clears its fit; siblings are untouched. Existing archives retain materialized data and legacy overlay metadata, while new chirp settings persist the selected reference without a schema change.

Validation includes synthetic signed, nonlinear, sparse, no-baseline and missing-data cases, archive tests, and an opt-in read-only project audit. Browser and platform verification are separate checks.

## Final integration verification

The main agent independently verified the completed Terra revision:

- 168 JavaScript unit tests, 22 browser tests (including the supplied eight-dataset project), 11 Origin bridge tests, and 48 Rust native-shell tests passed.
- The real-project browser check compares saved corrections against fresh calculations from the original base matrices, with identical missing-value masks and less than 1e-12 maximum finite-signal difference. Local retries preserve sibling analyses/fits and clear the affected fit; settings and results survive save/reopen.
- All eight datasets completed chirp and baseline treatment. This verifies application and persistence, not independent instrumental accuracy; the user can inspect the curve and retry with another cursor seed or crop.
- The original project SHA-256 remains `a3bcb148618cbad980d0dfa901f0e06f05fadec418493800d82045eb0a8f1afb`.
- The production frontend and macOS arm64 application built successfully. The ad-hoc application signature and portable ZIP integrity verify; the app is not notarized. Native interactive GUI verification and Windows packaging were not performed in this revision.
- Local test package: `releases/SpecFlowLab-1.0.9-chirp-cursors-20261107-macOS-arm64-portable.zip`, SHA-256 `3ef5fd488ffcba7f626d8887dbdb9d4dbb17aa53e6130f24a10d1cc6c14c3417`.

Launch the newly extracted app before opening a project, to avoid the older installed copy handling the file association. Saved results are preserved on opening; choose a cursor near the desired arrival and use Chirp / Apply to refit. On an already corrected display, the original-input t0 field includes the existing applied shift at the selected wavelength.

No original project was overwritten, installed app replaced, commit made, or release uploaded. The simplification skill kept the change within existing polynomial fitting and interpolation facilities without new dependencies.
