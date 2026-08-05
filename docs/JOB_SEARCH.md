# Portfolio and job-search brief

## One-line project description

SpecFlowLab is a provenance-preserving desktop application that turns
time-resolved spectroscopy data into inspectable, reproducible analysis
projects and interoperates with OriginPro without hiding raw data.

## What this demonstrates

- Product engineering: a Tauri v2 desktop shell, focused scientific
  workspaces, bilingual UI, native save dialogs, and portable archives.
- Data engineering: CSV/text and UFS parsing, immutable source records,
  Float64 matrix handling, metadata retention, and deterministic round trips.
- Scientific computing: calibrated time axes, VIS/NIR resampling, hard spectral
  joins, overlap diagnostics, wavelength breaks, and fit-result provenance.
- Integration design: a versioned .sflorigin contract with a thin OriginPro
  2021 Python adapter instead of coupling the core to GUI automation.
- Quality practice: JavaScript, Python, and Rust tests; build checks; release
  checksums; a public-beta validation boundary; and reproducible examples.

## Interview talking points

1. Why preserve source data separately from treated and derived data?
2. Why should VIS/NIR parents be globally fitted with shared lifetimes and
   separate amplitudes instead of allowing the denser segment to dominate?
3. How do explicit provenance and wavelength-break metadata prevent a visually
   smooth but scientifically fabricated spectrum?
4. Which gaps must be closed before claiming publication-grade fitting?

## Honest scope

This is a credible public beta and a strong engineering/scientific-software
portfolio project, not a claim of a new photophysical theory. The README and
reproducibility note deliberately separate implemented behavior from numerical
work that still needs stronger validation.
