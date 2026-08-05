# Release checklist

Use this checklist for each public release.

- [ ] Update package.json, src-tauri/tauri.conf.json, CHANGELOG.md, and
      CITATION.cff.
- [ ] Run npm test, npm run test:origin, npm run build, and native smoke tests
      available on the release machine.
- [ ] Rebuild macOS and Windows artifacts on their target platforms.
- [ ] Generate SHA-256 checksums and verify extraction.
- [ ] Create an annotated Git tag such as v1.0.0.
- [ ] Publish the tag and attach platform artifacts to a GitHub Release.
- [ ] Connect the repository to Zenodo and record the DOI in README.md and
      CITATION.cff.
- [ ] Add the public repository-code URL to CITATION.cff.
- [ ] Record unsigned, ad-hoc-signed, WebView2, OriginPro, and notarization
      limitations explicitly.

The initial source repository intentionally excludes large release binaries.
GitHub Releases are the durable home for those assets.
