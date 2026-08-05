#!/usr/bin/env python3
"""SpecFlowLab archive converter and OriginPro importer.

The archive/parser core uses only the Python standard library. The OriginPro
dependency is imported lazily only for ``--origin``, so the same file can be
tested on macOS/Linux and run with Origin's embedded Python on Windows.
"""

from __future__ import annotations

import argparse
import array
import csv
import hashlib
import json
import math
import re
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence


PROJECT_ARCHIVE_SCHEMA = "specflowlab.project_archive.v1"
ORIGIN_BUNDLE_SCHEMA = "specflowlab.origin_bundle.v1"

MAX_COMPRESSED_BYTES = 512 * 1024 * 1024
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10_000
MAX_MATRIX_VALUES = 100_000_000


class BridgeError(RuntimeError):
    """Raised for a malformed archive or an unsupported bridge operation."""


@dataclass
class BinaryMatrix:
    rows: int
    cols: int
    values: array.array

    def __post_init__(self) -> None:
        if self.rows < 0 or self.cols < 0:
            raise BridgeError("Matrix dimensions cannot be negative.")
        if self.rows * self.cols != len(self.values):
            raise BridgeError(
                f"Matrix descriptor expects {self.rows * self.cols} values, "
                f"but {len(self.values)} were decoded."
            )

    def at(self, row: int, col: int) -> float:
        return self.values[row * self.cols + col]

    def row(self, row: int) -> list[float]:
        start = row * self.cols
        return list(self.values[start:start + self.cols])

    def column(self, col: int) -> list[float]:
        return [self.values[row * self.cols + col] for row in range(self.rows)]

    def iter_rows(self) -> Iterable[Sequence[float]]:
        for row in range(self.rows):
            start = row * self.cols
            yield self.values[start:start + self.cols]


@dataclass
class SpectrumSet:
    kind: str
    labels: list[str]
    lifetimes: list[float]
    matrix: BinaryMatrix


@dataclass
class FitData:
    metadata: dict[str, Any] = field(default_factory=dict)
    fitted_matrix: BinaryMatrix | None = None
    residual_matrix: BinaryMatrix | None = None
    das: SpectrumSet | None = None
    eas: SpectrumSet | None = None


@dataclass
class DatasetData:
    dataset_id: str
    folder_id: str
    folder_name: str
    label: str
    sample_note: str
    source_file_name: str
    source_format: str
    raw_source_text: str
    raw_source_bytes: bytes
    units: dict[str, str]
    selected_time_index: int
    selected_wavelength_index: int
    time_axis: list[float]
    spectral_axis: list[float]
    matrix: BinaryMatrix
    analysis_metadata: dict[str, Any] = field(default_factory=dict)
    fit: FitData | None = None

    @property
    def selected_time(self) -> float:
        return self.time_axis[self.selected_time_index]

    @property
    def selected_wavelength(self) -> float:
        return self.spectral_axis[self.selected_wavelength_index]

    def selected_spectrum(self) -> list[float]:
        return self.matrix.column(self.selected_time_index)

    def selected_kinetics(self) -> list[float]:
        return self.matrix.row(self.selected_wavelength_index)


@dataclass
class ProjectData:
    archive_path: Path
    archive_sha256: str
    archive_schema: str
    project_schema: str
    app_version: str
    saved_at: str
    folders: list[dict[str, Any]]
    datasets: list[DatasetData]

    def summary(self) -> dict[str, Any]:
        return {
            "archive": str(self.archive_path),
            "sha256": self.archive_sha256,
            "archiveSchema": self.archive_schema,
            "projectSchema": self.project_schema,
            "appVersion": self.app_version,
            "savedAt": self.saved_at,
            "datasetCount": len(self.datasets),
            "datasets": [
                {
                    "id": dataset.dataset_id,
                    "folder": dataset.folder_name,
                    "label": dataset.label,
                    "sourceFile": dataset.source_file_name,
                    "sourceFormat": dataset.source_format,
                    "shape": {
                        "spectralPoints": len(dataset.spectral_axis),
                        "timePoints": len(dataset.time_axis),
                    },
                    "selected": {
                        "time": dataset.selected_time,
                        "wavelength": dataset.selected_wavelength,
                    },
                    "hasFit": dataset.fit is not None,
                    "hasPlotReadyFit": bool(
                        dataset.fit
                        and (
                            dataset.fit.fitted_matrix
                            or dataset.fit.residual_matrix
                            or dataset.fit.das
                            or dataset.fit.eas
                        )
                    ),
                }
                for dataset in self.datasets
            ],
        }


def load_project(path_value: str | Path) -> ProjectData:
    """Read and validate a ``.sflproj`` or ``.sflorigin`` archive."""

    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise BridgeError(f"Input archive does not exist: {path}")
    if path.stat().st_size > MAX_COMPRESSED_BYTES:
        raise BridgeError("The archive exceeds the 512 MB compressed-size limit.")

    archive_sha256 = _sha256_file(path)
    try:
        with zipfile.ZipFile(path, "r") as archive:
            _validate_archive(archive)
            manifest = _read_json_entry(archive, "manifest.json")
            if manifest.get("bundleSchema") == ORIGIN_BUNDLE_SCHEMA:
                return _read_origin_bundle(path, archive_sha256, archive, manifest)
            if manifest.get("archiveSchema") == PROJECT_ARCHIVE_SCHEMA:
                return _read_project_archive(path, archive_sha256, archive, manifest)
            schema = manifest.get("bundleSchema") or manifest.get("archiveSchema") or "missing"
            raise BridgeError(f"Unsupported SpecFlowLab archive schema: {schema}")
    except zipfile.BadZipFile as error:
        raise BridgeError(f"The input is not a valid ZIP-based SpecFlowLab archive: {error}") from error


def _read_project_archive(
    path: Path,
    archive_sha256: str,
    archive: zipfile.ZipFile,
    manifest: dict[str, Any],
) -> ProjectData:
    state = manifest.get("state") if isinstance(manifest.get("state"), dict) else {}
    folders = _folder_records(manifest.get("folders"))
    folder_names = {
        str(folder.get("id", "")): str(folder.get("name") or "Unfiled")
        for folder in folders
    }
    datasets = []
    for index, descriptor in enumerate(_dataset_descriptors(manifest)):
        analysis = _mapping(descriptor.get("analysis"), f"dataset {index + 1} analysis")
        time_axis = _read_axis(archive, analysis.get("timeAxis"), f"dataset {index + 1} time axis")
        spectral_axis = _read_axis(
            archive,
            analysis.get("spectralAxis"),
            f"dataset {index + 1} spectral axis",
        )
        matrix = _read_matrix(archive, analysis.get("matrix"), f"dataset {index + 1} treated matrix")
        _validate_dataset_shape(time_axis, spectral_axis, matrix, index)
        source = _mapping(descriptor.get("source"), f"dataset {index + 1} source")
        raw_source_text = _read_text_entry(archive, _entry_name(source, "source"))
        source_format, raw_source_bytes = _read_preserved_source(
            archive,
            source,
            raw_source_text,
            f"dataset {index + 1} source",
        )
        fit_descriptor = descriptor.get("fit")
        fit = FitData(metadata=fit_descriptor) if isinstance(fit_descriptor, dict) else None
        folder_id = str(descriptor.get("folderId") or "")
        datasets.append(
            DatasetData(
                dataset_id=str(descriptor.get("id") or f"dataset-{index + 1}"),
                folder_id=folder_id,
                folder_name=folder_names.get(folder_id, "Unfiled"),
                label=str(descriptor.get("projectLabel") or f"Dataset {index + 1}"),
                sample_note=str(descriptor.get("sampleNote") or ""),
                source_file_name=str(source.get("fileName") or f"dataset-{index + 1}.csv"),
                source_format=source_format,
                raw_source_text=raw_source_text,
                raw_source_bytes=raw_source_bytes,
                units={"time": "ps", "spectral": "nm", "signal": "signal"},
                selected_time_index=_clamp_index(state.get("selectedTimeIndex"), len(time_axis)),
                selected_wavelength_index=_clamp_index(
                    state.get("selectedWavelengthIndex"),
                    len(spectral_axis),
                ),
                time_axis=time_axis,
                spectral_axis=spectral_axis,
                matrix=matrix,
                analysis_metadata=_mapping_or_empty(analysis.get("metadata")),
                fit=fit,
            )
        )

    return ProjectData(
        archive_path=path,
        archive_sha256=archive_sha256,
        archive_schema=PROJECT_ARCHIVE_SCHEMA,
        project_schema=str(manifest.get("projectSchema") or PROJECT_ARCHIVE_SCHEMA),
        app_version=str(manifest.get("appVersion") or ""),
        saved_at=str(manifest.get("savedAt") or ""),
        folders=folders,
        datasets=datasets,
    )


def _read_origin_bundle(
    path: Path,
    archive_sha256: str,
    archive: zipfile.ZipFile,
    manifest: dict[str, Any],
) -> ProjectData:
    folders = _folder_records(manifest.get("folders"))
    folder_names = {
        str(folder.get("id", "")): str(folder.get("name") or "Unfiled")
        for folder in folders
    }
    datasets = []
    for index, descriptor in enumerate(_dataset_descriptors(manifest)):
        analysis = _mapping(descriptor.get("analysis"), f"dataset {index + 1} analysis")
        time_axis = _read_axis(archive, analysis.get("timeAxis"), f"dataset {index + 1} time axis")
        spectral_axis = _read_axis(
            archive,
            analysis.get("spectralAxis"),
            f"dataset {index + 1} spectral axis",
        )
        matrix = _read_matrix(archive, analysis.get("matrix"), f"dataset {index + 1} treated matrix")
        _validate_dataset_shape(time_axis, spectral_axis, matrix, index)
        source = _mapping(descriptor.get("source"), f"dataset {index + 1} source")
        selection = _mapping_or_empty(descriptor.get("selection"))
        units = {
            "time": str(_mapping_or_empty(descriptor.get("units")).get("time") or "ps"),
            "spectral": str(_mapping_or_empty(descriptor.get("units")).get("spectral") or "nm"),
            "signal": str(_mapping_or_empty(descriptor.get("units")).get("signal") or "signal"),
        }
        fit = _read_plot_ready_fit(archive, descriptor.get("fit"), spectral_axis, matrix)
        folder_id = str(descriptor.get("folderId") or "")
        raw_source_text = _read_text_entry(archive, _entry_name(source, "source"))
        source_format, raw_source_bytes = _read_preserved_source(
            archive,
            source,
            raw_source_text,
            f"dataset {index + 1} source",
        )
        datasets.append(
            DatasetData(
                dataset_id=str(descriptor.get("id") or f"dataset-{index + 1}"),
                folder_id=folder_id,
                folder_name=folder_names.get(folder_id, "Unfiled"),
                label=str(descriptor.get("projectLabel") or f"Dataset {index + 1}"),
                sample_note=str(descriptor.get("sampleNote") or ""),
                source_file_name=str(source.get("fileName") or f"dataset-{index + 1}.csv"),
                source_format=source_format,
                raw_source_text=raw_source_text,
                raw_source_bytes=raw_source_bytes,
                units=units,
                selected_time_index=_clamp_index(selection.get("timeIndex"), len(time_axis)),
                selected_wavelength_index=_clamp_index(
                    selection.get("wavelengthIndex"),
                    len(spectral_axis),
                ),
                time_axis=time_axis,
                spectral_axis=spectral_axis,
                matrix=matrix,
                analysis_metadata=_mapping_or_empty(analysis.get("metadata")),
                fit=fit,
            )
        )

    return ProjectData(
        archive_path=path,
        archive_sha256=archive_sha256,
        archive_schema=ORIGIN_BUNDLE_SCHEMA,
        project_schema=str(manifest.get("sourceProjectSchema") or ""),
        app_version=str(manifest.get("appVersion") or ""),
        saved_at=str(manifest.get("sourceSavedAt") or manifest.get("createdAt") or ""),
        folders=folders,
        datasets=datasets,
    )


def _read_plot_ready_fit(
    archive: zipfile.ZipFile,
    descriptor_value: Any,
    spectral_axis: list[float],
    treated_matrix: BinaryMatrix,
) -> FitData | None:
    if not isinstance(descriptor_value, dict):
        return None
    metadata = _mapping_or_empty(descriptor_value.get("metadata"))
    fitted = _read_optional_matrix(archive, descriptor_value.get("fittedMatrix"), "fitted matrix")
    residual = _read_optional_matrix(archive, descriptor_value.get("residualMatrix"), "residual matrix")
    for label, matrix in (("fitted", fitted), ("residual", residual)):
        if matrix and (matrix.rows != treated_matrix.rows or matrix.cols != treated_matrix.cols):
            raise BridgeError(f"The {label} matrix shape does not match the treated matrix.")
    return FitData(
        metadata=metadata,
        fitted_matrix=fitted,
        residual_matrix=residual,
        das=_read_spectrum_set(archive, descriptor_value.get("das"), spectral_axis, "DAS"),
        eas=_read_spectrum_set(archive, descriptor_value.get("eas"), spectral_axis, "EAS"),
    )


def _read_spectrum_set(
    archive: zipfile.ZipFile,
    descriptor_value: Any,
    spectral_axis: list[float],
    kind: str,
) -> SpectrumSet | None:
    if not isinstance(descriptor_value, dict):
        return None
    matrix = _read_matrix(archive, descriptor_value, f"{kind} spectra")
    if matrix.cols != len(spectral_axis):
        raise BridgeError(f"The {kind} spectra do not match the treated spectral axis.")
    labels_value = descriptor_value.get("labels")
    labels = [str(value) for value in labels_value] if isinstance(labels_value, list) else []
    if len(labels) != matrix.rows:
        labels = [f"{kind} {index + 1}" for index in range(matrix.rows)]
    lifetimes_value = descriptor_value.get("lifetimes")
    lifetimes = [_json_number(value) for value in lifetimes_value] if isinstance(lifetimes_value, list) else []
    if len(lifetimes) != matrix.rows:
        lifetimes = [math.nan] * matrix.rows
    return SpectrumSet(kind=kind, labels=labels, lifetimes=lifetimes, matrix=matrix)


def extract_project(
    project: ProjectData,
    output_directory: str | Path,
    *,
    overwrite: bool = False,
) -> list[Path]:
    """Write interoperable CSV/JSON files without requiring OriginPro."""

    root = Path(output_directory).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    used_names: set[str] = set()
    converted_datasets = []

    for index, dataset in enumerate(project.datasets):
        base_name = _unique_name(
            _safe_filename(f"{index + 1:04d}-{dataset.folder_name}-{dataset.label}"),
            used_names,
        )
        dataset_root = root / base_name
        dataset_root.mkdir(parents=True, exist_ok=True)

        source_path = dataset_root / ("source.ufs" if dataset.source_format == "ufs" else "source.csv")
        _write_bytes(source_path, dataset.raw_source_bytes, overwrite)
        written.append(source_path)
        if dataset.source_format == "ufs":
            compatibility_path = dataset_root / "source.csv"
            _write_bytes(
                compatibility_path,
                dataset.raw_source_text.encode("utf-8"),
                overwrite,
            )
            written.append(compatibility_path)

        metadata = _dataset_metadata(project, dataset)
        metadata_path = dataset_root / "metadata.json"
        _write_json(metadata_path, metadata, overwrite)
        written.append(metadata_path)

        treated_path = dataset_root / "treated-virtual-matrix.csv"
        _write_virtual_matrix_csv(treated_path, dataset, dataset.matrix, overwrite)
        written.append(treated_path)

        spectrum_path = dataset_root / "selected-spectrum.csv"
        _write_xy_csv(
            spectrum_path,
            f"Wavelength ({dataset.units['spectral']})",
            dataset.spectral_axis,
            f"Signal at {format_number(dataset.selected_time)} {dataset.units['time']}",
            dataset.selected_spectrum(),
            overwrite,
        )
        written.append(spectrum_path)

        kinetics_path = dataset_root / "selected-kinetics.csv"
        _write_xy_csv(
            kinetics_path,
            f"Time ({dataset.units['time']})",
            dataset.time_axis,
            f"Signal at {format_number(dataset.selected_wavelength)} {dataset.units['spectral']}",
            dataset.selected_kinetics(),
            overwrite,
        )
        written.append(kinetics_path)

        if dataset.fit:
            for name, matrix in (
                ("fitted-virtual-matrix.csv", dataset.fit.fitted_matrix),
                ("residual-virtual-matrix.csv", dataset.fit.residual_matrix),
            ):
                if matrix:
                    path = dataset_root / name
                    _write_virtual_matrix_csv(path, dataset, matrix, overwrite)
                    written.append(path)
            for name, spectra in (("das.csv", dataset.fit.das), ("eas.csv", dataset.fit.eas)):
                if spectra:
                    path = dataset_root / name
                    _write_spectra_csv(path, dataset.spectral_axis, dataset.units["spectral"], spectra, overwrite)
                    written.append(path)

        converted_datasets.append({
            "id": dataset.dataset_id,
            "folder": dataset.folder_name,
            "label": dataset.label,
            "directory": base_name,
        })

    conversion_manifest = {
        "schema": "specflowlab.origin_csv_export.v1",
        "sourceArchive": str(project.archive_path),
        "sourceArchiveSha256": project.archive_sha256,
        "sourceArchiveSchema": project.archive_schema,
        "datasets": converted_datasets,
        "nanPolicy": "NaN values are preserved as the literal token NaN.",
        "virtualMatrixLayout": (
            "Time coordinates are stored across the first row, wavelength coordinates "
            "down the first column, and signal values in the intersecting cells."
        ),
    }
    manifest_path = root / "conversion-manifest.json"
    _write_json(manifest_path, conversion_manifest, overwrite)
    written.append(manifest_path)
    return written


def import_project_into_origin(
    project: ProjectData,
    *,
    create_plots: bool = True,
    save_path: str | Path | None = None,
) -> dict[str, Any]:
    """Import the project through the official ``originpro`` Python package."""

    try:
        import originpro as op  # type: ignore
    except ImportError as error:
        raise BridgeError(
            "The originpro package is unavailable. Run this action from Origin's "
            "embedded Python, or install originpro in external Python on Windows."
        ) from error

    if getattr(op, "oext", False):
        op.set_show(True)

    warnings: list[str] = []
    workbook_count = 0
    graph_count = 0
    for dataset in project.datasets:
        metadata_sheet = op.new_sheet("w", lname=_origin_long_name(dataset.label))
        if metadata_sheet is None:
            raise BridgeError(f"Origin could not create a workbook for {dataset.label}.")
        workbook_count += 1
        metadata_sheet.name = "Metadata"
        _fill_metadata_sheet(metadata_sheet, project, dataset)
        book = metadata_sheet.get_book()

        treated_sheet = book.add_sheet("TreatedVM")
        _fill_virtual_matrix_sheet(treated_sheet, dataset, dataset.matrix, "Treated signal")

        selected_sheet = book.add_sheet("Selected")
        trace_time_indices, trace_wavelength_indices = _fill_selected_sheet(
            selected_sheet, dataset
        )
        spectrum_y_columns = list(range(1, 1 + len(trace_time_indices)))
        kinetics_x_column = 1 + len(trace_time_indices)
        kinetics_y_columns = list(
            range(
                kinetics_x_column + 1,
                kinetics_x_column + 1 + len(trace_wavelength_indices),
            )
        )

        if create_plots:
            if _try_origin_plot(
                warnings,
                dataset.label,
                "treated heatmap",
                lambda: _plot_virtual_heatmap(op, treated_sheet, dataset, "Treated signal"),
            ):
                graph_count += 1
            if _try_origin_plot(
                warnings,
                dataset.label,
                "representative spectra",
                lambda: _plot_multi_line(
                    op,
                    selected_sheet,
                    0,
                    spectrum_y_columns,
                    f"{dataset.label} - representative spectra",
                ),
            ):
                graph_count += 1
            if _try_origin_plot(
                warnings,
                dataset.label,
                "representative kinetics",
                lambda: _plot_multi_line(
                    op,
                    selected_sheet,
                    kinetics_x_column,
                    kinetics_y_columns,
                    f"{dataset.label} - representative kinetics",
                ),
            ):
                graph_count += 1

        if dataset.fit:
            fit_sheet = book.add_sheet("FitSummary")
            _fill_fit_summary_sheet(fit_sheet, dataset.fit)
            for sheet_name, title, matrix in (
                ("FittedVM", "Fitted signal", dataset.fit.fitted_matrix),
                ("ResidualVM", "Fit residual", dataset.fit.residual_matrix),
            ):
                if not matrix:
                    continue
                matrix_sheet = book.add_sheet(sheet_name)
                _fill_virtual_matrix_sheet(matrix_sheet, dataset, matrix, title)
                if create_plots and sheet_name == "ResidualVM":
                    if _try_origin_plot(
                        warnings,
                        dataset.label,
                        "residual heatmap",
                        lambda sheet=matrix_sheet: _plot_virtual_heatmap(
                            op,
                            sheet,
                            dataset,
                            "Fit residual",
                        ),
                    ):
                        graph_count += 1

            for sheet_name, spectra in (("DAS", dataset.fit.das), ("EAS", dataset.fit.eas)):
                if not spectra:
                    continue
                spectra_sheet = book.add_sheet(sheet_name)
                visible_component_count = _fill_spectra_sheet(
                    spectra_sheet,
                    dataset,
                    spectra,
                )
                if (
                    create_plots
                    and visible_component_count
                    and _try_origin_plot(
                        warnings,
                        dataset.label,
                        sheet_name,
                        lambda sheet=spectra_sheet,
                        item=spectra,
                        count=visible_component_count: _plot_spectra(
                            op,
                            sheet,
                            item,
                            f"{dataset.label} - {item.kind}",
                            count,
                        ),
                    )
                ):
                    graph_count += 1

    saved_to = None
    if save_path:
        destination = Path(save_path).expanduser().resolve()
        if destination.suffix.lower() not in {".opj", ".opju"}:
            destination = destination.with_suffix(".opju")
        destination.parent.mkdir(parents=True, exist_ok=True)
        saved = op.save(str(destination))
        if saved is False:
            raise BridgeError(f"Origin reported that it could not save {destination}.")
        if not destination.is_file() or destination.stat().st_size == 0:
            raise BridgeError(
                f"Origin returned from save without creating a non-empty project at {destination}."
            )
        saved_to = str(destination)

    return {
        "datasetCount": len(project.datasets),
        "workbookCount": workbook_count,
        "graphCount": graph_count,
        "createPlots": create_plots,
        "savedTo": saved_to,
        "warnings": warnings,
    }


def _fill_metadata_sheet(sheet: Any, project: ProjectData, dataset: DatasetData) -> None:
    metadata = _dataset_metadata(project, dataset)
    pairs = [
        ("Dataset ID", dataset.dataset_id),
        ("Folder", dataset.folder_name),
        ("Display name", dataset.label),
        ("Sample note", dataset.sample_note),
        ("Source file", dataset.source_file_name),
        ("Source format", dataset.source_format.upper()),
        ("Source file SHA-256", hashlib.sha256(dataset.raw_source_bytes).hexdigest()),
        ("Source archive", str(project.archive_path)),
        ("Source archive SHA-256", project.archive_sha256),
        ("Archive schema", project.archive_schema),
        ("Rows (wavelength)", str(dataset.matrix.rows)),
        ("Columns (time)", str(dataset.matrix.cols)),
        ("Selected time", f"{format_number(dataset.selected_time)} {dataset.units['time']}"),
        (
            "Selected wavelength",
            f"{format_number(dataset.selected_wavelength)} {dataset.units['spectral']}",
        ),
        ("Treatment metadata", json.dumps(metadata["analysisMetadata"], ensure_ascii=False)),
    ]
    sheet.cols = 2
    sheet.from_list(0, [key for key, _ in pairs], lname="Property", axis="N")
    sheet.from_list(1, [value for _, value in pairs], lname="Value", axis="N")
    sheet.set_str("tree.specflowlab.dataset_id", dataset.dataset_id)
    sheet.set_str("tree.specflowlab.archive_sha256", project.archive_sha256)
    sheet.set_str("tree.specflowlab.archive_path", str(project.archive_path))
    sheet.set_str("tree.specflowlab.archive_schema", project.archive_schema)


def _fill_virtual_matrix_sheet(
    sheet: Any,
    dataset: DatasetData,
    matrix: BinaryMatrix,
    signal_label: str,
) -> None:
    # WSheet.rows is read-only in originpro. from_list() grows the worksheet
    # automatically as each complete virtual-matrix column is written.
    sheet.cols = matrix.rows + 1
    sheet.from_list(
        0,
        [math.nan, *dataset.time_axis],
        lname=f"Time ({dataset.units['time']})",
        axis="N",
    )
    for row, wavelength_value in enumerate(dataset.spectral_axis):
        sheet.from_list(
            row + 1,
            [wavelength_value, *matrix.row(row)],
            lname=(
                f"{format_label_number(wavelength_value)} "
                f"{dataset.units['spectral']}"
            ),
            comments=signal_label,
            axis="N",
        )
    sheet.set_str(
        "tree.specflowlab.virtual_matrix_layout",
        "x_wavelength_across_y_time_down",
    )
    sheet.set_str("tree.specflowlab.nan_policy", "preserved")


def _fill_selected_sheet(
    sheet: Any, dataset: DatasetData
) -> tuple[list[int], list[int]]:
    time_indices = _representative_indices(
        len(dataset.time_axis), dataset.selected_time_index
    )
    wavelength_indices = _representative_indices(
        len(dataset.spectral_axis), dataset.selected_wavelength_index
    )
    sheet.cols = 2 + len(time_indices) + len(wavelength_indices)
    sheet.from_list(
        0,
        dataset.spectral_axis,
        lname="Wavelength",
        units=dataset.units["spectral"],
        axis="X",
    )
    for offset, time_index in enumerate(time_indices, start=1):
        selected = " (selected)" if time_index == dataset.selected_time_index else ""
        sheet.from_list(
            offset,
            dataset.matrix.column(time_index),
            lname=(
                f"Signal at {format_label_number(dataset.time_axis[time_index])} "
                f"{dataset.units['time']}{selected}"
            ),
            units=dataset.units["signal"],
            axis="Y",
        )
    kinetics_x_column = 1 + len(time_indices)
    sheet.from_list(
        kinetics_x_column,
        dataset.time_axis,
        lname="Time",
        units=dataset.units["time"],
        axis="X",
    )
    for offset, wavelength_index in enumerate(wavelength_indices, start=1):
        selected = (
            " (selected)"
            if wavelength_index == dataset.selected_wavelength_index
            else ""
        )
        sheet.from_list(
            kinetics_x_column + offset,
            dataset.matrix.row(wavelength_index),
            lname=(
                f"Signal at {format_label_number(dataset.spectral_axis[wavelength_index])} "
                f"{dataset.units['spectral']}{selected}"
            ),
            units=dataset.units["signal"],
            axis="Y",
        )
    sheet.set_str(
        "tree.specflowlab.trace_time_indices",
        json.dumps(time_indices, separators=(",", ":")),
    )
    sheet.set_str(
        "tree.specflowlab.trace_wavelength_indices",
        json.dumps(wavelength_indices, separators=(",", ":")),
    )
    return time_indices, wavelength_indices


def _representative_indices(
    length: int, selected_index: int, base_count: int = 5
) -> list[int]:
    if length <= 0:
        return []
    if length <= base_count:
        return list(range(length))
    selected_index = max(0, min(selected_index, length - 1))
    indices = {
        round(position * (length - 1) / (base_count - 1))
        for position in range(base_count)
    }
    indices.add(selected_index)
    return sorted(indices)


def _fill_fit_summary_sheet(sheet: Any, fit: FitData) -> None:
    pairs = []
    for key, value in fit.metadata.items():
        if isinstance(value, (dict, list)):
            rendered = json.dumps(value, ensure_ascii=False)
        else:
            rendered = "" if value is None else str(value)
        pairs.append((str(key), rendered))
    sheet.cols = 2
    sheet.from_list(0, [key for key, _ in pairs], lname="Fit property", axis="N")
    sheet.from_list(1, [value for _, value in pairs], lname="Value", axis="N")


def _fill_spectra_sheet(
    sheet: Any,
    dataset: DatasetData,
    spectra: SpectrumSet,
) -> int:
    visible_indices = _origin_component_indices(dataset.fit, spectra.matrix.rows)
    sheet.cols = len(visible_indices) + 1
    sheet.from_list(
        0,
        dataset.spectral_axis,
        lname="Wavelength",
        units=dataset.units["spectral"],
        axis="X",
    )
    irf_limited = fit_irf_limited(dataset.fit)
    for output_column, index in enumerate(visible_indices, start=1):
        label = spectra.labels[index]
        lifetime = spectra.lifetimes[index]
        status = " (IRF-limited)" if index < len(irf_limited) and irf_limited[index] else ""
        lifetime_text = (
            f", tau={format_label_number(lifetime)} {dataset.units['time']}"
            if math.isfinite(lifetime)
            else ""
        )
        sheet.from_list(
            output_column,
            spectra.matrix.row(index),
            lname=f"{label}{lifetime_text}{status}",
            units=dataset.units["signal"],
            axis="Y",
        )
    sheet.set_str(
        "tree.specflowlab.component_indices",
        json.dumps(visible_indices, separators=(",", ":")),
    )
    return len(visible_indices)


def _plot_virtual_heatmap(op: Any, sheet: Any, dataset: DatasetData, z_title: str) -> None:
    x_title = _labtalk_text(f"Wavelength ({dataset.units['spectral']})")
    y_title = _labtalk_text(f"Time ({dataset.units['time']})")
    command = (
        f"plotvm irng:={sheet.lt_range()} format:=xacross "
        "rowpos:=selrow1 colpos:=selcol1 "
        f'xtitle:="{x_title}" '
        f'ytitle:="{y_title}" '
        f'ztitle:="{_labtalk_text(z_title)}" '
        "type:=105 ogl:=<new template:=heatmap>;"
    )
    op.lt_exec(command)
    graph = op.find_graph()
    if graph is None:
        raise BridgeError("Origin did not return the newly created heatmap graph page.")
    graph.lname = _origin_long_name(f"{dataset.label} - {z_title} heatmap")
    layer = graph[0]
    layer.rescale()
    maximum_time = max(
        (
            value
            for value in dataset.time_axis
            if math.isfinite(value) and value >= 0.1
        ),
        default=0.1,
    )
    if maximum_time <= 0.1:
        maximum_time = 1.0
    layer.yscale = "log10"
    layer.set_ylim(0.1, maximum_time)


def _plot_line(op: Any, sheet: Any, colx: int, coly: int, title: str) -> None:
    graph = _new_line_graph(op, title)
    graph[0].add_plot(sheet, coly=coly, colx=colx, type="line")
    graph[0].rescale()


def _plot_multi_line(
    op: Any, sheet: Any, colx: int, colys: Sequence[int], title: str
) -> None:
    graph = _new_line_graph(op, title)
    layer = graph[0]
    for index, coly in enumerate(colys):
        plot = layer.add_plot(sheet, coly=coly, colx=colx, type="line")
        _set_plot_color_compatibly(plot, index)
    layer.rescale()


def _plot_spectra(
    op: Any,
    sheet: Any,
    spectra: SpectrumSet,
    title: str,
    component_count: int | None = None,
) -> None:
    graph = _new_line_graph(op, title)
    layer = graph[0]
    count = spectra.matrix.rows if component_count is None else component_count
    for index in range(count):
        plot = layer.add_plot(sheet, coly=index + 1, colx=0, type="line")
        _set_plot_color_compatibly(plot, index)
    layer.rescale()


def _new_line_graph(op: Any, title: str) -> Any:
    # Origin.otp is the standard one-layer graph page. Referencing that page's
    # layer directly prevents an active heatmap page from receiving line plots.
    graph = op.new_graph(lname=_origin_long_name(title), template="Origin")
    if graph is None:
        raise BridgeError(f"Origin could not create a graph page for {title}.")
    return graph


def _set_plot_color_compatibly(plot: Any, index: int) -> None:
    colors = ("#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9")
    try:
        plot.color = colors[index % len(colors)]
    except Exception:
        # Color is cosmetic and older embedded originpro builds expose fewer
        # Plot properties. Never discard a valid curve because styling failed.
        pass


def _try_origin_plot(
    warnings: list[str],
    dataset_label: str,
    plot_label: str,
    operation: Any,
) -> bool:
    try:
        operation()
        return True
    except Exception as error:  # Origin raises implementation-specific exception types.
        warnings.append(f"{dataset_label}: could not create {plot_label}: {error}")
        return False


def fit_irf_limited(fit: FitData | None) -> list[bool]:
    if not fit:
        return []
    value = fit.metadata.get("irfLimited")
    return [bool(item) for item in value] if isinstance(value, list) else []


def _origin_component_indices(fit: FitData | None, component_count: int) -> list[int]:
    if not fit or not bool(fit.metadata.get("originHideIrfLimited")):
        return list(range(component_count))
    irf_limited = fit_irf_limited(fit)
    return [
        index
        for index in range(component_count)
        if index >= len(irf_limited) or not irf_limited[index]
    ]


def _dataset_metadata(project: ProjectData, dataset: DatasetData) -> dict[str, Any]:
    return {
        "datasetId": dataset.dataset_id,
        "folderId": dataset.folder_id,
        "folderName": dataset.folder_name,
        "label": dataset.label,
        "sampleNote": dataset.sample_note,
        "sourceFileName": dataset.source_file_name,
        "sourceFormat": dataset.source_format,
        "sourceSha256": hashlib.sha256(dataset.raw_source_bytes).hexdigest(),
        "sourceTextSha256": hashlib.sha256(dataset.raw_source_text.encode("utf-8")).hexdigest(),
        "sourceArchive": str(project.archive_path),
        "sourceArchiveSha256": project.archive_sha256,
        "sourceArchiveSchema": project.archive_schema,
        "units": dataset.units,
        "shape": {"rows": dataset.matrix.rows, "cols": dataset.matrix.cols},
        "selection": {
            "timeIndex": dataset.selected_time_index,
            "timeValue": dataset.selected_time,
            "wavelengthIndex": dataset.selected_wavelength_index,
            "wavelengthValue": dataset.selected_wavelength,
        },
        "analysisMetadata": dataset.analysis_metadata,
        "fitMetadata": dataset.fit.metadata if dataset.fit else None,
    }


def _write_virtual_matrix_csv(
    path: Path,
    dataset: DatasetData,
    matrix: BinaryMatrix,
    overwrite: bool,
) -> None:
    _prepare_output(path, overwrite)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["", *[format_number(value) for value in dataset.time_axis]])
        for wavelength, row in zip(dataset.spectral_axis, matrix.iter_rows()):
            writer.writerow([format_number(wavelength), *[format_number(value) for value in row]])


def _write_xy_csv(
    path: Path,
    x_label: str,
    x_values: Sequence[float],
    y_label: str,
    y_values: Sequence[float],
    overwrite: bool,
) -> None:
    _prepare_output(path, overwrite)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow([x_label, y_label])
        for x_value, y_value in zip(x_values, y_values):
            writer.writerow([format_number(x_value), format_number(y_value)])


def _write_spectra_csv(
    path: Path,
    spectral_axis: Sequence[float],
    spectral_unit: str,
    spectra: SpectrumSet,
    overwrite: bool,
) -> None:
    _prepare_output(path, overwrite)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        labels = []
        for index, label in enumerate(spectra.labels):
            lifetime = spectra.lifetimes[index]
            suffix = f" (tau={format_number(lifetime)})" if math.isfinite(lifetime) else ""
            labels.append(f"{label}{suffix}")
        writer.writerow([f"Wavelength ({spectral_unit})", *labels])
        for col, wavelength in enumerate(spectral_axis):
            writer.writerow([
                format_number(wavelength),
                *[format_number(spectra.matrix.at(row, col)) for row in range(spectra.matrix.rows)],
            ])


def _write_json(path: Path, value: Any, overwrite: bool) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    _write_bytes(path, payload + b"\n", overwrite)


def _write_bytes(path: Path, payload: bytes, overwrite: bool) -> None:
    _prepare_output(path, overwrite)
    path.write_bytes(payload)


def _prepare_output(path: Path, overwrite: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise BridgeError(f"Output already exists (use --overwrite to replace it): {path}")
    if path.exists() and not path.is_file():
        raise BridgeError(f"Output path is not a regular file: {path}")


def _validate_archive(archive: zipfile.ZipFile) -> None:
    infos = archive.infolist()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise BridgeError("The archive contains too many entries.")
    expanded_bytes = 0
    names: set[str] = set()
    for info in infos:
        _validate_entry_name(info.filename)
        if info.filename in names:
            raise BridgeError(f"The archive contains a duplicate entry: {info.filename}")
        names.add(info.filename)
        if info.flag_bits & 0x1:
            raise BridgeError(f"Encrypted archive entries are unsupported: {info.filename}")
        expanded_bytes += info.file_size
        if expanded_bytes > MAX_EXPANDED_BYTES:
            raise BridgeError("The archive exceeds the 1 GB expanded-size limit.")
    if "manifest.json" not in names:
        raise BridgeError("The archive has no manifest.json.")


def _validate_entry_name(name: str) -> None:
    if not name or "\x00" in name or "\\" in name:
        raise BridgeError(f"The archive contains an unsafe path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise BridgeError(f"The archive contains an unsafe path: {name}")
    if path.parts and re.match(r"^[A-Za-z]:", path.parts[0]):
        raise BridgeError(f"The archive contains an unsafe path: {name}")


def _read_json_entry(archive: zipfile.ZipFile, name: str) -> dict[str, Any]:
    try:
        value = json.loads(_read_text_entry(archive, name))
    except json.JSONDecodeError as error:
        raise BridgeError(f"{name} is not valid JSON: {error}") from error
    return _mapping(value, name)


def _read_text_entry(archive: zipfile.ZipFile, name: str) -> str:
    try:
        payload = archive.read(name)
    except KeyError as error:
        raise BridgeError(f"The archive is missing required entry: {name}") from error
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BridgeError(f"Archive entry is not valid UTF-8 text: {name}") from error


def _read_preserved_source(
    archive: zipfile.ZipFile,
    descriptor: dict[str, Any],
    compatibility_text: str,
    label: str,
) -> tuple[str, bytes]:
    source_format = str(descriptor.get("format") or "csv").strip().lower()
    if source_format != "ufs":
        return "csv", compatibility_text.encode("utf-8")
    raw_entry = descriptor.get("rawEntry")
    if not isinstance(raw_entry, str) or not raw_entry:
        raise BridgeError(f"The {label} UFS descriptor has no rawEntry path.")
    _validate_entry_name(raw_entry)
    try:
        return "ufs", archive.read(raw_entry)
    except KeyError as error:
        raise BridgeError(f"The archive is missing required entry: {raw_entry}") from error


def _read_axis(archive: zipfile.ZipFile, descriptor_value: Any, label: str) -> list[float]:
    descriptor = _mapping(descriptor_value, label)
    length = _nonnegative_int(descriptor.get("length"), f"{label} length")
    values = _read_float64_values(archive, _entry_name(descriptor, label), length, label)
    if not values:
        raise BridgeError(f"The {label} is empty.")
    return list(values)


def _read_optional_matrix(
    archive: zipfile.ZipFile,
    descriptor_value: Any,
    label: str,
) -> BinaryMatrix | None:
    if not isinstance(descriptor_value, dict):
        return None
    return _read_matrix(archive, descriptor_value, label)


def _read_matrix(archive: zipfile.ZipFile, descriptor_value: Any, label: str) -> BinaryMatrix:
    descriptor = _mapping(descriptor_value, label)
    rows = _nonnegative_int(descriptor.get("rows"), f"{label} rows")
    cols = _nonnegative_int(descriptor.get("cols"), f"{label} columns")
    count = rows * cols
    if count > MAX_MATRIX_VALUES:
        raise BridgeError(f"The {label} exceeds the 100,000,000-value limit.")
    values = _read_float64_values(archive, _entry_name(descriptor, label), count, label)
    return BinaryMatrix(rows=rows, cols=cols, values=values)


def _read_float64_values(
    archive: zipfile.ZipFile,
    entry: str,
    count: int,
    label: str,
) -> array.array:
    try:
        payload = archive.read(entry)
    except KeyError as error:
        raise BridgeError(f"The archive is missing required entry: {entry}") from error
    expected_bytes = count * 8
    if len(payload) != expected_bytes:
        raise BridgeError(
            f"The {label} entry has {len(payload)} bytes; expected {expected_bytes}."
        )
    values = array.array("d")
    if values.itemsize != 8:
        raise BridgeError("This Python build does not use 64-bit C doubles.")
    values.frombytes(payload)
    if sys.byteorder != "little":
        values.byteswap()
    return values


def _validate_dataset_shape(
    time_axis: list[float],
    spectral_axis: list[float],
    matrix: BinaryMatrix,
    index: int,
) -> None:
    if matrix.rows != len(spectral_axis) or matrix.cols != len(time_axis):
        raise BridgeError(
            f"Dataset {index + 1} matrix shape {matrix.rows}x{matrix.cols} "
            f"does not match axes {len(spectral_axis)}x{len(time_axis)}."
        )
    if not _is_monotone(time_axis):
        raise BridgeError(f"Dataset {index + 1} time axis is not monotone.")
    if not _is_monotone(spectral_axis):
        raise BridgeError(f"Dataset {index + 1} spectral axis is not monotone.")


def _is_monotone(values: Sequence[float]) -> bool:
    if any(not math.isfinite(value) for value in values):
        return False
    increasing = all(left < right for left, right in zip(values, values[1:]))
    decreasing = all(left > right for left, right in zip(values, values[1:]))
    return increasing or decreasing or len(values) == 1


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BridgeError(f"{label} must be a JSON object.")
    return value


def _mapping_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _dataset_descriptors(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    value = manifest.get("datasets")
    if not isinstance(value, list) or not value:
        raise BridgeError("The archive manifest contains no datasets.")
    return [_mapping(item, f"dataset {index + 1}") for index, item in enumerate(value)]


def _folder_records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _entry_name(descriptor: dict[str, Any], label: str) -> str:
    entry = descriptor.get("entry")
    if not isinstance(entry, str) or not entry:
        raise BridgeError(f"The {label} descriptor has no entry path.")
    _validate_entry_name(entry)
    return entry


def _nonnegative_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise BridgeError(f"{label} must be a non-negative integer.")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise BridgeError(f"{label} must be a non-negative integer.") from error
    if number < 0 or number != value:
        raise BridgeError(f"{label} must be a non-negative integer.")
    return number


def _clamp_index(value: Any, length: int) -> int:
    if length <= 0:
        return 0
    try:
        number = round(float(value))
    except (TypeError, ValueError):
        number = 0
    return max(0, min(length - 1, number))


def _json_number(value: Any) -> float:
    if value is None:
        return math.nan
    try:
        number = float(value)
    except (TypeError, ValueError):
        return math.nan
    return number if math.isfinite(number) else math.nan


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_filename(value: str) -> str:
    normalized = re.sub(r"[^\w.-]+", "-", value.strip(), flags=re.UNICODE)
    normalized = normalized.strip(".-_")
    return normalized[:120] or "dataset"


def _unique_name(base: str, used: set[str]) -> str:
    candidate = base
    suffix = 2
    while candidate.casefold() in used:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used.add(candidate.casefold())
    return candidate


def _origin_long_name(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ")[:255] or "SpecFlowLab"


def _labtalk_text(value: str) -> str:
    return value.replace("\\", "/").replace('"', "'").replace("\r", " ").replace("\n", " ")


def format_number(value: float) -> str:
    if math.isnan(value):
        return "NaN"
    if value == math.inf:
        return "Infinity"
    if value == -math.inf:
        return "-Infinity"
    if value == 0:
        return "0"
    return format(value, ".17g")


def format_label_number(value: float) -> str:
    if not math.isfinite(value):
        return format_number(value)
    if value == 0:
        return "0"
    return format(value, ".9g")


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate/convert SpecFlowLab archives and import them into OriginPro "
            "without GUI automation."
        )
    )
    parser.add_argument("input", help="Input .sflproj or .sflorigin archive")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument(
        "--inspect",
        action="store_true",
        help="Validate the archive and print a JSON summary (default)",
    )
    actions.add_argument(
        "--extract",
        metavar="DIRECTORY",
        help="Convert every dataset to CSV/JSON files",
    )
    actions.add_argument(
        "--origin",
        action="store_true",
        help="Create Origin workbooks and graphs through originpro",
    )
    parser.add_argument(
        "--no-plots",
        action="store_true",
        help="With --origin, import worksheets but do not create graphs",
    )
    parser.add_argument(
        "--save",
        metavar="PROJECT.OPJU",
        help="With --origin, save the resulting Origin project",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="With --extract, replace existing output files",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    if args.save and not args.origin:
        parser.error("--save requires --origin")
    if args.no_plots and not args.origin:
        parser.error("--no-plots requires --origin")
    if args.overwrite and not args.extract:
        parser.error("--overwrite requires --extract")

    try:
        project = load_project(args.input)
        if args.extract:
            written = extract_project(project, args.extract, overwrite=args.overwrite)
            print(json.dumps({
                "status": "converted",
                "outputDirectory": str(Path(args.extract).expanduser().resolve()),
                "fileCount": len(written),
                "sourceSha256": project.archive_sha256,
            }, indent=2))
        elif args.origin:
            result = import_project_into_origin(
                project,
                create_plots=not args.no_plots,
                save_path=args.save,
            )
            print(json.dumps({"status": "imported", **result}, indent=2))
        else:
            print(json.dumps(project.summary(), ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except BridgeError as error:
        print(f"SpecFlowLab Origin bridge error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
