import { invoke } from "@tauri-apps/api/core";
import "./lib/parser-core.js";
import {
  createProjectArchive,
  hydrateProjectArchive,
  readProjectArchive,
} from "./lib/project-archive.js";
import { createOriginBundle } from "./lib/origin-bundle.js";
import {
  createMergedAnalysis,
  mergePreviewSeries,
  prepareMergePlan,
} from "./lib/dataset-merge.js";
import { spectroscopySourceToCsv } from "./lib/source-data.js";
import {
  SUPPORTED_LOCALES,
  localizeDom,
  normalizeLocale,
  preferredLocale,
  saveLocale,
  translateText,
} from "./lib/i18n.js";
import "./styles/app.css";
import appIconUrl from "./assets/specflowlab-icon.svg";

const Parser = globalThis.SpecFlowLabParser;
const app = document.getElementById("app");
const APP_VERSION = "1.0.0";
const plotGeometry = new WeakMap();

const state = {
  locale: preferredLocale(),
  folders: [],
  datasets: [],
  editingFolderId: null,
  activeIndex: 0,
  selectedTimeIndex: 0,
  selectedWavelengthIndex: 0,
  compare: {
    stage: "select",
    selectedIds: [],
    timeIndex: 0,
    wavelengthIndex: 0,
    normalize: "none",
    lineWidth: 2.2,
    lineStyle: "solid",
    componentMode: "EAS",
    hideIrfLimited: false,
    styles: {},
  },
  merge: {
    selectedIds: [],
    plan: null,
    draft: null,
  },
  fitting: {
    components: 3,
    irfFwhm: 0.25,
    spectrumMode: "EAS",
    normalize: "none",
    hideIrfLimited: false,
    editorDatasetId: null,
    lifetimeValues: [],
    fixedLifetimes: [],
  },
  project: {
    dirty: false,
    lastSavedAt: null,
    path: null,
  },
  origin: {
    outputMode: "sheets-plots",
  },
  modal: null,
  expandedPlot: null,
  plotZooms: {},
  zoomSelectionKey: null,
  zoomDrag: null,
  pendingDeleteId: null,
  pendingDatasetId: null,
  datasetMenu: null,
  folderMenu: null,
  plotMenu: null,
  datasetClipboard: null,
  importTargetFolderId: null,
  job: null,
  notice: null,
};

function render() {
  pruneMergeSelection();
  const datasetTreeScrollTop =
    document.querySelector(".dataset-tree-scroll")?.scrollTop ?? 0;
  const dataset = activeDataset();
  const busy = Boolean(state.job);
  app.innerHTML = `
    <aside class="side">
      <section class="brand">
        <div class="mark"><img src="${appIconUrl}" alt="" /></div>
        <div class="brand-copy">
          <h1>SpecFlowLab</h1>
          <p>Version ${APP_VERSION}</p>
          <div class="brand-product-actions">
            <button data-action="open-manual">Manual</button>
            <button data-action="open-about">About</button>
          </div>
        </div>
        <label class="language-control">
          <span class="visually-hidden">Language</span>
          <select id="language-select" aria-label="Language">
            ${SUPPORTED_LOCALES.map((locale) => `<option value="${locale.code}" ${state.locale === locale.code ? "selected" : ""}>${locale.label}</option>`).join("")}
          </select>
        </label>
      </section>

      <section class="panel sidebar-panel project-panel">
        <div class="section-heading">
          <h2>Project</h2>
          <span class="state-label ${state.project.dirty ? "warning" : ""}">${projectStateLabel()}</span>
        </div>
        <div class="context-actions two">
          <label class="button-like">
            <input id="project-input" type="file" accept=".sflproj,.sfl.json,.json,application/zip,application/json" />
            <span>Open Project</span>
          </label>
          <button data-action="save-project" ${state.datasets.length && !busy ? "" : "disabled"}>Save Project</button>
        </div>
        <dl class="metric-list compact-metrics">
          <div><dt>Datasets</dt><dd>${state.datasets.length}</dd></div>
          <div><dt>Treated</dt><dd>${state.datasets.filter(isTreated).length}</dd></div>
          <div><dt>Fitted</dt><dd>${state.datasets.filter((item) => item.fit).length}</dd></div>
        </dl>
      </section>

      <section class="panel sidebar-panel folder-rail-panel">
        <div class="section-heading">
          <h2>Dataset Folders</h2>
          <div class="section-heading-actions">
            <button class="compact-icon-button" data-action="new-folder" title="Create dataset folder" aria-label="Create dataset folder">+</button>
            <label class="small-file primary-file">
              <input id="file-input" type="file" accept=".csv,.txt,.tsv,.asc,.ufs,text/csv,text/plain,application/octet-stream" multiple />
              <span>Import Data</span>
            </label>
            <input id="folder-file-input" class="hidden-file-input" type="file" accept=".csv,.txt,.tsv,.asc,.ufs,text/csv,text/plain,application/octet-stream" multiple />
          </div>
        </div>
        <div class="dataset-tree-scroll">${renderDatasetFolders()}</div>
        <button class="wide-command" data-action="compare" ${state.datasets.length > 1 && !busy ? "" : "disabled"}>Compare...</button>
      </section>

      <section class="panel sidebar-panel handoff-panel">
        <div class="section-heading">
          <h2>AI Handoff</h2>
        </div>
        <button class="wide-command" data-action="export-md" ${dataset && !busy ? "" : "disabled"}>Export MD...</button>
      </section>

      <section class="panel sidebar-panel handoff-panel">
        <div class="section-heading">
          <h2>OriginPro</h2>
        </div>
        <label class="inline-select origin-mode-select"><span>Output</span><select id="origin-output-mode" ${busy ? "disabled" : ""}>
          <option value="sheets-plots" ${state.origin.outputMode === "sheets-plots" ? "selected" : ""}>Sheets and plots</option>
          <option value="sheets-only" ${state.origin.outputMode === "sheets-only" ? "selected" : ""}>Only sheets</option>
        </select></label>
        <button class="wide-command" data-action="create-origin" ${dataset && !busy && isTauriRuntime() && isWindowsPlatform() ? "" : "disabled"}>Create in OriginPro...</button>
      </section>
    </aside>

    <section class="workspace">
      ${renderFeedback()}
      ${renderOverview()}
    </section>

    ${state.modal ? renderModal() : ""}
    ${state.expandedPlot ? renderExpandedPlot() : ""}
    ${state.datasetMenu ? renderDatasetContextMenu() : ""}
    ${state.folderMenu ? renderFolderContextMenu() : ""}
    ${state.plotMenu ? renderPlotContextMenu() : ""}
  `;
  localizeDom(app, state.locale);
  bindDom();
  const datasetTree = document.querySelector(".dataset-tree-scroll");
  if (datasetTree) datasetTree.scrollTop = datasetTreeScrollTop;
  positionContextMenus();
  paintCanvases();
}

function renderDatasetFolders() {
  if (!state.folders.length) return "<p class=\"list-empty\">Import files or create a folder such as VIS or IR.</p>";
  return `
    <ul class="folder-tree">
      ${state.folders.map((folder) => {
        const datasets = folderDatasets(folder.id);
        return `
          <li class="folder-node ${folder.collapsed ? "collapsed" : ""}" data-folder-drop="${escapeHtml(folder.id)}">
            <div class="folder-heading" data-folder-id="${escapeHtml(folder.id)}">
              <button class="folder-toggle" data-action="toggle-folder" data-folder-id="${escapeHtml(folder.id)}" aria-label="${folder.collapsed ? "Expand" : "Collapse"} ${escapeHtml(folder.name)}">${folder.collapsed ? "\u25b8" : "\u25be"}</button>
              ${state.editingFolderId === folder.id
                ? `<input class="folder-name-input" data-folder-id="${escapeHtml(folder.id)}" value="${escapeHtml(folder.name)}" aria-label="Rename folder" />`
                : `<button type="button" class="folder-name-display" data-i18n-skip data-folder-id="${escapeHtml(folder.id)}" title="Double-click to rename">${escapeHtml(folder.name)}</button>`}
              <span class="folder-count">${datasets.length}</span>
              <button class="dataset-delete" data-action="delete-folder" data-folder-id="${escapeHtml(folder.id)}" title="Delete empty folder" aria-label="Delete ${escapeHtml(folder.name)} folder" ${datasets.length ? "disabled" : ""}>\u00d7</button>
            </div>
            <ol class="dataset-list">
              ${datasets.length ? datasets.map((item) => {
                const index = state.datasets.indexOf(item);
                return `
                  <li class="dataset-row" data-dataset-id="${escapeHtml(item.id)}">
                    <button type="button" class="dataset-drag-handle" title="Drag to move dataset" aria-label="Drag ${escapeHtml(datasetDisplayName(item))} to another folder">&#8942;&#8942;</button>
                    <label class="dataset-merge-select" title="${isMergeReadyDataset(item) ? "Select for merge" : "Treat the dataset before merging"}">
                      <input class="merge-check" type="checkbox" data-merge-id="${escapeHtml(item.id)}" aria-label="Select ${escapeHtml(datasetDisplayName(item))} for merge" ${state.merge.selectedIds.includes(item.id) ? "checked" : ""} ${isMergeReadyDataset(item) ? "" : "disabled"} />
                    </label>
                    <button class="dataset-activate ${index === state.activeIndex ? "active" : ""}" data-action="activate" data-dataset-id="${escapeHtml(item.id)}" title="${escapeHtml(datasetDisplayName(item))}">
                      <span data-i18n-skip>${escapeHtml(datasetDisplayName(item))}</span>
                      <small>${datasetStateLabel(item)}</small>
                    </button>
                    <button class="dataset-delete" data-action="delete-dataset" data-dataset-id="${escapeHtml(item.id)}" title="Remove from project" aria-label="Remove ${escapeHtml(datasetDisplayName(item))} from project">\u00d7</button>
                  </li>`;
              }).join("") : "<li class=\"folder-empty\">Drop datasets here</li>"}
            </ol>
          </li>`;
      }).join("")}
    </ul>`;
}

function renderRangeControls(dataset, folder) {
  const analysis = dataset.analysis;
  const range = folder?.range ?? rangeFromAnalysis(analysis);
  return `
    <div class="range-grid">
      <label><span>Wavelength min</span><input id="range-wavelength-min" type="number" step="any" value="${inputValue(range.wavelengthMin)}" /></label>
      <label><span>Wavelength max</span><input id="range-wavelength-max" type="number" step="any" value="${inputValue(range.wavelengthMax)}" /></label>
      <label><span>Time min</span><input id="range-time-min" type="number" step="any" value="${inputValue(range.timeMin)}" /></label>
      <label><span>Time max</span><input id="range-time-max" type="number" step="any" value="${inputValue(range.timeMax)}" /></label>
    </div>
    <button class="wide-command secondary-command" data-action="apply-range" ${state.job ? "disabled" : ""}>Apply Range to Folder</button>
  `;
}

function renderTreatmentHistory(dataset) {
  const provenance = dataset.analysis.provenance ?? [];
  if (!provenance.length) return "<p class=\"history-line\">Imported analysis range. No treatment applied.</p>";
  return `
    <ul class="history-list">
      ${provenance.map((item) => `<li><span></span>${escapeHtml(item.label)}${item.status === "skipped" ? " skipped" : ""}</li>`).join("")}
    </ul>
  `;
}

function renderFeedback() {
  if (state.job) {
    return `<section class="feedback processing"><span class="spinner"></span><strong>${escapeHtml(state.job.label)}</strong><span>${escapeHtml(state.job.detail ?? "")}</span></section>`;
  }
  if (state.notice) {
    return `<section class="feedback ${state.notice.kind ?? "info"}"><strong>${escapeHtml(state.notice.title)}</strong><span>${escapeHtml(state.notice.message ?? "")}</span></section>`;
  }
  return "";
}

function renderOverview() {
  const dataset = activeDataset();
  if (!dataset) {
    return `
      <section class="empty">
        <h3>SpecFlowLab workspace</h3>
        <p>Open a project or import spectroscopy CSV or UFS files. Original source data remains unchanged while analysis versions are treated separately.</p>
      </section>
    `;
  }

  const analysis = dataset.analysis;
  const folder = activeFolder();
  return `
    <section class="analysis-layout">
      <div class="primary-column">
        <section class="panel info-treatment-panel">
          <div class="active-dataset-heading">
            <div>
              <span class="folder-context" data-i18n-skip>${escapeHtml(folder?.name ?? "Unfiled")}</span>
              <h2 data-i18n-skip title="${escapeHtml(datasetDisplayName(dataset))}">${escapeHtml(datasetDisplayName(dataset))}</h2>
              <p>${datasetStateLabel(dataset)} analysis dataset</p>
            </div>
            <div class="active-dataset-actions">
              <span class="merge-selection-copy">${state.merge.selectedIds.length} selected</span>
              <span class="dataset-badge">${analysisRangeLabel(analysis)}</span>
            </div>
          </div>
          <div class="info-metrics">
            <span><small>Source</small><strong>${dataset.source.sourceShape.rows} x ${dataset.source.sourceShape.cols}</strong></span>
            <span><small>Analysis</small><strong>${analysis.spectralAxis.length} x ${analysis.timeAxis.length}</strong></span>
            <span><small>Time</small><strong>${formatCoordinate(analysis.timeAxis[0])} to ${formatCoordinate(analysis.timeAxis.at(-1))} ps</strong></span>
            <span><small>Folder treatment</small><strong>${treatmentLabel(folder)}</strong></span>
          </div>
          <div class="treatment-layout">
            <div>${renderRangeControls(dataset, folder)}</div>
            <div class="treatment-actions">
              <button data-action="baseline" class="${folder?.treatments?.baseline ? "active" : ""}" ${state.job ? "disabled" : ""}>Baseline</button>
              <button data-action="chirp" class="${folder?.treatments?.chirp ? "active" : ""}" ${state.job ? "disabled" : ""}>Chirp</button>
              <button data-action="open-merge" ${canOpenMergeWorkspace() && !state.job ? "" : "disabled"} title="Select exactly two treated datasets">Merge...</button>
              <button data-action="reset" ${state.job ? "disabled" : ""}>Reset</button>
            </div>
          </div>
          ${renderTreatmentHistory(dataset)}
        </section>

        <section class="plot-panel heatmap-panel">
          <div class="panel-head">
            <div>
              <h3>Analysis Heatmap</h3>
              <span>Rows: time · Columns: wavelength</span>
            </div>
            <div class="panel-head-actions">
              ${enlargeButton("heatmap")}
            </div>
          </div>
          <canvas id="heatmap" data-plot-key="heatmap" width="1080" height="520" aria-label="Transient spectroscopy heatmap"></canvas>
        </section>

        <section class="analysis-band">
          <div class="analysis-heading">
            <div>
              <h3>Global Fit Summary</h3>
              ${dataset.fit ? "" : "<p>Set component count, IRF, and nonlinear global-fitting options.</p>"}
            </div>
            <button data-action="global-fit" ${state.job ? "disabled" : ""}>Global Fitting...</button>
          </div>
          ${dataset.fit ? renderMainFitSummary(dataset) : `
            <div class="analysis-empty">
              <strong>No global fit for this dataset</strong>
              <span>A successful fit will add time constants and diagnostics here.</span>
            </div>`}
        </section>
      </div>

      <div class="secondary-column">
        <article class="plot-panel spectrum-panel">
          <div class="panel-head">
            <h3>Spectrum</h3>
            <div class="panel-head-actions"><span id="spectrum-coordinate">${formatCoordinate(analysis.timeAxis[state.selectedTimeIndex])} ps</span>${enlargeButton("spectrum")}</div>
          </div>
          <label class="slider">
            <span>Time</span>
            <input id="time-slider" type="range" min="0" max="${analysis.timeAxis.length - 1}" value="${state.selectedTimeIndex}" />
          </label>
          <canvas id="spectrum" data-plot-key="spectrum" width="640" height="310" aria-label="Selected spectrum"></canvas>
        </article>

        <article class="plot-panel kinetics-panel">
          <div class="panel-head">
            <h3>Kinetics</h3>
            <div class="panel-head-actions"><span id="kinetics-coordinate">${formatWavelength(analysis.spectralAxis[state.selectedWavelengthIndex])} nm</span>${enlargeButton("kinetics")}</div>
          </div>
          <label class="slider">
            <span>Wavelength</span>
            <input id="wavelength-slider" type="range" min="0" max="${analysis.spectralAxis.length - 1}" value="${state.selectedWavelengthIndex}" />
          </label>
          <canvas id="kinetics" data-plot-key="kinetics" width="640" height="310" aria-label="Selected kinetics"></canvas>
        </article>

        ${dataset.fit ? renderMainComponentSpectra(dataset) : `
          <article class="result-panel component-placeholder">
            <h3>Component Spectra</h3>
            <p>EAS and DAS appear after global fitting.</p>
          </article>`}
      </div>
    </section>
  `;
}

function renderMainFitSummary(dataset, includeSupportingDetails = false) {
  const fit = dataset.fit;
  const limitedCount = fit.irfLimited?.filter(Boolean).length || 0;
  return `
    ${limitedCount ? `<div class="fit-summary-header"><span>${limitedCount} IRF-limited</span></div>` : ""}
    <table class="fit-table">
      <thead><tr><th>Component</th><th>Time constant</th></tr></thead>
      <tbody>
        ${fit.lifetimes.map((lifetime, index) => `
          <tr>
            <td>t${index + 1}</td>
            <td>${format(lifetime)} ps${fit.fixedLifetimes?.[index] ? " <span class=\"fixed-text\">(fixed)</span>" : ""}${fit.irfLimited?.[index] ? " <span class=\"warning-text\">(IRF-limited)</span>" : ""}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    <dl class="fit-metrics">
      <div><dt>IRF</dt><dd>${format(fit.irfFwhm)} ps FWHM</dd></div>
      <div><dt>RMSE</dt><dd>${format(fit.rmse)}</dd></div>
      <div><dt>Explained</dt><dd>${Number.isFinite(fit.explainedVariance) ? `${(fit.explainedVariance * 100).toFixed(1)}%` : "-"}</dd></div>
      <div><dt>Iterations</dt><dd>${fit.lifetimeIterations ?? "-"}</dd></div>
    </dl>
    ${includeSupportingDetails ? `<p class="fit-supporting-details">Model: ${escapeHtml(fit.lifetimeBasis)}. Time-zero term: ${escapeHtml(fit.irfArtifactModel ?? "off")}.</p>` : ""}
  `;
}

function renderMainComponentSpectra(dataset) {
  const limitedCount = irfLimitedCount(dataset);
  const hiddenCount = state.fitting.hideIrfLimited ? limitedCount : 0;
  return `
    <article class="result-panel spectra-result">
      <div class="panel-head result-controls">
        <div>
          <h3>Component Spectra</h3>
          <span id="main-component-mode-copy">${hiddenCount ? `${hiddenCount} hidden` : ""}</span>
        </div>
        <div class="panel-head-actions">${enlargeButton("main-components")}</div>
      </div>
      <div class="component-controls">
        <div class="segmented" role="group" aria-label="Component spectra mode">
          <button data-action="result-mode" data-mode="EAS" class="${state.fitting.spectrumMode === "EAS" ? "active" : ""}">EAS</button>
          <button data-action="result-mode" data-mode="DAS" class="${state.fitting.spectrumMode === "DAS" ? "active" : ""}">DAS</button>
        </div>
        <label class="inline-select"><span>Normalize</span><select id="result-normalize">
          <option value="none" ${state.fitting.normalize === "none" ? "selected" : ""}>Off</option>
          <option value="each" ${state.fitting.normalize === "each" ? "selected" : ""}>Each max/min</option>
        </select></label>
        <label class="check-control ${limitedCount ? "" : "disabled-control"}"><input id="result-hide-irf" type="checkbox" ${state.fitting.hideIrfLimited && limitedCount ? "checked" : ""} ${limitedCount ? "" : "disabled"} /> ${limitedCount ? "Hide IRF-limited" : "No IRF-limited components"}</label>
      </div>
      <canvas id="main-components" data-plot-key="main-components" width="760" height="340" aria-label="${state.fitting.spectrumMode} component spectra"></canvas>
    </article>`;
}

function enlargeButton(plotKey) {
  const selecting = state.zoomSelectionKey === plotKey;
  const zoomed = Boolean(state.plotZooms[plotKey]);
  return `
    <button class="icon-button plot-tool ${selecting ? "active" : ""}" data-action="select-plot-region" data-plot-key="${plotKey}" title="Select a plot region to magnify" aria-label="Select a plot region to magnify">&#128269;</button>
    ${zoomed ? `<button class="icon-button plot-reset" data-action="reset-plot-zoom" data-plot-key="${plotKey}" title="Reset plot region" aria-label="Reset plot region">&#8634;</button>` : ""}
    <button class="icon-button plot-expand" data-action="enlarge-plot" data-plot-key="${plotKey}" title="Enlarge plot" aria-label="Enlarge plot">\u26f6</button>`;
}

function renderModal() {
  if (state.modal === "merge") return renderMergeWorkspace();
  if (state.modal === "manual") return renderManualModal();
  if (state.modal === "about") return renderAboutModal();
  if (state.modal === "compare-select") return renderCompareSelection();
  if (state.modal === "compare-workspace") return renderCompareWorkspace();
  if (state.modal === "fit") return renderFitModal();
  if (state.modal === "new-folder") return renderNewFolderModal();
  if (state.modal === "delete-dataset") return renderDeleteDatasetModal();
  if (state.modal === "edit-dataset") return renderDatasetEditorModal();
  if (state.modal === "move-dataset") return renderMoveDatasetModal();
  return "";
}

function renderMergeWorkspace() {
  const plan = state.merge.plan;
  const draft = state.merge.draft;
  if (!plan || !draft) return "";
  const overlapCopy = plan.overlap
    ? `${formatWavelength(plan.overlap.min)}-${formatWavelength(plan.overlap.max)} nm`
    : "No wavelength overlap";
  const scale = Number.isFinite(plan.amplitudeScale.scale) ? format(plan.amplitudeScale.scale) : "Unavailable";
  const seam = Number.isFinite(draft.seamWavelength) ? draft.seamWavelength : plan.seam.wavelength;
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Merge spectral ranges">
      <div class="modal merge-modal">
        <header class="modal-head">
          <div>
            <h2>Merge Spectral Ranges</h2>
            <p>Join clean wavelength ranges from two treated datasets on their common measured time support.</p>
          </div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>

        <div class="merge-workspace-stack">
          <section class="merge-join-bar">
            <div class="merge-join-heading">
              <div><h3>Join and output</h3><p>The treated time axes are used directly; no additional time-zero shift is applied.</p></div>
            </div>
            <div class="merge-join-row">
              ${renderMergeRangeGroup("Lower-wavelength range", plan.low, draft.lowRange, "low")}
              ${renderMergeRangeGroup("Higher-wavelength range", plan.high, draft.highRange, "high")}
              <div class="merge-options-cell">
                <label class="modal-field"><span>Seam wavelength (nm)</span><input id="merge-seam" type="number" step="any" value="${inputValue(seam)}" ${plan.overlap ? "" : "disabled"} /></label>
                <label class="check-control merge-scale-control"><input id="merge-apply-scale" type="checkbox" ${draft.applyAmplitudeScale ? "checked" : ""} ${Number.isFinite(plan.amplitudeScale.scale) ? "" : "disabled"} /> Match one positive amplitude scale</label>
              </div>
              <label class="modal-field"><span>Destination folder</span><select id="merge-folder">
                <option value="__new__" ${draft.folderId === "__new__" ? "selected" : ""}>New folder: Merged VIS-NIR</option>
                ${state.folders.map((folder) => `<option value="${escapeHtml(folder.id)}" ${draft.folderId === folder.id ? "selected" : ""} data-i18n-skip>${escapeHtml(folder.name)}</option>`).join("")}
              </select></label>
              <label class="modal-field merge-name-field"><span>Merged dataset name</span><input id="merge-output-name" type="text" value="${escapeHtml(draft.outputName)}" /></label>
            </div>
            <div class="merge-review-row">
              <dl class="merge-diagnostics compact">
                <div><dt>Wavelength overlap</dt><dd>${overlapCopy}</dd></div>
                <div><dt>Common time points</dt><dd>${plan.commonTimeAxis.length}</dd></div>
                <div><dt>Higher-probe scale</dt><dd>${scale}</dd></div>
                <div><dt>Suggested seam</dt><dd>${formatWavelength(plan.seam.wavelength)} nm</dd></div>
              </dl>
              ${plan.warnings.length ? `<div class="merge-warning-list"><strong>Review before merging</strong><ul>${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
            </div>
          </section>

          <section class="merge-preview-panel">
            <div class="merge-preview-heading">
              <div><h3>Spectral preview</h3><p>Linear resampling uses only the measured common time support. The saved matrix uses unsmoothed retained values.</p></div>
              <strong id="merge-preview-coordinate">${formatCoordinate(plan.commonTimeAxis[draft.previewTimeIndex])} ps</strong>
            </div>
            <label class="slider merge-time-slider"><span>Time</span><input id="merge-preview-time" type="range" min="0" max="${plan.commonTimeAxis.length - 1}" value="${draft.previewTimeIndex}" /></label>
            <canvas id="merge-preview-canvas" width="1200" height="660" aria-label="Aligned VIS and NIR spectral preview"></canvas>
            <div class="merge-preview-legend">
              <span><i style="--legend-color:#0c7c86"></i><strong data-i18n-skip>${escapeHtml(plan.low.label)}</strong></span>
              <span><i style="--legend-color:#8b5d2a"></i><strong data-i18n-skip>${escapeHtml(plan.high.label)}</strong></span>
            </div>
          </section>
        </div>

        <footer class="modal-footer merge-footer">
          <span>Both parent datasets and their original CSV/UFS sources remain unchanged.</span>
          <button data-action="create-merged-dataset">Create Merged Dataset</button>
        </footer>
      </div>
    </section>`;
}

function renderMergeRangeGroup(title, dataset, range, key) {
  return `
    <fieldset class="merge-range-group">
      <legend><span>${title}</span><strong data-i18n-skip title="${escapeHtml(dataset.label)}">${escapeHtml(dataset.label)}</strong></legend>
      <div class="merge-range-row">
        <label><span>Retain min</span><input id="merge-${key}-min" type="number" step="any" value="${inputValue(range.min)}" /></label>
        <label><span>Retain max</span><input id="merge-${key}-max" type="number" step="any" value="${inputValue(range.max)}" /></label>
      </div>
    </fieldset>`;
}

function renderManualModal() {
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="SpecFlowLab Manual">
      <div class="modal product-modal manual-modal">
        <header class="modal-head">
          <div><h2>SpecFlowLab Manual</h2><p>How to use the version 1.0 spectroscopy workspace.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="manual-intro">
          <strong>Recommended workflow</strong>
          <span>Import → organize → set analysis range → baseline/chirp treatment → merge or compare → global fitting → save/export.</span>
        </div>
        <ol class="manual-steps">
          <li><div><strong>Start a project</strong><p>Open an existing .sflproj project, or import CSV, TXT, TSV, ASC, or UFS files. Files imported together enter one dataset folder.</p></div></li>
          <li><div><strong>Organize datasets</strong><p>Rename datasets, add sample notes, and move datasets between VIS, NIR, IR, or other folders without changing the source files.</p></div></li>
          <li><div><strong>Treat the data</strong><p>Set the wavelength and time range for the active folder, then apply Baseline and Chirp as needed. Merge selection becomes available only after treatment.</p></div></li>
          <li><div><strong>Merge treated spectral ranges</strong><p>Select exactly two treated datasets, click Merge between Chirp and Reset, choose clean retained wavelength ranges, review the spectral preview, and create the derived dataset.</p></div></li>
          <li><div><strong>Compare datasets</strong><p>Use Compare to inspect coordinated kinetics, spectra, EAS, and DAS views with reusable sample styles.</p></div></li>
          <li><div><strong>Run global fitting</strong><p>Open Global Fitting, set component starts and IRF options, and review lifetimes, residuals, DAS, EAS, and fit diagnostics.</p></div></li>
          <li><div><strong>Save and export</strong><p>Save the complete .sflproj archive, export an AI-ready Markdown summary, or create OriginPro sheets and plots on Windows.</p></div></li>
        </ol>
        <div class="manual-integrity-note"><strong>Data integrity</strong><span>Original CSV text and UFS bytes remain unchanged. Treatments, fits, merges, warnings, and provenance are stored separately and reproducibly.</span></div>
        <footer class="modal-footer"><span>For feedback, open About.</span><button data-action="close-modal">Close</button></footer>
      </div>
    </section>`;
}

function renderAboutModal() {
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="About SpecFlowLab">
      <div class="modal compact-modal product-modal about-modal">
        <header class="modal-head">
          <div><h2>About SpecFlowLab</h2><p>Version ${APP_VERSION}</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="about-identity">
          <img src="${appIconUrl}" alt="" />
          <div><strong>SpecFlowLab</strong><span>Transient-absorption spectroscopy workspace</span></div>
        </div>
        <p>SpecFlowLab organizes, treats, compares, merges, fits, and exports time-resolved spectroscopy datasets while preserving source data and analysis provenance.</p>
        <dl class="about-details">
          <div><dt>Version</dt><dd>${APP_VERSION}</dd></div>
          <div><dt>Feedback</dt><dd><a href="mailto:specflowlab@icluod.com" data-i18n-skip>specflowlab@icluod.com</a></dd></div>
          <div><dt>Copyright</dt><dd>© 2026 SpecFlowLab. All rights reserved.</dd></div>
        </dl>
        <p class="about-note">OriginPro is a product of OriginLab Corporation. SpecFlowLab is independent software and is not affiliated with OriginLab.</p>
        <footer class="modal-footer"><span>Thank you for testing SpecFlowLab.</span><button data-action="close-modal">Close</button></footer>
      </div>
    </section>`;
}

function renderDatasetContextMenu() {
  const dataset = state.datasets.find((item) => item.id === state.datasetMenu?.datasetId);
  if (!dataset) return "";
  const targetFolder = state.folders.find((folder) => folder.id === dataset.folderId);
  const canPaste = Boolean(state.datasetClipboard);
  return `
    <button class="context-menu-dismiss" data-action="close-context-menus" aria-label="Close dataset menu"></button>
    <menu class="app-context-menu dataset-context-menu" aria-label="Dataset actions">
      <li class="context-menu-title" data-i18n-skip>${escapeHtml(datasetDisplayName(dataset))}</li>
      <li><button data-action="edit-dataset" data-dataset-id="${escapeHtml(dataset.id)}">Rename and sample note...</button></li>
      <li><button data-action="move-dataset" data-dataset-id="${escapeHtml(dataset.id)}">Move to...</button></li>
      <li class="context-separator"></li>
      <li><button data-action="copy-dataset" data-dataset-id="${escapeHtml(dataset.id)}">Copy</button></li>
      <li><button data-action="cut-dataset" data-dataset-id="${escapeHtml(dataset.id)}">Cut</button></li>
      <li><button data-action="paste-dataset" data-folder-id="${escapeHtml(targetFolder?.id ?? "")}" ${canPaste ? "" : "disabled"}>Paste into ${escapeHtml(targetFolder?.name ?? "folder")}</button></li>
      <li class="context-separator"></li>
      <li><button class="context-danger" data-action="delete-dataset" data-dataset-id="${escapeHtml(dataset.id)}">Remove from project...</button></li>
    </menu>`;
}

function renderFolderContextMenu() {
  const folder = state.folders.find((item) => item.id === state.folderMenu?.folderId);
  if (!folder) return "";
  const canPaste = Boolean(state.datasetClipboard);
  const empty = folderDatasets(folder.id).length === 0;
  return `
    <button class="context-menu-dismiss" data-action="close-context-menus" aria-label="Close folder menu"></button>
    <menu class="app-context-menu folder-context-menu" aria-label="Folder actions">
      <li class="context-menu-title" data-i18n-skip>${escapeHtml(folder.name)}</li>
      <li><button data-action="import-folder" data-folder-id="${escapeHtml(folder.id)}">Import data into folder...</button></li>
      <li><button data-action="paste-dataset" data-folder-id="${escapeHtml(folder.id)}" ${canPaste ? "" : "disabled"}>Paste dataset</button></li>
      <li class="context-separator"></li>
      <li><button data-action="rename-folder-menu" data-folder-id="${escapeHtml(folder.id)}">Rename...</button></li>
      <li><button data-action="toggle-folder" data-folder-id="${escapeHtml(folder.id)}">${folder.collapsed ? "Expand" : "Collapse"}</button></li>
      <li class="context-separator"></li>
      <li><button class="context-danger" data-action="delete-folder" data-folder-id="${escapeHtml(folder.id)}" ${empty ? "" : "disabled"}>Delete empty folder</button></li>
    </menu>`;
}

function renderPlotContextMenu() {
  const meta = expandedPlotMeta(state.plotMenu?.plotKey);
  return `
    <button class="context-menu-dismiss" data-action="close-context-menus" aria-label="Close plot menu"></button>
    <menu class="app-context-menu plot-context-menu" aria-label="Plot actions">
      <li class="context-menu-title">${escapeHtml(meta.title)}</li>
      <li class="plot-export-actions">
        <button data-action="export-plot-png" data-plot-key="${escapeHtml(state.plotMenu.plotKey)}">PNG image...</button>
        <button data-action="export-plot-txt" data-plot-key="${escapeHtml(state.plotMenu.plotKey)}">TXT data...</button>
      </li>
    </menu>`;
}

function renderCompareSelection() {
  const selectedCount = state.compare.selectedIds.length;
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Select datasets to compare">
      <div class="modal selection-modal">
        <header class="modal-head">
          <div>
            <h2>Select Datasets</h2>
            <p>Choose at least two treated datasets for coordinated comparison.</p>
          </div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <label class="selection-select-all">
          <input id="compare-select-all" type="checkbox" />
          <span><strong>Select all</strong><small>Include every project dataset</small></span>
        </label>
        <div class="selection-list">
          ${state.datasets.map((dataset, index) => `
            <label class="selection-row">
              <input class="compare-check" type="checkbox" data-index="${index}" ${state.compare.selectedIds.includes(dataset.id) ? "checked" : ""} />
              <span class="selection-name"><strong data-i18n-skip>${escapeHtml(datasetDisplayName(dataset))}</strong><small>${datasetStateLabel(dataset)}</small></span>
              <span>${formatWavelength(dataset.analysis.spectralAxis[0])}-${formatWavelength(dataset.analysis.spectralAxis.at(-1))} nm</span>
              <span>${formatCoordinate(dataset.analysis.timeAxis[0])}-${formatCoordinate(dataset.analysis.timeAxis.at(-1))} ps</span>
              <span>${dataset.fit ? `${dataset.fit.componentCount}C fit` : "No fit"}</span>
            </label>`).join("")}
        </div>
        <footer class="modal-footer">
          <span id="compare-selection-count">${selectedCount} selected</span>
          <button data-action="open-comparison" id="open-comparison" ${selectedCount >= 2 ? "" : "disabled"}>Open Comparison</button>
        </footer>
      </div>
    </section>
  `;
}

function renderCompareWorkspace() {
  const reference = activeDataset()?.analysis;
  const referenceTime = reference?.timeAxis[clamp(state.compare.timeIndex, 0, reference.timeAxis.length - 1)] ?? 0;
  const referenceWavelength = reference?.spectralAxis[clamp(state.compare.wavelengthIndex, 0, reference.spectralAxis.length - 1)] ?? 0;
  const limitedCount = compareDatasets().reduce((count, dataset) => count + irfLimitedCount(dataset), 0);
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Dataset comparison">
      <div class="modal comparison-modal">
        <header class="modal-head">
          <div>
            <h2>Dataset Comparison</h2>
            <p>${state.compare.selectedIds.length} datasets linked to one comparison object.</p>
          </div>
          <div class="modal-head-actions">
            <button data-action="change-comparison">Change Datasets</button>
            <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
          </div>
        </header>

        <section class="compare-controls">
          <label class="wide-slider"><span>Wavelength <strong id="compare-wavelength-value">${formatWavelength(referenceWavelength)} nm</strong></span>
            <input id="compare-wavelength-slider" type="range" min="0" max="${Math.max(0, (reference?.spectralAxis.length ?? 1) - 1)}" value="${state.compare.wavelengthIndex}" />
          </label>
          <label class="wide-slider"><span>Time <strong id="compare-time-value">${formatCoordinate(referenceTime)} ps</strong></span>
            <input id="compare-time-slider" type="range" min="0" max="${Math.max(0, (reference?.timeAxis.length ?? 1) - 1)}" value="${state.compare.timeIndex}" />
          </label>
          <label><span>Components</span><select id="compare-component-mode">
            <option value="EAS" ${state.compare.componentMode === "EAS" ? "selected" : ""}>EAS</option>
            <option value="DAS" ${state.compare.componentMode === "DAS" ? "selected" : ""}>DAS</option>
          </select></label>
          <label><span>Normalize</span><select id="compare-normalize">
            <option value="none" ${state.compare.normalize === "none" ? "selected" : ""}>Off</option>
            <option value="each" ${state.compare.normalize === "each" ? "selected" : ""}>Each max/min</option>
          </select></label>
          <label class="check-control compare-check-control ${limitedCount ? "" : "disabled-control"}"><input id="compare-hide-irf" type="checkbox" ${state.compare.hideIrfLimited && limitedCount ? "checked" : ""} ${limitedCount ? "" : "disabled"} /> ${limitedCount ? "Hide IRF-limited" : "No IRF-limited components"}</label>
        </section>

        <section class="comparison-grid">
          <article class="plot-panel">
            <div class="panel-head"><h3>Kinetics Comparison</h3><div class="panel-head-actions"><span>${formatWavelength(referenceWavelength)} nm</span>${enlargeButton("compare-kinetics")}</div></div>
            <canvas id="compare-kinetics" data-plot-key="compare-kinetics" width="760" height="330"></canvas>
          </article>
          <article class="plot-panel">
            <div class="panel-head"><h3>Spectra Comparison</h3><div class="panel-head-actions"><span>${formatCoordinate(referenceTime)} ps</span>${enlargeButton("compare-spectrum")}</div></div>
            <canvas id="compare-spectrum" data-plot-key="compare-spectrum" width="760" height="330"></canvas>
          </article>
          <article class="plot-panel comparison-components">
            <div class="panel-head"><h3 id="compare-component-heading">${state.compare.componentMode} Comparison</h3><div class="panel-head-actions"><span id="compare-component-copy">${comparisonComponentCopy()}</span>${enlargeButton("compare-components")}</div></div>
            <canvas id="compare-components" data-plot-key="compare-components" width="1180" height="370"></canvas>
          </article>
        </section>

        <section class="line-settings">
          <div class="panel-head"><h3>Dataset Lines</h3><span>One style and one legend entry per sample</span></div>
          <div class="style-list">
            ${compareDatasets().map((dataset, index) => {
              const style = ensureDatasetStyle(dataset, index);
              return `<div class="style-row" data-style-id="${escapeHtml(dataset.id)}">
                <input type="color" class="line-color" value="${style.color}" aria-label="Line color" />
                <input type="text" class="line-label" value="${escapeHtml(style.label)}" aria-label="Legend name" />
                <select class="line-style" aria-label="Line style">
                  <option value="solid" ${style.lineStyle === "solid" ? "selected" : ""}>Solid</option>
                  <option value="dashed" ${style.lineStyle === "dashed" ? "selected" : ""}>Dashed</option>
                  <option value="dotted" ${style.lineStyle === "dotted" ? "selected" : ""}>Dotted</option>
                </select>
                <input type="number" class="line-width" min="0.5" max="6" step="0.5" value="${style.lineWidth}" aria-label="Line width" />
              </div>`;
            }).join("")}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderFitModal() {
  const dataset = activeDataset();
  const limitedCount = irfLimitedCount(dataset);
  const unfittedCount = state.datasets.filter((item) => !item.fit).length;
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Global fitting">
      <div class="modal fit-modal">
        <header class="modal-head">
          <div>
            <h2>Global Fitting</h2>
            <p>${escapeHtml(dataset ? datasetDisplayName(dataset) : "No dataset selected")}</p>
          </div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <section class="modal-tools">
          <label><span>Components</span><select id="fit-components">
            ${[1, 2, 3, 4, 5, 6].map((count) => `<option value="${count}" ${state.fitting.components === count ? "selected" : ""}>${count}</option>`).join("")}
          </select></label>
          <label><span>IRF FWHM (ps)</span><input id="fit-irf" type="number" min="0" step="0.01" value="${state.fitting.irfFwhm}" /></label>
          <button data-action="run-fit" ${state.job ? "disabled" : ""}>${state.job?.kind === "fit" ? "Processing..." : "Fit Active Dataset"}</button>
          <button data-action="batch-fit" ${state.job || !unfittedCount ? "disabled" : ""}>${state.job?.kind === "batch-fit" ? "Processing..." : unfittedCount ? `Batch Global Fitting (${unfittedCount})` : "All Datasets Fitted"}</button>
          <label class="check-control fit-hide-control ${limitedCount ? "" : "disabled-control"}"><input id="fit-hide-irf" type="checkbox" ${state.fitting.hideIrfLimited && limitedCount ? "checked" : ""} ${limitedCount ? "" : "disabled"} /> ${limitedCount ? "Hide IRF-limited spectra" : "No IRF-limited components"}</label>
        </section>
        ${renderLifetimeControls()}
        ${dataset?.fit ? renderFitDiagnostics(dataset) : "<section class=\"empty compact\"><h3>No fit yet</h3><p>Run a fit to create lifetime, DAS, EAS-preview, overlay, and residual results.</p></section>"}
      </div>
    </section>
  `;
}

function renderLifetimeControls() {
  const count = state.fitting.components;
  return `
    <section class="lifetime-editor" aria-label="Lifetime starts and constraints">
      <div class="lifetime-editor-head">
        <strong>Lifetime starts</strong>
      </div>
      <div class="lifetime-grid">
        ${Array.from({ length: count }, (_, index) => `
          <label class="lifetime-row">
            <span>t${index + 1}</span>
            <input class="lifetime-value" data-lifetime-index="${index}" type="number" min="0" step="any" value="${escapeHtml(state.fitting.lifetimeValues[index] ?? "")}" placeholder="Auto" />
            <small>ps</small>
            <span class="fix-control"><input class="lifetime-fixed" data-lifetime-index="${index}" type="checkbox" ${state.fitting.fixedLifetimes[index] ? "checked" : ""} /> Fix</span>
          </label>`).join("")}
      </div>
    </section>`;
}

function renderFitDiagnostics(dataset) {
  const fit = dataset.fit;
  return `
    <section class="fit-diagnostic-grid">
      <article class="result-panel fit-summary-diagnostic">
        <div class="panel-head"><h3>Global Fit Summary</h3><span>${fit.componentCount} components</span></div>
        ${renderMainFitSummary(dataset)}
      </article>
      <article class="plot-panel">
        <div class="panel-head"><h3>Fit Residual Map</h3><div class="panel-head-actions"><span>Measured minus fitted</span>${enlargeButton("fit-residual")}</div></div>
        <canvas id="fit-residual" data-plot-key="fit-residual" width="1180" height="420"></canvas>
      </article>
      <article class="plot-panel">
        <div class="panel-head"><h3>EAS Preview</h3><div class="panel-head-actions">${enlargeButton("modal-eas")}</div></div>
        <canvas id="modal-eas" data-plot-key="modal-eas" width="760" height="310"></canvas>
      </article>
      <article class="plot-panel">
        <div class="panel-head"><h3>DAS</h3><div class="panel-head-actions">${enlargeButton("modal-das")}</div></div>
        <canvas id="modal-das" data-plot-key="modal-das" width="760" height="310"></canvas>
      </article>
    </section>
  `;
}

function renderNewFolderModal() {
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Create dataset folder">
      <div class="modal compact-modal">
        <header class="modal-head">
          <div><h2>New Dataset Folder</h2><p>Use a test condition such as VIS, NIR, or IR.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <label class="modal-field"><span>Folder name</span><input id="new-folder-name" type="text" value="" placeholder="VIS" /></label>
        <footer class="modal-footer">
          <span>Folders live inside this project and do not alter source files.</span>
          <button data-action="create-folder">Create Folder</button>
        </footer>
      </div>
    </section>`;
}

function renderDeleteDatasetModal() {
  const dataset = state.datasets.find((item) => item.id === state.pendingDeleteId);
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Remove dataset">
      <div class="modal compact-modal">
        <header class="modal-head">
          <div><h2>Remove Dataset</h2><p data-i18n-skip>${escapeHtml(dataset?.source.fileName ?? "Dataset")}</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <p class="scientific-note">This removes the dataset and its derived results from the project. The original source file remains untouched.</p>
        <footer class="modal-footer">
          <button data-action="close-modal">Cancel</button>
          <button class="danger-button" data-action="confirm-delete-dataset">Remove from Project</button>
        </footer>
      </div>
    </section>`;
}

function renderDatasetEditorModal() {
  const dataset = state.datasets.find((item) => item.id === state.pendingDatasetId);
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Dataset details">
      <div class="modal compact-modal">
        <header class="modal-head">
          <div><h2>Dataset Details</h2><p>Project metadata for AI handoff and comparison labels.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="dataset-detail-fields">
          <label class="modal-field"><span>Display name</span><input id="dataset-display-name" type="text" value="${escapeHtml(datasetDisplayName(dataset))}" /></label>
          <label class="modal-field"><span>Sample note</span><textarea id="dataset-sample-note" rows="5" placeholder="Sample identity, environment, excitation conditions, or interpretation context">${escapeHtml(dataset?.sampleNote ?? "")}</textarea></label>
          <p class="source-readonly">Source file: <strong data-i18n-skip>${escapeHtml(dataset?.source.fileName ?? "-")}</strong></p>
        </div>
        <footer class="modal-footer">
          <span>The source filename and original CSV or UFS data remain unchanged.</span>
          <button data-action="save-dataset-details">Save Details</button>
        </footer>
      </div>
    </section>`;
}

function renderMoveDatasetModal() {
  const dataset = state.datasets.find((item) => item.id === state.pendingDatasetId);
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Move dataset">
      <div class="modal compact-modal">
        <header class="modal-head">
          <div><h2>Move Dataset</h2><p data-i18n-skip>${escapeHtml(datasetDisplayName(dataset))}</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <label class="modal-field"><span>Destination folder</span><select id="dataset-move-folder" data-i18n-skip>
          ${state.folders.map((folder) => `<option value="${escapeHtml(folder.id)}" ${folder.id === dataset?.folderId ? "selected" : ""}>${escapeHtml(folder.name)}</option>`).join("")}
        </select></label>
        <footer class="modal-footer">
          <span>The treated dataset and fit are preserved.</span>
          <button data-action="confirm-move-dataset">Move Dataset</button>
        </footer>
      </div>
    </section>`;
}

function renderExpandedCoordinateControl(plotKey) {
  const analysis = activeDataset()?.analysis;
  if (!analysis) return "";
  const isCompare = plotKey.startsWith("compare-");
  const isSpectrum = plotKey === "spectrum" || plotKey === "compare-spectrum";
  const isKinetics = plotKey === "kinetics" || plotKey === "compare-kinetics";
  if (!isSpectrum && !isKinetics) return "";

  const axis = isSpectrum ? "time" : "wavelength";
  const values = isSpectrum ? analysis.timeAxis : analysis.spectralAxis;
  const index = clamp(
    isCompare
      ? isSpectrum ? state.compare.timeIndex : state.compare.wavelengthIndex
      : isSpectrum ? state.selectedTimeIndex : state.selectedWavelengthIndex,
    0,
    values.length - 1,
  );
  const coordinate = isSpectrum
    ? `${formatCoordinate(values[index])} ps`
    : `${formatWavelength(values[index])} nm`;
  return `
    <label class="expanded-coordinate-control">
      <span>${isSpectrum ? "Time" : "Wavelength"} <strong id="expanded-coordinate">${coordinate}</strong></span>
      <input id="expanded-coordinate-slider" type="range" min="0" max="${values.length - 1}" value="${index}" data-axis="${axis}" data-scope="${isCompare ? "compare" : "main"}" />
    </label>`;
}

function renderExpandedPlot() {
  const meta = expandedPlotMeta(state.expandedPlot);
  const coordinateControl = renderExpandedCoordinateControl(state.expandedPlot);
  const componentPlot = ["main-components", "modal-eas", "modal-das", "compare-components"].includes(state.expandedPlot);
  const compareComponentPlot = state.expandedPlot === "compare-components";
  const limitedCount = compareComponentPlot
    ? compareDatasets().reduce((count, dataset) => count + irfLimitedCount(dataset), 0)
    : irfLimitedCount(activeDataset());
  return `
    <section class="modal-shell expanded-shell" role="dialog" aria-modal="true" aria-label="${escapeHtml(meta.title)} enlarged">
      <div class="modal expanded-plot-modal">
        <header class="modal-head expanded-head">
          <div><h2>${escapeHtml(meta.title)}</h2>${meta.subtitle && !coordinateControl ? `<p>${escapeHtml(meta.subtitle)}</p>` : ""}</div>
          <div class="expanded-tools">
            ${componentPlot ? `<label class="check-control ${limitedCount ? "" : "disabled-control"}"><input id="expanded-hide-irf" type="checkbox" ${(compareComponentPlot ? state.compare.hideIrfLimited : state.fitting.hideIrfLimited) && limitedCount ? "checked" : ""} ${limitedCount ? "" : "disabled"} /> ${limitedCount ? "Hide IRF-limited" : "No IRF-limited components"}</label>` : ""}
            ${enlargeButton(state.expandedPlot).replace(/<button[^>]*data-action="enlarge-plot"[\s\S]*?<\/button>/, "")}
            <button data-action="close-expanded-plot" class="icon-button" aria-label="Close enlarged plot">x</button>
          </div>
        </header>
        ${coordinateControl}
        <div class="expanded-canvas-wrap">
          <div class="expanded-canvas-stage">
            <canvas id="expanded-canvas" data-plot-key="${escapeHtml(state.expandedPlot)}" width="1500" height="900" aria-label="${escapeHtml(meta.title)} enlarged plot"></canvas>
          </div>
        </div>
      </div>
    </section>`;
}

function bindDom() {
  document.getElementById("language-select")?.addEventListener("change", (event) => {
    state.locale = normalizeLocale(event.target.value);
    saveLocale(state.locale);
    render();
  });
  document.getElementById("file-input")?.addEventListener("change", (event) => importDataFiles(event, null));
  document.getElementById("folder-file-input")?.addEventListener("change", (event) => importDataFiles(event, state.importTargetFolderId));
  document.getElementById("project-input")?.addEventListener("change", openProjectFile);
  document.getElementById("origin-output-mode")?.addEventListener("change", (event) => {
    state.origin.outputMode = event.target.value === "sheets-only"
      ? "sheets-only"
      : "sheets-plots";
  });
  document.querySelectorAll(".merge-check").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => updateMergeSelection(event.currentTarget.dataset.mergeId, event.currentTarget.checked));
  });
  document.getElementById("merge-preview-time")?.addEventListener("input", (event) => {
    state.merge.draft.previewTimeIndex = Number(event.target.value);
    const coordinate = document.getElementById("merge-preview-coordinate");
    if (coordinate) coordinate.textContent = `${formatCoordinate(state.merge.plan.commonTimeAxis[state.merge.draft.previewTimeIndex])} ps`;
    paintMergePreview();
  });
  document.getElementById("merge-apply-scale")?.addEventListener("change", (event) => {
    state.merge.draft.applyAmplitudeScale = event.target.checked;
    paintMergePreview();
  });
  ["merge-low-min", "merge-low-max", "merge-high-min", "merge-high-max", "merge-seam"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      syncMergeDraftFromDom();
      paintMergePreview();
    });
  });
  ["merge-output-name", "merge-folder"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", syncMergeDraftFromDom);
  });

  document.getElementById("time-slider")?.addEventListener("input", (event) => {
    state.selectedTimeIndex = Number(event.target.value);
    syncSelectionLabels();
    paintCanvases();
  });
  document.getElementById("wavelength-slider")?.addEventListener("input", (event) => {
    state.selectedWavelengthIndex = Number(event.target.value);
    syncSelectionLabels();
    paintCanvases();
  });
  document.getElementById("expanded-coordinate-slider")?.addEventListener("input", (event) => {
    const index = Number(event.target.value);
    const isCompare = event.target.dataset.scope === "compare";
    const isTime = event.target.dataset.axis === "time";
    if (isCompare) {
      if (isTime) state.compare.timeIndex = index;
      else state.compare.wavelengthIndex = index;
      const linked = document.getElementById(isTime ? "compare-time-slider" : "compare-wavelength-slider");
      if (linked) linked.value = `${index}`;
      updateComparisonCoordinateLabels();
    } else {
      if (isTime) state.selectedTimeIndex = index;
      else state.selectedWavelengthIndex = index;
      const linked = document.getElementById(isTime ? "time-slider" : "wavelength-slider");
      if (linked) linked.value = `${index}`;
      syncSelectionLabels();
    }
    paintCanvases();
  });

  document.getElementById("result-normalize")?.addEventListener("change", (event) => {
    state.fitting.normalize = event.target.value;
    paintCanvases();
  });
  document.getElementById("result-hide-irf")?.addEventListener("change", (event) => {
    state.fitting.hideIrfLimited = event.target.checked;
    updateComponentViewUi();
  });
  document.getElementById("fit-components")?.addEventListener("change", (event) => {
    state.fitting.components = Number(event.target.value) || 3;
    resetLifetimeEditor();
    render();
  });
  document.getElementById("fit-irf")?.addEventListener("input", (event) => {
    state.fitting.irfFwhm = Number(event.target.value) || 0.25;
  });
  document.getElementById("fit-hide-irf")?.addEventListener("change", (event) => {
    state.fitting.hideIrfLimited = event.target.checked;
    updateComponentViewUi();
  });
  document.getElementById("expanded-hide-irf")?.addEventListener("change", (event) => {
    if (state.expandedPlot === "compare-components") {
      state.compare.hideIrfLimited = event.target.checked;
      updateComparisonComponentUi();
    } else {
      state.fitting.hideIrfLimited = event.target.checked;
      updateComponentViewUi();
    }
  });
  document.querySelectorAll(".lifetime-value").forEach((input) => {
    input.addEventListener("input", (event) => {
      state.fitting.lifetimeValues[Number(event.currentTarget.dataset.lifetimeIndex)] = event.currentTarget.value;
    });
  });
  document.querySelectorAll(".lifetime-fixed").forEach((input) => {
    input.addEventListener("change", (event) => {
      state.fitting.fixedLifetimes[Number(event.currentTarget.dataset.lifetimeIndex)] = event.currentTarget.checked;
    });
  });

  document.querySelectorAll(".compare-check").forEach((checkbox) => {
    checkbox.addEventListener("change", updateComparisonSelection);
  });
  document.getElementById("compare-select-all")?.addEventListener("change", (event) => {
    state.compare.selectedIds = event.target.checked ? state.datasets.map((dataset) => dataset.id) : [];
    document.querySelectorAll(".compare-check").forEach((checkbox) => {
      checkbox.checked = event.target.checked;
    });
    syncComparisonSelectionControls();
    markDirty();
  });
  syncComparisonSelectionControls();
  document.getElementById("compare-time-slider")?.addEventListener("input", (event) => {
    state.compare.timeIndex = Number(event.target.value);
    updateComparisonCoordinateLabels();
    paintCanvases();
  });
  document.getElementById("compare-wavelength-slider")?.addEventListener("input", (event) => {
    state.compare.wavelengthIndex = Number(event.target.value);
    updateComparisonCoordinateLabels();
    paintCanvases();
  });
  document.getElementById("compare-component-mode")?.addEventListener("change", (event) => {
    state.compare.componentMode = event.target.value;
    clearPlotZooms(["compare-components"]);
    updateComparisonComponentUi();
  });
  document.getElementById("compare-normalize")?.addEventListener("change", (event) => {
    state.compare.normalize = event.target.value;
    clearPlotZooms(["compare-kinetics", "compare-spectrum", "compare-components"]);
    paintCanvases();
  });
  document.getElementById("compare-hide-irf")?.addEventListener("change", (event) => {
    state.compare.hideIrfLimited = event.target.checked;
    updateComparisonComponentUi();
  });
  document.querySelectorAll("[data-style-id]").forEach((row) => {
    const id = row.dataset.styleId;
    row.querySelector(".line-color")?.addEventListener("input", (event) => {
      state.compare.styles[id].color = event.target.value;
      markDirty();
      paintCanvases();
    });
    row.querySelector(".line-label")?.addEventListener("input", (event) => {
      state.compare.styles[id].label = event.target.value;
      markDirty();
      paintCanvases();
    });
    row.querySelector(".line-style")?.addEventListener("change", (event) => {
      state.compare.styles[id].lineStyle = event.target.value;
      markDirty();
      paintCanvases();
    });
    row.querySelector(".line-width")?.addEventListener("input", (event) => {
      state.compare.styles[id].lineWidth = clamp(Number(event.target.value) || 2.2, 0.5, 6);
      markDirty();
      paintCanvases();
    });
  });

  const heatmap = document.getElementById("heatmap");
  if (heatmap) {
    const update = (event) => {
      if (state.zoomSelectionKey === "heatmap") return;
      if (event.type === "pointerdown" && event.button !== 0) return;
      if (event.type === "pointermove" && event.buttons !== 1) return;
      updateSelectionFromHeatmap(event, heatmap);
    };
    heatmap.addEventListener("pointerdown", update);
    heatmap.addEventListener("pointermove", update);
  }

  document.querySelectorAll(".folder-name-display").forEach((label) => {
    label.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startFolderRename(event.currentTarget.dataset.folderId);
    });
  });
  document.querySelectorAll(".folder-name-input").forEach((input) => {
    input.addEventListener("blur", (event) => renameFolder(event.currentTarget.dataset.folderId, event.currentTarget.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        renameFolder(event.currentTarget.dataset.folderId, event.currentTarget.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        state.editingFolderId = null;
        render();
      }
    });
  });
  document.querySelectorAll(".dataset-row").forEach((row) => {
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const datasetId = event.currentTarget.dataset.datasetId;
      const index = state.datasets.findIndex((dataset) => dataset.id === datasetId);
      if (index >= 0) state.activeIndex = index;
      const anchor = event.currentTarget.querySelector(".dataset-activate")?.getBoundingClientRect()
        ?? event.currentTarget.getBoundingClientRect();
      const position = anchoredMenuPosition(anchor, 240, 306);
      closeContextMenus();
      state.datasetMenu = {
        datasetId,
        ...position,
      };
      render();
    });
  });
  document.querySelectorAll(".folder-heading").forEach((heading) => {
    heading.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      const position = anchoredMenuPosition(event.currentTarget.getBoundingClientRect(), 240, 250);
      closeContextMenus();
      state.folderMenu = { folderId, ...position };
      render();
    });
  });
  document.querySelectorAll(".dataset-drag-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const dragHandle = event.currentTarget;
      const row = dragHandle.closest(".dataset-row");
      const datasetId = row?.dataset.datasetId;
      if (!row || !datasetId) return;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let started = false;
      let dropTarget = null;
      dragHandle.setPointerCapture?.(pointerId);

      const clearTarget = () => {
        dropTarget?.classList.remove("drop-target");
        dropTarget = null;
      };
      const updateTarget = (pointerEvent) => {
        const nextTarget = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest("[data-folder-drop]") ?? null;
        if (nextTarget === dropTarget) return;
        clearTarget();
        dropTarget = nextTarget;
        dropTarget?.classList.add("drop-target");
      };
      const move = (pointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (!started && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) >= 4) {
          started = true;
          row.classList.add("dragging");
          document.documentElement.classList.add("dataset-drag-active");
        }
        if (started) updateTarget(pointerEvent);
      };
      const finish = (pointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (started) updateTarget(pointerEvent);
        const folderId = dropTarget?.dataset.folderDrop;
        cleanup();
        if (started && folderId) moveDatasetToFolder(datasetId, folderId);
      };
      const cleanup = () => {
        clearTarget();
        row.classList.remove("dragging");
        document.documentElement.classList.remove("dataset-drag-active");
        if (dragHandle.hasPointerCapture?.(pointerId)) dragHandle.releasePointerCapture(pointerId);
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", cleanup);
      };

      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", cleanup);
    });
  });
  document.getElementById("new-folder-name")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createFolderFromModal();
  });

  bindPlotInteractions();

  app.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", handleAction);
  });
}

function bindPlotInteractions() {
  document.querySelectorAll("canvas[data-plot-key]").forEach((canvas) => {
    const plotKey = canvas.dataset.plotKey;
    canvas.classList.toggle("zoom-selecting", state.zoomSelectionKey === plotKey);
    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenus();
      state.plotMenu = {
        plotKey,
        x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 264)),
        y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 116)),
      };
      render();
    });
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.zoomSelectionKey !== plotKey) return;
      const geometry = plotGeometry.get(canvas);
      if (!geometry) return;
      const rect = canvas.getBoundingClientRect();
      const startX = clamp(event.clientX - rect.left, geometry.plot.left, geometry.plot.right);
      const startY = clamp(event.clientY - rect.top, geometry.plot.top, geometry.plot.bottom);
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      state.zoomDrag = {
        plotKey,
        canvasId: canvas.id,
        pointerId: event.pointerId,
        startX,
        startY,
        currentX: startX,
        currentY: startY,
      };

      const move = (pointerEvent) => {
        if (pointerEvent.pointerId !== state.zoomDrag?.pointerId) return;
        const nextRect = canvas.getBoundingClientRect();
        state.zoomDrag.currentX = clamp(pointerEvent.clientX - nextRect.left, geometry.plot.left, geometry.plot.right);
        state.zoomDrag.currentY = clamp(pointerEvent.clientY - nextRect.top, geometry.plot.top, geometry.plot.bottom);
        paintCanvases();
      };
      const finish = (pointerEvent) => {
        if (pointerEvent.pointerId !== state.zoomDrag?.pointerId) return;
        move(pointerEvent);
        const drag = state.zoomDrag;
        cleanup();
        if (Math.abs(drag.currentX - drag.startX) >= 10 && Math.abs(drag.currentY - drag.startY) >= 10) {
          applyPlotZoomDrag(canvas, drag);
        } else {
          state.notice = { kind: "info", title: "Select a larger region", message: "Drag a rectangle across the plot to magnify that physical range." };
          render();
        }
      };
      const cancel = () => {
        cleanup();
        paintCanvases();
      };
      const cleanup = () => {
        if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        state.zoomDrag = null;
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", finish);
        canvas.removeEventListener("pointercancel", cancel);
      };

      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", finish);
      canvas.addEventListener("pointercancel", cancel);
    });
  });
}

function anchoredMenuPosition(anchor, menuWidth, menuHeight) {
  const gap = 6;
  const fitsRight = anchor.right + gap + menuWidth <= window.innerWidth - 8;
  const x = fitsRight ? anchor.right + gap : anchor.left - menuWidth - gap;
  return {
    x: clamp(x, 8, Math.max(8, window.innerWidth - menuWidth - 8)),
    y: clamp(anchor.top, 8, Math.max(8, window.innerHeight - menuHeight - 8)),
  };
}

function closeContextMenus() {
  state.datasetMenu = null;
  state.folderMenu = null;
  state.plotMenu = null;
}

function positionContextMenus() {
  [
    [".dataset-context-menu", state.datasetMenu],
    [".folder-context-menu", state.folderMenu],
    [".plot-context-menu", state.plotMenu],
  ].forEach(([selector, position]) => {
    const menu = document.querySelector(selector);
    if (!menu || !position) return;
    menu.animate(
      [{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }],
      { duration: 1, fill: "both" },
    );
  });
}

function clearPlotZooms(keys = null) {
  if (Array.isArray(keys)) {
    keys.forEach((key) => delete state.plotZooms[key]);
    if (keys.includes(state.zoomSelectionKey)) state.zoomSelectionKey = null;
  } else {
    state.plotZooms = {};
    state.zoomSelectionKey = null;
  }
  state.zoomDrag = null;
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  try {
    if (action === "activate") {
      const index = state.datasets.findIndex((dataset) => dataset.id === event.currentTarget.dataset.datasetId);
      if (index < 0) return;
      if (index !== state.activeIndex) clearPlotZooms();
      state.activeIndex = index;
      clampSelections();
      render();
    } else if (action === "apply-range") {
      const range = readRangeControls();
      const folderId = activeFolder()?.id;
      await runJob("Applying folder analysis range", "range", () => applyRangeToFolder(folderId, range), "Analysis range applied to the active folder.");
    } else if (action === "baseline") {
      const folder = activeFolder();
      if (!folder) return;
      folder.treatments.baseline = !folder.treatments.baseline;
      await runJob(folder.treatments.baseline ? "Applying pre-zero baseline" : "Removing baseline treatment", "baseline", () => rebuildTreatments(folder.id), "Baseline state updated for the active folder.");
    } else if (action === "chirp") {
      const folder = activeFolder();
      if (!folder) return;
      folder.treatments.chirp = !folder.treatments.chirp;
      await runJob(folder.treatments.chirp ? "Estimating and applying chirp" : "Removing chirp treatment", "chirp", () => rebuildTreatments(folder.id), "Chirp state updated for the active folder.");
    } else if (action === "reset") {
      const folderId = activeFolder()?.id;
      await runJob("Resetting folder datasets", "reset", () => resetAnalysis(folderId), "Active-folder treatments and manual cropping were reset.");
    } else if (action === "open-manual") {
      state.modal = "manual";
      render();
    } else if (action === "open-about") {
      state.modal = "about";
      render();
    } else if (action === "open-merge") {
      openMergeWorkspace();
    } else if (action === "create-merged-dataset") {
      await runJob("Creating aligned merged dataset", "merge", createMergedDatasetFromDraft,
        (dataset) => `${datasetDisplayName(dataset)} was added as a derived dataset; both parent sources remain unchanged.`);
    } else if (action === "compare") {
      openCompareSelection();
    } else if (action === "open-comparison") {
      if (state.compare.selectedIds.length >= 2) {
        state.modal = "compare-workspace";
        render();
      }
    } else if (action === "change-comparison") {
      state.modal = "compare-select";
      render();
    } else if (action === "global-fit") {
      syncLifetimeEditorFromDataset();
      state.modal = "fit";
      render();
    } else if (action === "close-modal") {
      state.modal = null;
      state.pendingDeleteId = null;
      state.pendingDatasetId = null;
      render();
    } else if (action === "run-fit") {
      await runFitActive();
    } else if (action === "batch-fit") {
      await runBatchFit();
    } else if (action === "save-project") {
      await saveProject();
    } else if (action === "export-md") {
      await exportMarkdown();
    } else if (action === "create-origin") {
      await createInOrigin();
    } else if (action === "export-plot-png") {
      const plotKey = event.currentTarget.dataset.plotKey;
      closeContextMenus();
      await exportDisplayedPlotPng(plotKey);
    } else if (action === "export-plot-txt") {
      const plotKey = event.currentTarget.dataset.plotKey;
      closeContextMenus();
      await exportDisplayedPlotTxt(plotKey);
    } else if (action === "result-mode") {
      state.fitting.spectrumMode = event.currentTarget.dataset.mode;
      clearPlotZooms(["main-components"]);
      updateComponentViewUi();
    } else if (action === "new-folder") {
      state.modal = "new-folder";
      render();
    } else if (action === "create-folder") {
      createFolderFromModal();
    } else if (action === "toggle-folder") {
      closeContextMenus();
      toggleFolder(event.currentTarget.dataset.folderId);
    } else if (action === "delete-folder") {
      closeContextMenus();
      deleteEmptyFolder(event.currentTarget.dataset.folderId);
    } else if (action === "delete-dataset") {
      state.datasetMenu = null;
      state.pendingDeleteId = event.currentTarget.dataset.datasetId;
      state.modal = "delete-dataset";
      render();
    } else if (action === "confirm-delete-dataset") {
      removeDatasetFromProject(state.pendingDeleteId);
    } else if (action === "enlarge-plot") {
      state.expandedPlot = event.currentTarget.dataset.plotKey;
      render();
    } else if (action === "select-plot-region") {
      const plotKey = event.currentTarget.dataset.plotKey;
      state.zoomSelectionKey = state.zoomSelectionKey === plotKey ? null : plotKey;
      closeContextMenus();
      render();
    } else if (action === "reset-plot-zoom") {
      const plotKey = event.currentTarget.dataset.plotKey;
      delete state.plotZooms[plotKey];
      if (state.zoomSelectionKey === plotKey) state.zoomSelectionKey = null;
      render();
    } else if (action === "close-expanded-plot") {
      state.expandedPlot = null;
      state.zoomSelectionKey = null;
      render();
    } else if (action === "close-context-menus") {
      closeContextMenus();
      render();
    } else if (action === "edit-dataset") {
      state.pendingDatasetId = event.currentTarget.dataset.datasetId;
      state.datasetMenu = null;
      state.modal = "edit-dataset";
      render();
    } else if (action === "save-dataset-details") {
      saveDatasetDetails();
    } else if (action === "move-dataset") {
      state.pendingDatasetId = event.currentTarget.dataset.datasetId;
      state.datasetMenu = null;
      state.modal = "move-dataset";
      render();
    } else if (action === "confirm-move-dataset") {
      const datasetId = state.pendingDatasetId;
      const folderId = document.getElementById("dataset-move-folder")?.value;
      state.pendingDatasetId = null;
      state.modal = null;
      moveDatasetToFolder(datasetId, folderId);
    } else if (action === "copy-dataset" || action === "cut-dataset") {
      setDatasetClipboard(event.currentTarget.dataset.datasetId, action === "copy-dataset" ? "copy" : "cut");
    } else if (action === "paste-dataset") {
      closeContextMenus();
      pasteDatasetIntoFolder(event.currentTarget.dataset.folderId);
    } else if (action === "rename-folder-menu") {
      const folderId = event.currentTarget.dataset.folderId;
      closeContextMenus();
      startFolderRename(folderId);
    } else if (action === "import-folder") {
      state.importTargetFolderId = event.currentTarget.dataset.folderId;
      closeContextMenus();
      render();
      await nextFrame();
      document.getElementById("folder-file-input")?.click();
    }
  } catch (error) {
    showError(error);
  }
}

async function importDataFiles(event, targetFolderId = null) {
  const files = Array.from(event.target.files ?? []);
  if (!files.length) {
    state.importTargetFolderId = null;
    return;
  }
  await runJob(`Importing ${files.length} dataset${files.length === 1 ? "" : "s"}`, "import", async () => {
    const existingFolder = state.folders.find((item) => item.id === targetFolderId);
    const folder = existingFolder ?? createFolderRecord(uniqueFolderName(inferImportFolderName(files)));
    const parsed = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      state.job.detail = `${index + 1} of ${files.length}: ${file.name}`;
      render();
      await nextFrame();
      const isUfs = /\.ufs$/i.test(file.name);
      let source;
      if (isUfs) {
        source = Parser.parseSpectroscopyUfs(await file.arrayBuffer(), file.name);
      } else {
        const rawText = await file.text();
        source = Parser.parseSpectroscopyCsv(rawText, file.name);
        source.rawText = rawText;
        source.sourceFormat = "csv";
      }
      const range = existingFolder?.range;
      const baseAnalysis = Parser.createAnalysisDataset(source, range ? {
        spectralRange: { min: range.wavelengthMin, max: range.wavelengthMax },
        timeRange: { min: range.timeMin, max: range.timeMax },
      } : {});
      if (range) {
        baseAnalysis.provenance.push({
          label: "Crop",
          status: "applied",
          range: `${format(baseAnalysis.spectralAxis[0])}-${format(baseAnalysis.spectralAxis.at(-1))} nm; ${format(baseAnalysis.timeAxis[0])}-${format(baseAnalysis.timeAxis.at(-1))} ps`,
        });
      }
      parsed.push({
        id: uniqueDatasetId(file.name, index),
        folderId: folder.id,
        projectLabel: file.name.replace(/\.[^.]+$/, ""),
        sampleNote: isUfs ? Parser.buildUfsDatasetNote(source) : "",
        source,
        baseAnalysis,
        analysis: Parser.cloneAnalysisDataset(baseAnalysis),
        fit: null,
      });
    }

    let analyses = parsed.map((dataset) => Parser.cloneAnalysisDataset(dataset.baseAnalysis));
    if (folder.treatments?.baseline) analyses = analyses.map((analysis) => Parser.applyBaselineCorrection(analysis));
    if (folder.treatments?.chirp) analyses = Parser.applySharedChirpCorrection(analyses);
    const datasets = parsed.map((dataset, index) => ({ ...dataset, analysis: analyses[index] }));

    if (!existingFolder) {
      folder.range = commonRangeFromAnalyses(datasets.map((dataset) => dataset.baseAnalysis));
      state.folders.push(folder);
    } else {
      folder.collapsed = false;
    }
    const firstNewIndex = state.datasets.length;
    state.datasets.push(...datasets);
    state.activeIndex = firstNewIndex;
    state.selectedTimeIndex = Math.floor(activeDataset().analysis.timeAxis.length * 0.25);
    state.selectedWavelengthIndex = Math.floor(activeDataset().analysis.spectralAxis.length * 0.5);
    state.compare.selectedIds = state.datasets.map((dataset) => dataset.id);
    ensureCompareStyles();
    markDirty();
  }, targetFolderId
    ? `${files.length} dataset${files.length === 1 ? "" : "s"} imported into the selected folder with its stored range and treatments. Original CSV text or UFS bytes are preserved.`
    : `${files.length} dataset${files.length === 1 ? "" : "s"} imported into one new folder. Original CSV text or UFS bytes are preserved.`);
  event.target.value = "";
  state.importTargetFolderId = null;
}

async function openProjectFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  await runJob("Opening project", "open-project", async () => {
    const project = isProjectArchive(file)
      ? hydrateProjectArchive(readProjectArchive(await file.arrayBuffer()), Parser)
      : JSON.parse(await file.text());
    loadProject(project);
    state.project = {
      dirty: false,
      lastSavedAt: project.savedAt ?? null,
      path: file.name,
    };
  }, `${file.name} opened with treated datasets and analysis state.`);
  event.target.value = "";
}

function readRangeControls() {
  const range = {
    wavelengthMin: readFiniteInput("range-wavelength-min"),
    wavelengthMax: readFiniteInput("range-wavelength-max"),
    timeMin: readFiniteInput("range-time-min"),
    timeMax: readFiniteInput("range-time-max"),
  };
  if (range.wavelengthMin > range.wavelengthMax || range.timeMin > range.timeMax) {
    throw new Error("Range minimum must not exceed range maximum.");
  }
  return range;
}

function applyRangeToFolder(folderId, nextRange) {
  const folder = state.folders.find((item) => item.id === folderId);
  const targets = folderDatasets(folderId);
  if (!folder || !targets.length) throw new Error("The active dataset folder is empty.");
  const targetIds = new Set(targets.map((dataset) => dataset.id));
  const updated = state.datasets.map((dataset) => {
    if (!targetIds.has(dataset.id)) return dataset;
    const baseAnalysis = Parser.createAnalysisDataset(dataset.source, {
      spectralRange: { min: nextRange.wavelengthMin, max: nextRange.wavelengthMax },
      timeRange: { min: nextRange.timeMin, max: nextRange.timeMax },
    });
    baseAnalysis.provenance.push({
      label: "Crop",
      status: "applied",
      range: `${format(baseAnalysis.spectralAxis[0])}-${format(baseAnalysis.spectralAxis.at(-1))} nm; ${format(baseAnalysis.timeAxis[0])}-${format(baseAnalysis.timeAxis.at(-1))} ps`,
    });
    return { ...dataset, baseAnalysis, analysis: Parser.cloneAnalysisDataset(baseAnalysis), fit: null };
  });
  state.datasets = updated;
  folder.range = { ...nextRange };
  rebuildTreatments(folderId);
  clearPlotZooms();
  clampSelections();
  markDirty();
}

function rebuildTreatments(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  const targets = folderDatasets(folderId);
  if (!folder || !targets.length) return;
  let analyses = targets.map((dataset) => {
    let analysis = Parser.cloneAnalysisDataset(dataset.baseAnalysis);
    if (folder.treatments.baseline) analysis = Parser.applyBaselineCorrection(analysis);
    return analysis;
  });
  if (folder.treatments.chirp) analyses = Parser.applySharedChirpCorrection(analyses);
  const analysisById = new Map(targets.map((dataset, index) => [dataset.id, analyses[index]]));
  state.datasets = state.datasets.map((dataset) => analysisById.has(dataset.id)
    ? { ...dataset, analysis: analysisById.get(dataset.id), fit: null }
    : dataset);
  clearPlotZooms();
  clampSelections();
  markDirty();
}

function resetAnalysis(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  const targets = folderDatasets(folderId);
  if (!folder || !targets.length) return;
  const targetIds = new Set(targets.map((dataset) => dataset.id));
  state.datasets = state.datasets.map((dataset) => {
    if (!targetIds.has(dataset.id)) return dataset;
    const baseAnalysis = Parser.createAnalysisDataset(dataset.source);
    return {
      ...dataset,
      baseAnalysis,
      analysis: Parser.cloneAnalysisDataset(baseAnalysis),
      fit: null,
    };
  });
  folder.treatments = { baseline: false, chirp: false };
  folder.range = commonRangeFromAnalyses(folderDatasets(folderId).map((dataset) => dataset.baseAnalysis));
  clearPlotZooms();
  clampSelections();
  markDirty();
}

async function runFitActive() {
  const configuration = readLifetimeConfiguration();
  await runJob("Running nonlinear global fitting", "fit", async () => {
    const dataset = activeDataset();
    if (!dataset) return;
    await nextFrame();
    dataset.fit = Parser.fitGlobalExponentials(dataset.analysis, state.fitting.components, {
      irfFwhm: state.fitting.irfFwhm,
      lifetimes: configuration.lifetimes,
      fixedLifetimes: configuration.fixedLifetimes,
    });
    state.fitting.lifetimeValues = dataset.fit.lifetimes.map((value) => conciseInputNumber(value));
    state.fitting.fixedLifetimes = dataset.fit.fixedLifetimes.slice();
    state.fitting.spectrumMode = "EAS";
    clearPlotZooms(["main-components", "modal-eas", "modal-das", "fit-residual"]);
    markDirty();
  }, "Global fitting completed. Main-screen lifetime and component-spectra panels are now available.");
}

async function runBatchFit() {
  const configuration = readLifetimeConfiguration();
  const targets = state.datasets.filter((dataset) => !dataset.fit);
  if (!targets.length) {
    state.notice = { kind: "info", title: "No unfitted datasets", message: "Batch Global Fitting preserves existing results and found no unfitted datasets to process." };
    render();
    return;
  }
  const targetIds = new Set(targets.map((dataset) => dataset.id));
  await runJob("Batch Global Fitting", "batch-fit", async () => {
    for (let index = 0; index < targets.length; index += 1) {
      state.job.detail = `${index + 1} of ${targets.length}: ${targets[index].source.fileName}`;
      render();
      await nextFrame();
      targets[index].fit = Parser.fitGlobalExponentials(targets[index].analysis, state.fitting.components, {
        irfFwhm: state.fitting.irfFwhm,
        lifetimes: configuration.lifetimes,
        fixedLifetimes: configuration.fixedLifetimes,
      });
    }
    const activeFit = activeDataset()?.fit;
    if (activeFit && targetIds.has(activeDataset().id)) {
      state.fitting.lifetimeValues = activeFit.lifetimes.map((value) => conciseInputNumber(value));
      state.fitting.fixedLifetimes = activeFit.fixedLifetimes.slice();
    }
    state.fitting.spectrumMode = "EAS";
    clearPlotZooms(["main-components", "modal-eas", "modal-das", "fit-residual", "compare-components"]);
    markDirty();
  }, `Global fitting completed for ${targets.length} previously unfitted dataset${targets.length === 1 ? "" : "s"}; existing fits were preserved.`);
}

function resetLifetimeEditor() {
  state.fitting.editorDatasetId = activeDataset()?.id ?? null;
  state.fitting.lifetimeValues = Array.from({ length: state.fitting.components }, () => "");
  state.fitting.fixedLifetimes = Array.from({ length: state.fitting.components }, () => false);
}

function syncLifetimeEditorFromDataset() {
  const dataset = activeDataset();
  if (state.fitting.editorDatasetId === dataset?.id
    && state.fitting.lifetimeValues.length === state.fitting.components) return;
  state.fitting.editorDatasetId = dataset?.id ?? null;
  if (dataset?.fit?.componentCount === state.fitting.components) {
    state.fitting.lifetimeValues = dataset.fit.lifetimes.map((value) => conciseInputNumber(value));
  } else {
    state.fitting.lifetimeValues = Array.from({ length: state.fitting.components }, () => "");
  }
  state.fitting.fixedLifetimes = Array.from({ length: state.fitting.components }, () => false);
}

function readLifetimeConfiguration() {
  const lifetimes = Array.from({ length: state.fitting.components }, (_, index) => {
    const raw = String(state.fitting.lifetimeValues[index] ?? "").trim();
    if (!raw) return Number.NaN;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`t${index + 1} must be a positive number or left blank.`);
    return value;
  });
  const fixedLifetimes = Array.from({ length: state.fitting.components }, (_, index) => Boolean(state.fitting.fixedLifetimes[index]));
  fixedLifetimes.forEach((fixed, index) => {
    if (fixed && !Number.isFinite(lifetimes[index])) throw new Error(`Enter a value for t${index + 1} before selecting Fix.`);
  });
  return { lifetimes, fixedLifetimes };
}

function serializeProject() {
  return {
    schema: "specflowlab.desktop_preview.v3",
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    projectContract: {
      sourceCsvPolicy: "original source text preserved and never modified",
      sourceDataPolicy: "original CSV text or UFS bytes preserved and never modified",
      treatedDatasetPolicy: "cropped, baseline-corrected, and chirp-corrected matrices materialized",
      derivedDatasetPolicy: "merged datasets are materialized derivatives with immutable parent sources, explicit lineage, time resampling, retained wavelength segments, and no hidden smoothing",
      folderPolicy: "one-level project dataset folders with per-folder range and treatment state",
      archivePolicy: "original source data and treated Float64 matrix stored once; derived fit matrices reconstructed on open",
    },
    state: {
      activeIndex: state.activeIndex,
      selectedTimeIndex: state.selectedTimeIndex,
      selectedWavelengthIndex: state.selectedWavelengthIndex,
      compare: state.compare,
      fitting: state.fitting,
    },
    folders: state.folders,
    datasets: state.datasets,
  };
}

function loadProject(project) {
  if (!project?.schema?.startsWith("specflowlab")) throw new Error("Unsupported SpecFlowLab project.");
  state.datasets = (project.datasets ?? []).map(reviveDataset);
  state.folders = reviveFolders(project.folders, project.state);
  assignLegacyFolderMembership();
  state.activeIndex = project.state?.activeIndex ?? 0;
  state.selectedTimeIndex = project.state?.selectedTimeIndex ?? 0;
  state.selectedWavelengthIndex = project.state?.selectedWavelengthIndex ?? 0;
  state.compare = { ...state.compare, ...(project.state?.compare ?? {}) };
  state.fitting = { ...state.fitting, ...(project.state?.fitting ?? {}) };
  state.merge = { selectedIds: [], plan: null, draft: null };
  state.compare.componentMode = "EAS";
  state.fitting.spectrumMode = "EAS";
  if (!state.compare.selectedIds?.length) state.compare.selectedIds = state.datasets.map((dataset) => dataset.id);
  ensureCompareStyles();
  clampSelections();
  state.expandedPlot = null;
  state.plotZooms = {};
  state.zoomSelectionKey = null;
  closeContextMenus();
  state.datasetClipboard = null;
}

function reviveDataset(dataset) {
  return {
    ...dataset,
    projectLabel: dataset.projectLabel || dataset.source?.fileName?.replace(/\.[^.]+$/, "") || "Dataset",
    sampleNote: dataset.sampleNote || "",
    source: reviveMatrixObject(dataset.source),
    baseAnalysis: reviveMatrixObject(dataset.baseAnalysis),
    analysis: reviveMatrixObject(dataset.analysis),
    fit: dataset.fit ? reviveFit(dataset.fit) : null,
  };
}

function reviveFolders(folders, legacyState = {}) {
  if (Array.isArray(folders) && folders.length) {
    return folders.map((folder) => ({
      ...folder,
      id: folder.id || uniqueId("folder"),
      name: folder.name || "Dataset Folder",
      range: folder.range ?? null,
      treatments: {
        baseline: Boolean(folder.treatments?.baseline),
        chirp: Boolean(folder.treatments?.chirp),
      },
      collapsed: Boolean(folder.collapsed),
    }));
  }
  if (!state.datasets.length) return [];
  const folder = createFolderRecord("Imported Data");
  folder.id = "folder_legacy_import";
  folder.range = legacyState.range ?? commonRangeFromAnalyses(state.datasets.map((dataset) => dataset.baseAnalysis));
  folder.treatments = legacyState.treatments ?? { baseline: false, chirp: false };
  return [folder];
}

function assignLegacyFolderMembership() {
  if (!state.datasets.length) return;
  if (!state.folders.length) state.folders.push(createFolderRecord("Imported Data"));
  const validIds = new Set(state.folders.map((folder) => folder.id));
  state.datasets.forEach((dataset) => {
    if (!validIds.has(dataset.folderId)) dataset.folderId = state.folders[0].id;
  });
  state.folders.forEach((folder) => {
    if (!folder.range) {
      const analyses = folderDatasets(folder.id).map((dataset) => dataset.baseAnalysis);
      folder.range = commonRangeFromAnalyses(analyses);
    }
  });
}

function reviveMatrixObject(value) {
  if (!value) return value;
  return {
    ...value,
    timeAxis: reviveArray(value.timeAxis),
    spectralAxis: reviveArray(value.spectralAxis),
    matrix: reviveMatrix(value.matrix),
  };
}

function reviveFit(fit) {
  return {
    ...fit,
    lifetimes: reviveArray(fit.lifetimes),
    fittedMatrix: reviveMatrix(fit.fittedMatrix),
    residualMatrix: reviveMatrix(fit.residualMatrix),
    amplitudes: reviveMatrix(fit.amplitudes),
    dasSpectra: reviveSpectra(fit.dasSpectra),
    easSpectra: reviveSpectra(fit.easSpectra),
  };
}

function reviveSpectra(spectra) {
  return (spectra ?? []).map((spectrum) => ({
    ...spectrum,
    x: reviveArray(spectrum.x),
    y: reviveArray(spectrum.y),
  }));
}

function reviveArray(values) {
  return (values ?? []).map((value) => value === null ? Number.NaN : value);
}

function reviveMatrix(matrix) {
  return (matrix ?? []).map(reviveArray);
}

function isProjectArchive(file) {
  return file.name.toLowerCase().endsWith(".sflproj");
}

function projectArchiveDefaultName() {
  const currentName = state.project.path?.split(/[\\/]/).at(-1) ?? "SpecFlowLab_project";
  const stem = currentName
    .replace(/\.sflproj$/i, "")
    .replace(/\.sfl\.json$/i, "")
    .replace(/\.json$/i, "");
  return `${stem || "SpecFlowLab_project"}.sflproj`;
}

async function saveProject() {
  await runJob("Saving project", "save", async () => {
    const archive = createProjectArchive(serializeProject());
    const defaultName = projectArchiveDefaultName();
    const path = await saveBinaryWithDialog(archive, defaultName, "project", "application/zip");
    if (!path) return false;
    state.project.path = path;
    state.project.lastSavedAt = new Date().toISOString();
    state.project.dirty = false;
    return true;
  }, "Compressed project archive saved with original CSV or UFS files, treated matrices, fit parameters, and analysis settings.");
}

async function exportMarkdown() {
  await runJob("Preparing AI handoff", "export-md", async () => {
    const summary = state.datasets.length > 1
      ? Parser.buildAiReadyProjectSummary(state.datasets, {
          componentCount: state.fitting.components,
          irfFwhm: state.fitting.irfFwhm,
        })
      : Parser.buildAiReadySummary(activeDataset().source, activeDataset().analysis, {
          fit: activeDataset().fit,
          sampleName: datasetDisplayName(activeDataset()),
          sampleNote: activeDataset().sampleNote || "",
          selectedTimeIndex: state.selectedTimeIndex,
          selectedWavelengthIndex: state.selectedWavelengthIndex,
        });
    return saveTextWithDialog(summary.markdown, "SpecFlowLab_ai_summary.md", "markdown", "text/markdown");
  }, "AI-ready Markdown exported to the selected path.");
}

async function createInOrigin() {
  await runJob("Launching OriginPro bridge", "create-origin", async () => {
    if (!isTauriRuntime() || !isWindowsPlatform()) {
      throw new Error("Create in OriginPro is available in the Windows SpecFlowLab app.");
    }
    const bundle = createOriginBundle(serializeProject());
    const projectName = projectArchiveDefaultName().replace(/\.sflproj$/i, "");
    return invoke("create_origin_project", {
      defaultName: `${projectName || "SpecFlowLab_project"}.opju`,
      bytes: Array.from(bundle),
      createPlots: state.origin.outputMode === "sheets-plots",
    });
  }, (result) => {
    const graphSummary = result.createPlots
      ? ` and ${result.graphCount} automatically rescaled graphs`
      : " in sheets-only mode";
    return (
      `OriginPro imported ${result.datasetCount} datasets into ${result.workbookCount} workbooks${graphSummary}, `
      + `then saved a ${formatBytes(result.outputBytes)} project at ${result.outputPath}. `
      + `The exact bridge input remains at ${result.bundlePath}. `
      + `${result.warningCount ? `${result.warningCount} plot warning(s) were recorded. ` : ""}`
      + `Diagnostics: ${result.statusPath} and ${result.logPath}.`
    );
  });
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown-size";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = bytes / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

async function exportDisplayedPlotPng(plotKey) {
  await runJob("Exporting displayed plot", "export-plot-png", async () => {
    await nextFrame();
    const canvas = findVisiblePlotCanvas(plotKey);
    if (!canvas) throw new Error("The selected plot is not currently visible.");
    const blob = await canvasToBlob(canvas, "image/png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return saveBinaryWithDialog(bytes, `${plotExportBaseName(plotKey)}.png`, "png", "image/png");
  }, "The displayed plot was exported with its current range and styling.");
}

async function exportDisplayedPlotTxt(plotKey) {
  await runJob("Exporting displayed plot data", "export-plot-txt", async () => {
    const contents = buildDisplayedPlotText(plotKey);
    return saveTextWithDialog(contents, `${plotExportBaseName(plotKey)}.txt`, "txt", "text/plain");
  }, "The numerical data represented by the displayed plot were exported.");
}

function findVisiblePlotCanvas(plotKey) {
  if (state.expandedPlot === plotKey) {
    const expanded = document.getElementById("expanded-canvas");
    if (expanded) return expanded;
  }
  return Array.from(document.querySelectorAll("canvas[data-plot-key]"))
    .find((canvas) => canvas.dataset.plotKey === plotKey && canvas.id !== "expanded-canvas") ?? null;
}

function plotExportBaseName(plotKey) {
  const datasetName = exportBaseName(datasetDisplayName(activeDataset()));
  return `${datasetName}_${plotKey.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
}

function buildDisplayedPlotText(plotKey) {
  const matrix = matrixExportForPlot(plotKey);
  if (matrix) {
    const rows = [matrix.columns, ...matrix.rows]
      .map((row) => row.map(formatExportValue).join("\t"));
    return `${rows.join("\n")}\n`;
  }
  const lineData = lineExportForPlot(plotKey);
  if (!lineData?.series.length) throw new Error("The selected plot has no displayed numerical data.");
  const rows = [["Series", lineData.xLabel, lineData.yLabel]];
  lineData.series.forEach((series) => {
    series.points
      .filter((point) => pointInsidePlotZoom(plotKey, point))
      .forEach((point) => rows.push([series.label, point.x, point.y]));
  });
  return `${rows.map((row) => row.map(formatExportValue).join("\t")).join("\n")}\n`;
}

function matrixExportForPlot(plotKey) {
  const dataset = activeDataset();
  if (!dataset) return null;
  const analysis = plotKey === "fit-residual" && dataset.fit?.residualMatrix
    ? { ...dataset.analysis, matrix: dataset.fit.residualMatrix }
    : plotKey === "heatmap" ? dataset.analysis : null;
  if (!analysis) return null;
  const zoom = state.plotZooms[plotKey];
  const rows = [];
  analysis.spectralAxis.forEach((wavelength, spectralIndex) => {
    if (zoom && (wavelength < zoom.xMin || wavelength > zoom.xMax)) return;
    analysis.timeAxis.forEach((time, timeIndex) => {
      if (zoom && (time < zoom.yMin || time > zoom.yMax)) return;
      rows.push([wavelength, time, analysis.matrix[spectralIndex][timeIndex]]);
    });
  });
  return {
    columns: ["Wavelength (nm)", "Time (ps)", plotKey === "fit-residual" ? "Residual DeltaOD" : "DeltaOD"],
    rows,
  };
}

function lineExportForPlot(plotKey) {
  const dataset = activeDataset();
  if (!dataset) return null;
  if (plotKey === "spectrum") return spectrumSeriesData(dataset);
  if (plotKey === "kinetics") return kineticsSeriesData(dataset);
  if (plotKey === "compare-spectrum") return comparisonSliceSeriesData("spectrum");
  if (plotKey === "compare-kinetics") return comparisonSliceSeriesData("kinetics");
  if (plotKey === "compare-components") return comparisonComponentSeriesData();
  if (plotKey === "main-components") {
    return componentSeriesData(
      visibleComponentSpectra(dataset, state.fitting.spectrumMode, state.fitting.hideIrfLimited),
      state.fitting.normalize,
      `${state.fitting.spectrumMode} DeltaOD`,
    );
  }
  if (plotKey === "modal-eas") {
    return componentSeriesData(visibleComponentSpectra(dataset, "EAS", state.fitting.hideIrfLimited), "none", "EAS DeltaOD");
  }
  if (plotKey === "modal-das") {
    return componentSeriesData(visibleComponentSpectra(dataset, "DAS", state.fitting.hideIrfLimited), "none", "DAS DeltaOD");
  }
  return null;
}

function spectrumSeriesData(dataset) {
  const analysis = dataset.analysis;
  const timeIndex = clamp(state.selectedTimeIndex, 0, analysis.timeAxis.length - 1);
  const series = [{
    label: "Measured",
    points: analysis.spectralAxis.map((x, rowIndex) => ({ x, y: analysis.matrix[rowIndex][timeIndex] })),
  }];
  if (dataset.fit?.fittedMatrix) {
    series.push({
      label: "Fit",
      points: analysis.spectralAxis.map((x, rowIndex) => ({ x, y: dataset.fit.fittedMatrix[rowIndex][timeIndex] })),
    });
  }
  return { xLabel: "Wavelength (nm)", yLabel: "DeltaOD", series };
}

function kineticsSeriesData(dataset) {
  const analysis = dataset.analysis;
  const wavelengthIndex = clamp(state.selectedWavelengthIndex, 0, analysis.spectralAxis.length - 1);
  const series = [{
    label: "Measured",
    points: analysis.timeAxis.map((x, timeIndex) => ({ x, y: analysis.matrix[wavelengthIndex][timeIndex] })),
  }];
  if (dataset.fit?.fittedMatrix) {
    series.push({
      label: "Fit",
      points: analysis.timeAxis.map((x, timeIndex) => ({ x, y: dataset.fit.fittedMatrix[wavelengthIndex][timeIndex] })),
    });
  }
  return { xLabel: "Time (ps)", yLabel: "DeltaOD", series };
}

function comparisonSliceSeriesData(mode) {
  const reference = activeDataset()?.analysis;
  if (!reference) return { xLabel: "", yLabel: "", series: [] };
  const referenceTime = reference.timeAxis[clamp(state.compare.timeIndex, 0, reference.timeAxis.length - 1)];
  const referenceWavelength = reference.spectralAxis[clamp(state.compare.wavelengthIndex, 0, reference.spectralAxis.length - 1)];
  const series = compareDatasets().map((dataset, index) => {
    const style = ensureDatasetStyle(dataset, index);
    const analysis = dataset.analysis;
    const points = mode === "spectrum"
      ? analysis.spectralAxis.map((x, rowIndex) => ({ x, y: analysis.matrix[rowIndex][nearestIndex(analysis.timeAxis, referenceTime)] }))
      : analysis.timeAxis.map((x, timeIndex) => ({ x, y: analysis.matrix[nearestIndex(analysis.spectralAxis, referenceWavelength)][timeIndex] }));
    return { label: style.label, points: normalizePoints(points, state.compare.normalize) };
  });
  return {
    xLabel: mode === "spectrum" ? "Wavelength (nm)" : "Time (ps)",
    yLabel: state.compare.normalize === "each" ? "Normalized DeltaOD" : "DeltaOD",
    series,
  };
}

function componentSeriesData(spectra, normalize, yLabel) {
  return {
    xLabel: "Wavelength (nm)",
    yLabel: normalize === "each" ? "Normalized amplitude" : yLabel,
    series: (spectra ?? []).map((spectrum, index) => {
      const componentIndex = spectrum.componentIndex ?? index;
      return {
        label: `t${componentIndex + 1} = ${format(spectrum.lifetime)} ps`,
        points: normalizePoints(spectrum.x.map((x, pointIndex) => ({ x, y: spectrum.y[pointIndex] })), normalize),
      };
    }),
  };
}

function comparisonComponentSeriesData() {
  const spectraKey = state.compare.componentMode === "EAS" ? "easSpectra" : "dasSpectra";
  const series = [];
  compareDatasets().forEach((dataset, datasetIndex) => {
    const style = ensureDatasetStyle(dataset, datasetIndex);
    (dataset.fit?.[spectraKey] ?? []).forEach((spectrum, componentIndex) => {
      if (state.compare.hideIrfLimited && dataset.fit?.irfLimited?.[componentIndex]) return;
      const points = normalizePoints(
        spectrum.x.map((x, pointIndex) => ({ x, y: spectrum.y[pointIndex] })),
        state.compare.normalize,
      );
      series.push({ label: `${style.label} t${componentIndex + 1}`, points });
    });
  });
  return {
    xLabel: "Wavelength (nm)",
    yLabel: state.compare.normalize === "each" ? `Normalized ${state.compare.componentMode}` : "DeltaOD",
    series,
  };
}

function pointInsidePlotZoom(plotKey, point) {
  const zoom = state.plotZooms[plotKey];
  if (!zoom) return true;
  return point.x >= zoom.xMin && point.x <= zoom.xMax && point.y >= zoom.yMin && point.y <= zoom.yMax;
}

function formatExportValue(value) {
  if (typeof value === "string") return value.replaceAll("\t", " ").replaceAll("\n", " ");
  if (!Number.isFinite(value)) return "NaN";
  return Number(value).toPrecision(12).replace(/\.?0+e/, "e");
}

async function saveTextWithDialog(contents, defaultName, fileType, mimeType) {
  if (isTauriRuntime()) {
    return invoke("save_text_file", { defaultName, fileType, contents });
  }
  downloadBlob(new Blob([contents], { type: mimeType }), defaultName);
  return defaultName;
}

async function saveBinaryWithDialog(bytes, defaultName, fileType, mimeType) {
  if (isTauriRuntime()) {
    return invoke("save_binary_file", { defaultName, fileType, bytes: Array.from(bytes) });
  }
  downloadBlob(new Blob([bytes], { type: mimeType }), defaultName);
  return defaultName;
}

async function runJob(label, kind, work, successMessage) {
  state.job = { label, kind, detail: "" };
  state.notice = null;
  render();
  await nextFrame();
  try {
    const result = await work();
    if (result === false || result === null) {
      state.notice = { kind: "info", title: "Cancelled", message: "No file or project state was changed." };
    } else {
      state.notice = {
        kind: "success",
        title: "Completed",
        message: typeof successMessage === "function" ? successMessage(result) : successMessage,
      };
    }
    return result;
  } catch (error) {
    state.notice = { kind: "error", title: "Could not complete the operation", message: errorMessage(error) };
    return null;
  } finally {
    state.job = null;
    render();
  }
}

function updateMergeSelection(datasetId, checked) {
  const dataset = state.datasets.find((item) => item.id === datasetId);
  if (!dataset || (checked && !isMergeReadyDataset(dataset))) return;
  if (checked) {
    state.merge.selectedIds = state.merge.selectedIds.filter((id) => id !== datasetId);
    state.merge.selectedIds.push(datasetId);
    if (state.merge.selectedIds.length > 2) state.merge.selectedIds.shift();
  } else {
    state.merge.selectedIds = state.merge.selectedIds.filter((id) => id !== datasetId);
  }
  state.merge.plan = null;
  state.merge.draft = null;
  render();
}

function selectedMergeDatasets() {
  return state.merge.selectedIds
    .map((id) => state.datasets.find((dataset) => dataset.id === id))
    .filter(Boolean);
}

function isMergeReadyDataset(dataset) {
  return Boolean(dataset && isTreated(dataset));
}

function pruneMergeSelection() {
  state.merge.selectedIds = state.merge.selectedIds.filter((id) => {
    const dataset = state.datasets.find((item) => item.id === id);
    return isMergeReadyDataset(dataset);
  }).slice(-2);
}

function canOpenMergeWorkspace() {
  const datasets = selectedMergeDatasets();
  return datasets.length === 2 && datasets.every(isMergeReadyDataset);
}

function openMergeWorkspace() {
  const datasets = selectedMergeDatasets();
  if (datasets.length !== 2) throw new Error("Select exactly two datasets before merging.");
  if (!datasets.every(isMergeReadyDataset)) throw new Error("Treat both datasets before merging.");
  const plan = prepareMergePlan(datasets[0], datasets[1], {
    alignmentMode: "treated-time-axis",
    timeShiftPs: 0,
  });
  state.merge.plan = plan;
  state.merge.draft = {
    lowRange: { ...plan.recommendedRanges.low },
    highRange: { ...plan.recommendedRanges.high },
    seamWavelength: plan.seam.wavelength,
    applyAmplitudeScale: Number.isFinite(plan.amplitudeScale.scale),
    outputName: uniqueDatasetLabel(`${plan.low.label} + ${plan.high.label}`),
    folderId: "__new__",
    previewTimeIndex: nearestIndex(plan.commonTimeAxis, Math.max(0, plan.commonTimeAxis[0])),
  };
  state.modal = "merge";
  render();
}

function syncMergeDraftFromDom() {
  const draft = state.merge.draft;
  if (!draft) return;
  const finiteValue = (id, fallback) => {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  draft.lowRange = {
    min: finiteValue("merge-low-min", draft.lowRange.min),
    max: finiteValue("merge-low-max", draft.lowRange.max),
  };
  draft.highRange = {
    min: finiteValue("merge-high-min", draft.highRange.min),
    max: finiteValue("merge-high-max", draft.highRange.max),
  };
  draft.seamWavelength = finiteValue("merge-seam", draft.seamWavelength);
  draft.applyAmplitudeScale = document.getElementById("merge-apply-scale")?.checked ?? draft.applyAmplitudeScale;
  draft.outputName = document.getElementById("merge-output-name")?.value ?? draft.outputName;
  draft.folderId = document.getElementById("merge-folder")?.value ?? draft.folderId;
}

function createMergedDatasetFromDraft() {
  syncMergeDraftFromDom();
  const plan = state.merge.plan;
  const draft = state.merge.draft;
  if (!plan || !draft) throw new Error("The merge workspace has no active plan.");
  const outputName = draft.outputName.trim();
  if (!outputName) throw new Error("Enter a name for the merged dataset.");
  let folder = state.folders.find((item) => item.id === draft.folderId);
  if (folder && (folder.treatments?.baseline || folder.treatments?.chirp)) {
    throw new Error("Choose the new Merged VIS-NIR folder or an untreated folder to avoid applying a folder treatment twice.");
  }
  const result = createMergedAnalysis(plan, {
    lowRange: draft.lowRange,
    highRange: draft.highRange,
    seamWavelength: draft.seamWavelength,
    applyAmplitudeScale: draft.applyAmplitudeScale,
  });
  if (!folder) {
    folder = createFolderRecord(uniqueFolderName("Merged VIS-NIR"));
    folder.range = rangeFromAnalysis(result.analysis);
    state.folders.push(folder);
  }

  const safeBase = exportBaseName(outputName) || "merged-vis-nir";
  const fileName = `${safeBase}.merged.csv`;
  const rawText = spectroscopySourceToCsv(result.analysis);
  const source = Parser.parseSpectroscopyCsv(rawText, fileName);
  source.rawText = rawText;
  source.sourceFormat = "derived-merge";
  source.metadata = {
    ...(source.metadata ?? {}),
    "Source format": "SpecFlowLab derived VIS/NIR merge",
    "Parent datasets": result.merge.sourceDatasets.map((item) => item.fileName || item.label).join("; "),
    "Time basis": result.merge.timeAlignment.method,
    "Time shift (ps)": String(result.merge.timeAlignment.appliedShiftPs),
    "Amplitude scale": String(result.merge.amplitudeScale.factor),
  };
  source.spectralSegments = result.analysis.spectralSegments.map((segment) => ({ ...segment }));
  source.wavelengthBreaks = result.analysis.wavelengthBreaks.map((item) => ({ ...item }));
  source.merge = result.merge;
  const baseAnalysis = Parser.cloneAnalysisDataset(result.analysis);
  const analysis = Parser.cloneAnalysisDataset(result.analysis);
  const dataset = {
    id: uniqueDatasetId(fileName, state.datasets.length),
    folderId: folder.id,
    kind: "merged",
    projectLabel: uniqueDatasetLabel(outputName),
    sampleNote: buildMergedDatasetNote(result.merge),
    source,
    baseAnalysis,
    analysis,
    merge: result.merge,
    fit: null,
  };
  state.datasets.push(dataset);
  state.activeIndex = state.datasets.length - 1;
  state.selectedTimeIndex = clamp(draft.previewTimeIndex, 0, analysis.timeAxis.length - 1);
  state.selectedWavelengthIndex = Math.floor(analysis.spectralAxis.length / 2);
  folder.collapsed = false;
  state.merge = { selectedIds: [], plan: null, draft: null };
  state.modal = null;
  ensureDatasetStyle(dataset, state.datasets.length - 1);
  markDirty();
  return dataset;
}

function buildMergedDatasetNote(merge) {
  const sources = merge.sourceDatasets.map((source) => source.fileName || source.label).join(" + ");
  const breaks = merge.wavelengthBreaks.length
    ? merge.wavelengthBreaks.map((item) => `${formatWavelength(item.left)}-${formatWavelength(item.right)} nm`).join(", ")
    : "none";
  return [
    "SpecFlowLab derived VIS/NIR merge; parent source datasets remain unchanged.",
    `Parents: ${sources}`,
    `Lower range: ${formatWavelength(merge.selectedRangesNm.low.min)}-${formatWavelength(merge.selectedRangesNm.low.max)} nm`,
    `Higher range: ${formatWavelength(merge.selectedRangesNm.high.min)}-${formatWavelength(merge.selectedRangesNm.high.max)} nm`,
    merge.timeAlignment.alignmentMode === "treated-time-axis"
      ? "Time basis: treated analysis time axes; no additional time-zero shift"
      : `Time alignment: moving signal sampled at reference time + ${formatCoordinate(merge.timeAlignment.appliedShiftPs)} ps`,
    `Common time grid: ${merge.commonTimePoints} reference-grid points; linear interpolation; no extrapolation`,
    `Higher-probe amplitude scale: ${merge.amplitudeScale.applied ? format(merge.amplitudeScale.factor) : "not applied"}`,
    `Wavelength breaks: ${breaks}`,
    `Saved signal smoothing: none`,
  ].join("\n");
}

function openCompareSelection() {
  clearPlotZooms(["compare-kinetics", "compare-spectrum", "compare-components"]);
  if (!state.compare.selectedIds.length) state.compare.selectedIds = state.datasets.map((dataset) => dataset.id);
  state.compare.stage = "select";
  state.compare.componentMode = "EAS";
  state.modal = "compare-select";
  state.compare.timeIndex = state.selectedTimeIndex;
  state.compare.wavelengthIndex = state.selectedWavelengthIndex;
  render();
}

function updateComparisonSelection(event) {
  const dataset = state.datasets[Number(event.target.dataset.index)];
  if (!dataset) return;
  if (event.target.checked) {
    if (!state.compare.selectedIds.includes(dataset.id)) state.compare.selectedIds.push(dataset.id);
  } else {
    state.compare.selectedIds = state.compare.selectedIds.filter((id) => id !== dataset.id);
  }
  syncComparisonSelectionControls();
  markDirty();
}

function syncComparisonSelectionControls() {
  const selectedCount = state.compare.selectedIds.length;
  const count = document.getElementById("compare-selection-count");
  const openButton = document.getElementById("open-comparison");
  const selectAll = document.getElementById("compare-select-all");
  if (count) count.textContent = `${selectedCount} selected`;
  if (openButton) openButton.disabled = selectedCount < 2;
  if (selectAll) {
    const checked = Boolean(state.datasets.length) && selectedCount === state.datasets.length;
    const mixed = selectedCount > 0 && selectedCount < state.datasets.length;
    selectAll.checked = checked;
    selectAll.indeterminate = mixed;
    selectAll.setAttribute("aria-checked", mixed ? "mixed" : `${checked}`);
  }
}

function updateComponentViewUi() {
  const dataset = activeDataset();
  const hiddenCount = state.fitting.hideIrfLimited && dataset?.fit
    ? dataset.fit.irfLimited?.filter(Boolean).length || 0
    : 0;
  document.querySelectorAll("[data-action=\"result-mode\"]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.fitting.spectrumMode);
  });
  const copy = document.getElementById("main-component-mode-copy");
  if (copy) {
    copy.textContent = hiddenCount ? `${hiddenCount} hidden` : "";
  }
  const canvas = document.getElementById("main-components");
  if (canvas) canvas.setAttribute("aria-label", `${state.fitting.spectrumMode} component spectra`);
  const resultHide = document.getElementById("result-hide-irf");
  const fitHide = document.getElementById("fit-hide-irf");
  const expandedHide = state.expandedPlot === "compare-components" ? null : document.getElementById("expanded-hide-irf");
  [resultHide, fitHide, expandedHide].filter(Boolean).forEach((control) => {
    const limited = irfLimitedCount(dataset);
    control.checked = state.fitting.hideIrfLimited && Boolean(limited);
    control.disabled = !limited;
  });
  paintCanvases();
}

function comparisonComponentCopy() {
  if (!state.compare.hideIrfLimited) return "";
  const hidden = compareDatasets().reduce(
    (count, dataset) => count + (dataset.fit?.irfLimited?.filter(Boolean).length || 0),
    0,
  );
  return hidden ? `${hidden} IRF-limited component${hidden === 1 ? "" : "s"} omitted` : "";
}

function updateComparisonComponentUi() {
  const heading = document.getElementById("compare-component-heading");
  const copy = document.getElementById("compare-component-copy");
  const hide = document.getElementById("compare-hide-irf");
  const expandedHide = state.expandedPlot === "compare-components" ? document.getElementById("expanded-hide-irf") : null;
  if (heading) heading.textContent = `${state.compare.componentMode} Comparison`;
  if (copy) copy.textContent = comparisonComponentCopy();
  [hide, expandedHide].filter(Boolean).forEach((control) => {
    const limited = compareDatasets().some((dataset) => irfLimitedCount(dataset));
    control.checked = state.compare.hideIrfLimited && limited;
    control.disabled = !limited;
  });
  paintComparisonComponents(document.getElementById("compare-components"));
  paintExpandedPlot();
}

function paintCanvases() {
  const dataset = activeDataset();
  if (!dataset) return;
  paintHeatmap(document.getElementById("heatmap"), dataset.analysis, { crosshair: true });
  paintSpectrum(document.getElementById("spectrum"), dataset);
  paintKinetics(document.getElementById("kinetics"), dataset);
  paintComponentSpectra(
    document.getElementById("main-components"),
    visibleComponentSpectra(dataset, state.fitting.spectrumMode, state.fitting.hideIrfLimited),
    { normalize: state.fitting.normalize, xBreaks: dataset.analysis.wavelengthBreaks },
  );
  paintComponentSpectra(document.getElementById("modal-eas"), visibleComponentSpectra(dataset, "EAS", state.fitting.hideIrfLimited), { xBreaks: dataset.analysis.wavelengthBreaks });
  paintComponentSpectra(document.getElementById("modal-das"), visibleComponentSpectra(dataset, "DAS", state.fitting.hideIrfLimited), { xBreaks: dataset.analysis.wavelengthBreaks });
  if (dataset.fit?.residualMatrix) {
    paintHeatmap(document.getElementById("fit-residual"), {
      ...dataset.analysis,
      matrix: dataset.fit.residualMatrix,
    }, { crosshair: false });
  }
  paintComparisonSlice(document.getElementById("compare-kinetics"), "kinetics");
  paintComparisonSlice(document.getElementById("compare-spectrum"), "spectrum");
  paintComparisonComponents(document.getElementById("compare-components"));
  paintMergePreview();
  paintExpandedPlot();
  paintZoomDragOverlay();
}

function paintMergePreview() {
  const canvas = document.getElementById("merge-preview-canvas");
  const plan = state.merge.plan;
  const draft = state.merge.draft;
  if (!canvas || !plan || !draft) return;
  const preview = mergePreviewSeries(plan, draft.previewTimeIndex, {
    applyAmplitudeScale: draft.applyAmplitudeScale,
  });
  drawLinePlot(canvas, [
    { ...preview.series[0], color: "#0c7c86", width: 2.4 },
    { ...preview.series[1], color: "#8b5d2a", width: 2.4 },
  ], "linear", {
    xLabel: uiText("Wavelength (nm)"),
    yLabel: "ΔOD",
    legend: false,
    bottomPadding: 58,
  });
  drawMergePreviewGuides(canvas, draft);
}

function drawMergePreviewGuides(canvas, draft) {
  const geometry = plotGeometry.get(canvas);
  if (!geometry) return;
  const ratio = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d");
  const xAt = (value) => scale(value, geometry.xExtent, [geometry.plot.left, geometry.plot.right]);
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  [
    [draft.lowRange.min, "#0c7c86"],
    [draft.lowRange.max, "#0c7c86"],
    [draft.highRange.min, "#8b5d2a"],
    [draft.highRange.max, "#8b5d2a"],
  ].forEach(([value, color]) => {
    if (!Number.isFinite(value) || value < geometry.xExtent[0] || value > geometry.xExtent[1]) return;
    const x = xAt(value);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, geometry.plot.top);
    ctx.lineTo(x, geometry.plot.bottom);
    ctx.stroke();
  });
  if (Number.isFinite(draft.seamWavelength)
    && draft.seamWavelength >= geometry.xExtent[0]
    && draft.seamWavelength <= geometry.xExtent[1]) {
    const x = xAt(draft.seamWavelength);
    ctx.strokeStyle = "#303f42";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, geometry.plot.top);
    ctx.lineTo(x, geometry.plot.bottom);
    ctx.stroke();
  }
  ctx.restore();
}

function paintHeatmap(canvas, analysis, options = {}) {
  if (!canvas || !analysis) return;
  const prepared = setupCanvas(canvas, options.exportWidth, options.exportHeight);
  const { ctx, width, height } = prepared;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const plot = heatmapPlotArea(width, height);
  const plotKey = options.plotKey ?? canvas.dataset.plotKey;
  const zoom = state.plotZooms[plotKey];
  const xExtent = zoom
    ? [clamp(zoom.xMin, analysis.spectralAxis[0], analysis.spectralAxis.at(-1)), clamp(zoom.xMax, analysis.spectralAxis[0], analysis.spectralAxis.at(-1))]
    : [analysis.spectralAxis[0], analysis.spectralAxis.at(-1)];
  const yExtent = zoom
    ? [clamp(zoom.yMin, analysis.timeAxis[0], analysis.timeAxis.at(-1)), clamp(zoom.yMax, analysis.timeAxis[0], analysis.timeAxis.at(-1))]
    : [analysis.timeAxis[0], analysis.timeAxis.at(-1)];
  const values = analysis.matrix.flatMap((row, spectralIndex) => {
    const wavelength = analysis.spectralAxis[spectralIndex];
    if (wavelength < xExtent[0] || wavelength > xExtent[1]) return [];
    return row.filter((value, timeIndex) => {
      const time = analysis.timeAxis[timeIndex];
      return time >= yExtent[0] && time <= yExtent[1] && Number.isFinite(value);
    });
  }).map(Math.abs).sort((a, b) => a - b);
  const limit = values[Math.floor(values.length * 0.985)] || 1;
  const timeTransform = makeTimeTransform(yExtent);
  const xCenters = analysis.spectralAxis.map((value) => scale(value, xExtent, [plot.left, plot.right]));
  const yCenters = analysis.timeAxis.map((value) => scale(timeTransform.toFraction(value), [0, 1], [plot.top, plot.bottom]));
  const xCells = heatmapSpectralCells(analysis.spectralAxis, xCenters, plot.left, plot.right, analysis.wavelengthBreaks);
  const yBounds = cellBounds(yCenters, plot.top, plot.bottom);

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.clip();
  analysis.matrix.forEach((row, spectralIndex) => {
    const wavelength = analysis.spectralAxis[spectralIndex];
    if (wavelength < xExtent[0] || wavelength > xExtent[1]) return;
    row.forEach((value, timeIndex) => {
      const time = analysis.timeAxis[timeIndex];
      if (time < yExtent[0] || time > yExtent[1]) return;
      const x0 = xCells[spectralIndex].left;
      const x1 = xCells[spectralIndex].right;
      const y0 = yBounds[timeIndex];
      const y1 = yBounds[timeIndex + 1];
      ctx.fillStyle = Number.isFinite(value) ? diverging(value / limit) : "#d9e0e2";
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0 + 0.5), Math.max(1, y1 - y0 + 0.5));
    });
  });
  ctx.restore();

  drawHeatmapAxes(ctx, plot, analysis, timeTransform, xExtent, yExtent);
  plotGeometry.set(canvas, { type: "heatmap", plot, plotKey, xExtent, yExtent, timeTransform });
  if (options.crosshair !== false) {
    const wavelength = analysis.spectralAxis[clamp(state.selectedWavelengthIndex, 0, analysis.spectralAxis.length - 1)];
    const time = analysis.timeAxis[clamp(state.selectedTimeIndex, 0, analysis.timeAxis.length - 1)];
    if (wavelength >= xExtent[0] && wavelength <= xExtent[1] && time >= yExtent[0] && time <= yExtent[1]) {
      const x = scale(wavelength, xExtent, [plot.left, plot.right]);
      const y = scale(timeTransform.toFraction(time), [0, 1], [plot.top, plot.bottom]);
      ctx.save();
      ctx.strokeStyle = "rgba(20, 42, 46, 0.78)";
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom);
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function paintSpectrum(canvas, dataset) {
  if (!canvas || !dataset) return;
  const analysis = dataset.analysis;
  const timeIndex = clamp(state.selectedTimeIndex, 0, analysis.timeAxis.length - 1);
  const measured = analysis.spectralAxis.map((x, rowIndex) => ({ x, y: analysis.matrix[rowIndex][timeIndex] }));
  const series = [{ points: measured, color: "#8b5d2a", width: 2.1, label: uiText("Measured"), xBreaks: analysis.wavelengthBreaks }];
  if (dataset.fit?.fittedMatrix) {
    series.push({
      points: analysis.spectralAxis.map((x, rowIndex) => ({ x, y: dataset.fit.fittedMatrix[rowIndex][timeIndex] })),
      color: "#0c7c86",
      width: 2.1,
      label: uiText("Fit"),
      xBreaks: analysis.wavelengthBreaks,
    });
  }
  drawLinePlot(canvas, series, "linear", { xLabel: uiText("Wavelength (nm)"), yLabel: "\u0394OD" });
}

function paintKinetics(canvas, dataset) {
  if (!canvas || !dataset) return;
  const analysis = dataset.analysis;
  const wavelengthIndex = clamp(state.selectedWavelengthIndex, 0, analysis.spectralAxis.length - 1);
  const measured = analysis.timeAxis.map((x, timeIndex) => ({ x, y: analysis.matrix[wavelengthIndex][timeIndex] }));
  const series = [{ points: measured, color: "#8b5d2a", width: 2.1, label: uiText("Measured") }];
  if (dataset.fit?.fittedMatrix) {
    series.push({
      points: analysis.timeAxis.map((x, timeIndex) => ({ x, y: dataset.fit.fittedMatrix[wavelengthIndex][timeIndex] })),
      color: "#0c7c86",
      width: 2.1,
      label: uiText("Fit"),
    });
  }
  drawLinePlot(canvas, series, "time", { xLabel: uiText("Time (ps)"), yLabel: "\u0394OD" });
}

function paintComparisonSlice(canvas, mode) {
  if (!canvas) return;
  const datasets = compareDatasets();
  const reference = activeDataset()?.analysis;
  if (datasets.length < 2 || !reference) return;
  const referenceTime = reference.timeAxis[clamp(state.compare.timeIndex, 0, reference.timeAxis.length - 1)];
  const referenceWavelength = reference.spectralAxis[clamp(state.compare.wavelengthIndex, 0, reference.spectralAxis.length - 1)];
  const series = datasets.map((dataset, index) => {
    const style = ensureDatasetStyle(dataset, index);
    const analysis = dataset.analysis;
    const points = mode === "spectrum"
      ? analysis.spectralAxis.map((x, rowIndex) => ({ x, y: analysis.matrix[rowIndex][nearestIndex(analysis.timeAxis, referenceTime)] }))
      : analysis.timeAxis.map((x, colIndex) => ({ x, y: analysis.matrix[nearestIndex(analysis.spectralAxis, referenceWavelength)][colIndex] }));
    return {
      points: normalizePoints(points, state.compare.normalize),
      color: style.color,
      width: style.lineWidth,
      dash: lineDash(style.lineStyle),
      label: style.label,
      xBreaks: mode === "spectrum" ? analysis.wavelengthBreaks : [],
    };
  });
  drawLinePlot(canvas, series, mode === "spectrum" ? "linear" : "time", {
    xLabel: uiText(mode === "spectrum" ? "Wavelength (nm)" : "Time (ps)"),
    yLabel: state.compare.normalize === "each" ? uiText("Normalized \u0394OD") : "\u0394OD",
  });
}

function paintComparisonComponents(canvas) {
  if (!canvas) return;
  const spectraKey = state.compare.componentMode === "EAS" ? "easSpectra" : "dasSpectra";
  const series = [];
  const legendItems = [];
  compareDatasets().forEach((dataset, datasetIndex) => {
    const style = ensureDatasetStyle(dataset, datasetIndex);
    let retained = 0;
    (dataset.fit?.[spectraKey] ?? []).forEach((spectrum, componentIndex) => {
      if (state.compare.hideIrfLimited && dataset.fit?.irfLimited?.[componentIndex]) return;
      const points = spectrum.x.map((x, pointIndex) => ({ x, y: spectrum.y[pointIndex] }));
      series.push({
        points: normalizePoints(points, state.compare.normalize),
        color: style.color,
        width: style.lineWidth,
        dash: lineDash(style.lineStyle),
        label: `${style.label} t${componentIndex + 1}`,
        xBreaks: dataset.analysis.wavelengthBreaks,
      });
      retained += 1;
    });
    if (retained) {
      legendItems.push({
        label: style.label,
        color: style.color,
        width: style.lineWidth,
        dash: lineDash(style.lineStyle),
      });
    }
  });
  if (!series.length) {
    drawEmptyCanvas(canvas, uiText(`No compatible ${state.compare.componentMode} results in the selected datasets.`));
    return;
  }
  drawLinePlot(canvas, series, "linear", {
    xLabel: uiText("Wavelength (nm)"),
    yLabel: state.compare.normalize === "each" ? `Normalized ${state.compare.componentMode}` : "\u0394OD",
    legendItems,
  });
}

function paintComponentSpectra(canvas, spectra, options = {}) {
  if (!canvas) return;
  if (!spectra?.length) {
    drawEmptyCanvas(canvas, uiText("No visible component spectra."));
    return;
  }
  const series = spectra.map((spectrum, index) => {
    const componentIndex = spectrum.componentIndex ?? index;
    const points = spectrum.x.map((x, pointIndex) => ({ x, y: spectrum.y[pointIndex] }));
    return {
      points: normalizePoints(points, options.normalize),
      color: componentColor(componentIndex),
      width: 2,
      label: `t${componentIndex + 1} = ${format(spectrum.lifetime)} ps`,
      xBreaks: options.xBreaks,
    };
  });
  drawLinePlot(canvas, series, "linear", {
    xLabel: uiText("Wavelength (nm)"),
    yLabel: options.normalize === "each" ? uiText("Normalized amplitude") : "\u0394OD",
    legend: false,
    bottomPadding: 72,
    xLabelOffset: 30,
  });
}

function paintExpandedPlot() {
  const canvas = document.getElementById("expanded-canvas");
  const dataset = activeDataset();
  if (!canvas || !dataset || !state.expandedPlot) return;
  if (state.expandedPlot === "heatmap") {
    paintHeatmap(canvas, dataset.analysis, { crosshair: true });
  } else if (state.expandedPlot === "spectrum") {
    paintSpectrum(canvas, dataset);
  } else if (state.expandedPlot === "kinetics") {
    paintKinetics(canvas, dataset);
  } else if (state.expandedPlot === "main-components") {
    paintComponentSpectra(canvas, visibleComponentSpectra(dataset, state.fitting.spectrumMode, state.fitting.hideIrfLimited), {
      normalize: state.fitting.normalize,
      xBreaks: dataset.analysis.wavelengthBreaks,
    });
  } else if (state.expandedPlot === "modal-eas") {
    paintComponentSpectra(canvas, visibleComponentSpectra(dataset, "EAS", state.fitting.hideIrfLimited), { xBreaks: dataset.analysis.wavelengthBreaks });
  } else if (state.expandedPlot === "modal-das") {
    paintComponentSpectra(canvas, visibleComponentSpectra(dataset, "DAS", state.fitting.hideIrfLimited), { xBreaks: dataset.analysis.wavelengthBreaks });
  } else if (state.expandedPlot === "fit-residual" && dataset.fit?.residualMatrix) {
    paintHeatmap(canvas, { ...dataset.analysis, matrix: dataset.fit.residualMatrix }, { crosshair: false });
  } else if (state.expandedPlot === "compare-kinetics") {
    paintComparisonSlice(canvas, "kinetics");
  } else if (state.expandedPlot === "compare-spectrum") {
    paintComparisonSlice(canvas, "spectrum");
  } else if (state.expandedPlot === "compare-components") {
    paintComparisonComponents(canvas);
  }
}

function drawLinePlot(canvas, series, xMode, options = {}) {
  if (!canvas) return;
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);
  const finite = series.flatMap((item) => item.points).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (finite.length < 2) {
    drawEmptyCanvas(canvas, uiText("No finite values available."));
    return;
  }

  const plot = {
    left: 88,
    right: width - 28,
    top: 20,
    bottom: height - (options.bottomPadding ?? 64),
  };
  const plotKey = options.plotKey ?? canvas.dataset.plotKey;
  const zoom = state.plotZooms[plotKey];
  const fullXExtent = [Math.min(...finite.map((point) => point.x)), Math.max(...finite.map((point) => point.x))];
  const fullYExtent = paddedExtent(finite.map((point) => point.y));
  const xExtent = zoom ? [zoom.xMin, zoom.xMax] : fullXExtent;
  const yAxis = zoom
    ? { extent: [zoom.yMin, zoom.yMax], ticks: makeNiceTicksWithin(zoom.yMin, zoom.yMax, 5) }
    : makeNiceAxis(...fullYExtent, 5);
  const yExtent = yAxis.extent;
  const timeTransform = xMode === "time" ? makeTimeTransform([xExtent[0], xExtent[1]]) : null;
  const projectX = (value) => xMode === "time"
    ? scale(timeTransform.toFraction(value), [0, 1], [plot.left, plot.right])
    : scale(value, xExtent, [plot.left, plot.right]);
  const projectY = (value) => scale(value, yExtent, [plot.bottom, plot.top]);

  drawLineAxes(ctx, plot, xExtent, yExtent, yAxis.ticks, xMode, timeTransform, options);
  const wavelengthBreaks = xMode === "linear"
    ? (options.xBreaks ?? series.flatMap((item) => item.xBreaks ?? []))
    : [];
  drawWavelengthBreakMarks(ctx, plot, xExtent, wavelengthBreaks);
  plotGeometry.set(canvas, { type: "line", plot, plotKey, xMode, xExtent, yExtent, timeTransform });
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.clip();
  series.forEach((item) => {
    ctx.save();
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width ?? 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (item.dash?.length) ctx.setLineDash(item.dash);
    ctx.beginPath();
    let started = false;
    let previousX = null;
    item.points.forEach((point) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        started = false;
        previousX = null;
        return;
      }
      if (previousX !== null && crossesWavelengthBreak(item.xBreaks ?? options.xBreaks, previousX, point.x)) started = false;
      const x = projectX(point.x);
      const y = projectY(point.y);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      previousX = point.x;
    });
    ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
  const legendItems = options.legendItems ?? series;
  if (options.legend !== false && (legendItems.length > 1 || options.legendItems)) drawLegend(ctx, legendItems, plot);
}

function crossesWavelengthBreak(breaks, left, right) {
  const min = Math.min(left, right);
  const max = Math.max(left, right);
  return (breaks ?? []).some((item) => min <= item.left && max >= item.right);
}

function drawWavelengthBreakMarks(ctx, plot, xExtent, breaks) {
  (breaks ?? []).forEach((item) => {
    if (item.right < xExtent[0] || item.left > xExtent[1]) return;
    const middle = (item.left + item.right) / 2;
    const x = scale(middle, xExtent, [plot.left, plot.right]);
    ctx.save();
    ctx.strokeStyle = "#56666a";
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(x - 7, plot.bottom + 5);
    ctx.lineTo(x - 2, plot.bottom - 5);
    ctx.moveTo(x + 1, plot.bottom + 5);
    ctx.lineTo(x + 6, plot.bottom - 5);
    ctx.stroke();
    ctx.restore();
  });
}

function drawLineAxes(ctx, plot, xExtent, yExtent, yTicks, xMode, timeTransform, options) {
  ctx.save();
  ctx.font = "12px system-ui, sans-serif";
  ctx.strokeStyle = "rgba(194, 205, 208, 0.72)";
  ctx.fillStyle = "#687579";
  ctx.lineWidth = 1;

  yTicks.forEach((tick) => {
    const y = scale(tick, yExtent, [plot.bottom, plot.top]);
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(formatAxisNumber(tick), plot.left - 9, y);
  });

  if (xMode === "time") {
    const tickSet = makeTimeTickSet(xExtent[0], xExtent[1]);
    tickSet.minor.forEach((tick) => {
      const x = scale(timeTransform.toFraction(tick), [0, 1], [plot.left, plot.right]);
      ctx.beginPath();
      ctx.moveTo(x, plot.bottom);
      ctx.lineTo(x, plot.bottom + 4);
      ctx.stroke();
    });
    tickSet.major.forEach((tick) => {
      const x = scale(timeTransform.toFraction(tick), [0, 1], [plot.left, plot.right]);
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom + 6);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(`${Math.round(tick)}`, x, plot.bottom + 9);
    });
  } else {
    makeNiceTicksWithin(xExtent[0], xExtent[1], 6).forEach((tick) => {
      const x = scale(tick, xExtent, [plot.left, plot.right]);
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom + 6);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(formatAxisNumber(tick), x, plot.bottom + 9);
    });
  }

  ctx.fillStyle = "#56666a";
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    options.xLabel ?? "",
    (plot.left + plot.right) / 2,
    plot.bottom + (options.xLabelOffset ?? 36),
  );
  ctx.save();
  ctx.translate(15, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(options.yLabel ?? "", 0, 0);
  ctx.restore();
  ctx.restore();
}

function drawHeatmapAxes(ctx, plot, analysis, timeTransform, xExtent, yExtent) {
  ctx.save();
  ctx.strokeStyle = "#bfcacc";
  ctx.fillStyle = "#687579";
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui, sans-serif";
  ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);

  makeStepTicks(xExtent[0], xExtent[1], 100).forEach((tick) => {
    const x = scale(tick, xExtent, [plot.left, plot.right]);
    ctx.beginPath();
    ctx.moveTo(x, plot.bottom);
    ctx.lineTo(x, plot.bottom + 6);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(formatAxisNumber(tick), x, plot.bottom + 9);
  });

  const ticks = makeTimeTickSet(yExtent[0], yExtent[1]);
  ticks.minor.forEach((tick) => {
    const y = scale(timeTransform.toFraction(tick), [0, 1], [plot.top, plot.bottom]);
    ctx.beginPath();
    ctx.moveTo(plot.left - 4, y);
    ctx.lineTo(plot.left, y);
    ctx.stroke();
  });
  let lastTimeLabelY = -Infinity;
  ticks.major.forEach((tick) => {
    const y = scale(timeTransform.toFraction(tick), [0, 1], [plot.top, plot.bottom]);
    ctx.beginPath();
    ctx.moveTo(plot.left - 6, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    if (y - lastTimeLabelY >= 14) {
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(`${Math.round(tick)}`, plot.left - 9, y);
      lastTimeLabelY = y;
    }
  });

  ctx.font = "600 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(uiText("Wavelength (nm)"), (plot.left + plot.right) / 2, plot.bottom + 42);
  drawWavelengthBreakMarks(ctx, plot, xExtent, analysis.wavelengthBreaks);
  ctx.save();
  ctx.translate(15, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(uiText("Time (ps)"), 0, 0);
  ctx.restore();
  ctx.restore();
}

function drawLegend(ctx, series, plot) {
  const rows = series.slice(0, 12);
  const boxWidth = Math.min(210, Math.max(120, ...rows.map((item) => item.label.length * 6.4 + 48)));
  const boxHeight = rows.length * 18 + 12;
  const x = plot.right - boxWidth - 8;
  const y = plot.top + 8;
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.strokeStyle = "#ccd6d8";
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.strokeRect(x, y, boxWidth, boxHeight);
  ctx.font = "12px system-ui, sans-serif";
  rows.forEach((item, index) => {
    const rowY = y + 12 + index * 18;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(item.dash ?? []);
    ctx.beginPath();
    ctx.moveTo(x + 10, rowY);
    ctx.lineTo(x + 34, rowY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#263437";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(item.label, x + 41, rowY);
  });
  ctx.restore();
}

function drawEmptyCanvas(canvas, message) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#718084";
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, width / 2, height / 2);
}

function setupCanvas(canvas, exportWidth, exportHeight) {
  const ratio = exportWidth ? 1 : window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = exportWidth ?? Math.max(1, rect.width || Number(canvas.getAttribute("width")) || 640);
  const height = exportHeight ?? Math.max(1, rect.height || Number(canvas.getAttribute("height")) || 320);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function heatmapPlotArea(width, height) {
  return { left: 78, right: width - 26, top: 20, bottom: height - 66 };
}

function applyPlotZoomDrag(canvas, drag) {
  const geometry = plotGeometry.get(canvas);
  if (!geometry) return;
  const left = Math.min(drag.startX, drag.currentX);
  const right = Math.max(drag.startX, drag.currentX);
  const top = Math.min(drag.startY, drag.currentY);
  const bottom = Math.max(drag.startY, drag.currentY);
  const xAt = (pixel) => geometry.xMode === "time"
    ? geometry.timeTransform.fromFraction(scale(pixel, [geometry.plot.left, geometry.plot.right], [0, 1]))
    : scale(pixel, [geometry.plot.left, geometry.plot.right], geometry.xExtent);
  const yAt = geometry.type === "heatmap"
    ? (pixel) => geometry.timeTransform.fromFraction(scale(pixel, [geometry.plot.top, geometry.plot.bottom], [0, 1]))
    : (pixel) => scale(pixel, [geometry.plot.bottom, geometry.plot.top], geometry.yExtent);
  const xValues = [xAt(left), xAt(right)].sort((a, b) => a - b);
  const yValues = [yAt(top), yAt(bottom)].sort((a, b) => a - b);
  if (!xValues.every(Number.isFinite) || !yValues.every(Number.isFinite)) return;
  state.plotZooms[drag.plotKey] = {
    xMin: xValues[0],
    xMax: xValues[1],
    yMin: yValues[0],
    yMax: yValues[1],
  };
  state.zoomSelectionKey = null;
  state.notice = {
    kind: "success",
    title: "Plot region selected",
    message: `${expandedPlotMeta(drag.plotKey).title} now shows the selected physical range.`,
  };
  render();
}

function paintZoomDragOverlay() {
  const drag = state.zoomDrag;
  if (!drag) return;
  const canvas = document.getElementById(drag.canvasId);
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const left = Math.min(drag.startX, drag.currentX);
  const top = Math.min(drag.startY, drag.currentY);
  const width = Math.abs(drag.currentX - drag.startX);
  const height = Math.abs(drag.currentY - drag.startY);
  ctx.fillStyle = "rgba(11, 124, 134, 0.14)";
  ctx.strokeStyle = "#0b7c86";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(left, top, width, height);
  ctx.strokeRect(left, top, width, height);
  ctx.restore();
}

function updateSelectionFromHeatmap(event, canvas) {
  const analysis = activeDataset()?.analysis;
  if (!analysis) return;
  const rect = canvas.getBoundingClientRect();
  const plot = heatmapPlotArea(rect.width, rect.height);
  const x = clamp(event.clientX - rect.left, plot.left, plot.right);
  const y = clamp(event.clientY - rect.top, plot.top, plot.bottom);
  const wavelength = scale(x, [plot.left, plot.right], [analysis.spectralAxis[0], analysis.spectralAxis.at(-1)]);
  const timeTransform = makeTimeTransform(analysis.timeAxis);
  const fraction = scale(y, [plot.top, plot.bottom], [0, 1]);
  const time = timeTransform.fromFraction(fraction);
  state.selectedWavelengthIndex = nearestIndex(analysis.spectralAxis, wavelength);
  state.selectedTimeIndex = nearestIndex(analysis.timeAxis, time);
  const timeSlider = document.getElementById("time-slider");
  const wavelengthSlider = document.getElementById("wavelength-slider");
  if (timeSlider) timeSlider.value = `${state.selectedTimeIndex}`;
  if (wavelengthSlider) wavelengthSlider.value = `${state.selectedWavelengthIndex}`;
  syncSelectionLabels();
  paintCanvases();
}

function syncSelectionLabels() {
  const analysis = activeDataset()?.analysis;
  if (!analysis) return;
  const spectrum = document.getElementById("spectrum-coordinate");
  const kinetics = document.getElementById("kinetics-coordinate");
  if (spectrum) spectrum.textContent = `${formatCoordinate(analysis.timeAxis[state.selectedTimeIndex])} ps`;
  if (kinetics) kinetics.textContent = `${formatWavelength(analysis.spectralAxis[state.selectedWavelengthIndex])} nm`;
  const expanded = document.getElementById("expanded-coordinate");
  if (expanded && state.expandedPlot === "spectrum") {
    expanded.textContent = `${formatCoordinate(analysis.timeAxis[state.selectedTimeIndex])} ps`;
  } else if (expanded && state.expandedPlot === "kinetics") {
    expanded.textContent = `${formatWavelength(analysis.spectralAxis[state.selectedWavelengthIndex])} nm`;
  }
}

function updateComparisonCoordinateLabels() {
  const analysis = activeDataset()?.analysis;
  if (!analysis) return;
  const time = analysis.timeAxis[clamp(state.compare.timeIndex, 0, analysis.timeAxis.length - 1)];
  const wavelength = analysis.spectralAxis[clamp(state.compare.wavelengthIndex, 0, analysis.spectralAxis.length - 1)];
  const timeLabel = document.getElementById("compare-time-value");
  const wavelengthLabel = document.getElementById("compare-wavelength-value");
  if (timeLabel) timeLabel.textContent = `${formatCoordinate(time)} ps`;
  if (wavelengthLabel) wavelengthLabel.textContent = `${formatWavelength(wavelength)} nm`;
  const expanded = document.getElementById("expanded-coordinate");
  if (expanded && state.expandedPlot === "compare-spectrum") {
    expanded.textContent = `${formatCoordinate(time)} ps`;
  } else if (expanded && state.expandedPlot === "compare-kinetics") {
    expanded.textContent = `${formatWavelength(wavelength)} nm`;
  }
}

function makeTimeTransform(values) {
  const finite = values.filter(Number.isFinite);
  const min = finite[0] ?? 0;
  const max = finite.at(-1) ?? 1;
  const switchTime = 1;
  const hasLinear = min < switchTime;
  const hasLog = max > switchTime;
  const linearFraction = hasLinear ? (hasLog ? 0.24 : 1) : 0;
  const linearEnd = hasLog ? switchTime : max;
  const logMin = Math.log10(Math.max(min, switchTime));
  const logMax = Math.log10(Math.max(max, switchTime + 1e-9));
  const logSpan = Math.max(1e-12, logMax - logMin);

  return {
    toFraction(value) {
      if (value <= switchTime && linearFraction > 0) {
        return clamp(((value - min) / Math.max(1e-12, linearEnd - min)) * linearFraction, 0, 1);
      }
      const positiveFraction = (Math.log10(Math.max(value, switchTime)) - logMin) / logSpan;
      return clamp(linearFraction + positiveFraction * (1 - linearFraction), 0, 1);
    },
    fromFraction(fraction) {
      const x = clamp(fraction, 0, 1);
      if (linearFraction > 0 && x <= linearFraction) {
        return min + (x / linearFraction) * (linearEnd - min);
      }
      const positiveFraction = (x - linearFraction) / Math.max(1e-12, 1 - linearFraction);
      return 10 ** (logMin + positiveFraction * logSpan);
    },
  };
}

function makeTimeTickSet(min, max) {
  const major = [];
  const minor = [];
  if (min < 0) {
    [-10, -5, -2, -1].forEach((tick) => {
      if (tick >= min && tick <= max) major.push(tick);
    });
  }
  if (min <= 0 && max >= 0) major.push(0);
  const maxExp = Math.ceil(Math.log10(Math.max(1, max)));
  for (let exponent = 0; exponent <= maxExp; exponent += 1) {
    const base = 10 ** exponent;
    if (base >= min && base <= max) major.push(base);
    [2, 3, 5].forEach((factor) => {
      const tick = factor * base;
      if (tick >= min && tick <= max) minor.push(tick);
    });
  }
  if (!major.length) return { major: makeTicks(min, max, 5), minor: [] };
  return {
    major: Array.from(new Set(major)).sort((a, b) => a - b),
    minor: Array.from(new Set(minor)).sort((a, b) => a - b),
  };
}

function cellBounds(centers, min, max) {
  if (!centers.length) return [min, max];
  const bounds = [min];
  for (let index = 0; index < centers.length - 1; index += 1) {
    bounds.push((centers[index] + centers[index + 1]) / 2);
  }
  bounds.push(max);
  return bounds;
}

function heatmapSpectralCells(axis, centers, min, max, breaks = []) {
  const bounds = cellBounds(centers, min, max);
  const cells = centers.map((_, index) => ({ left: bounds[index], right: bounds[index + 1] }));
  breaks.forEach((item) => {
    let leftIndex = -1;
    let rightIndex = -1;
    axis.forEach((value, index) => {
      if (value <= item.left) leftIndex = index;
      if (rightIndex < 0 && value >= item.right) rightIndex = index;
    });
    if (leftIndex < 0 || rightIndex < 0 || rightIndex <= leftIndex) return;
    const leftHalf = leftIndex > 0 ? Math.abs(centers[leftIndex] - centers[leftIndex - 1]) / 2 : 1;
    const rightHalf = rightIndex < centers.length - 1 ? Math.abs(centers[rightIndex + 1] - centers[rightIndex]) / 2 : 1;
    cells[leftIndex].right = Math.min(cells[leftIndex].right, centers[leftIndex] + leftHalf);
    cells[rightIndex].left = Math.max(cells[rightIndex].left, centers[rightIndex] - rightHalf);
  });
  return cells;
}

function makeTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [];
  if (min === max) return [min];
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

function niceStep(span, targetIntervals) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / Math.max(1, targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
}

function roundTick(value, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(Math.abs(step))) + 2);
  return Number(value.toFixed(Math.min(12, decimals)));
}

function makeNiceAxis(min, max, targetIntervals = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { extent: [0, 1], ticks: [0, 1] };
  if (min === max) return { extent: [min - 1, max + 1], ticks: [min - 1, min, max + 1] };
  const step = niceStep(max - min, targetIntervals);
  const axisMin = Math.floor(min / step) * step;
  const axisMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let tick = axisMin; tick <= axisMax + step * 0.25; tick += step) ticks.push(roundTick(tick, step));
  return { extent: [roundTick(axisMin, step), roundTick(axisMax, step)], ticks };
}

function makeNiceTicksWithin(min, max, targetIntervals = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const step = niceStep(max - min, targetIntervals);
  const start = Math.ceil((min - step * 1e-9) / step) * step;
  const ticks = [];
  for (let tick = start; tick <= max + step * 1e-9; tick += step) ticks.push(roundTick(tick, step));
  return ticks.length ? ticks : [min, max];
}

function makeStepTicks(min, max, step) {
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let tick = start; tick <= max + 1e-9; tick += step) ticks.push(tick);
  return ticks.length ? ticks : makeTicks(min, max, 5);
}

function activeDataset() {
  return state.datasets[state.activeIndex] ?? null;
}

function activeFolder() {
  const folderId = activeDataset()?.folderId;
  return state.folders.find((folder) => folder.id === folderId) ?? null;
}

function folderDatasets(folderId) {
  return state.datasets.filter((dataset) => dataset.folderId === folderId);
}

function compareDatasets() {
  return state.datasets.filter((dataset) => state.compare.selectedIds.includes(dataset.id));
}

function ensureCompareStyles() {
  state.datasets.forEach((dataset, index) => ensureDatasetStyle(dataset, index));
}

function ensureDatasetStyle(dataset, index) {
  state.compare.styles[dataset.id] ??= {
    color: componentColor(index),
    label: datasetDisplayName(dataset),
    lineStyle: ["solid", "dashed", "dotted"][index % 3],
    lineWidth: 2.2,
  };
  state.compare.styles[dataset.id].label ||= datasetDisplayName(dataset);
  state.compare.styles[dataset.id].lineStyle ||= ["solid", "dashed", "dotted"][index % 3];
  state.compare.styles[dataset.id].lineWidth = clamp(Number(state.compare.styles[dataset.id].lineWidth) || 2.2, 0.5, 6);
  return state.compare.styles[dataset.id];
}

function createFolderRecord(name) {
  return {
    id: uniqueId("folder"),
    name,
    range: null,
    treatments: { baseline: false, chirp: false },
    collapsed: false,
    createdAt: new Date().toISOString(),
  };
}

function createFolderFromModal() {
  const name = document.getElementById("new-folder-name")?.value.trim();
  if (!name) {
    showError(new Error("Folder name is required."));
    return;
  }
  state.folders.push(createFolderRecord(uniqueFolderName(name)));
  state.modal = null;
  markDirty();
  state.notice = { kind: "success", title: "Folder created", message: `${name} is ready for datasets.` };
  render();
}

function startFolderRename(folderId) {
  if (!state.folders.some((folder) => folder.id === folderId)) return;
  state.editingFolderId = folderId;
  render();
  const input = document.querySelector(`.folder-name-input[data-folder-id="${CSS.escape(folderId)}"]`);
  input?.focus();
  input?.select();
}

function renameFolder(folderId, requestedName) {
  const folder = state.folders.find((item) => item.id === folderId);
  const name = requestedName.trim();
  state.editingFolderId = null;
  if (!folder || !name || folder.name === name) {
    render();
    return;
  }
  folder.name = uniqueFolderName(name, folderId);
  markDirty();
  render();
}

function toggleFolder(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) return;
  folder.collapsed = !folder.collapsed;
  render();
}

function deleteEmptyFolder(folderId) {
  if (folderDatasets(folderId).length) throw new Error("Move or remove every dataset before deleting this folder.");
  state.folders = state.folders.filter((folder) => folder.id !== folderId);
  markDirty();
  render();
}

function moveDatasetToFolder(datasetId, folderId) {
  const dataset = state.datasets.find((item) => item.id === datasetId);
  const folder = state.folders.find((item) => item.id === folderId);
  if (!dataset || !folder || dataset.folderId === folderId) return;
  dataset.folderId = folderId;
  folder.collapsed = false;
  markDirty();
  state.notice = {
    kind: "success",
    title: "Dataset moved",
    message: `${dataset.source.fileName} moved to ${folder.name}. Its current treated version was preserved.`,
  };
  render();
}

function saveDatasetDetails() {
  const dataset = state.datasets.find((item) => item.id === state.pendingDatasetId);
  const displayName = document.getElementById("dataset-display-name")?.value.trim();
  if (!dataset || !displayName) throw new Error("Dataset display name is required.");
  dataset.projectLabel = displayName;
  dataset.sampleNote = document.getElementById("dataset-sample-note")?.value.trim() ?? "";
  if (state.compare.styles[dataset.id]) state.compare.styles[dataset.id].label = displayName;
  state.pendingDatasetId = null;
  state.modal = null;
  markDirty();
  state.notice = { kind: "success", title: "Dataset details saved", message: "The display name and sample note are now included in the project and AI handoff." };
  render();
}

function setDatasetClipboard(datasetId, mode) {
  const dataset = state.datasets.find((item) => item.id === datasetId);
  if (!dataset) return;
  state.datasetClipboard = { datasetId, mode };
  state.datasetMenu = null;
  state.notice = {
    kind: "info",
    title: mode === "copy" ? "Dataset copied" : "Dataset cut",
    message: `${datasetDisplayName(dataset)} can now be pasted into a dataset folder.`,
  };
  render();
}

function pasteDatasetIntoFolder(folderId) {
  const folder = state.folders.find((item) => item.id === folderId);
  const sourceDataset = state.datasets.find((item) => item.id === state.datasetClipboard?.datasetId);
  if (!folder || !sourceDataset || !state.datasetClipboard) throw new Error("There is no dataset available to paste.");
  if (state.datasetClipboard.mode === "cut") {
    const name = datasetDisplayName(sourceDataset);
    sourceDataset.folderId = folder.id;
    folder.collapsed = false;
    state.datasetClipboard = null;
    state.datasetMenu = null;
    markDirty();
    state.notice = { kind: "success", title: "Dataset moved", message: `${name} moved to ${folder.name}.` };
    render();
    return;
  }
  const cloned = typeof structuredClone === "function"
    ? structuredClone(sourceDataset)
    : JSON.parse(JSON.stringify(sourceDataset));
  cloned.id = uniqueDatasetId(sourceDataset.source.fileName, state.datasets.length);
  cloned.folderId = folder.id;
  cloned.projectLabel = uniqueDatasetLabel(`${datasetDisplayName(sourceDataset)} Copy`);
  cloned.sampleNote = sourceDataset.sampleNote || "";
  state.datasets.push(reviveDataset(cloned));
  state.activeIndex = state.datasets.length - 1;
  folder.collapsed = false;
  ensureDatasetStyle(state.datasets.at(-1), state.datasets.length - 1);
  state.datasetMenu = null;
  markDirty();
  state.notice = { kind: "success", title: "Dataset pasted", message: `${cloned.projectLabel} was added to ${folder.name}; its source asset remains unchanged.` };
  render();
}

function uniqueDatasetLabel(requested) {
  const used = new Set(state.datasets.map((dataset) => datasetDisplayName(dataset).toLowerCase()));
  if (!used.has(requested.toLowerCase())) return requested;
  let suffix = 2;
  while (used.has(`${requested} ${suffix}`.toLowerCase())) suffix += 1;
  return `${requested} ${suffix}`;
}

function removeDatasetFromProject(datasetId) {
  const index = state.datasets.findIndex((dataset) => dataset.id === datasetId);
  if (index < 0) return;
  const dependent = state.datasets.find((dataset) => dataset.id !== datasetId
    && dataset.merge?.sourceDatasets?.some((source) => source.id === datasetId));
  if (dependent) {
    throw new Error(`${datasetDisplayName(state.datasets[index])} is a parent of ${datasetDisplayName(dependent)}. Remove the merged derivative first so its lineage is not detached.`);
  }
  const [removed] = state.datasets.splice(index, 1);
  state.compare.selectedIds = state.compare.selectedIds.filter((id) => id !== datasetId);
  state.merge.selectedIds = state.merge.selectedIds.filter((id) => id !== datasetId);
  delete state.compare.styles[datasetId];
  state.activeIndex = clamp(state.activeIndex > index ? state.activeIndex - 1 : state.activeIndex, 0, Math.max(0, state.datasets.length - 1));
  state.pendingDeleteId = null;
  state.modal = null;
  clampSelections();
  markDirty();
  state.notice = {
    kind: "success",
    title: "Dataset removed",
    message: `${removed.source.fileName} was removed from the project. Its source file was not changed.`,
  };
  render();
}

function uniqueFolderName(requestedName, exceptId = null) {
  const base = requestedName.trim() || "Dataset Folder";
  const used = new Set(state.folders.filter((folder) => folder.id !== exceptId).map((folder) => folder.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

function inferImportFolderName(files) {
  const prefixes = files.map((file) => file.name.replace(/\.[^.]+$/, "").split(/[-_\s]+/)[0].toUpperCase()).filter(Boolean);
  const common = prefixes.length && prefixes.every((prefix) => prefix === prefixes[0]) ? prefixes[0] : "Import";
  return common === "IMPORT" ? `Import ${state.folders.length + 1}` : common;
}

function commonRangeFromAnalyses(analyses) {
  if (!analyses.length) return null;
  return {
    wavelengthMin: Math.max(...analyses.map((analysis) => analysis.spectralAxis[0])),
    wavelengthMax: Math.min(...analyses.map((analysis) => analysis.spectralAxis.at(-1))),
    timeMin: Math.max(...analyses.map((analysis) => analysis.timeAxis[0])),
    timeMax: Math.min(...analyses.map((analysis) => analysis.timeAxis.at(-1))),
  };
}

function rangeFromAnalysis(analysis) {
  return {
    wavelengthMin: analysis.spectralAxis[0],
    wavelengthMax: analysis.spectralAxis.at(-1),
    timeMin: analysis.timeAxis[0],
    timeMax: analysis.timeAxis.at(-1),
  };
}

function visibleComponentSpectra(dataset, mode, hideIrfLimited) {
  if (!dataset?.fit) return [];
  const spectra = mode === "EAS" ? dataset.fit.easSpectra : dataset.fit.dasSpectra;
  return (spectra ?? [])
    .map((spectrum, index) => ({ ...spectrum, componentIndex: index }))
    .filter((spectrum) => !hideIrfLimited || !dataset.fit.irfLimited?.[spectrum.componentIndex]);
}

function expandedPlotMeta(key) {
  const mode = state.fitting.spectrumMode;
  const labels = {
    heatmap: ["Analysis Heatmap", ""],
    spectrum: ["Spectrum", `${formatCoordinate(activeDataset()?.analysis.timeAxis[state.selectedTimeIndex])} ps`],
    kinetics: ["Kinetics", `${formatWavelength(activeDataset()?.analysis.spectralAxis[state.selectedWavelengthIndex])} nm`],
    "main-components": [`${mode} Component Spectra`, state.fitting.hideIrfLimited ? "IRF-limited components hidden" : ""],
    "modal-eas": ["EAS Preview", state.fitting.hideIrfLimited ? "IRF-limited components hidden" : ""],
    "modal-das": ["DAS", state.fitting.hideIrfLimited ? "IRF-limited components hidden" : ""],
    "fit-residual": ["Fit Residual Map", ""],
    "compare-kinetics": ["Kinetics Comparison", ""],
    "compare-spectrum": ["Spectra Comparison", ""],
    "compare-components": [`${state.compare.componentMode} Comparison`, state.compare.hideIrfLimited ? "IRF-limited components hidden" : ""],
  };
  const [title, subtitle] = labels[key] ?? ["Plot", ""];
  return { title, subtitle };
}

function clampSelections() {
  const analysis = activeDataset()?.analysis;
  if (!analysis) return;
  state.selectedTimeIndex = clamp(state.selectedTimeIndex, 0, analysis.timeAxis.length - 1);
  state.selectedWavelengthIndex = clamp(state.selectedWavelengthIndex, 0, analysis.spectralAxis.length - 1);
  state.compare.timeIndex = clamp(state.compare.timeIndex, 0, analysis.timeAxis.length - 1);
  state.compare.wavelengthIndex = clamp(state.compare.wavelengthIndex, 0, analysis.spectralAxis.length - 1);
}

function normalizePoints(points, mode = state.compare.normalize) {
  if (mode !== "each") return points;
  const finite = points.map((point) => Math.abs(point.y)).filter(Number.isFinite);
  const maxAbs = Math.max(...finite, 1e-12);
  return points.map((point) => ({ x: point.x, y: Number.isFinite(point.y) ? point.y / maxAbs : Number.NaN }));
}

function nearestIndex(values, target) {
  let best = 0;
  let distance = Infinity;
  values.forEach((value, index) => {
    const next = Math.abs(value - target);
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

function scale(value, domain, range) {
  if (domain[0] === domain[1]) return (range[0] + range[1]) / 2;
  return range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
}

function paddedExtent(values) {
  const finite = values.filter(Number.isFinite);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return [min - 1, max + 1];
  const pad = Math.max((max - min) * 0.08, 1e-12);
  return [min - pad, max + pad];
}

function diverging(value) {
  const x = clamp(value, -1, 1);
  if (x >= 0) {
    const greenBlue = Math.round(255 * (1 - x));
    return `rgb(255,${greenBlue},${greenBlue})`;
  }
  const redGreen = Math.round(255 * (1 + x));
  return `rgb(${redGreen},${redGreen},255)`;
}

function lineDash(style) {
  if (style === "dashed") return [8, 5];
  if (style === "dotted") return [2, 5];
  return [];
}

function componentDash(index) {
  return [[], [8, 4], [2, 4], [10, 3, 2, 3], [5, 3], [1, 3]][index % 6];
}

function componentColor(index) {
  return ["#0c7c86", "#8b5d2a", "#7b5aa6", "#b54b4b", "#457b3c", "#c05f8a"][index % 6];
}

function projectStateLabel() {
  if (!state.datasets.length) return "No project";
  if (state.job?.kind === "save") return "Saving";
  if (state.project.dirty) return state.project.lastSavedAt ? "Modified" : "Unsaved";
  if (state.project.lastSavedAt) return "Saved";
  return "Unsaved";
}

function datasetStateLabel(dataset) {
  if (dataset.fit) return dataset.fit.irfLimited?.some(Boolean) ? "Fit available, unresolved" : "Fit available";
  if (isTreated(dataset)) return "Treated";
  return "Imported";
}

function datasetDisplayName(dataset) {
  return dataset?.projectLabel?.trim() || dataset?.source?.fileName?.replace(/\.[^.]+$/, "") || "Dataset";
}

function irfLimitedCount(dataset) {
  return dataset?.fit?.irfLimited?.filter(Boolean).length || 0;
}

function isTreated(dataset) {
  return Boolean(dataset?.analysis?.provenance?.length);
}

function treatmentLabel(folder = activeFolder()) {
  const labels = [];
  if (folder?.treatments?.baseline) labels.push("Baseline");
  if (folder?.treatments?.chirp) labels.push("Chirp");
  return labels.length ? labels.join(" + ") : "Analysis range";
}

function analysisRangeLabel(analysis) {
  if ((analysis.spectralSegments ?? []).length > 1) {
    return analysis.spectralSegments
      .map((segment) => `${formatWavelength(segment.minNm)}-${formatWavelength(segment.maxNm)}`)
      .join(" / ") + " nm";
  }
  return `${formatWavelength(analysis.spectralAxis[0])}-${formatWavelength(analysis.spectralAxis.at(-1))} nm`;
}

function markDirty() {
  state.project.dirty = true;
}

function readFiniteInput(id) {
  const value = Number(document.getElementById(id)?.value);
  if (!Number.isFinite(value)) throw new Error("All range values must be finite numbers.");
  return value;
}

function showError(error) {
  state.notice = { kind: "error", title: "Could not complete the operation", message: errorMessage(error) };
  state.job = null;
  render();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTauriRuntime() {
  return Boolean(globalThis.__TAURI_INTERNALS__);
}

function isWindowsPlatform() {
  const navigator = globalThis.navigator;
  return /Windows/i.test(navigator?.userAgent || "") || /^Win/i.test(navigator?.platform || "");
}

function inputValue(value) {
  return Number.isFinite(value) ? formatCoordinate(value) : "";
}

function uniqueDatasetId(fileName, index) {
  return `${exportBaseName(fileName)}_${index + 1}_${uniqueId("dataset")}`;
}

function uniqueId(prefix) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${token}`;
}

function exportBaseName(fileName) {
  return (fileName || "dataset").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function format(value) {
  return Parser.format(value);
}

function formatCoordinate(value) {
  if (!Number.isFinite(value)) return "-";
  const absolute = Math.abs(value);
  const decimals = absolute >= 1000 ? 2 : absolute >= 10 ? 3 : absolute >= 1 ? 4 : 5;
  return Number(value.toFixed(decimals)).toString();
}

function conciseInputNumber(value) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1000) return Number(value.toPrecision(6)).toString();
  return Number(value.toFixed(6)).toString();
}

function formatAxisNumber(value) {
  if (!Number.isFinite(value)) return "-";
  const absolute = Math.abs(value);
  if (absolute === 0) return "0";
  if (absolute >= 1) return Number(value.toFixed(2)).toString();
  if (absolute >= 0.01) return Number(value.toFixed(3)).toString();
  return value.toExponential(1).replace("e+", "e");
}

function formatWavelength(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "-";
}

function uiText(value) {
  return translateText(value, state.locale);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the figure.")), type);
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let resizeTimer = null;
document.addEventListener("contextmenu", (event) => {
  if (event.target.closest("input, textarea, select")) return;
  event.preventDefault();
});
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(paintCanvases, 120);
});

render();
