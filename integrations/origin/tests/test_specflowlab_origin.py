import hashlib
import json
import math
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

import specflowlab_origin as bridge  # noqa: E402


class OriginBridgeTests(unittest.TestCase):
    def test_reads_plot_ready_bundle_and_preserves_nan(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "fixture.sflorigin"
            write_origin_bundle(archive_path)

            project = bridge.load_project(archive_path)
            self.assertEqual(project.archive_schema, bridge.ORIGIN_BUNDLE_SCHEMA)
            self.assertEqual(len(project.datasets), 1)
            dataset = project.datasets[0]
            self.assertEqual(dataset.label, "Python bridge fixture")
            self.assertEqual(dataset.matrix.rows, 2)
            self.assertEqual(dataset.matrix.cols, 3)
            self.assertTrue(math.isnan(dataset.matrix.at(1, 1)))
            self.assertEqual(dataset.selected_spectrum(), [3.0, 6.0])
            kinetics = dataset.selected_kinetics()
            self.assertEqual(kinetics[0], 4.0)
            self.assertTrue(math.isnan(kinetics[1]))
            self.assertEqual(kinetics[2], 6.0)
            self.assertIsNotNone(dataset.fit)
            self.assertEqual(dataset.fit.das.labels, ["DAS 1", "DAS 2"])
            self.assertEqual(dataset.fit.residual_matrix.at(1, 2), -0.3)

    def test_converts_bundle_to_virtual_matrix_csv_without_interpolation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "fixture.sflorigin"
            output = root / "converted"
            write_origin_bundle(archive_path)
            project = bridge.load_project(archive_path)

            written = bridge.extract_project(project, output)
            self.assertGreaterEqual(len(written), 9)
            dataset_dir = next(path for path in output.iterdir() if path.is_dir())
            treated = (dataset_dir / "treated-virtual-matrix.csv").read_text(encoding="utf-8")
            self.assertIn(",-1,0,1\n", treated)
            self.assertIn("510,4,NaN,6\n", treated)
            self.assertEqual(
                (dataset_dir / "source.csv").read_bytes(),
                b"0,-1,0,1\r\n500,1,2,3\r\n510,4,NaN,6\r\n",
            )

            with self.assertRaisesRegex(bridge.BridgeError, "already exists"):
                bridge.extract_project(project, output)

    def test_ufs_bundle_preserves_and_extracts_exact_raw_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "ufs-fixture.sflorigin"
            output = root / "converted"
            entries, manifest = origin_bundle_entries()
            raw_ufs = b"Version2 synthetic UFS bytes\x00\xff"
            entries["datasets/0001/source.ufs"] = raw_ufs
            source = manifest["datasets"][0]["source"]
            source.update({
                "fileName": "fixture.ufs",
                "format": "ufs",
                "rawEntry": "datasets/0001/source.ufs",
            })
            write_archive(archive_path, entries, manifest)

            project = bridge.load_project(archive_path)
            dataset = project.datasets[0]
            self.assertEqual(dataset.source_format, "ufs")
            self.assertEqual(dataset.raw_source_bytes, raw_ufs)
            self.assertEqual(
                bridge._dataset_metadata(project, dataset)["sourceSha256"],
                hashlib.sha256(raw_ufs).hexdigest(),
            )

            bridge.extract_project(project, output)
            dataset_dir = next(path for path in output.iterdir() if path.is_dir())
            self.assertEqual((dataset_dir / "source.ufs").read_bytes(), raw_ufs)
            self.assertEqual(
                (dataset_dir / "source.csv").read_bytes(),
                entries["datasets/0001/source.csv"],
            )

    def test_reads_standard_project_archive_without_claiming_derived_fit_arrays(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "fixture.sflproj"
            write_project_archive(archive_path)
            project = bridge.load_project(archive_path)
            dataset = project.datasets[0]

            self.assertEqual(project.archive_schema, bridge.PROJECT_ARCHIVE_SCHEMA)
            self.assertIsNotNone(dataset.fit)
            self.assertIsNone(dataset.fit.das)
            self.assertEqual(dataset.fit.metadata["lifetimes"], [0.5, 12])
            self.assertFalse(project.summary()["datasets"][0]["hasPlotReadyFit"])

    def test_rejects_unsafe_archive_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "unsafe.sflorigin"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(
                    "manifest.json",
                    json.dumps({"bundleSchema": bridge.ORIGIN_BUNDLE_SCHEMA, "datasets": [{}]}),
                )
                archive.writestr("../outside.csv", "unsafe")
            with self.assertRaisesRegex(bridge.BridgeError, "unsafe path"):
                bridge.load_project(archive_path)

    def test_rejects_matrix_descriptor_byte_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "mismatch.sflorigin"
            entries, manifest = origin_bundle_entries()
            entries["datasets/0001/treated-matrix.f64"] = pack_f64([1, 2])
            write_archive(archive_path, entries, manifest)
            with self.assertRaisesRegex(bridge.BridgeError, "expected 48"):
                bridge.load_project(archive_path)

    def test_representative_traces_cover_full_range_and_keep_current_selection(self):
        self.assertEqual(
            bridge._representative_indices(200, 73),
            [0, 50, 73, 100, 149, 199],
        )
        self.assertEqual(
            bridge._representative_indices(200, 50),
            [0, 50, 100, 149, 199],
        )
        self.assertEqual(bridge._representative_indices(3, 1), [0, 1, 2])

    def test_selected_sheet_contains_multiple_spectra_and_kinetics(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "fixture.sflorigin"
            write_origin_bundle(archive_path)
            dataset = bridge.load_project(archive_path).datasets[0]
            sheet = FakeSheet()

            time_indices, wavelength_indices = bridge._fill_selected_sheet(sheet, dataset)

            self.assertEqual(time_indices, [0, 1, 2])
            self.assertEqual(wavelength_indices, [0, 1])
            self.assertEqual(sheet.cols, 7)
            self.assertEqual(sheet.columns[0]["values"], [500.0, 510.0])
            self.assertEqual(sheet.columns[1]["values"], [1.0, 4.0])
            self.assertEqual(sheet.columns[3]["values"], [3.0, 6.0])
            self.assertEqual(sheet.columns[4]["values"], [-1.0, 0.0, 1.0])
            self.assertEqual(sheet.columns[6]["values"][0], 4.0)
            self.assertTrue(math.isnan(sheet.columns[6]["values"][1]))
            self.assertEqual(sheet.columns[6]["values"][2], 6.0)
            self.assertIn("(selected)", sheet.columns[3]["lname"])
            self.assertIn("(selected)", sheet.columns[6]["lname"])

    def test_origin_virtual_matrix_places_wavelength_on_x_and_time_on_y(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "fixture.sflorigin"
            write_origin_bundle(archive_path)
            dataset = bridge.load_project(archive_path).datasets[0]
            sheet = FakeSheet()

            bridge._fill_virtual_matrix_sheet(
                sheet,
                dataset,
                dataset.matrix,
                "Treated signal",
            )

            self.assertEqual(sheet.cols, 3)
            self.assertTrue(math.isnan(sheet.columns[0]["values"][0]))
            self.assertEqual(sheet.columns[0]["values"][1:], [-1.0, 0.0, 1.0])
            self.assertEqual(sheet.columns[1]["values"], [500.0, 1.0, 2.0, 3.0])
            self.assertEqual(sheet.columns[2]["values"][0], 510.0)
            self.assertEqual(sheet.columns[2]["values"][1], 4.0)
            self.assertTrue(math.isnan(sheet.columns[2]["values"][2]))
            self.assertEqual(sheet.columns[2]["values"][3], 6.0)
            self.assertEqual(
                sheet.properties["tree.specflowlab.virtual_matrix_layout"],
                "x_wavelength_across_y_time_down",
            )

    def test_hidden_irf_components_are_omitted_from_origin_sheet_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "fixture.sflorigin"
            entries, manifest = origin_bundle_entries()
            metadata = manifest["datasets"][0]["fit"]["metadata"]
            metadata["irfLimited"] = [True, False]
            metadata["originHideIrfLimited"] = True
            write_archive(archive_path, entries, manifest)
            dataset = bridge.load_project(archive_path).datasets[0]
            sheet = FakeSheet()

            visible_count = bridge._fill_spectra_sheet(
                sheet,
                dataset,
                dataset.fit.das,
            )

            self.assertEqual(visible_count, 1)
            self.assertEqual(sheet.cols, 2)
            self.assertEqual(sheet.columns[1]["values"], [0.003, 0.004])
            self.assertEqual(
                sheet.properties["tree.specflowlab.component_indices"],
                "[1]",
            )
            self.assertEqual(dataset.fit.das.matrix.rows, 2)

    def test_origin_2021_plot_paths_do_not_require_sheet_activate_or_layer_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "fixture.sflorigin"
            write_origin_bundle(archive_path)
            dataset = bridge.load_project(archive_path).datasets[0]

            heatmap_origin = FakeHeatmapOrigin()
            bridge._plot_virtual_heatmap(
                heatmap_origin,
                FakeSheet(lt_range="[Book1]TreatedVM!"),
                dataset,
                "Treated signal",
            )
            self.assertIn("plotvm irng:=[Book1]TreatedVM!", heatmap_origin.commands[0])
            self.assertIn('xtitle:="Wavelength (nm)"', heatmap_origin.commands[0])
            self.assertIn('ytitle:="Time (ps)"', heatmap_origin.commands[0])
            self.assertTrue(heatmap_origin.layer.rescaled)
            self.assertEqual(heatmap_origin.layer.yscale, "log10")
            self.assertEqual(heatmap_origin.layer.y_limits, (0.1, 1.0))

            graph_origin = FakeGraphOrigin()
            bridge._plot_spectra(
                graph_origin,
                FakeSheet(),
                dataset.fit.das,
                "Fixture DAS",
            )
            self.assertEqual(len(graph_origin.layer.plots), 2)
            self.assertTrue(graph_origin.layer.rescaled)
            self.assertEqual(graph_origin.configurations[0]["template"], "Origin")

            graph_origin = FakeGraphOrigin()
            bridge._plot_multi_line(
                graph_origin,
                FakeSheet(),
                0,
                [1, 2, 3],
                "Fixture traces",
            )
            self.assertEqual(len(graph_origin.layer.plots), 3)
            self.assertTrue(graph_origin.layer.rescaled)
            self.assertEqual(graph_origin.configurations[0]["template"], "Origin")


class FakeSheet:
    def __init__(self, lt_range="[Book1]Selected!"):
        self.cols = 0
        self.columns = {}
        self.properties = {}
        self._lt_range = lt_range

    def from_list(self, column, values, **metadata):
        self.columns[column] = {"values": list(values), **metadata}

    def set_str(self, name, value):
        self.properties[name] = value

    def lt_range(self):
        return self._lt_range


class FakeHeatmapOrigin:
    def __init__(self):
        self.commands = []
        self.layer = FakeLayer()
        self.graph = FakeGraph(self.layer)

    def lt_exec(self, command):
        self.commands.append(command)

    def find_graph(self):
        return self.graph


class FakePlot:
    def __init__(self):
        self.color = None


class FakeLayer:
    def __init__(self):
        self.plots = []
        self.rescaled = False
        self.yscale = None
        self.y_limits = None

    def add_plot(self, sheet, **configuration):
        plot = FakePlot()
        self.plots.append((sheet, configuration, plot))
        return plot

    def rescale(self):
        self.rescaled = True

    def set_ylim(self, begin, end):
        self.y_limits = (begin, end)


class FakeGraph:
    def __init__(self, layer):
        self.layer = layer
        self.lname = ""

    def __getitem__(self, index):
        if index != 0:
            raise IndexError(index)
        return self.layer


class FakeGraphOrigin:
    def __init__(self):
        self.layer = FakeLayer()
        self.configurations = []

    def new_graph(self, **configuration):
        self.configurations.append(configuration)
        return FakeGraph(self.layer)


def write_origin_bundle(path):
    entries, manifest = origin_bundle_entries()
    write_archive(path, entries, manifest)


def origin_bundle_entries():
    entries = {
        "datasets/0001/source.csv": b"0,-1,0,1\r\n500,1,2,3\r\n510,4,NaN,6\r\n",
        "datasets/0001/treated-time.f64": pack_f64([-1, 0, 1]),
        "datasets/0001/treated-wavelength.f64": pack_f64([500, 510]),
        "datasets/0001/treated-matrix.f64": pack_f64([1, 2, 3, 4, math.nan, 6]),
        "datasets/0001/fitted-matrix.f64": pack_f64([0.9, 1.8, 2.7, 4.1, 5.2, 6.3]),
        "datasets/0001/residual-matrix.f64": pack_f64([0.1, 0.2, 0.3, -0.1, -0.2, -0.3]),
        "datasets/0001/das-spectra.f64": pack_f64([-0.01, -0.02, 0.003, 0.004]),
        "datasets/0001/eas-spectra.f64": pack_f64([-0.02, -0.03, 0.005, 0.006]),
    }
    manifest = {
        "bundleSchema": bridge.ORIGIN_BUNDLE_SCHEMA,
        "sourceProjectSchema": "specflowlab.desktop_preview.v3",
        "appVersion": "test",
        "sourceSavedAt": "2026-07-29T00:00:00.000Z",
        "folders": [{"id": "folder-1", "name": "VIS"}],
        "datasets": [{
            "id": "dataset-1",
            "folderId": "folder-1",
            "projectLabel": "Python bridge fixture",
            "sampleNote": "Round trip",
            "source": {
                "fileName": "fixture.csv",
                "entry": "datasets/0001/source.csv",
            },
            "units": {"time": "ps", "spectral": "nm", "signal": "Delta A"},
            "selection": {
                "timeIndex": 2,
                "wavelengthIndex": 1,
                "timeValue": 1,
                "wavelengthValue": 510,
            },
            "analysis": {
                "metadata": {"provenance": [{"label": "Baseline", "status": "applied"}]},
                "timeAxis": {"entry": "datasets/0001/treated-time.f64", "length": 3},
                "spectralAxis": {
                    "entry": "datasets/0001/treated-wavelength.f64",
                    "length": 2,
                },
                "matrix": {
                    "entry": "datasets/0001/treated-matrix.f64",
                    "rows": 2,
                    "cols": 3,
                },
            },
            "fit": {
                "metadata": {
                    "componentCount": 2,
                    "lifetimes": [0.5, 12],
                    "irfLimited": [False, False],
                    "rmse": 0.001,
                },
                "fittedMatrix": {
                    "entry": "datasets/0001/fitted-matrix.f64",
                    "rows": 2,
                    "cols": 3,
                },
                "residualMatrix": {
                    "entry": "datasets/0001/residual-matrix.f64",
                    "rows": 2,
                    "cols": 3,
                },
                "das": {
                    "entry": "datasets/0001/das-spectra.f64",
                    "rows": 2,
                    "cols": 2,
                    "labels": ["DAS 1", "DAS 2"],
                    "lifetimes": [0.5, 12],
                },
                "eas": {
                    "entry": "datasets/0001/eas-spectra.f64",
                    "rows": 2,
                    "cols": 2,
                    "labels": ["EAS 1", "EAS 2"],
                    "lifetimes": [0.5, 12],
                },
            },
        }],
    }
    return entries, manifest


def write_project_archive(path):
    entries = {
        "datasets/0001/source.csv": b"0,-1,0,1\r\n500,1,2,3\r\n510,4,5,6\r\n",
        "datasets/0001/treated-time.f64": pack_f64([-1, 0, 1]),
        "datasets/0001/treated-wavelength.f64": pack_f64([500, 510]),
        "datasets/0001/treated-matrix.f64": pack_f64([1, 2, 3, 4, 5, 6]),
    }
    manifest = {
        "archiveSchema": bridge.PROJECT_ARCHIVE_SCHEMA,
        "projectSchema": "specflowlab.desktop_preview.v3",
        "appVersion": "test",
        "savedAt": "2026-07-29T00:00:00.000Z",
        "state": {"selectedTimeIndex": 1, "selectedWavelengthIndex": 0},
        "folders": [{"id": "folder-1", "name": "VIS"}],
        "datasets": [{
            "id": "dataset-1",
            "folderId": "folder-1",
            "projectLabel": "Project archive fixture",
            "source": {
                "fileName": "fixture.csv",
                "entry": "datasets/0001/source.csv",
            },
            "analysis": {
                "metadata": {},
                "timeAxis": {"entry": "datasets/0001/treated-time.f64", "length": 3},
                "spectralAxis": {
                    "entry": "datasets/0001/treated-wavelength.f64",
                    "length": 2,
                },
                "matrix": {
                    "entry": "datasets/0001/treated-matrix.f64",
                    "rows": 2,
                    "cols": 3,
                },
            },
            "fit": {
                "componentCount": 2,
                "lifetimes": [0.5, 12],
                "rmse": 0.001,
            },
        }],
    }
    write_archive(path, entries, manifest)


def write_archive(path, entries, manifest):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
        for name, payload in entries.items():
            archive.writestr(name, payload)


def pack_f64(values):
    return struct.pack(f"<{len(values)}d", *values)


if __name__ == "__main__":
    unittest.main()
