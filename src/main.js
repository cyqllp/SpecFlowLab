import { invoke } from "@tauri-apps/api/core";
import "./lib/parser-core.js";
import {
  createProjectArchive,
  hydrateProjectArchive,
  readProjectArchive,
} from "./lib/project-archive.js";
import { createOriginBundle } from "./lib/origin-bundle.js";
import { getUnfittedDatasetsInFolder } from "./lib/dataset-scope.js";
import { isEligibleForMode, SELECTION_MODES, toggleSelection, validateSelection } from "./lib/dataset-selection.js";
import { moveDataset } from "./lib/dataset-order.js";
import {
  createMergedAnalysis,
  mergePreviewSeries,
  prepareMergePlan,
} from "./lib/dataset-merge.js";
import { spectroscopySourceToCsv } from "./lib/source-data.js";
import { AI_INVESTIGATION_GOALS } from "./lib/ai-investigation/goals.js";
import { createAiInvestigationPackage, inspectAiInvestigation } from "./lib/ai-investigation/package.js";
import { AI_INVESTIGATION_SPEC_SCHEMA } from "./lib/ai-investigation/schema.js";
import { defaultAiScope } from "./lib/ai-investigation/scope.js";
import {
  CONDITION_FIELDS,
  RELATIONSHIP_DEFINITIONS,
  createEmptyEvidenceGraph,
  migrateEvidenceGraph,
  normalizeDatasetEvidence,
} from "./lib/evidence-graph/schema.js";
import {
  connectionsForEntity,
  removeDatasetFromEvidenceGraph,
  removeEvidenceConnection,
  upsertEvidenceConnection,
} from "./lib/evidence-graph/connections.js";
import { updateDatasetEvidenceEntities } from "./lib/evidence-graph/entities.js";
import { compareDatasetConditions } from "./lib/evidence-graph/comparability.js";
import {
  EVIDENCE_ASSET_KINDS,
  LITERATURE_RIGHTS_STATUSES,
  createEvidenceAssetFromFile,
  evidenceImportOptions,
  normalizeEvidenceAsset,
} from "./lib/evidence-assets/schema.js";
import { getTechnique, listTechniques } from "./lib/modalities/registry.js";
import { detectFstaFeatureCandidates } from "./lib/feature-monitor/detector.js";
import { buildFeatureTimeMap } from "./lib/feature-monitor/compression.js";
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
const APP_VERSION = "1.0.5";
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
    hideIrfLimited: true,
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
    hideIrfLimited: true,
    editorDatasetId: null,
    lifetimeValues: [],
    fixedLifetimes: [],
  },
  featureFinding: {
    relativeThreshold: 0.12,
    minimumGaussianR2: 0.45,
    minimumFwhmNm: 6,
  },
  project: {
    dirty: false,
    lastSavedAt: null,
    path: null,
  },
  origin: {
    outputMode: "sheets-plots",
    installation: null,
    outputFormat: null,
  },
  aiInvestigation: {
    stage: "builder",
    draft: null,
    preview: null,
    lastExport: null,
  },
  evidenceGraph: createEmptyEvidenceGraph(),
  evidenceAssets: [],
  evidenceSelectionIds: [],
  evidenceViewMode: "list",
  modal: null,
  expandedPlot: null,
  plotZooms: {},
  zoomSelectionKey: null,
  zoomDrag: null,
  pendingDeleteId: null,
  pendingDatasetId: null,
  pendingConnectionId: null,
  pendingConnectionTargetIds: [],
  pendingEvidenceAssetId: null,
  pendingEvidenceAssetDraft: null,
  evidenceImportMode: "evidence",
  evidenceImportResultIds: [],
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
        <div class="context-actions two">
          <button class="wide-command" data-action="compare" ${state.datasets.length > 1 && !busy ? "" : "disabled"}>Compare...</button>
          <button class="wide-command" data-action="open-merge-selection" ${state.datasets.length && !busy ? "" : "disabled"}>Merge...</button>
        </div>
      </section>

      <section class="panel sidebar-panel handoff-panel">
        <div class="section-heading">
          <h2>AI Investigation</h2>
        </div>
        <p class="ai-sidebar-status">${state.aiInvestigation.lastExport ? escapeHtml(state.aiInvestigation.lastExport.goalLabel) : "No investigation configured"}</p>
        <button class="wide-command" data-action="new-ai-investigation" ${dataset && !busy ? "" : "disabled"}>New Investigation...</button>
      </section>

      <section class="panel sidebar-panel handoff-panel">
        <div class="section-heading">
          <h2>OriginPro Output</h2>
        </div>
        ${state.origin.installation ? `
          <div class="origin-status-block">
            <span class="origin-version">${escapeHtml(state.origin.installation.displayName ?? state.origin.installation.executablePath)}${state.origin.installation.bitness ? ` (${state.origin.installation.bitness}-bit)` : ""}</span>
            <span class="origin-support ${state.origin.installation.supportLevel}">${state.origin.installation.supportLevel === "experimental" ? "Origin 8.6+ · Worksheets only" : `${state.origin.installation.supportLevel} · ${escapeHtml(state.origin.installation.backend)} · ${(state.origin.outputFormat || state.origin.installation.defaultProjectFormat || "opju").toUpperCase()}`}</span>
          </div>
          ${state.origin.installation.supportLevel !== "experimental" ? `<label class="origin-mode-select"><span class="visually-hidden">OriginPro output mode</span><select id="origin-output-mode" aria-label="OriginPro output mode" ${busy ? "disabled" : ""}>
            <option value="sheets-plots" ${state.origin.outputMode === "sheets-plots" && state.origin.installation.capabilities?.linePlots ? "selected" : ""} ${state.origin.installation.capabilities?.linePlots ? "" : "disabled"}>Sheets and supported plots</option>
            <option value="sheets-only" ${state.origin.outputMode === "sheets-only" ? "selected" : ""}>Only sheets</option>
          </select></label>` : ""}
          ${state.origin.installation.supportLevel !== "experimental" && (state.origin.installation.projectFormats?.length ?? 0) > 1 ? `<label class="origin-mode-select"><span class="visually-hidden">Project format</span><select id="origin-format" aria-label="Project format" ${busy ? "disabled" : ""}>
            ${state.origin.installation.projectFormats.map((fmt) => `<option value="${fmt}" ${(state.origin.outputFormat || state.origin.installation.defaultProjectFormat) === fmt ? "selected" : ""}>${fmt.toUpperCase()}</option>`).join("")}
          </select></label>` : ""}
        ` : `<p class="origin-placeholder">Select an OriginPro installation to enable direct export.</p>`}
        <button class="wide-command" data-action="${state.origin.installation ? "change-origin" : "select-origin"}" ${busy ? "disabled" : ""}>${state.origin.installation ? "Choose another EXE..." : "Choose Origin EXE..."}</button>
        <button class="wide-command" data-action="create-origin" ${dataset && !busy && isTauriRuntime() && isWindowsPlatform() && state.origin.installation?.capabilities?.worksheets && state.origin.installation?.supportLevel !== "unsupported" ? "" : "disabled"}>Create in OriginPro...</button>
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
                  <li class="dataset-row" data-dataset-id="${escapeHtml(item.id)}" data-dataset-drop="${escapeHtml(item.id)}">
                    <button type="button" class="dataset-drag-handle" title="Drag to reorder or move dataset" aria-label="Drag ${escapeHtml(datasetDisplayName(item))} to reorder or move">&#8942;&#8942;</button>
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
              ${renderDatasetIdentityTags(dataset)}
            </div>
            <div class="active-dataset-actions">
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
  const visibleLifetimes = fit.lifetimes
    .map((lifetime, index) => ({ lifetime, index }))
    .filter(({ index }) => !fit.irfLimited?.[index]);
  const monitor = featureMonitorFor(dataset);
  const showFeatures = monitor.status === "live" && monitor.candidates.length;
  return `
    ${limitedCount ? `<div class="fit-summary-header"><span>${limitedCount} IRF-limited component${limitedCount === 1 ? "" : "s"} excluded from interpreted outputs</span></div>` : ""}
    <table class="fit-table">
      <thead><tr><th>Component</th><th>Time constant</th>${showFeatures ? "<th>Feature regions</th>" : ""}</tr></thead>
      <tbody>
        ${visibleLifetimes.map(({ lifetime, index }) => `
          <tr>
            <td>t${index + 1}</td>
            <td>${format(lifetime)} ps${fit.fixedLifetimes?.[index] ? " <span class=\"fixed-text\">(fixed)</span>" : ""}</td>
            ${showFeatures ? `<td><div class="lifetime-feature-tags">${monitor.candidates.filter((candidate) => candidate.componentIndex === index).map(renderFeatureTag).join("") || "<span class=\"feature-none\">None above threshold</span>"}</div></td>` : ""}
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
  return `
    <article class="result-panel spectra-result">
      <div class="panel-head result-controls">
        <div>
          <h3>Component Spectra</h3>
          <span id="main-component-mode-copy">${limitedCount ? `${limitedCount} IRF-limited excluded` : ""}</span>
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
      </div>
      <canvas id="main-components" data-plot-key="main-components" width="760" height="340" aria-label="${state.fitting.spectrumMode} component spectra"></canvas>
      ${renderFeaturePlotNote(dataset, state.fitting.spectrumMode)}
    </article>`;
}

function featureMonitorFor(dataset, mode = null) {
  return detectFstaFeatureCandidates(dataset, state.evidenceGraph, state.evidenceAssets, {
    ...state.featureFinding,
    ...(mode ? { spectrumMode: mode } : {}),
  });
}

function renderFeatureTag(candidate) {
  const range = `${formatWavelength(candidate.wavelengthMin)}–${formatWavelength(candidate.wavelengthMax)} nm`;
  const gaussian = candidate.gaussianShape;
  const shape = Number.isFinite(gaussian?.rSquared) ? `Gaussian R² ${(gaussian.rSquared * 100).toFixed(0)}%; FWHM ${formatWavelength(gaussian.fwhmNm)} nm` : "Gaussian score unavailable";
  return `<span class="feature-tag ${candidate.sign}" title="${escapeHtml(`${candidate.candidateType}; ${range}; ${shape}; ${candidate.supportSummary}; suggested, not confirmed`)}"><b>${escapeHtml(candidate.featureCode)}</b>${escapeHtml(shortFeatureType(candidate.candidateType))}<small>${range} · G${Number.isFinite(gaussian?.rSquared) ? Math.round(gaussian.rSquared * 100) : "-"}%</small></span>`;
}

function renderFeaturePlotNote(dataset, mode) {
  const monitor = featureMonitorFor(dataset, mode);
  if (monitor.status !== "live" || !monitor.candidates.length) return "";
  const context = monitor.references.length
    ? `${monitor.references.length} explicitly connected Abs/PL reference${monitor.references.length === 1 ? "" : "s"} supplies overlap context.`
    : "No linked Abs/PL reference: negative regions remain unresolved GSB/SE candidates.";
  return `<p class="feature-plot-note"><span><i></i>Labels are live ${escapeHtml(mode)} Gaussian-informed candidate regions.</span><span>${escapeHtml(context)}</span><strong>Suggested, not confirmed</strong></p>`;
}

function shortFeatureType(candidateType) {
  if (candidateType === "ESA candidate") return "ESA?";
  if (candidateType === "GSB candidate") return "GSB?";
  if (candidateType === "SE candidate") return "SE?";
  return "GSB/SE?";
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
  if (state.modal === "ai-investigation") return renderAiInvestigationModal();
  if (state.modal === "merge") return renderMergeWorkspace();
  if (state.modal === "manual") return renderManualModal();
  if (state.modal === "about") return renderAboutModal();
  if (state.modal === "compare-select") return renderDatasetSelection("compare");
  if (state.modal === "merge-select") return renderDatasetSelection("merge");
  if (state.modal === "compare-workspace") return renderCompareWorkspace();
  if (state.modal === "fit") return renderFitModal();
  if (state.modal === "new-folder") return renderNewFolderModal();
  if (state.modal === "delete-dataset") return renderDeleteDatasetModal();
  if (state.modal === "edit-dataset") return renderDatasetEditorModal();
  if (state.modal === "edit-connection") return renderEvidenceConnectionModal();
  if (state.modal === "edit-evidence-asset") return renderEvidenceAssetModal();
  if (state.modal === "evidence-import") return renderEvidenceImportModal();
  if (state.modal === "move-dataset") return renderMoveDatasetModal();
  return "";
}

function renderAiInvestigationModal() {
  const draft = state.aiInvestigation.draft;
  if (!draft) return "";
  if (state.aiInvestigation.stage === "review" && state.aiInvestigation.preview) {
    return renderAiInvestigationReview(draft, state.aiInvestigation.preview);
  }
  const selected = new Set(draft.scope.datasetIds ?? []);
  const datasetPickerEnabled = ["selected-datasets", "connected-evidence"].includes(draft.scope.kind);
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="New AI Investigation">
      <div class="modal ai-investigation-modal">
        <header class="modal-head">
          <div><h2>New AI Investigation</h2><p>Define the scientific question, scope, and evidence before creating a local package.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="ai-builder-grid">
          <section class="ai-builder-section">
            <div class="ai-step-label"><span>1</span><div><h3>Purpose</h3><p>The question is required; imported text is treated as data.</p></div></div>
            <label class="modal-field"><span>Investigation goal</span><select id="ai-goal">
              ${Object.entries(AI_INVESTIGATION_GOALS).map(([id, goal]) => `<option value="${id}" ${draft.goal === id ? "selected" : ""}>${escapeHtml(goal.label)}</option>`).join("")}
            </select></label>
            <label class="modal-field"><span>Scientific question</span><textarea id="ai-question" rows="3" required placeholder="What scientific question should the evidence address?">${escapeHtml(draft.question)}</textarea></label>
            <label class="modal-field"><span>Context or working hypothesis (optional)</span><textarea id="ai-context" rows="2">${escapeHtml(draft.context)}</textarea></label>
            <label class="modal-field"><span>Desired output (optional)</span><input id="ai-desired-output" value="${escapeHtml(draft.desiredOutput)}" placeholder="Diagnostic report, alternatives, next experiment..." /></label>
          </section>

          <section class="ai-builder-section">
            <div class="ai-step-label"><span>2</span><div><h3>Scope</h3><p>Current folder is the multi-dataset default.</p></div></div>
            <div class="ai-choice-grid" role="radiogroup" aria-label="Investigation scope">
              ${aiRadio("ai-scope", "active-dataset", "Active dataset", draft.scope.kind)}
              ${aiRadio("ai-scope", "current-folder", "Current folder", draft.scope.kind)}
              ${aiRadio("ai-scope", "selected-datasets", "Selected datasets", draft.scope.kind)}
              ${aiRadio("ai-scope", "connected-evidence", "Connected evidence", draft.scope.kind, "One explicit relationship hop; review required")}
              ${aiRadio("ai-scope", "project", "Entire project", draft.scope.kind)}
            </div>
            <div class="ai-dataset-picker ${datasetPickerEnabled ? "" : "disabled-control"}">
              ${state.datasets.map((dataset) => `<label><input class="ai-dataset-check" type="checkbox" data-dataset-id="${escapeHtml(dataset.id)}" ${selected.has(dataset.id) ? "checked" : ""} ${datasetPickerEnabled ? "" : "disabled"} /><span data-i18n-skip>${escapeHtml(datasetDisplayName(dataset))}</span><small>${escapeHtml(state.folders.find((folder) => folder.id === dataset.folderId)?.name ?? "Unfiled")} · ${escapeHtml(getTechnique(dataset.evidenceMetadata?.technique?.id).label)} · ${escapeHtml(uiText(dataset.fit ? "fit available" : "unfitted"))}</small></label>`).join("")}
            </div>
          </section>

          <section class="ai-builder-section">
            <div class="ai-step-label"><span>3</span><div><h3>Evidence</h3><p>Raw sources and full matrices remain opt-in.</p></div></div>
            <div class="ai-profile-grid">
              ${aiRadio("ai-profile", "brief", "Brief", draft.evidenceProfile, "Metadata, provenance, fit table, limitations")}
              ${aiRadio("ai-profile", "diagnostic", "Diagnostic", draft.evidenceProfile, "Brief plus deterministic spectra, kinetics, residual profiles")}
              ${aiRadio("ai-profile", "full", "Full evidence", draft.evidenceProfile, "Diagnostic plus explicitly selected source or matrix files")}
            </div>
            <div class="ai-options-grid">
              ${aiCheckbox("ai-include-notes", "Include sample notes", draft.include.sampleNotes)}
              ${aiCheckbox("ai-include-filenames", "Include source filenames", draft.include.sourceFileNames)}
              ${aiCheckbox("ai-include-metadata", "Include instrument metadata", draft.include.instrumentMetadata)}
              ${aiCheckbox("ai-redact-paths", "Redact absolute paths", draft.privacy.redactAbsolutePaths)}
              ${aiCheckbox("ai-redact-operators", "Redact operator names", draft.privacy.redactOperatorNames)}
              ${aiCheckbox("ai-redact-computers", "Redact computer names", draft.privacy.redactComputerNames)}
              ${aiCheckbox("ai-include-raw", "Include exact raw sources", draft.include.rawSources, draft.evidenceProfile !== "full")}
              ${aiCheckbox("ai-include-matrices", "Include full treated matrices", draft.include.fullTreatedMatrices, draft.evidenceProfile !== "full")}
            </div>
          </section>

          <section class="ai-builder-section ai-review-callout">
            <div class="ai-step-label"><span>4</span><div><h3>Review and export</h3><p>No provider upload occurs. Reviewing, cancelling, or exporting does not mark the project dirty.</p></div></div>
            <button data-action="review-ai-investigation">Review Evidence Package</button>
          </section>
        </div>
        <footer class="modal-footer">
          <button data-action="legacy-export-md" class="secondary-command">Advanced: Legacy MD...</button>
          <span>The legacy whole-project Markdown path is retained temporarily for compatibility.</span>
          <button data-action="close-modal">Cancel</button>
        </footer>
      </div>
    </section>`;
}

function renderAiInvestigationReview(draft, preview) {
  const scopeDatasets = preview.manifest.datasets;
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Review AI Investigation">
      <div class="modal ai-investigation-modal ai-review-modal">
        <header class="modal-head">
          <div><h2>Review AI Investigation</h2><p>Confirm the exact evidence and limitations before local export.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="ai-review-layout">
          <section class="ai-review-question"><span>Scientific question</span><strong>${escapeHtml(draft.question)}</strong></section>
          <dl class="ai-review-metrics">
            <div><dt>Datasets</dt><dd>${scopeDatasets.length}</dd></div>
            <div><dt>Evidence items</dt><dd>${preview.estimate.evidenceCount}</dd></div>
            <div><dt>Files</dt><dd>${preview.estimate.fileCount}</dd></div>
            <div><dt>Estimated expanded size</dt><dd>${formatFileSize(preview.estimate.expandedBytes)}</dd></div>
            <div><dt>Approx. text tokens</dt><dd>${preview.estimate.approximateTextTokens.toLocaleString()}</dd></div>
          </dl>
          <section><h3>Scoped datasets</h3><ul class="ai-compact-list">${scopeDatasets.map((dataset) => `<li><strong data-i18n-skip>${escapeHtml(dataset.label)}</strong><span>${escapeHtml(uiText(dataset.fitState))}${preview.manifest.connectedInclusions?.[dataset.id] ? ` · ${escapeHtml(preview.manifest.connectedInclusions[dataset.id].map((reason) => reason.relationshipType || reason.kind).join(", "))}` : ""}</span></li>`).join("")}</ul></section>
          <section><h3>Evidence index</h3><ol class="ai-evidence-list">${preview.evidence.map((item) => `<li><code>${item.id}</code><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.files.join(", "))}</small></div></li>`).join("")}</ol></section>
          ${preview.manifest.connections?.length ? `<section><h3>Reviewed connections</h3><ul class="ai-compact-list">${preview.manifest.connections.map((connection) => `<li><strong><code>${escapeHtml(connection.id)}</code> · ${escapeHtml(connection.type)}</strong><span>${escapeHtml(connection.rationale)}</span></li>`).join("")}</ul></section>` : ""}
          <section><h3>Known limitations and omissions</h3><ul class="ai-limitations">${[...preview.manifest.limitations, ...preview.manifest.omissions.map((item) => item.reason)].map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
          ${preview.estimate.warnings.length ? `<section class="ai-package-warning"><strong>Package warning</strong><ul>${preview.estimate.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>` : ""}
          <section class="ai-privacy-summary"><strong>Privacy</strong><span>${escapeHtml(uiText(draft.include.rawSources && draft.evidenceProfile === "full" ? "Exact raw sources included by explicit choice." : "Raw sources omitted."))} ${escapeHtml(uiText(draft.include.fullTreatedMatrices && draft.evidenceProfile === "full" ? "Full treated matrices included." : "Full treated matrices omitted."))} ${escapeHtml(uiText("No network upload."))}</span></section>
        </div>
        <footer class="modal-footer">
          <button data-action="back-ai-investigation" class="secondary-command">Back</button>
          <span>Package schema: ${escapeHtml(preview.manifest.schema)}</span>
          <button data-action="copy-ai-prompt" class="secondary-command">Copy Prompt Only</button>
          <button data-action="save-ai-brief" class="secondary-command">Save Brief MD...</button>
          <button data-action="save-ai-investigation">Save .sflai Package...</button>
        </footer>
      </div>
    </section>`;
}

function aiRadio(name, value, label, selected, detail = "") {
  return `<label class="ai-choice"><input type="radio" name="${name}" value="${value}" ${selected === value ? "checked" : ""} /><span><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></label>`;
}

function aiCheckbox(id, label, checked, disabled = false) {
  return `<label class="ai-check ${disabled ? "disabled-control" : ""}"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} /><span>${escapeHtml(label)}</span></label>`;
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
          <div class="modal-head-actions">
            <button data-action="change-merge">Change Datasets</button>
            <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
          </div>
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
          <div><h2>SpecFlowLab Manual</h2><p>How to use the version 1.0.5 spectroscopy workspace.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="manual-intro">
          <strong>Recommended workflow</strong>
          <span>Import → organize → set analysis range → baseline/chirp treatment → merge or compare → global fitting → save/export.</span>
        </div>
        <ol class="manual-steps">
          <li><div><strong>Start a project</strong><p>Open an existing .sflproj project, or import CSV, TXT, TSV, ASC, or UFS files. Files imported together enter one dataset folder.</p></div></li>
          <li><div><strong>Organize datasets</strong><p>Use Edit Dataset Details for the project label and sample note. Move datasets between VIS, NIR, IR, or other folders without changing source files.</p></div></li>
          <li><div><strong>Connect scientific evidence</strong><p>Open Dataset Details to record identity and high-value conditions above the evidence workspace. Use its independent import panel to drag, paste, or choose spectra, characterization files, figures, papers, and manuscripts; select evidence, add only relationships you can justify, and inspect the focused one-hop relation map.</p></div></li>
          <li><div><strong>Treat the data</strong><p>Set the wavelength and time range for the active folder, then apply Baseline and Chirp as needed. Merge selection becomes available only after treatment.</p></div></li>
          <li><div><strong>Merge treated spectral ranges</strong><p>Select exactly two treated datasets, click Merge between Chirp and Reset, choose clean retained wavelength ranges, review the spectral preview, and create the derived dataset.</p></div></li>
          <li><div><strong>Compare datasets</strong><p>Use Compare to inspect coordinated kinetics, spectra, EAS, and DAS views with reusable sample styles.</p></div></li>
          <li><div><strong>Run global fitting</strong><p>Open Global Fitting, set component starts and IRF options, and review lifetimes, residuals, DAS, EAS, and fit diagnostics.</p></div></li>
          <li><div><strong>Interpret fsTA features</strong><p>After fitting, match feature labels on EAS/DAS with their lifetime-row tags, then inspect the lossy Feature × Time Map. Abs/PL evidence can refine context, but every candidate remains suggested—not confirmed.</p></div></li>
          <li><div><strong>Save and export</strong><p>Save the complete .sflproj archive, build a question-driven local .sflai evidence package, or create OriginPro output on Windows. AI raw sources and full matrices are opt-in; no provider upload occurs.</p></div></li>
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
          <div><dt>DOI</dt><dd><a href="https://doi.org/10.5281/zenodo.21839697" target="_blank" rel="noreferrer" data-i18n-skip>10.5281/zenodo.21839697</a></dd></div>
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
      <li><button data-action="edit-dataset" data-dataset-id="${escapeHtml(dataset.id)}">Edit Dataset Details...</button></li>
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

function renderDatasetSelection(mode) {
  const config = SELECTION_MODES[mode];
  const selectedIds = mode === "compare" ? state.compare.selectedIds : state.merge.selectedIds;
  const selectedCount = selectedIds.length;
  const eligible = state.datasets.filter((d) => isEligibleForMode(d, mode));
  const validation = validateSelection(selectedIds, mode);
  const title = mode === "compare" ? "Select Datasets to Compare" : "Select Datasets to Merge";
  const description = mode === "compare"
    ? "Choose at least two datasets for coordinated comparison."
    : "Choose exactly two treated datasets for merging.";
  const continueLabel = mode === "compare" ? "Open Comparison" : "Open Merge Workspace";
  const continueAction = mode === "compare" ? "open-comparison" : "open-merge-workspace";

  // Group eligible datasets by folder
  const grouped = new Map();
  for (const dataset of eligible) {
    const folder = state.folders.find((f) => f.id === dataset.folderId);
    const key = folder?.name ?? "Unfiled";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(dataset);
  }

  let rows = "";
  for (const [folderName, datasets] of grouped) {
    rows += `<div class="selection-group-heading">${escapeHtml(folderName)}</div>`;
    for (const dataset of datasets) {
      const datasetEligible = isEligibleForMode(dataset, mode);
      const checked = selectedIds.includes(dataset.id);
      const disabled = !datasetEligible;
      rows += `
        <label class="selection-row ${disabled ? "disabled" : ""}">
          <input class="selection-check" type="checkbox" data-dataset-id="${escapeHtml(dataset.id)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
          <span class="selection-name"><strong data-i18n-skip>${escapeHtml(datasetDisplayName(dataset))}</strong><small>${datasetStateLabel(dataset)}</small>${disabled ? `<em>Treat before merging</em>` : ""}</span>
          <span>${formatWavelength(dataset.analysis.spectralAxis[0])}-${formatWavelength(dataset.analysis.spectralAxis.at(-1))} nm</span>
          <span>${formatCoordinate(dataset.analysis.timeAxis[0])}-${formatCoordinate(dataset.analysis.timeAxis.at(-1))} ps</span>
          <span>${dataset.fit ? `${dataset.fit.componentCount}C fit` : "No fit"}</span>
        </label>`;
    }
  }

  const selectAllRow = config.supportsSelectAll ? `
    <label class="selection-select-all">
      <input id="selection-select-all" type="checkbox" ${selectedCount === eligible.length && eligible.length > 0 ? "checked" : ""} />
      <span><strong>Select all</strong><small>Include every project dataset</small></span>
    </label>` : "";

  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal selection-modal">
        <header class="modal-head">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(description)}</p>
          </div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        ${selectAllRow}
        <div class="selection-list">${rows}</div>
        <footer class="modal-footer">
          <span id="selection-count">${selectedCount} selected</span>
          <button data-action="${continueAction}" id="selection-continue" ${validation.valid ? "" : "disabled"}>${continueLabel}</button>
        </footer>
      </div>
    </section>
  `;
}

function renderCompareWorkspace() {
  const reference = activeDataset()?.analysis;
  const referenceTime = reference?.timeAxis[clamp(state.compare.timeIndex, 0, reference.timeAxis.length - 1)] ?? 0;
  const referenceWavelength = reference?.spectralAxis[clamp(state.compare.wavelengthIndex, 0, reference.spectralAxis.length - 1)] ?? 0;
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
  const folder = activeFolder();
  const limitedCount = irfLimitedCount(dataset);
  const folderTargets = folder
    ? getUnfittedDatasetsInFolder(state.datasets, folder.id)
    : [];
  const unfittedCount = folderTargets.length;
  const folderContext = folder
    ? `Batch fit unfitted datasets in "${escapeHtml(folder.name)}" (${unfittedCount})`
    : "No active folder";
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
          <button data-action="batch-fit" ${state.job || !unfittedCount ? "disabled" : ""} title="${escapeHtml(folderContext)}">${state.job?.kind === "batch-fit" ? "Processing..." : unfittedCount ? `Batch Global Fitting (${unfittedCount})` : "Current Folder Fitted"}</button>
          ${limitedCount ? `<span class="irf-exclusion-note">${limitedCount} IRF-limited component${limitedCount === 1 ? "" : "s"} excluded from all interpreted outputs</span>` : ""}
        </section>
        ${renderLifetimeControls()}
        ${dataset?.fit ? renderFeatureFindingControls() : ""}
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

function renderFeatureFindingControls() {
  const finder = state.featureFinding;
  return `<section class="feature-finder-controls" aria-label="Feature finding controls">
    <div><strong>Gaussian Feature Finder</strong><span>Search EAS/DAS for resolved major and minor bands</span></div>
    <label><span>Relative peak threshold</span><input id="feature-relative-threshold" type="number" min="1" max="80" step="1" value="${Math.round(finder.relativeThreshold * 100)}" /><small>% of component maximum</small></label>
    <label><span>Minimum Gaussian R²</span><input id="feature-gaussian-r2" type="number" min="0" max="0.99" step="0.05" value="${finder.minimumGaussianR2}" /></label>
    <label><span>Minimum FWHM</span><input id="feature-minimum-fwhm" type="number" min="0" max="500" step="1" value="${finder.minimumFwhmNm}" /><small>nm</small></label>
    <button data-action="reset-feature-finder" class="secondary-command">Reset finder</button>
    <p>A lower threshold finds weaker peaks; Gaussian likeness filters irregular shapes. Neither setting confirms ESA, GSB, SE, or species identity.</p>
  </section>`;
}

function renderFitDiagnostics(dataset) {
  const fit = dataset.fit;
  const interpretedCount = fit.lifetimes.filter((_, index) => !fit.irfLimited?.[index]).length;
  return `
    <section class="fit-diagnostic-grid">
      <article class="result-panel fit-summary-diagnostic">
        <div class="panel-head"><h3>Global Fit Summary</h3><span>${interpretedCount} interpreted component${interpretedCount === 1 ? "" : "s"}</span></div>
        ${renderMainFitSummary(dataset)}
      </article>
      <article class="plot-panel fit-residual">
        <div class="panel-head"><h3>Fit Residual Map</h3><div class="panel-head-actions"><span>Measured minus fitted</span>${enlargeButton("fit-residual")}</div></div>
        <canvas id="fit-residual" data-plot-key="fit-residual" width="1180" height="420"></canvas>
      </article>
      <article class="plot-panel">
        <div class="panel-head"><h3>EAS Preview</h3><div class="panel-head-actions">${enlargeButton("modal-eas")}</div></div>
        <canvas id="modal-eas" data-plot-key="modal-eas" width="760" height="310"></canvas>
        ${renderFeaturePlotNote(dataset, "EAS")}
      </article>
      <article class="plot-panel">
        <div class="panel-head"><h3>DAS</h3><div class="panel-head-actions">${enlargeButton("modal-das")}</div></div>
        <canvas id="modal-das" data-plot-key="modal-das" width="760" height="310"></canvas>
        ${renderFeaturePlotNote(dataset, "DAS")}
      </article>
      <article class="plot-panel feature-time-panel">
        <div class="panel-head"><div><h3>Feature × Time Map</h3><span>Lossy regional compression of the treated fsTA heatmap</span></div><div class="panel-head-actions"><button class="icon-button plot-expand" data-action="enlarge-plot" data-plot-key="feature-time" title="Enlarge plot" aria-label="Enlarge plot">⛶</button></div></div>
        <canvas id="feature-time" data-plot-key="feature-time" width="1180" height="390" aria-label="Feature by time compressed fsTA map"></canvas>
        ${renderFeatureTimeSummary(dataset)}
      </article>
    </section>
  `;
}

function renderFeatureTimeSummary(dataset) {
  const compressed = buildFeatureTimeMap(dataset, featureMonitorFor(dataset));
  if (compressed.status !== "live") return `<p class="feature-time-unavailable">${escapeHtml(compressed.limitations[0])}</p>`;
  const score = compressed.compression.reconstructionScore;
  return `<div class="feature-time-summary">
    <span><strong>${compressed.features.length}</strong> feature traces</span>
    <span><strong>${format(compressed.compression.cellReductionFactor)}×</strong> fewer signal cells</span>
    <span><strong>${(compressed.compression.coveredWavelengthFraction * 100).toFixed(1)}%</strong> wavelength coverage</span>
    <span><strong>${Number.isFinite(score) ? `${(score * 100).toFixed(1)}%` : "-"}</strong> reconstruction score</span>
    <em>Derived summary only; raw heatmap remains authoritative.</em>
  </div>`;
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
  const metadata = normalizeDatasetEvidence(dataset?.evidenceMetadata, "fsta");
  const connections = connectionsForEntity(state.evidenceGraph, dataset?.id);
  const primaryConditions = primaryConditionFields(metadata.technique.id);
  const additionalConditions = CONDITION_FIELDS.filter((field) => !primaryConditions.includes(field));
  const speciesLabels = metadata.speciesStateIds
    .map((id) => state.evidenceGraph.entities.find((entity) => entity.id === id)?.label)
    .filter(Boolean)
    .join(", ");
  return `
    <section class="modal-shell" role="dialog" aria-modal="true" aria-label="Edit dataset details">
      <div class="modal dataset-details-modal">
        <header class="modal-head">
          <div><h2>Edit Dataset Details</h2><p>Edit the dataset label and note, then keep identity and conditions as compact scientific tags.</p></div>
          <button data-action="close-modal" class="icon-button" aria-label="Close">x</button>
        </header>
        <div class="dataset-detail-fields">
          <section class="dataset-detail-section">
            <div class="dataset-detail-section-head"><div><h3>Dataset label and note</h3><p>The project label does not rename or alter the imported source file.</p></div></div>
            <label class="modal-field"><span>Dataset label</span><input id="dataset-display-name" type="text" value="${escapeHtml(datasetDisplayName(dataset))}" /></label>
            <label class="modal-field"><span>Sample note</span><textarea id="dataset-sample-note" rows="3" placeholder="Sample identity, environment, excitation conditions, or interpretation context">${escapeHtml(dataset?.sampleNote ?? "")}</textarea></label>
          </section>
          <section class="dataset-detail-section dataset-tag-section">
            <div class="dataset-detail-section-head"><div><h3>Identity and conditions</h3><p>Compact labels only. Blank values remain unknown and stay out of the summary.</p></div></div>
            <div class="dataset-tag-editor">
              <label class="dataset-tag-field"><span>Technique</span><select id="dataset-technique">${listTechniques().map((item) => `<option value="${escapeHtml(item.id)}" ${metadata.technique.id === item.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
              <label class="dataset-tag-field"><span>Role</span><select id="dataset-measurement-role">
                ${["unknown", "primary", "reference", "control", "supporting"].map((role) => `<option value="${role}" ${metadata.measurementRole === role ? "selected" : ""}>${escapeHtml(titleCase(role))}</option>`).join("")}
              </select></label>
              <label class="dataset-tag-field"><span>Sample ID</span><input id="dataset-sample-id" value="${escapeHtml(metadata.sampleId)}" placeholder="Unknown" /></label>
              <label class="dataset-tag-field"><span>Preparation ID</span><input id="dataset-preparation-id" value="${escapeHtml(metadata.preparationId)}" placeholder="Unknown" /></label>
              ${primaryConditions.map((field) => renderConditionField(field, metadata, true)).join("")}
            </div>
            <label class="modal-field"><span>Candidate species or states</span><input id="dataset-species-states" value="${escapeHtml(speciesLabels)}" placeholder="Comma-separated; stored as proposed hypotheses" /></label>
            <details class="dataset-conditions-disclosure">
              <summary>More condition tags <span>${additionalConditions.filter((field) => metadata.conditions[field] != null).length} filled</span></summary>
              <div class="dataset-tag-editor additional-condition-tags">${additionalConditions.map((field) => renderConditionField(field, metadata, true)).join("")}</div>
            </details>
          </section>
          <section class="dataset-detail-section connected-evidence-section">
            <div class="dataset-detail-section-head"><div><h3>Connected Evidence</h3><p>Select project evidence, create typed connections, and inspect the local relation map.</p></div><div class="evidence-toolbar"><button data-action="toggle-evidence-view">${state.evidenceViewMode === "map" ? "List view" : "Relation map"}</button><button data-action="open-evidence-import">Import evidence...</button><button data-action="open-literature-import">Import literature...</button></div></div>
            ${state.evidenceViewMode === "map" ? renderFocusedEvidenceMap(dataset, connections) : (connections.length ? `<div class="evidence-connection-list">${connections.map((connection) => renderEvidenceConnectionRow(dataset, connection)).join("")}</div>` : `<p class="empty-evidence-state">No explicit connections. Similar filenames, lifetimes, or spectra will not create one automatically.</p>`)}
            ${renderEvidenceLibrary(dataset)}
          </section>
          <p class="source-readonly">Source file: <strong data-i18n-skip>${escapeHtml(dataset?.source.fileName ?? "-")}</strong></p>
        </div>
        <footer class="modal-footer">
          <span>Metadata and graph records never duplicate or modify numerical source data.</span>
          <button data-action="save-dataset-details">Save Details</button>
        </footer>
      </div>
    </section>`;
}

function renderConditionField(field, metadata, compact = false) {
  return `<label class="${compact ? "dataset-tag-field" : "modal-field"}"><span>${escapeHtml(conditionLabel(field))}</span><input id="dataset-condition-${escapeHtml(field)}" value="${escapeHtml(metadata.conditions[field] ?? "")}" placeholder="Unknown" /></label>`;
}

function renderDatasetIdentityTags(dataset) {
  const metadata = normalizeDatasetEvidence(dataset?.evidenceMetadata, "fsta");
  const tags = [
    getTechnique(metadata.technique.id).label,
    titleCase(metadata.measurementRole),
    metadata.sampleId ? `ID ${metadata.sampleId}` : null,
    metadata.preparationId ? `Prep ${metadata.preparationId}` : null,
    ...primaryConditionFields(metadata.technique.id)
      .map((field) => metadata.conditions[field] ? `${conditionLabel(field)} ${metadata.conditions[field]}` : null),
  ].filter(Boolean);
  return `<div class="dataset-context-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function primaryConditionFields(techniqueId) {
  if (["fsta", "psta", "nsta"].includes(techniqueId)) return ["solvent", "excitationWavelength", "fluence", "atmosphere"];
  if (techniqueId === "absorption") return ["solvent", "concentration", "temperature"];
  if (["pl", "trpl"].includes(techniqueId)) return ["solvent", "excitationWavelength", "temperature"];
  return ["solvent", "temperature", "instrument"];
}

function renderEvidenceLibrary(dataset) {
  const choices = state.evidenceGraph.entities
    .filter((entity) => entity.id !== dataset.id)
    .sort((left, right) => left.label.localeCompare(right.label));
  return `<div class="evidence-library">
    <div class="evidence-library-head"><div><strong>Project evidence library</strong><span>${state.evidenceSelectionIds.length} selected</span></div><button data-action="connect-selected-evidence" ${state.evidenceSelectionIds.length ? "" : "disabled"}>Connect selected...</button></div>
    ${choices.length ? `<div class="evidence-library-grid">${choices.map((entity) => {
      const asset = state.evidenceAssets.find((item) => item.id === entity.assetId);
      return `<div class="evidence-library-item"><label><input class="evidence-library-check" type="checkbox" value="${escapeHtml(entity.id)}" ${state.evidenceSelectionIds.includes(entity.id) ? "checked" : ""} /><span><strong data-i18n-skip>${escapeHtml(entity.label)}</strong><small>${escapeHtml(titleCase(entity.kind))}${asset?.techniqueId ? ` · ${escapeHtml(getTechnique(asset.techniqueId).label)}` : ""}</small></span></label>${asset ? `<button type="button" data-action="open-evidence-asset" data-asset-id="${escapeHtml(asset.id)}">Details</button>` : ""}</div>`;
    }).join("")}</div>` : `<p class="empty-evidence-state">Import an external spectrum, characterization, figure, manuscript, or literature citation to start the library.</p>`}
  </div>`;
}

function renderFocusedEvidenceMap(dataset, connections) {
  const neighbors = connections.map((connection) => {
    const id = connection.fromId === dataset.id ? connection.toId : connection.fromId;
    return { connection, entity: state.evidenceGraph.entities.find((item) => item.id === id) };
  }).filter((item) => item.entity).slice(0, 12);
  if (!neighbors.length) return `<div class="evidence-map evidence-map-empty"><strong>${escapeHtml(datasetDisplayName(dataset))}</strong><span>No connected evidence yet</span></div>`;
  const cx = 400;
  const cy = 190;
  return `<div class="evidence-map"><svg viewBox="0 0 800 380" role="img" aria-label="Focused evidence relation map">
    ${neighbors.map(({ connection }, index) => {
      const angle = (Math.PI * 2 * index / neighbors.length) - Math.PI / 2;
      const x = cx + Math.cos(angle) * 285;
      const y = cy + Math.sin(angle) * 130;
      return `<g><line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/><text class="evidence-map-edge" x="${(cx + x) / 2}" y="${(cy + y) / 2 - 5}">${escapeHtml(shortLabel(connection.type, 22))}</text></g>`;
    }).join("")}
    <g class="evidence-map-node evidence-map-center"><rect x="310" y="156" width="180" height="68" rx="18"/><text x="400" y="186">${escapeHtml(shortLabel(datasetDisplayName(dataset), 25))}</text><text class="evidence-map-kind" x="400" y="206">Dataset</text></g>
    ${neighbors.map(({ entity }, index) => {
      const angle = (Math.PI * 2 * index / neighbors.length) - Math.PI / 2;
      const x = cx + Math.cos(angle) * 285;
      const y = cy + Math.sin(angle) * 130;
      return `<g class="evidence-map-node" data-action="open-evidence-entity" data-entity-id="${escapeHtml(entity.id)}"><rect x="${x - 82}" y="${y - 29}" width="164" height="58" rx="15"/><text x="${x}" y="${y - 2}">${escapeHtml(shortLabel(entity.label, 22))}</text><text class="evidence-map-kind" x="${x}" y="${y + 17}">${escapeHtml(titleCase(entity.kind))}</text></g>`;
    }).join("")}
  </svg></div>`;
}

function shortLabel(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function renderEvidenceConnectionRow(dataset, connection) {
  const otherId = connection.fromId === dataset.id ? connection.toId : connection.fromId;
  const other = state.evidenceGraph.entities.find((entity) => entity.id === otherId);
  const otherDataset = state.datasets.find((item) => item.id === otherId);
  const comparison = otherDataset ? compareDatasetConditions(dataset, otherDataset) : null;
  const technique = otherDataset ? getTechnique(otherDataset.evidenceMetadata?.technique?.id).label : titleCase(other?.kind ?? "entity");
  const warning = comparison
    ? `${comparison.matching.length} matching · ${comparison.different.length} different · ${comparison.unknown.length} unknown conditions`
    : "Condition comparison not applicable";
  return `<article class="evidence-connection-row">
    <div><strong data-i18n-skip>${escapeHtml(other?.label ?? otherId)}</strong><span>${escapeHtml(technique)} · ${escapeHtml(connection.type)} · ${escapeHtml(connection.category)}</span><small>${escapeHtml(warning)}</small><p>${escapeHtml(connection.rationale)}</p></div>
    <div class="evidence-connection-actions"><button data-action="start-ai-from-connection" data-connection-id="${escapeHtml(connection.id)}">Investigate...</button><button data-action="edit-evidence-connection" data-connection-id="${escapeHtml(connection.id)}">Edit rationale...</button><button class="danger-button" data-action="remove-evidence-connection" data-connection-id="${escapeHtml(connection.id)}">Remove</button></div>
  </article>`;
}

function renderEvidenceConnectionModal() {
  const dataset = state.datasets.find((item) => item.id === state.pendingDatasetId);
  const existing = state.evidenceGraph.relationships.find((item) => item.id === state.pendingConnectionId);
  const sourceId = existing?.fromId ?? dataset?.id;
  const source = state.evidenceGraph.entities.find((entity) => entity.id === sourceId);
  const targets = state.evidenceGraph.entities.filter((entity) => entity.id !== sourceId);
  const selectedTargetIds = existing ? [existing.toId] : state.pendingConnectionTargetIds.length
    ? state.pendingConnectionTargetIds
    : [targets[0]?.id].filter(Boolean);
  const compatibleTypes = compatibleRelationshipTypes(sourceId, selectedTargetIds);
  const selectedTarget = selectedTargetIds[0] ?? "";
  return `<section class="modal-shell" role="dialog" aria-modal="true" aria-label="Evidence connection">
    <div class="modal compact-modal evidence-connection-modal">
      <header class="modal-head">
        <div><h2>${existing ? "Edit Evidence Connection" : "Add Evidence Connection"}</h2><p>Record the relationship as authored metadata; no relationship is inferred automatically.</p></div>
        <button data-action="back-dataset-details" class="icon-button" aria-label="Close">x</button>
      </header>
      <div class="dataset-detail-fields">
        <label class="modal-field"><span>From</span><input value="${escapeHtml(source?.label ?? sourceId ?? "")}" disabled /></label>
        ${selectedTargetIds.length > 1 ? `<div class="modal-field"><span>To selected evidence (${selectedTargetIds.length})</span><div class="connection-target-chips">${selectedTargetIds.map((id) => `<span>${escapeHtml(state.evidenceGraph.entities.find((entity) => entity.id === id)?.label ?? id)}</span>`).join("")}</div></div>` : `<label class="modal-field"><span>To evidence</span><select id="connection-target" ${existing || state.pendingConnectionTargetIds.length ? "disabled" : ""}>${targets.map((entity) => `<option value="${escapeHtml(entity.id)}" ${entity.id === selectedTarget ? "selected" : ""}>${escapeHtml(entity.label)} · ${escapeHtml(titleCase(entity.kind))}</option>`).join("")}</select></label>`}
        <label class="modal-field"><span>Relationship type</span><select id="connection-type">${compatibleTypes.map(([type, definition]) => `<option value="${type}" ${existing?.type === type ? "selected" : ""}>${escapeHtml(type)} · ${escapeHtml(definition.category)}</option>`).join("")}</select></label>
        <label class="modal-field"><span>Assertion status</span><select id="connection-status">${["recorded", "proposed", "contested"].map((status) => `<option value="${status}" ${existing?.assertionStatus === status ? "selected" : ""}>${escapeHtml(titleCase(status))}</option>`).join("")}</select></label>
        <label class="modal-field"><span>Authored rationale</span><textarea id="connection-rationale" rows="4" required placeholder="Why is this relationship scientifically relevant?">${escapeHtml(existing?.rationale ?? "")}</textarea></label>
        <label class="modal-field"><span>Author</span><input id="connection-author" value="${escapeHtml(existing?.author ?? "project-user")}" /></label>
        <p class="scientific-note">Interpretive connections remain proposals or contested assertions. Adding one never changes a species-hypothesis status.</p>
      </div>
      <footer class="modal-footer"><button data-action="back-dataset-details">Back</button><span>${compatibleTypes.length ? "One authored relationship will be applied to every selected item." : "The selected evidence types have no shared valid relationship."}</span><button data-action="save-evidence-connection" ${compatibleTypes.length ? "" : "disabled"}>${existing ? "Save Connection" : selectedTargetIds.length > 1 ? `Add ${selectedTargetIds.length} Connections` : "Add Connection"}</button></footer>
    </div>
  </section>`;
}

function compatibleRelationshipTypes(sourceId, targetIds) {
  const source = state.evidenceGraph.entities.find((entity) => entity.id === sourceId);
  const targets = targetIds.map((id) => state.evidenceGraph.entities.find((entity) => entity.id === id)).filter(Boolean);
  return Object.entries(RELATIONSHIP_DEFINITIONS).filter(([, definition]) => source && targets.length && targets.every((target) => (
    definition.pairs.some(([fromKind, toKind]) => fromKind === source.kind && toKind === target.kind)
  )));
}

function renderEvidenceImportModal() {
  const literatureMode = state.evidenceImportMode === "literature";
  const imported = state.evidenceImportResultIds
    .map((id) => state.evidenceAssets.find((asset) => asset.id === id))
    .filter(Boolean);
  return `<section class="modal-shell" role="dialog" aria-modal="true" aria-label="${literatureMode ? "Import literature" : "Import evidence"}">
    <div class="modal evidence-import-modal">
      <header class="modal-head">
        <div><h2>${literatureMode ? "Import Literature" : "Import External Evidence"}</h2><p>${literatureMode ? "Bring in a paper, supporting document, or published figure as a real file first." : "Bring project evidence in through one file-first workspace."}</p></div>
        <button data-action="close-evidence-import" class="icon-button" aria-label="Close">x</button>
      </header>
      <div class="evidence-import-layout">
        <div id="evidence-import-dropzone" class="evidence-import-dropzone" tabindex="0" role="button" aria-label="Drop or paste evidence files here">
          <div class="evidence-import-symbol" aria-hidden="true">+</div>
          <strong>${literatureMode ? "Drop or paste literature files and figures" : "Drop or paste files and pictures"}</strong>
          <p>Drag files here, copy an image or file and press <kbd>⌘V</kbd>, or choose from Finder.</p>
          <label class="evidence-import-choose">Choose files from Finder<input id="evidence-asset-input" type="file" multiple accept=".csv,.tsv,.txt,.asc,.dat,.xy,.png,.jpg,.jpeg,.webp,.gif,.svg,.tif,.tiff,.pdf,.doc,.docx,.odt,.rtf,.tex,.md" /></label>
          <small>${literatureMode ? "PDF, image, manuscript, text, or supporting files" : "Spectroscopy, characterization, images, PDF, documents, manuscripts, and text files"}</small>
        </div>
        <aside class="evidence-import-guidance">
          <h3>${literatureMode ? "Literature import" : "Evidence import"}</h3>
          <ul>
            <li>The exact pasted or imported bytes are preserved.</li>
            <li>Files are automatically classified; you can refine Details later.</li>
            <li>No scientific connection is created until you select and author one.</li>
            ${literatureMode ? "<li>Publication metadata is optional after import; the file is never replaced by typed text.</li>" : ""}
          </ul>
        </aside>
      </div>
      ${imported.length ? `<section class="evidence-import-results"><div><h3>Imported and selected</h3><span>${imported.length} item${imported.length === 1 ? "" : "s"}</span></div><div>${imported.map((asset) => `<button data-action="open-evidence-asset" data-asset-id="${escapeHtml(asset.id)}"><strong data-i18n-skip>${escapeHtml(asset.label)}</strong><small>${escapeHtml(titleCase(asset.kind))}</small></button>`).join("")}</div></section>` : ""}
      <footer class="modal-footer"><button data-action="close-evidence-import">Back to Dataset Details</button><span>Imported items are selected for connection automatically.</span></footer>
    </div>
  </section>`;
}

function renderEvidenceAssetModal() {
  const asset = state.pendingEvidenceAssetDraft
    ?? state.evidenceAssets.find((item) => item.id === state.pendingEvidenceAssetId);
  if (!asset) return "";
  const isNew = Boolean(state.pendingEvidenceAssetDraft);
  return `<section class="modal-shell" role="dialog" aria-modal="true" aria-label="External evidence details">
    <div class="modal compact-modal evidence-asset-modal">
      <header class="modal-head"><div><h2>${isNew ? "Add Literature Evidence" : "External Evidence Details"}</h2><p>Describe the evidence without changing its exact imported source.</p></div><button data-action="back-dataset-details" class="icon-button" aria-label="Close">x</button></header>
      <div class="dataset-detail-fields">
        <label class="modal-field"><span>Label</span><input id="evidence-asset-label" value="${escapeHtml(asset.label)}" /></label>
        <div class="dataset-detail-grid">
          <label class="modal-field"><span>Evidence kind</span><select id="evidence-asset-kind">${EVIDENCE_ASSET_KINDS.map((kind) => `<option value="${kind}" ${asset.kind === kind ? "selected" : ""}>${escapeHtml(titleCase(kind))}</option>`).join("")}</select></label>
          <label class="modal-field"><span>Technique</span><select id="evidence-asset-technique">${listTechniques().map((item) => `<option value="${escapeHtml(item.id)}" ${asset.techniqueId === item.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
          <label class="modal-field"><span>Measurement role</span><select id="evidence-asset-role">${["unknown", "primary", "reference", "control", "supporting"].map((role) => `<option value="${role}" ${asset.measurementRole === role ? "selected" : ""}>${escapeHtml(titleCase(role))}</option>`).join("")}</select></label>
          <label class="modal-field"><span>Rights / sharing status</span><select id="evidence-asset-rights">${LITERATURE_RIGHTS_STATUSES.map((status) => `<option value="${status}" ${asset.citation.rightsStatus === status ? "selected" : ""}>${escapeHtml(titleCase(status))}</option>`).join("")}</select></label>
        </div>
        <label class="modal-field"><span>Note</span><textarea id="evidence-asset-note" rows="3">${escapeHtml(asset.note)}</textarea></label>
        <label class="modal-field"><span>Title / citation</span><input id="evidence-citation-title" value="${escapeHtml(asset.citation.title)}" placeholder="Article, manuscript, or figure title" /></label>
        <div class="dataset-detail-grid">
          <label class="modal-field"><span>Authors</span><input id="evidence-citation-authors" value="${escapeHtml(asset.citation.authors)}" /></label>
          <label class="modal-field"><span>Year</span><input id="evidence-citation-year" value="${escapeHtml(asset.citation.year)}" /></label>
          <label class="modal-field"><span>DOI</span><input id="evidence-citation-doi" value="${escapeHtml(asset.citation.doi)}" /></label>
          <label class="modal-field"><span>URL</span><input id="evidence-citation-url" value="${escapeHtml(asset.citation.url)}" /></label>
          <label class="modal-field"><span>Figure / location</span><input id="evidence-citation-figure" value="${escapeHtml(asset.citation.figure)}" /></label>
        </div>
        <p class="source-readonly">Source: <strong data-i18n-skip>${escapeHtml(asset.source.fileName || "Citation only")}</strong> · ${asset.source.byteLength || 0} bytes${asset.source.sha256 ? ` · SHA-256 ${escapeHtml(asset.source.sha256)}` : ""}</p>
      </div>
      <footer class="modal-footer"><button data-action="back-dataset-details">Back</button><span>Imported bytes remain authoritative and untouched.</span><button data-action="save-evidence-asset">Save Evidence</button></footer>
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
  return `
    <section class="modal-shell expanded-shell" role="dialog" aria-modal="true" aria-label="${escapeHtml(meta.title)} enlarged">
      <div class="modal expanded-plot-modal">
        <header class="modal-head expanded-head">
          <div><h2>${escapeHtml(meta.title)}</h2>${meta.subtitle && !coordinateControl ? `<p>${escapeHtml(meta.subtitle)}</p>` : ""}</div>
          <div class="expanded-tools">
            ${componentPlot && (state.expandedPlot === "compare-components" ? compareDatasets().some((dataset) => irfLimitedCount(dataset)) : irfLimitedCount(activeDataset())) ? `<span class="irf-exclusion-note">IRF-limited components excluded</span>` : ""}
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
  document.getElementById("evidence-asset-input")?.addEventListener("change", (event) => importEvidenceFiles(event).catch(showError));
  const evidenceDropzone = document.getElementById("evidence-import-dropzone");
  evidenceDropzone?.addEventListener("dragenter", handleEvidenceDragEnter);
  evidenceDropzone?.addEventListener("dragover", handleEvidenceDragOver);
  evidenceDropzone?.addEventListener("dragleave", handleEvidenceDragLeave);
  evidenceDropzone?.addEventListener("drop", (event) => handleEvidenceDrop(event).catch(showError));
  evidenceDropzone?.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key) && event.target === evidenceDropzone) {
      event.preventDefault();
      document.getElementById("evidence-asset-input")?.click();
    }
  });
  document.querySelector(".evidence-import-modal")?.addEventListener("paste", (event) => handleEvidencePaste(event).catch(showError));
  document.querySelectorAll(".evidence-library-check").forEach((input) => {
    input.addEventListener("change", (event) => {
      const ids = new Set(state.evidenceSelectionIds);
      if (event.target.checked) ids.add(event.target.value);
      else ids.delete(event.target.value);
      state.evidenceSelectionIds = [...ids];
      render();
    });
  });
  document.getElementById("connection-target")?.addEventListener("change", (event) => {
    const sourceId = state.evidenceGraph.relationships.find((item) => item.id === state.pendingConnectionId)?.fromId
      ?? state.pendingDatasetId;
    const entries = compatibleRelationshipTypes(sourceId, [event.target.value]);
    const select = document.getElementById("connection-type");
    if (select) select.innerHTML = entries.map(([type, definition]) => `<option value="${type}">${escapeHtml(type)} · ${escapeHtml(definition.category)}</option>`).join("");
  });
  document.getElementById("origin-output-mode")?.addEventListener("change", (event) => {
    state.origin.outputMode = event.target.value === "sheets-only"
      ? "sheets-only"
      : "sheets-plots";
  });
  document.getElementById("origin-format")?.addEventListener("change", (event) => {
    state.origin.outputFormat = event.target.value;
  });
  ["ai-question", "ai-context", "ai-desired-output"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", syncAiDraftFromDom);
  });
  document.getElementById("ai-goal")?.addEventListener("change", (event) => {
    syncAiDraftFromDom();
    const goal = AI_INVESTIGATION_GOALS[event.target.value];
    state.aiInvestigation.draft.goal = event.target.value;
    if (!state.aiInvestigation.draft.question.trim() && goal?.scaffold) state.aiInvestigation.draft.question = goal.scaffold;
    state.aiInvestigation.preview = null;
    render();
  });
  document.querySelectorAll('input[name="ai-scope"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      syncAiDraftFromDom();
      state.aiInvestigation.draft.scope.kind = event.target.value;
      if (event.target.value === "connected-evidence") {
        state.aiInvestigation.draft.scope.datasetIds = activeDataset() ? [activeDataset().id] : [];
      }
      state.aiInvestigation.preview = null;
      render();
    });
  });
  document.querySelectorAll('input[name="ai-profile"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      syncAiDraftFromDom();
      state.aiInvestigation.draft.evidenceProfile = event.target.value;
      if (event.target.value !== "full") {
        state.aiInvestigation.draft.include.rawSources = false;
        state.aiInvestigation.draft.include.fullTreatedMatrices = false;
      }
      state.aiInvestigation.preview = null;
      render();
    });
  });
  document.querySelectorAll(".ai-dataset-check").forEach((input) => {
    input.addEventListener("change", (event) => {
      const ids = new Set(state.aiInvestigation.draft.scope.datasetIds ?? []);
      if (event.target.checked) ids.add(event.currentTarget.dataset.datasetId);
      else ids.delete(event.currentTarget.dataset.datasetId);
      state.aiInvestigation.draft.scope.datasetIds = state.datasets.filter((dataset) => ids.has(dataset.id)).map((dataset) => dataset.id);
      state.aiInvestigation.preview = null;
    });
  });
  [
    "ai-include-notes", "ai-include-filenames", "ai-include-metadata", "ai-redact-paths",
    "ai-redact-operators", "ai-redact-computers", "ai-include-raw", "ai-include-matrices",
  ].forEach((id) => document.getElementById(id)?.addEventListener("change", syncAiDraftFromDom));

  // Shared selection-modal listeners (compare and merge)
  document.querySelectorAll(".selection-check").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const datasetId = event.currentTarget.dataset.datasetId;
      const mode = state.modal === "merge-select" ? "merge" : "compare";
      const selectedIds = mode === "compare" ? state.compare.selectedIds : state.merge.selectedIds;
      const newIds = toggleSelection(selectedIds, datasetId, mode);
      if (mode === "compare") {
        state.compare.selectedIds = newIds;
      } else {
        state.merge.selectedIds = newIds;
        state.merge.plan = null;
        state.merge.draft = null;
      }
      markDirty();
      render();
    });
  });
  document.getElementById("selection-select-all")?.addEventListener("change", (event) => {
    if (state.modal === "compare-select") {
      state.compare.selectedIds = event.target.checked
        ? state.datasets.filter((d) => isEligibleForMode(d, "compare")).map((d) => d.id)
        : [];
    }
    render();
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
  document.getElementById("fit-components")?.addEventListener("change", (event) => {
    state.fitting.components = Number(event.target.value) || 3;
    resetLifetimeEditor();
    render();
  });
  document.getElementById("fit-irf")?.addEventListener("input", (event) => {
    state.fitting.irfFwhm = Number(event.target.value) || 0.25;
  });
  document.getElementById("feature-relative-threshold")?.addEventListener("change", (event) => {
    state.featureFinding.relativeThreshold = clamp((Number(event.target.value) || 12) / 100, 0.01, 0.8);
    clearPlotZooms(["main-components", "modal-eas", "modal-das", "feature-time"]);
    markDirty();
    render();
  });
  document.getElementById("feature-gaussian-r2")?.addEventListener("change", (event) => {
    state.featureFinding.minimumGaussianR2 = clamp(Number(event.target.value) || 0, 0, 0.99);
    clearPlotZooms(["main-components", "modal-eas", "modal-das", "feature-time"]);
    markDirty();
    render();
  });
  document.getElementById("feature-minimum-fwhm")?.addEventListener("change", (event) => {
    state.featureFinding.minimumFwhmNm = clamp(Number(event.target.value) || 0, 0, 500);
    clearPlotZooms(["main-components", "modal-eas", "modal-das", "feature-time"]);
    markDirty();
    render();
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
      let resolvedTarget = null;
      dragHandle.setPointerCapture?.(pointerId);

      const clearTarget = () => {
        if (resolvedTarget) {
          resolvedTarget.element.classList.remove(resolvedTarget.dropClass);
          resolvedTarget = null;
        }
      };
      const updateTarget = (pointerEvent) => {
        const element = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
        // First, try a dataset row for before/after placement
        const rowTarget = element?.closest("[data-dataset-drop]");
        if (rowTarget && rowTarget.dataset.datasetDrop !== datasetId) {
          const rect = rowTarget.getBoundingClientRect();
          const placement = pointerEvent.clientY < rect.top + rect.height / 2 ? "before" : "after";
          const dropClass = `drop-${placement}`;
          const key = `${rowTarget.dataset.datasetDrop}-${placement}`;
          if (resolvedTarget?.key === key) return;
          clearTarget();
          resolvedTarget = { element: rowTarget, placement, targetDatasetId: rowTarget.dataset.datasetDrop, folderId: rowTarget.closest("[data-folder-drop]")?.dataset.folderDrop, dropClass, key };
          rowTarget.classList.add(dropClass);
          return;
        }
        // Fallback to folder-level for end-of-folder drops
        const folderTarget = element?.closest("[data-folder-drop]");
        if (folderTarget) {
          const key = `end-${folderTarget.dataset.folderDrop}`;
          if (resolvedTarget?.key === key) return;
          clearTarget();
          resolvedTarget = { element: folderTarget, placement: "end", targetDatasetId: null, folderId: folderTarget.dataset.folderDrop, dropClass: "drop-end", key };
          folderTarget.classList.add("drop-end");
          return;
        }
        clearTarget();
      };
      const move = (pointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (!started && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) >= 4) {
          started = true;
          row.classList.add("dragging");
          document.documentElement.classList.add("dataset-drag-active");
        }
        if (started) {
          updateTarget(pointerEvent);
          // Edge auto-scroll
          const tree = document.querySelector(".dataset-tree-scroll");
          if (tree) {
            const treeRect = tree.getBoundingClientRect();
            const edge = 40;
            if (pointerEvent.clientY < treeRect.top + edge) tree.scrollTop -= 8;
            else if (pointerEvent.clientY > treeRect.bottom - edge) tree.scrollTop += 8;
          }
        }
      };
      const finish = (pointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        if (started) updateTarget(pointerEvent);
        const target = resolvedTarget;
        cleanup();
        if (started && target) {
          reorderDataset(datasetId, {
            targetFolderId: target.folderId,
            targetDatasetId: target.targetDatasetId,
            placement: target.placement,
          });
        }
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
    } else if (action === "new-ai-investigation") {
      openAiInvestigation();
    } else if (action === "review-ai-investigation") {
      await reviewAiInvestigation();
    } else if (action === "back-ai-investigation") {
      state.aiInvestigation.stage = "builder";
      state.aiInvestigation.preview = null;
      render();
    } else if (action === "save-ai-investigation") {
      await exportAiInvestigationPackage();
    } else if (action === "copy-ai-prompt") {
      await copyAiInvestigationPrompt();
    } else if (action === "save-ai-brief") {
      await saveAiInvestigationBrief();
    } else if (action === "legacy-export-md") {
      await exportMarkdown();
    } else if (action === "open-merge-selection") {
      state.merge.stage = "select";
      state.modal = "merge-select";
      render();
    } else if (action === "open-merge-workspace") {
      const datasets = state.merge.selectedIds
        .map((id) => state.datasets.find((d) => d.id === id))
        .filter(Boolean);
      if (datasets.length !== 2 || !datasets.every((d) => isEligibleForMode(d, "merge"))) {
        state.notice = { kind: "error", title: "Select exactly two treated datasets", message: "Treat both datasets before merging." };
        render();
        return;
      }
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
    } else if (action === "change-merge") {
      state.modal = "merge-select";
      render();
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
      state.pendingConnectionId = null;
      state.pendingConnectionTargetIds = [];
      state.pendingEvidenceAssetId = null;
      state.pendingEvidenceAssetDraft = null;
      render();
    } else if (action === "run-fit") {
      await runFitActive();
    } else if (action === "reset-feature-finder") {
      state.featureFinding = { relativeThreshold: 0.12, minimumGaussianR2: 0.45, minimumFwhmNm: 6 };
      clearPlotZooms(["main-components", "modal-eas", "modal-das", "feature-time"]);
      markDirty();
      render();
    } else if (action === "batch-fit") {
      await runBatchFit();
    } else if (action === "save-project") {
      await saveProject();
    } else if (action === "export-md") {
      await exportMarkdown();
    } else if (action === "select-origin" || action === "change-origin") {
      await selectOriginInstallation();
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
      render();
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
      state.evidenceSelectionIds = [];
      state.datasetMenu = null;
      state.modal = "edit-dataset";
      render();
    } else if (action === "save-dataset-details") {
      saveDatasetDetails();
    } else if (action === "toggle-evidence-view") {
      persistDatasetDetails({ close: false, notify: false });
      state.evidenceViewMode = state.evidenceViewMode === "map" ? "list" : "map";
      render();
    } else if (action === "connect-selected-evidence") {
      persistDatasetDetails({ close: false, notify: false });
      state.pendingConnectionId = null;
      state.pendingConnectionTargetIds = state.evidenceSelectionIds.slice();
      state.modal = "edit-connection";
      render();
    } else if (action === "open-evidence-import" || action === "open-literature-import") {
      persistDatasetDetails({ close: false, notify: false });
      state.evidenceImportMode = action === "open-literature-import" ? "literature" : "evidence";
      state.evidenceImportResultIds = [];
      state.modal = "evidence-import";
      render();
      await nextFrame();
      document.getElementById("evidence-import-dropzone")?.focus();
    } else if (action === "close-evidence-import") {
      state.evidenceImportResultIds = [];
      state.modal = "edit-dataset";
      render();
    } else if (action === "open-evidence-asset") {
      event.preventDefault();
      state.pendingEvidenceAssetId = event.currentTarget.dataset.assetId;
      state.pendingEvidenceAssetDraft = null;
      state.modal = "edit-evidence-asset";
      render();
    } else if (action === "open-evidence-entity") {
      const entity = state.evidenceGraph.entities.find((item) => item.id === event.currentTarget.dataset.entityId);
      if (entity?.datasetId) {
        state.pendingDatasetId = entity.datasetId;
        state.evidenceSelectionIds = [];
        state.modal = "edit-dataset";
      } else if (entity?.assetId) {
        state.pendingEvidenceAssetId = entity.assetId;
        state.pendingEvidenceAssetDraft = null;
        state.modal = "edit-evidence-asset";
      }
      render();
    } else if (action === "save-evidence-asset") {
      saveEvidenceAsset();
    } else if (action === "start-ai-from-connection") {
      const connection = state.evidenceGraph.relationships.find((item) => item.id === event.currentTarget.dataset.connectionId);
      if (!connection) throw new Error("The selected evidence connection is unavailable.");
      const datasetIds = [connection.fromId, connection.toId].filter((id) => state.datasets.some((dataset) => dataset.id === id));
      openAiInvestigation();
      state.aiInvestigation.draft.scope = { kind: "connected-evidence", datasetIds };
      const techniques = new Set(datasetIds.map((id) => state.datasets.find((dataset) => dataset.id === id)?.evidenceMetadata?.technique?.id).filter(Boolean));
      state.aiInvestigation.draft.goal = techniques.size > 1 ? "multimodal-consistency" : "custom";
      state.aiInvestigation.draft.context = `Investigate the reviewed connection ${connection.id} (${connection.type}). User rationale: ${connection.rationale}`;
      render();
    } else if (action === "add-evidence-connection") {
      persistDatasetDetails({ close: false, notify: false });
      state.pendingConnectionId = null;
      state.pendingConnectionTargetIds = [];
      state.modal = "edit-connection";
      render();
    } else if (action === "edit-evidence-connection") {
      persistDatasetDetails({ close: false, notify: false });
      state.pendingConnectionId = event.currentTarget.dataset.connectionId;
      state.pendingConnectionTargetIds = [];
      state.modal = "edit-connection";
      render();
    } else if (action === "remove-evidence-connection") {
      const connectionId = event.currentTarget.dataset.connectionId;
      state.evidenceGraph = removeEvidenceConnection(state.evidenceGraph, connectionId, state.datasets);
      markDirty();
      state.notice = { kind: "success", title: "Connection removed", message: "The relationship was removed; neither dataset nor source data was deleted." };
      render();
    } else if (action === "save-evidence-connection") {
      saveEvidenceConnection();
    } else if (action === "back-dataset-details") {
      state.pendingConnectionId = null;
      state.pendingConnectionTargetIds = [];
      state.pendingEvidenceAssetId = null;
      state.pendingEvidenceAssetDraft = null;
      state.modal = "edit-dataset";
      render();
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

async function importEvidenceFiles(event) {
  const files = Array.from(event.target.files ?? []);
  if (files.length) await importEvidenceFileList(files);
  event.target.value = "";
}

function handleEvidenceDragEnter(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-active");
}

function handleEvidenceDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  event.currentTarget.classList.add("drag-active");
}

function handleEvidenceDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove("drag-active");
}

async function handleEvidenceDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-active");
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) throw new Error("The dropped content contains no files or pictures.");
  await importEvidenceFileList(files);
}

async function handleEvidencePaste(event) {
  const files = clipboardEvidenceFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  await importEvidenceFileList(files);
}

function clipboardEvidenceFiles(clipboardData) {
  const direct = Array.from(clipboardData?.files ?? []);
  const itemFiles = Array.from(clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
  const files = direct.length ? direct : itemFiles;
  return files.map((file, index) => normalizePastedEvidenceFile(file, index));
}

function normalizePastedEvidenceFile(file, index) {
  if (file.name && !/^image\.(png|jpe?g)$/i.test(file.name)) return file;
  const extension = file.type === "image/jpeg" ? "jpg"
    : file.type === "image/svg+xml" ? "svg"
      : file.type === "image/webp" ? "webp"
        : "png";
  const name = `pasted-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}-${index + 1}.${extension}`;
  if (typeof File === "function") return new File([file], name, { type: file.type || `image/${extension}` });
  return { name, type: file.type || `image/${extension}`, arrayBuffer: () => file.arrayBuffer() };
}

async function importEvidenceFileList(files) {
  if (!files.length) return;
  const importMode = state.evidenceImportMode;
  await runJob(`Importing ${files.length} evidence item${files.length === 1 ? "" : "s"}`, "import-evidence", async () => {
    const imported = [];
    for (let index = 0; index < files.length; index += 1) {
      state.job.detail = `${index + 1} of ${files.length}: ${files[index].name}`;
      render();
      await nextFrame();
      imported.push(await createEvidenceAssetFromFile(files[index], {
        ...evidenceImportOptions(files[index].name, files[index].type, importMode),
        createdAt: new Date().toISOString(),
      }));
    }
    state.evidenceAssets.push(...imported);
    state.evidenceGraph = migrateEvidenceGraph(state.evidenceGraph, state.datasets, {
      createdAt: new Date().toISOString(),
      evidenceAssets: state.evidenceAssets,
    });
    state.evidenceSelectionIds = [...new Set([...state.evidenceSelectionIds, ...imported.map((asset) => asset.id)])];
    state.evidenceImportResultIds = [...new Set([...state.evidenceImportResultIds, ...imported.map((asset) => asset.id)])];
    markDirty();
    return imported;
  }, `${files.length} external evidence item${files.length === 1 ? " was" : "s were"} imported with exact source bytes and selected for connection.`);
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
        evidenceMetadata: normalizeDatasetEvidence(null, "fsta"),
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
    state.evidenceGraph = migrateEvidenceGraph(state.evidenceGraph, state.datasets);
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
  const activeId = activeDataset()?.id ?? null;
  const folder = activeFolder();
  if (!folder) {
    state.notice = { kind: "info", title: "No active folder", message: "Select a dataset so the batch fit knows which folder to process." };
    render();
    return;
  }
  const targets = getUnfittedDatasetsInFolder(state.datasets, folder.id);
  if (!targets.length) {
    state.notice = { kind: "info", title: "Current Folder Fitted", message: `No unfitted datasets in "${folder.name}". Batch Global Fitting preserves existing results.` };
    render();
    return;
  }
  const targetIds = new Set(targets.map((dataset) => dataset.id));
  const folderName = folder.name;
  await runJob(`Batch Global Fitting in ${folderName}`, "batch-fit", async () => {
    for (let index = 0; index < targets.length; index += 1) {
      state.job.detail = `${index + 1} of ${targets.length} in ${folderName}: ${targets[index].source.fileName}`;
      render();
      await nextFrame();
      targets[index].fit = Parser.fitGlobalExponentials(targets[index].analysis, state.fitting.components, {
        irfFwhm: state.fitting.irfFwhm,
        lifetimes: configuration.lifetimes,
        fixedLifetimes: configuration.fixedLifetimes,
      });
    }
    const activeFit = activeDataset()?.fit;
    if (activeFit && targetIds.has(activeId)) {
      state.fitting.lifetimeValues = activeFit.lifetimes.map((value) => conciseInputNumber(value));
      state.fitting.fixedLifetimes = activeFit.fixedLifetimes.slice();
    }
    state.fitting.spectrumMode = "EAS";
    clearPlotZooms(["main-components", "modal-eas", "modal-das", "fit-residual", "compare-components"]);
    markDirty();
  }, `Global fitting completed for ${targets.length} dataset(s) in "${folderName}"; existing fits were preserved.`);
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
      externalEvidencePolicy: "external evidence retains exact imported bytes; previews and graph relationships are derived, typed, and authored",
    },
    state: {
      activeIndex: state.activeIndex,
      selectedTimeIndex: state.selectedTimeIndex,
      selectedWavelengthIndex: state.selectedWavelengthIndex,
      compare: state.compare,
      fitting: state.fitting,
      featureFinding: state.featureFinding,
    },
    folders: state.folders,
    datasets: state.datasets,
    evidenceAssets: state.evidenceAssets,
    evidenceGraph: migrateEvidenceGraph(state.evidenceGraph, state.datasets, {
      createdAt: state.project.lastSavedAt ?? null,
      evidenceAssets: state.evidenceAssets,
    }),
  };
}

function loadProject(project) {
  if (!project?.schema?.startsWith("specflowlab")) throw new Error("Unsupported SpecFlowLab project.");
  state.datasets = (project.datasets ?? []).map(reviveDataset);
  state.evidenceAssets = (project.evidenceAssets ?? []).map((asset) => normalizeEvidenceAsset(asset));
  state.evidenceGraph = migrateEvidenceGraph(project.evidenceGraph, state.datasets, {
    createdAt: project.savedAt ?? null,
    evidenceAssets: state.evidenceAssets,
  });
  state.folders = reviveFolders(project.folders, project.state);
  assignLegacyFolderMembership();
  state.activeIndex = project.state?.activeIndex ?? 0;
  state.selectedTimeIndex = project.state?.selectedTimeIndex ?? 0;
  state.selectedWavelengthIndex = project.state?.selectedWavelengthIndex ?? 0;
  state.compare = { ...state.compare, ...(project.state?.compare ?? {}) };
  state.fitting = { ...state.fitting, ...(project.state?.fitting ?? {}) };
  state.featureFinding = { ...state.featureFinding, ...(project.state?.featureFinding ?? {}) };
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
  state.evidenceSelectionIds = [];
  state.pendingConnectionTargetIds = [];
  state.pendingEvidenceAssetId = null;
  state.pendingEvidenceAssetDraft = null;
}

function reviveDataset(dataset) {
  return {
    ...dataset,
    projectLabel: dataset.projectLabel || dataset.source?.fileName?.replace(/\.[^.]+$/, "") || "Dataset",
    sampleNote: dataset.sampleNote || "",
    evidenceMetadata: normalizeDatasetEvidence(dataset.evidenceMetadata, dataset.kind === "merged" ? "fsta" : "fsta"),
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

function openAiInvestigation() {
  const project = aiInvestigationProjectSnapshot();
  const scope = defaultAiScope(project);
  state.aiInvestigation = {
    ...state.aiInvestigation,
    stage: "builder",
    preview: null,
    draft: {
      schema: AI_INVESTIGATION_SPEC_SCHEMA,
      goal: folderDatasets(activeFolder()?.id).length > 1 ? "compare" : "custom",
      question: "",
      context: "",
      desiredOutput: "",
      scope: { ...scope, datasetIds: state.datasets.map((dataset) => dataset.id) },
      evidenceProfile: "diagnostic",
      userTimesPs: [],
      userWavelengthsNm: [],
      include: {
        sampleNotes: true,
        sourceFileNames: true,
        instrumentMetadata: true,
        rawSources: false,
        fullTreatedMatrices: false,
        fullResidualMatrices: false,
      },
      privacy: {
        redactAbsolutePaths: true,
        redactOperatorNames: true,
        redactComputerNames: true,
      },
    },
  };
  state.modal = "ai-investigation";
  render();
}

function syncAiDraftFromDom() {
  const draft = state.aiInvestigation.draft;
  if (!draft) return;
  const textValues = {
    question: document.getElementById("ai-question")?.value,
    context: document.getElementById("ai-context")?.value,
    desiredOutput: document.getElementById("ai-desired-output")?.value,
  };
  Object.entries(textValues).forEach(([key, value]) => {
    if (value !== undefined) draft[key] = value;
  });
  const goal = document.getElementById("ai-goal")?.value;
  if (goal) draft.goal = goal;
  const scope = document.querySelector('input[name="ai-scope"]:checked')?.value;
  if (scope) draft.scope.kind = scope;
  const profile = document.querySelector('input[name="ai-profile"]:checked')?.value;
  if (profile) draft.evidenceProfile = profile;
  const bindings = [
    ["ai-include-notes", draft.include, "sampleNotes"],
    ["ai-include-filenames", draft.include, "sourceFileNames"],
    ["ai-include-metadata", draft.include, "instrumentMetadata"],
    ["ai-include-raw", draft.include, "rawSources"],
    ["ai-include-matrices", draft.include, "fullTreatedMatrices"],
    ["ai-redact-paths", draft.privacy, "redactAbsolutePaths"],
    ["ai-redact-operators", draft.privacy, "redactOperatorNames"],
    ["ai-redact-computers", draft.privacy, "redactComputerNames"],
  ];
  bindings.forEach(([id, target, key]) => {
    const input = document.getElementById(id);
    if (input) target[key] = input.checked;
  });
  state.aiInvestigation.preview = null;
}

async function reviewAiInvestigation() {
  syncAiDraftFromDom();
  const preview = await inspectAiInvestigation(
    aiInvestigationProjectSnapshot(),
    state.aiInvestigation.draft,
    { investigationId: "pending-export", createdAt: "generated-on-export" },
  );
  if (preview.errors.length) throw new Error(preview.errors.join(" "));
  state.aiInvestigation.preview = preview;
  state.aiInvestigation.stage = "review";
  render();
}

async function exportAiInvestigationPackage() {
  const draft = state.aiInvestigation.draft;
  await runJob("Building AI investigation package", "export-ai-investigation", async () => {
    const result = await createAiInvestigationPackage(aiInvestigationProjectSnapshot(), draft, {
      selections: Object.fromEntries(state.datasets.map((dataset) => [dataset.id, {
        timeIndex: dataset.id === activeDataset()?.id ? state.selectedTimeIndex : 0,
        wavelengthIndex: dataset.id === activeDataset()?.id ? state.selectedWavelengthIndex : 0,
      }])),
    });
    const path = await saveBinaryWithDialog(
      result.bytes,
      aiInvestigationDefaultName(draft.question),
      "ai-investigation",
      "application/zip",
    );
    if (!path) return false;
    state.aiInvestigation.lastExport = {
      investigationId: result.manifest.investigationId,
      goalLabel: AI_INVESTIGATION_GOALS[draft.goal]?.label ?? draft.goal,
      path,
    };
    state.modal = null;
    return true;
  }, "Local .sflai package saved with a concise brief, provider-neutral prompt, evidence files, checksums, omissions, and limitations.");
}

async function copyAiInvestigationPrompt() {
  const prompt = state.aiInvestigation.preview?.prompt;
  if (!prompt) throw new Error("Review the investigation before copying its prompt.");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(prompt);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = prompt;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("The prompt could not be copied; save the brief or package instead.");
  }
  state.notice = { kind: "success", title: "Prompt copied", message: "The provider-neutral evidence-citation prompt is on the clipboard." };
  render();
}

async function saveAiInvestigationBrief() {
  const brief = state.aiInvestigation.preview?.brief;
  if (!brief) throw new Error("Review the investigation before saving its brief.");
  await runJob("Saving investigation brief", "export-ai-brief", () => saveTextWithDialog(
    brief,
    aiInvestigationDefaultName(state.aiInvestigation.draft.question).replace(/\.sflai$/i, ".md"),
    "markdown",
    "text/markdown",
  ), "Concise AI investigation brief saved without an embedded project JSON dump.");
}

function aiInvestigationProjectSnapshot() {
  return {
    ...serializeProject(),
    activeDatasetId: activeDataset()?.id ?? null,
    activeIndex: state.activeIndex,
    selectedTimeIndex: state.selectedTimeIndex,
    selectedWavelengthIndex: state.selectedWavelengthIndex,
  };
}

function aiInvestigationDefaultName(question) {
  const stem = String(question || "investigation")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .toLowerCase();
  return `SpecFlowLab-${stem || "investigation"}.sflai`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function titleCase(value) {
  return String(value ?? "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function conditionLabel(field) {
  return ({
    solvent: "Solvent / matrix",
    concentration: "Concentration",
    temperature: "Temperature",
    atmosphere: "Atmosphere",
    ph: "pH",
    excitationWavelength: "Excitation wavelength",
    fluence: "Fluence / power",
    polarization: "Polarization",
    repetitionRate: "Repetition rate",
    acquisitionDate: "Acquisition date",
    instrument: "Instrument",
  })[field] ?? titleCase(field);
}

async function selectOriginInstallation() {
  try {
    const result = await invoke("select_origin_installation");
    if (result) {
      state.origin.installation = result;
      state.origin.outputFormat = result.defaultProjectFormat;
      state.notice = { kind: "success", title: "OriginPro selected", message: `${result.displayName} (${result.supportLevel}, ${result.backend})` };
    }
  } catch (error) {
    state.notice = { kind: "error", title: "Could not select OriginPro", message: errorMessage(error) };
  }
  render();
}

async function createInOrigin() {
  await runJob("Launching OriginPro bridge", "create-origin", async () => {
    if (!isTauriRuntime() || !isWindowsPlatform()) {
      throw new Error("Create in OriginPro is available in the Windows SpecFlowLab app.");
    }
    const bundle = createOriginBundle(serializeProject());
    const projectName = projectArchiveDefaultName().replace(/\.sflproj$/i, "");
    const ext = state.origin.outputFormat || state.origin.installation?.defaultProjectFormat || "opju";
    return invoke("create_origin_project", {
      defaultName: `${projectName || "SpecFlowLab_project"}.${ext}`,
      bytes: Array.from(bundle),
      createPlots: state.origin.outputMode === "sheets-plots" && state.origin.installation?.capabilities?.linePlots === true,
      outputFormat: state.origin.outputFormat || null,
    });
  }, (result) => {
    const originInfo = result.originDisplayName
      ? `${result.originDisplayName}${result.originVersion ? ` ${result.originVersion}` : ""} (${result.supportLevel}, ${result.backend})`
      : result.originExecutable;
    const formatLabel = (result.outputFormat || "opju").toUpperCase();
    const graphSummary = result.createPlots
      ? ` and ${result.graphCount} automatically rescaled graphs`
      : " in sheets-only mode";
    const sheetSummary = result.sheetCount
      ? ` containing ${result.sheetCount} worksheets`
      : "";
    let omittedMsg = "";
    if (result.omittedGraphTypes?.length) {
      omittedMsg = ` Omitted: ${result.omittedGraphTypes.join(", ")}. ${result.omissionReasons?.join(" ") ?? ""}`;
    }
    return (
      `${originInfo} imported ${result.datasetCount} datasets into ${result.workbookCount} workbooks${sheetSummary}${graphSummary}, `
      + `then saved a ${formatBytes(result.outputBytes)} ${formatLabel} project at ${result.outputPath}.`
      + `${omittedMsg} `
      + `The exact bridge input remains at ${result.bundlePath}. `
      + `${result.warnings?.length ? `${result.warnings.length} warning(s): ${result.warnings.join(" ")} ` : ""}`
      + `Diagnostics: ${result.statusPath}, ${result.logPath}, and ${result.launchDiagnosticPath}.`
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
  if (plotKey === "feature-time") {
    const compressed = buildFeatureTimeMap(dataset, featureMonitorFor(dataset));
    if (compressed.status !== "live") return null;
    return {
      columns: ["Feature", "Candidate", "Wavelength min (nm)", "Wavelength max (nm)", "Time (ps)", "Mean DeltaOD"],
      rows: compressed.features.flatMap((feature) => compressed.timeAxis.map((time, timeIndex) => [
        feature.featureCode,
        feature.candidateType,
        feature.wavelengthMin,
        feature.wavelengthMax,
        time,
        feature.trace[timeIndex],
      ])),
    };
  }
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
      visibleComponentSpectra(dataset, state.fitting.spectrumMode),
      state.fitting.normalize,
      `${state.fitting.spectrumMode} DeltaOD`,
    );
  }
  if (plotKey === "modal-eas") {
    return componentSeriesData(visibleComponentSpectra(dataset, "EAS"), "none", "EAS DeltaOD");
  }
  if (plotKey === "modal-das") {
    return componentSeriesData(visibleComponentSpectra(dataset, "DAS"), "none", "DAS DeltaOD");
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
      if (dataset.fit?.irfLimited?.[componentIndex]) return;
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
    evidenceMetadata: normalizeDatasetEvidence(null, "fsta"),
    source,
    baseAnalysis,
    analysis,
    merge: result.merge,
    fit: null,
  };
  state.datasets.push(dataset);
  state.evidenceGraph = migrateEvidenceGraph(state.evidenceGraph, state.datasets);
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
  const hiddenCount = irfLimitedCount(dataset);
  document.querySelectorAll("[data-action=\"result-mode\"]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.fitting.spectrumMode);
  });
  const copy = document.getElementById("main-component-mode-copy");
  if (copy) {
    copy.textContent = hiddenCount ? `${hiddenCount} IRF-limited excluded` : "";
  }
  const canvas = document.getElementById("main-components");
  if (canvas) canvas.setAttribute("aria-label", `${state.fitting.spectrumMode} component spectra`);
  paintCanvases();
}

function comparisonComponentCopy() {
  const hidden = compareDatasets().reduce(
    (count, dataset) => count + (dataset.fit?.irfLimited?.filter(Boolean).length || 0),
    0,
  );
  return hidden ? `${hidden} IRF-limited component${hidden === 1 ? "" : "s"} omitted` : "";
}

function updateComparisonComponentUi() {
  const heading = document.getElementById("compare-component-heading");
  const copy = document.getElementById("compare-component-copy");
  if (heading) heading.textContent = `${state.compare.componentMode} Comparison`;
  if (copy) copy.textContent = comparisonComponentCopy();
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
    visibleComponentSpectra(dataset, state.fitting.spectrumMode),
    { normalize: state.fitting.normalize, xBreaks: dataset.analysis.wavelengthBreaks, features: featureMonitorFor(dataset, state.fitting.spectrumMode).candidates },
  );
  paintComponentSpectra(document.getElementById("modal-eas"), visibleComponentSpectra(dataset, "EAS"), { xBreaks: dataset.analysis.wavelengthBreaks, features: featureMonitorFor(dataset, "EAS").candidates });
  paintComponentSpectra(document.getElementById("modal-das"), visibleComponentSpectra(dataset, "DAS"), { xBreaks: dataset.analysis.wavelengthBreaks, features: featureMonitorFor(dataset, "DAS").candidates });
  paintFeatureTimeMap(document.getElementById("feature-time"), buildFeatureTimeMap(dataset, featureMonitorFor(dataset)));
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
      if (dataset.fit?.irfLimited?.[componentIndex]) return;
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
  drawFeatureAnnotations(canvas, spectra, options.features ?? [], options.normalize);
}

function drawFeatureAnnotations(canvas, spectra, features, normalizeMode) {
  const geometry = plotGeometry.get(canvas);
  if (!geometry || !features.length) return;
  const { ctx } = setupCanvas(canvas);
  const visibleComponents = new Set(spectra.map((spectrum, index) => spectrum.componentIndex ?? index));
  const retained = features.filter((feature) => visibleComponents.has(feature.componentIndex)).slice(0, 10);
  ctx.save();
  ctx.beginPath();
  ctx.rect(geometry.plot.left, geometry.plot.top, geometry.plot.right - geometry.plot.left, geometry.plot.bottom - geometry.plot.top);
  ctx.clip();
  retained.forEach((feature, labelIndex) => {
    const x0 = scale(feature.wavelengthMin, geometry.xExtent, [geometry.plot.left, geometry.plot.right]);
    const x1 = scale(feature.wavelengthMax, geometry.xExtent, [geometry.plot.left, geometry.plot.right]);
    if (x1 < geometry.plot.left || x0 > geometry.plot.right) return;
    const color = feature.sign === "positive" ? "#b96332" : "#7552a6";
    ctx.fillStyle = feature.sign === "positive" ? "rgba(185, 99, 50, 0.055)" : "rgba(117, 82, 166, 0.055)";
    ctx.fillRect(Math.max(x0, geometry.plot.left), geometry.plot.top, Math.max(2, Math.min(x1, geometry.plot.right) - Math.max(x0, geometry.plot.left)), geometry.plot.bottom - geometry.plot.top);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(Math.max(x0, geometry.plot.left), geometry.plot.top, Math.max(2, Math.min(x1, geometry.plot.right) - Math.max(x0, geometry.plot.left)), geometry.plot.bottom - geometry.plot.top);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    const spectrum = spectra.find((item, index) => (item.componentIndex ?? index) === feature.componentIndex);
    if (!spectrum) return;
    const normalized = normalizePoints(spectrum.x.map((x, index) => ({ x, y: spectrum.y[index] })), normalizeMode);
    const nearest = normalized[nearestIndex(normalized.map((point) => point.x), feature.wavelengthCenter)];
    const anchorX = scale(feature.wavelengthCenter, geometry.xExtent, [geometry.plot.left, geometry.plot.right]);
    const anchorY = Number.isFinite(nearest?.y) ? scale(nearest.y, geometry.yExtent, [geometry.plot.bottom, geometry.plot.top]) : geometry.plot.top + 18;
    const label = `${feature.featureCode} ${shortFeatureType(feature.candidateType)}`;
    ctx.font = "700 10px system-ui, sans-serif";
    const labelWidth = Math.min(78, Math.max(45, ctx.measureText(label).width + 10));
    const labelX = clamp(anchorX - labelWidth / 2, geometry.plot.left + 2, geometry.plot.right - labelWidth - 2);
    const verticalShift = (labelIndex % 3) * 18;
    const labelY = clamp(anchorY - 22 - verticalShift, geometry.plot.top + 3, geometry.plot.bottom - 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.fillRect(labelX, labelY, labelWidth, 16);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(labelX, labelY, labelWidth, 16);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, labelX + labelWidth / 2, labelY + 8, labelWidth - 6);
  });
  ctx.restore();
}

function paintFeatureTimeMap(canvas, compressed) {
  if (!canvas) return;
  if (compressed?.status !== "live" || !compressed.features.length) {
    drawEmptyCanvas(canvas, compressed?.limitations?.[0] ?? uiText("No live feature regions are available."));
    return;
  }
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);
  const plot = {
    left: Math.max(142, Math.round(width * 0.18)),
    right: Math.max(230, Math.round(width * 0.975)),
    top: 14,
    bottom: height - 50,
  };
  const timeExtent = [compressed.timeAxis[0], compressed.timeAxis.at(-1)];
  const timeTransform = makeTimeTransform(timeExtent);
  const xCenters = compressed.timeAxis.map((time) => scale(timeTransform.toFraction(time), [0, 1], [plot.left, plot.right]));
  const xBounds = cellBounds(xCenters, plot.left, plot.right);
  const rowHeight = (plot.bottom - plot.top) / compressed.features.length;
  const finite = compressed.matrix.flat().filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const limit = finite[Math.floor(finite.length * 0.985)] || 1;
  compressed.features.forEach((feature, rowIndex) => {
    const y0 = plot.top + rowIndex * rowHeight;
    const y1 = plot.top + (rowIndex + 1) * rowHeight;
    feature.trace.forEach((value, timeIndex) => {
      ctx.fillStyle = Number.isFinite(value) ? diverging(value / limit) : "#d9e0e2";
      ctx.fillRect(xBounds[timeIndex], y0, Math.max(1, xBounds[timeIndex + 1] - xBounds[timeIndex] + 0.5), Math.max(1, y1 - y0));
    });
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath();
    ctx.moveTo(plot.left, y1);
    ctx.lineTo(plot.right, y1);
    ctx.stroke();
    ctx.fillStyle = feature.candidateType === "ESA candidate" ? "#9b4d25" : "#654391";
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`${feature.featureCode} ${shortFeatureType(feature.candidateType)}`, plot.left - 9, (y0 + y1) / 2 - 6);
    ctx.fillStyle = "#718084";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(`${formatWavelength(feature.wavelengthMin)}–${formatWavelength(feature.wavelengthMax)} nm`, plot.left - 9, (y0 + y1) / 2 + 7);
  });
  ctx.strokeStyle = "#bfcacc";
  ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.fillStyle = "#687579";
  ctx.font = "12px system-ui, sans-serif";
  makeTimeTickSet(timeExtent[0], timeExtent[1]).major.forEach((tick) => {
    const x = scale(timeTransform.toFraction(tick), [0, 1], [plot.left, plot.right]);
    ctx.beginPath();
    ctx.moveTo(x, plot.bottom);
    ctx.lineTo(x, plot.bottom + 6);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`${Math.round(tick)}`, x, plot.bottom + 9);
  });
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.fillText(uiText("Time (ps)"), (plot.left + plot.right) / 2, plot.bottom + 38);
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
    paintComponentSpectra(canvas, visibleComponentSpectra(dataset, state.fitting.spectrumMode), {
      normalize: state.fitting.normalize,
      xBreaks: dataset.analysis.wavelengthBreaks,
      features: featureMonitorFor(dataset, state.fitting.spectrumMode).candidates,
    });
  } else if (state.expandedPlot === "modal-eas") {
    paintComponentSpectra(canvas, visibleComponentSpectra(dataset, "EAS"), { xBreaks: dataset.analysis.wavelengthBreaks, features: featureMonitorFor(dataset, "EAS").candidates });
  } else if (state.expandedPlot === "modal-das") {
    paintComponentSpectra(canvas, visibleComponentSpectra(dataset, "DAS"), { xBreaks: dataset.analysis.wavelengthBreaks, features: featureMonitorFor(dataset, "DAS").candidates });
  } else if (state.expandedPlot === "feature-time") {
    paintFeatureTimeMap(canvas, buildFeatureTimeMap(dataset, featureMonitorFor(dataset)));
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

  const left = Math.max(72, Math.round(width * 0.076));
  const right = Math.max(left + 60, Math.round(width * 0.978));
  const top = Math.max(12, Math.round(height * 0.024));
  const plot = {
    left,
    right,
    top,
    bottom: height - Math.max(50, Math.round(height * 0.088)),
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
  const left = Math.max(64, Math.round(width * 0.072));
  const right = Math.max(left + 80, Math.round(width * 0.976));
  const top = Math.max(12, Math.round(height * 0.028));
  const bottom = Math.max(top + 80, Math.round(height * 0.906));
  return { left, right, top, bottom };
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

function reorderDataset(datasetId, { targetFolderId, targetDatasetId, placement }) {
  const activeId = activeDataset()?.id ?? null;
  const result = moveDataset(state.datasets, state.folders, {
    datasetId,
    targetFolderId,
    targetDatasetId,
    placement,
  }, activeId);
  if (!result.changed) {
    render();
    return;
  }
  state.activeIndex = result.activeIndex;
  const targetFolder = state.folders.find((f) => f.id === targetFolderId);
  if (targetFolder) targetFolder.collapsed = false;
  markDirty();
  render();
}

function moveDatasetToFolder(datasetId, folderId) {
  reorderDataset(datasetId, { targetFolderId: folderId, targetDatasetId: null, placement: "end" });
}

function saveDatasetDetails() {
  persistDatasetDetails({ close: true, notify: true });
}

function persistDatasetDetails({ close = true, notify = true } = {}) {
  const dataset = state.datasets.find((item) => item.id === state.pendingDatasetId);
  const displayName = document.getElementById("dataset-display-name")?.value.trim();
  if (!dataset || !displayName) throw new Error("Dataset display name is required.");
  dataset.projectLabel = displayName;
  dataset.sampleNote = document.getElementById("dataset-sample-note")?.value.trim() ?? "";
  const metadata = normalizeDatasetEvidence(dataset.evidenceMetadata, "fsta");
  const techniqueId = document.getElementById("dataset-technique")?.value || metadata.technique.id;
  metadata.technique = { id: techniqueId, label: getTechnique(techniqueId).label };
  metadata.measurementRole = document.getElementById("dataset-measurement-role")?.value || "unknown";
  metadata.sampleId = document.getElementById("dataset-sample-id")?.value.trim() ?? "";
  metadata.preparationId = document.getElementById("dataset-preparation-id")?.value.trim() ?? "";
  metadata.conditions = Object.fromEntries(CONDITION_FIELDS.map((field) => {
    const value = document.getElementById(`dataset-condition-${field}`)?.value.trim();
    return [field, value || null];
  }));
  dataset.evidenceMetadata = metadata;
  const speciesLabels = String(document.getElementById("dataset-species-states")?.value ?? "")
    .split(/[,;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  state.evidenceGraph = updateDatasetEvidenceEntities(state.evidenceGraph, dataset, state.datasets, {
    speciesLabels,
    createdAt: new Date().toISOString(),
  });
  if (state.compare.styles[dataset.id]) state.compare.styles[dataset.id].label = displayName;
  markDirty();
  if (close) {
    state.pendingDatasetId = null;
    state.modal = null;
  }
  if (notify) state.notice = { kind: "success", title: "Dataset details saved", message: "Scientific metadata, conditions, hypotheses, notes, and graph records are included in the project." };
  if (close || notify) render();
}

function saveEvidenceConnection() {
  const existing = state.evidenceGraph.relationships.find((item) => item.id === state.pendingConnectionId);
  const dataset = state.datasets.find((item) => item.id === state.pendingDatasetId);
  if (!dataset) throw new Error("The connection source dataset is unavailable.");
  const fromId = existing?.fromId ?? dataset.id;
  const targetIds = existing ? [existing.toId] : state.pendingConnectionTargetIds.length
    ? state.pendingConnectionTargetIds
    : [document.getElementById("connection-target")?.value].filter(Boolean);
  if (!targetIds.length) throw new Error("Choose evidence to connect.");
  const now = new Date().toISOString();
  targetIds.forEach((toId) => {
    state.evidenceGraph = upsertEvidenceConnection(state.evidenceGraph, {
      id: existing?.id,
      fromId,
      toId,
      type: document.getElementById("connection-type")?.value,
      assertionStatus: document.getElementById("connection-status")?.value,
      rationale: document.getElementById("connection-rationale")?.value,
      author: document.getElementById("connection-author")?.value,
      createdAt: existing?.createdAt,
    }, state.datasets, { createdAt: now, evidenceAssets: state.evidenceAssets });
  });
  state.pendingConnectionId = null;
  state.pendingConnectionTargetIds = [];
  state.evidenceSelectionIds = [];
  state.modal = "edit-dataset";
  markDirty();
  state.notice = { kind: "success", title: "Evidence connection saved", message: "The authored relationship and rationale are now part of the project evidence graph." };
  render();
}

function saveEvidenceAsset() {
  const current = state.pendingEvidenceAssetDraft
    ?? state.evidenceAssets.find((item) => item.id === state.pendingEvidenceAssetId);
  if (!current) throw new Error("The external evidence item is unavailable.");
  const label = document.getElementById("evidence-asset-label")?.value.trim();
  if (!label) throw new Error("Evidence label is required.");
  const updated = normalizeEvidenceAsset({
    ...current,
    label,
    kind: document.getElementById("evidence-asset-kind")?.value,
    techniqueId: document.getElementById("evidence-asset-technique")?.value,
    measurementRole: document.getElementById("evidence-asset-role")?.value,
    note: document.getElementById("evidence-asset-note")?.value.trim() ?? "",
    citation: {
      ...current.citation,
      title: document.getElementById("evidence-citation-title")?.value.trim() ?? "",
      authors: document.getElementById("evidence-citation-authors")?.value.trim() ?? "",
      year: document.getElementById("evidence-citation-year")?.value.trim() ?? "",
      doi: document.getElementById("evidence-citation-doi")?.value.trim() ?? "",
      url: document.getElementById("evidence-citation-url")?.value.trim() ?? "",
      figure: document.getElementById("evidence-citation-figure")?.value.trim() ?? "",
      rightsStatus: document.getElementById("evidence-asset-rights")?.value,
    },
  });
  const index = state.evidenceAssets.findIndex((item) => item.id === updated.id);
  if (index >= 0) state.evidenceAssets[index] = updated;
  else state.evidenceAssets.push(updated);
  state.evidenceGraph = migrateEvidenceGraph(state.evidenceGraph, state.datasets, {
    createdAt: new Date().toISOString(),
    evidenceAssets: state.evidenceAssets,
  });
  state.evidenceSelectionIds = [...new Set([...state.evidenceSelectionIds, updated.id])];
  state.pendingEvidenceAssetDraft = null;
  state.pendingEvidenceAssetId = null;
  state.modal = "edit-dataset";
  markDirty();
  state.notice = { kind: "success", title: "Evidence saved", message: "The external evidence record is selected and ready to connect." };
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
  state.evidenceGraph = migrateEvidenceGraph(state.evidenceGraph, state.datasets);
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
  state.evidenceGraph = removeDatasetFromEvidenceGraph(state.evidenceGraph, datasetId, state.datasets);
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

function visibleComponentSpectra(dataset, mode) {
  if (!dataset?.fit) return [];
  const spectra = mode === "EAS" ? dataset.fit.easSpectra : dataset.fit.dasSpectra;
  return (spectra ?? [])
    .map((spectrum, index) => ({ ...spectrum, componentIndex: index }))
    .filter((spectrum) => !dataset.fit.irfLimited?.[spectrum.componentIndex]);
}

function expandedPlotMeta(key) {
  const mode = state.fitting.spectrumMode;
  const labels = {
    heatmap: ["Analysis Heatmap", ""],
    spectrum: ["Spectrum", `${formatCoordinate(activeDataset()?.analysis.timeAxis[state.selectedTimeIndex])} ps`],
    kinetics: ["Kinetics", `${formatWavelength(activeDataset()?.analysis.spectralAxis[state.selectedWavelengthIndex])} nm`],
    "main-components": [`${mode} Component Spectra`, irfLimitedCount(activeDataset()) ? "IRF-limited components excluded" : ""],
    "modal-eas": ["EAS Preview", irfLimitedCount(activeDataset()) ? "IRF-limited components excluded" : ""],
    "modal-das": ["DAS", irfLimitedCount(activeDataset()) ? "IRF-limited components excluded" : ""],
    "fit-residual": ["Fit Residual Map", ""],
    "feature-time": ["Feature × Time Map", "Lossy regional compression; source fsTA heatmap remains authoritative"],
    "compare-kinetics": ["Kinetics Comparison", ""],
    "compare-spectrum": ["Spectra Comparison", ""],
    "compare-components": [`${state.compare.componentMode} Comparison`, compareDatasets().some((dataset) => irfLimitedCount(dataset)) ? "IRF-limited components excluded" : ""],
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
  resizeTimer = window.setTimeout(() => {
    // Clear all cached plot geometries so canvases re-measure on next paint
    document.querySelectorAll("canvas[data-plot-key]").forEach((canvas) => {
      plotGeometry.delete(canvas);
    });
    const expanded = document.getElementById("expanded-canvas");
    if (expanded) plotGeometry.delete(expanded);
    paintCanvases();
  }, 100);
});

render();

// Load saved Origin installation on startup
(async () => {
  if (!isTauriRuntime()) return;
  try {
    const installation = await invoke("get_origin_installation");
    if (installation) {
      state.origin.installation = installation;
      state.origin.outputFormat = installation.defaultProjectFormat;
      render();
    }
  } catch (_) {
    // No saved installation — that's fine
  }
})();
