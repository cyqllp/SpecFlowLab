# Engineering notes

The desktop shell is deliberately layered:

- src/lib contains parser, archive, merge, Origin-bundle, and scientific data
  contracts that do not depend on the DOM, Tauri, or GUI automation.
- src/main.js and src/styles provide the browser/Tauri presentation layer.
- src-tauri provides native dialogs and platform integration.
- integrations/origin is a thin adapter over the portable .sflorigin contract.

When changing scientific behavior, preserve the distinction between source,
treated, and derived data. Record masks, transformations, merge lineage, and
warnings rather than silently changing a signal. When changing numerical code,
add a deterministic fixture and state the validation boundary in the README.

The OriginPro bridge is Windows-only at runtime and targets OriginPro 2021 or
newer. The parser and bundle contract remain usable on other platforms.
