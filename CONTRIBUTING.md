# Contributing to SpecFlowLab

Thanks for helping improve a scientific desktop application. Small, focused
pull requests are easiest to review and reproduce.

## Development setup

    npm ci
    npm test
    npm run test:origin
    npm run build

For native-shell work, install Rust and the Tauri prerequisites for your
platform, then run npm run tauri:dev.

## Scientific-data rules

- Do not commit private or identifiable experimental data.
- Preserve raw source text/binary, NaNs, metadata, masks, and provenance.
- Make transformations explicit and reversible where possible.
- Keep numerical claims within the tested validation boundary; the current
  nonlinear fit is a preview and is not publication-grade.
- Add a deterministic regression test for parser, archive, merge, or numerical
  behavior changes.

## Pull requests

Describe the user-visible change, the scientific/data-integrity implications,
commands run, and any platform-specific limitation. Screenshots or a short
screen recording are welcome for UI changes.
