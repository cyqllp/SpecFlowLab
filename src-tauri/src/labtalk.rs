// COM worksheet staging adapter for Origin 8.6.
//
// Origin 8.6 does not have embedded Python, so we cannot use the originpro
// bridge. Instead we extract the portable .sflorigin bundle, write Float64
// axes and matrices as tab-delimited text files, and generate a manifest for
// the bitness-matched COM helper.
//
// The .sflorigin sidecar remains the lossless provenance source.
#![allow(dead_code)]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct LabTalkStage {
    pub run_directory: PathBuf,
    pub manifest_path: PathBuf,
    pub dataset_count: usize,
    pub sheet_count: usize,
}

/// Extract the .sflorigin bundle and stage tab-delimited import files.
///
/// Returns the generated COM import stage and its expected dataset count.
pub fn stage_labtalk_import(bundle_path: &Path) -> Result<LabTalkStage, String> {
    let run_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("timestamp error: {e}"))?
        .as_millis();
    let run_directory = std::env::temp_dir()
        .join("SpecFlowLab-LabTalk")
        .join(format!("{}-{run_id}", std::process::id()));
    fs::create_dir_all(&run_directory)
        .map_err(|e| format!("Cannot create Origin COM staging directory: {e}"))?;

    // Read the .sflorigin zip
    let bundle_bytes = fs::read(bundle_path).map_err(|e| format!("Cannot read bundle: {e}"))?;
    let cursor = std::io::Cursor::new(bundle_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Cannot open bundle zip: {e}"))?;

    // Parse manifest
    let manifest: serde_json::Value = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|e| format!("Bundle has no manifest.json: {e}"))?;
        let mut buf = Vec::new();
        manifest_file
            .read_to_end(&mut buf)
            .map_err(|e| format!("Cannot read manifest: {e}"))?;
        serde_json::from_slice(&buf).map_err(|e| format!("Invalid manifest: {e}"))?
    };

    let datasets = manifest["datasets"]
        .as_array()
        .ok_or("Manifest missing datasets array")?;

    if datasets.is_empty() {
        return Err("Bundle contains no datasets".to_string());
    }

    let mut com_datasets: Vec<serde_json::Value> = Vec::new();
    let mut sheet_count = 0_usize;

    for (index, dataset) in datasets.iter().enumerate() {
        let name = dataset["projectLabel"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Dataset");

        // Extract Float64 data from zip entries
        let analysis = dataset["analysis"]
            .as_object()
            .ok_or_else(|| format!("Dataset {} has no analysis descriptor", index + 1))?;
        let time_descriptor = &analysis["timeAxis"];
        let wave_descriptor = &analysis["spectralAxis"];
        let matrix_descriptor = &analysis["matrix"];
        let time_path = descriptor_entry(time_descriptor, "time axis", index)?;
        let wave_path = descriptor_entry(wave_descriptor, "spectral axis", index)?;
        let matrix_path = descriptor_entry(matrix_descriptor, "matrix", index)?;
        let rows = descriptor_size(matrix_descriptor, "rows", "matrix", index)?;
        let cols = descriptor_size(matrix_descriptor, "cols", "matrix", index)?;

        let time_axis = read_f64_from_zip(&mut archive, time_path)?;
        let wave_axis = read_f64_from_zip(&mut archive, wave_path)?;
        if time_axis.len() != cols || wave_axis.len() != rows {
            return Err(format!(
                "Dataset {} descriptor mismatch: matrix is {rows}x{cols}, time axis has {}, spectral axis has {}",
                index + 1,
                time_axis.len(),
                wave_axis.len()
            ));
        }
        let matrix = read_f64_matrix_from_zip(&mut archive, matrix_path, rows, cols)?;

        let sanitized = sanitize_for_labtalk(name);
        let dataset_dir = run_directory.join(format!("{:04}-{sanitized}", index + 1));
        fs::create_dir_all(&dataset_dir).map_err(|e| format!("Cannot create dataset dir: {e}"))?;

        let time_unit = json_string(&dataset["units"]["time"], "ps");
        let spectral_unit = json_string(&dataset["units"]["spectral"], "nm");
        let signal_unit = json_string(&dataset["units"]["signal"], "signal");
        let selected_time_index = json_index(&dataset["selection"]["timeIndex"], time_axis.len());
        let selected_wavelength_index =
            json_index(&dataset["selection"]["wavelengthIndex"], wave_axis.len());
        let mut sheets: Vec<serde_json::Value> = Vec::new();

        let metadata_path = dataset_dir.join("metadata.txt");
        let metadata_pairs = dataset_metadata_pairs(
            &manifest,
            dataset,
            bundle_path,
            rows,
            cols,
            &time_axis,
            &wave_axis,
            selected_time_index,
            selected_wavelength_index,
        );
        write_text_pairs(&metadata_path, &metadata_pairs)?;
        sheets.push(sheet_manifest(
            "Metadata",
            "Dataset metadata and provenance",
            "text",
            &metadata_path,
            &[],
        ));

        let treated_path = dataset_dir.join("treated-vm.txt");
        write_wide_table(
            &treated_path,
            &time_axis,
            &wave_axis,
            &matrix,
            &spectral_unit,
        )?;
        sheets.push(sheet_manifest(
            "TreatedVM",
            "Treated virtual matrix",
            "numeric",
            &treated_path,
            &[0],
        ));

        let selected_path = dataset_dir.join("selected.txt");
        let selected_x_columns = write_selected_table(
            &selected_path,
            &time_axis,
            &wave_axis,
            &matrix,
            selected_time_index,
            selected_wavelength_index,
            &time_unit,
            &spectral_unit,
            &signal_unit,
        )?;
        sheets.push(sheet_manifest(
            "Selected",
            "Representative spectra and kinetics",
            "numeric",
            &selected_path,
            &selected_x_columns,
        ));

        if let Some(fit) = dataset["fit"].as_object() {
            let fit_summary_path = dataset_dir.join("fit-summary.txt");
            let fit_pairs = json_object_pairs(fit.get("metadata"));
            write_text_pairs(&fit_summary_path, &fit_pairs)?;
            sheets.push(sheet_manifest(
                "FitSummary",
                "Global fit summary",
                "text",
                &fit_summary_path,
                &[],
            ));

            for (key, sheet_name, long_name, file_name) in [
                (
                    "fittedMatrix",
                    "FittedVM",
                    "Fitted virtual matrix",
                    "fitted-vm.txt",
                ),
                (
                    "residualMatrix",
                    "ResidualVM",
                    "Residual virtual matrix",
                    "residual-vm.txt",
                ),
            ] {
                let Some(descriptor) = fit.get(key).filter(|value| value.is_object()) else {
                    continue;
                };
                let entry = descriptor_entry(descriptor, key, index)?;
                let fit_rows = descriptor_size(descriptor, "rows", key, index)?;
                let fit_cols = descriptor_size(descriptor, "cols", key, index)?;
                if fit_rows != rows || fit_cols != cols {
                    return Err(format!(
                        "Dataset {} {key} is {fit_rows}x{fit_cols}, expected {rows}x{cols}",
                        index + 1
                    ));
                }
                let fit_matrix = read_f64_matrix_from_zip(&mut archive, entry, fit_rows, fit_cols)?;
                let path = dataset_dir.join(file_name);
                write_wide_table(&path, &time_axis, &wave_axis, &fit_matrix, &spectral_unit)?;
                sheets.push(sheet_manifest(
                    sheet_name,
                    long_name,
                    "numeric",
                    &path,
                    &[0],
                ));
            }

            for (key, sheet_name, file_name) in
                [("das", "DAS", "das.txt"), ("eas", "EAS", "eas.txt")]
            {
                let Some(descriptor) = fit.get(key).filter(|value| value.is_object()) else {
                    continue;
                };
                let entry = descriptor_entry(descriptor, key, index)?;
                let component_count = descriptor_size(descriptor, "rows", key, index)?;
                let spectral_count = descriptor_size(descriptor, "cols", key, index)?;
                if spectral_count != wave_axis.len() {
                    return Err(format!(
                        "Dataset {} {sheet_name} has {spectral_count} spectral points, expected {}",
                        index + 1,
                        wave_axis.len()
                    ));
                }
                let spectra =
                    read_f64_matrix_from_zip(&mut archive, entry, component_count, spectral_count)?;
                let path = dataset_dir.join(file_name);
                write_spectra_table(
                    &path,
                    &wave_axis,
                    &spectra,
                    descriptor,
                    fit.get("metadata"),
                    &time_unit,
                    &spectral_unit,
                    sheet_name,
                )?;
                sheets.push(sheet_manifest(
                    sheet_name,
                    &format!("{sheet_name} component spectra"),
                    "numeric",
                    &path,
                    &[0],
                ));
            }
        }

        sheet_count += sheets.len();
        com_datasets.push(serde_json::json!({
            "workbookName": format!("SFL{:04}", index + 1),
            "label": sanitized,
            "displayLabel": name,
            "sheets": sheets,
        }));
    }

    let manifest_path = run_directory.join("com-import.json");
    let com_manifest = serde_json::json!({
        "schema": "specflowlab.origin_com_import.v2",
        "datasets": com_datasets,
    });
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&com_manifest)
            .map_err(|e| format!("Cannot serialize Origin COM manifest: {e}"))?,
    )
    .map_err(|e| format!("Cannot write Origin COM manifest: {e}"))?;

    Ok(LabTalkStage {
        run_directory,
        manifest_path,
        dataset_count: datasets.len(),
        sheet_count,
    })
}

fn descriptor_entry<'a>(
    descriptor: &'a serde_json::Value,
    label: &str,
    dataset_index: usize,
) -> Result<&'a str, String> {
    descriptor["entry"].as_str().ok_or_else(|| {
        format!(
            "Dataset {} {label} descriptor has no archive entry",
            dataset_index + 1
        )
    })
}

fn descriptor_size(
    descriptor: &serde_json::Value,
    key: &str,
    label: &str,
    dataset_index: usize,
) -> Result<usize, String> {
    descriptor[key]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| {
            format!(
                "Dataset {} {label} descriptor has no valid {key}",
                dataset_index + 1
            )
        })
}

fn read_f64_from_zip(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    name: &str,
) -> Result<Vec<f64>, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("Missing bundle entry {name}: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Read error {name}: {e}"))?;
    if bytes.len() % 8 != 0 {
        return Err(format!("{name}: not aligned to 8 bytes"));
    }
    let count = bytes.len() / 8;
    let mut values = Vec::with_capacity(count);
    for chunk in bytes.chunks_exact(8) {
        let arr: [u8; 8] = chunk.try_into().unwrap();
        values.push(f64::from_le_bytes(arr));
    }
    Ok(values)
}

fn read_f64_matrix_from_zip(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    name: &str,
    rows: usize,
    cols: usize,
) -> Result<Vec<Vec<f64>>, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("Missing bundle entry {name}: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Read error {name}: {e}"))?;

    let expected_bytes = rows
        .checked_mul(cols)
        .and_then(|values| values.checked_mul(8))
        .ok_or_else(|| format!("{name}: matrix dimensions overflow"))?;
    if bytes.len() != expected_bytes {
        return Err(format!(
            "{name}: expected {rows}x{cols} ({expected_bytes} bytes), got {} bytes",
            bytes.len()
        ));
    }
    let mut matrix: Vec<Vec<f64>> = Vec::with_capacity(rows);
    for r in 0..rows {
        let start = r * cols * 8;
        let mut row = Vec::with_capacity(cols);
        for c in 0..cols {
            let offset = start + c * 8;
            let arr: [u8; 8] = bytes[offset..offset + 8].try_into().unwrap();
            row.push(f64::from_le_bytes(arr));
        }
        matrix.push(row);
    }
    Ok(matrix)
}

fn json_string(value: &serde_json::Value, fallback: &str) -> String {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn json_index(value: &serde_json::Value, length: usize) -> usize {
    if length == 0 {
        return 0;
    }
    value
        .as_u64()
        .and_then(|number| usize::try_from(number).ok())
        .unwrap_or_default()
        .min(length - 1)
}

fn render_json_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_default()
        }
    }
}

fn json_object_pairs(value: Option<&serde_json::Value>) -> Vec<(String, String)> {
    value
        .and_then(serde_json::Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), render_json_value(value)))
                .collect()
        })
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn dataset_metadata_pairs(
    manifest: &serde_json::Value,
    dataset: &serde_json::Value,
    bundle_path: &Path,
    rows: usize,
    cols: usize,
    time_axis: &[f64],
    wave_axis: &[f64],
    selected_time_index: usize,
    selected_wavelength_index: usize,
) -> Vec<(String, String)> {
    let folder_id = json_string(&dataset["folderId"], "");
    let folder_name = manifest["folders"]
        .as_array()
        .and_then(|folders| {
            folders
                .iter()
                .find(|folder| folder["id"].as_str().unwrap_or_default() == folder_id.as_str())
        })
        .and_then(|folder| folder["name"].as_str())
        .unwrap_or("Unfiled");
    let time_unit = json_string(&dataset["units"]["time"], "ps");
    let spectral_unit = json_string(&dataset["units"]["spectral"], "nm");
    let selected_time = time_axis
        .get(selected_time_index)
        .copied()
        .map(format_f64)
        .unwrap_or_default();
    let selected_wavelength = wave_axis
        .get(selected_wavelength_index)
        .copied()
        .map(format_f64)
        .unwrap_or_default();
    let source = &dataset["source"];
    vec![
        ("Dataset ID".to_string(), json_string(&dataset["id"], "")),
        ("Folder ID".to_string(), folder_id),
        ("Folder".to_string(), folder_name.to_string()),
        (
            "Display name".to_string(),
            json_string(&dataset["projectLabel"], "Dataset"),
        ),
        (
            "Sample note".to_string(),
            json_string(&dataset["sampleNote"], ""),
        ),
        (
            "Dataset kind".to_string(),
            json_string(&dataset["kind"], "imported"),
        ),
        (
            "Source file".to_string(),
            json_string(&source["fileName"], ""),
        ),
        (
            "Source format".to_string(),
            json_string(&source["format"], ""),
        ),
        (
            "Source bundle".to_string(),
            bundle_path.display().to_string(),
        ),
        (
            "Bundle schema".to_string(),
            json_string(&manifest["bundleSchema"], ""),
        ),
        (
            "Source project schema".to_string(),
            json_string(&manifest["sourceProjectSchema"], ""),
        ),
        (
            "App version".to_string(),
            json_string(&manifest["appVersion"], ""),
        ),
        (
            "Source saved at".to_string(),
            json_string(&manifest["sourceSavedAt"], ""),
        ),
        ("Rows (wavelength)".to_string(), rows.to_string()),
        ("Columns (time)".to_string(), cols.to_string()),
        (
            "Selected time".to_string(),
            format!("{selected_time} {time_unit}"),
        ),
        (
            "Selected wavelength".to_string(),
            format!("{selected_wavelength} {spectral_unit}"),
        ),
        ("Units".to_string(), render_json_value(&dataset["units"])),
        (
            "Treatment metadata".to_string(),
            render_json_value(&dataset["analysis"]["metadata"]),
        ),
        (
            "Merge lineage".to_string(),
            render_json_value(&dataset["merge"]),
        ),
        (
            "Plot plan".to_string(),
            render_json_value(&dataset["plotPlan"]),
        ),
    ]
}

fn sheet_manifest(
    name: &str,
    long_name: &str,
    value_type: &str,
    table_path: &Path,
    x_columns: &[usize],
) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "longName": long_name,
        "valueType": value_type,
        "tablePath": table_path,
        "xColumns": x_columns,
    })
}

fn sanitize_tsv_cell(value: &str) -> String {
    value
        .replace('\t', " ")
        .replace("\r\n", "\\n")
        .replace(['\r', '\n'], "\\n")
}

fn sanitize_labtalk_label(value: &str) -> String {
    value
        .replace(['\t', '\r', '\n'], " ")
        .replace('"', "'")
        .replace('\\', "/")
        .replace(';', ",")
        .chars()
        .take(240)
        .collect()
}

fn write_text_pairs(path: &Path, pairs: &[(String, String)]) -> Result<(), String> {
    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    writeln!(file, "Property\tValue").map_err(|e| format!("Write error: {e}"))?;
    for (key, value) in pairs {
        writeln!(
            file,
            "{}\t{}",
            sanitize_tsv_cell(key),
            sanitize_tsv_cell(value)
        )
        .map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

fn write_wide_table(
    path: &Path,
    time_axis: &[f64],
    wave_axis: &[f64],
    matrix: &[Vec<f64>],
    spectral_unit: &str,
) -> Result<(), String> {
    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    // Virtual-matrix layout: the wavelength axis occupies the first column and
    // the exact time coordinates occupy the first data row, so the name row
    // carries only the axis label instead of the time values.
    let mut header = vec![format!("Wavelength ({spectral_unit})")];
    header.extend((0..time_axis.len()).map(|_| String::new()));
    header.iter_mut().for_each(|value| {
        *value = sanitize_labtalk_label(value);
    });
    writeln!(file, "{}", header.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    let mut time_row = Vec::with_capacity(time_axis.len() + 1);
    time_row.push(String::new());
    time_row.extend(time_axis.iter().map(|value| format_f64(*value)));
    writeln!(file, "{}", time_row.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    for (wavelength, row) in wave_axis.iter().zip(matrix.iter()) {
        let mut fields = Vec::with_capacity(row.len() + 1);
        fields.push(format_f64(*wavelength));
        fields.extend(row.iter().map(|value| format_f64(*value)));
        writeln!(file, "{}", fields.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_selected_table(
    path: &Path,
    time_axis: &[f64],
    wave_axis: &[f64],
    matrix: &[Vec<f64>],
    selected_time_index: usize,
    selected_wavelength_index: usize,
    time_unit: &str,
    spectral_unit: &str,
    signal_unit: &str,
) -> Result<Vec<usize>, String> {
    let time_indices = representative_indices(time_axis.len(), selected_time_index, 5);
    let wavelength_indices = representative_indices(wave_axis.len(), selected_wavelength_index, 5);
    let kinetics_x_column = 1 + time_indices.len();
    let mut headers = vec![format!("Wavelength ({spectral_unit})")];
    headers.extend(time_indices.iter().map(|index| {
        let selected = if *index == selected_time_index {
            " (selected)"
        } else {
            ""
        };
        format!(
            "Signal at {} {time_unit}{selected} ({signal_unit})",
            format_f64(time_axis[*index])
        )
    }));
    headers.push(format!("Time ({time_unit})"));
    headers.extend(wavelength_indices.iter().map(|index| {
        let selected = if *index == selected_wavelength_index {
            " (selected)"
        } else {
            ""
        };
        format!(
            "Signal at {} {spectral_unit}{selected} ({signal_unit})",
            format_f64(wave_axis[*index])
        )
    }));
    headers.iter_mut().for_each(|value| {
        *value = sanitize_labtalk_label(value);
    });

    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    writeln!(file, "{}", headers.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    let row_count = wave_axis.len().max(time_axis.len());
    for row in 0..row_count {
        let mut fields = Vec::with_capacity(headers.len());
        fields.push(
            wave_axis
                .get(row)
                .copied()
                .map(format_f64)
                .unwrap_or_default(),
        );
        fields.extend(time_indices.iter().map(|index| {
            matrix
                .get(row)
                .and_then(|values| values.get(*index))
                .copied()
                .map(format_f64)
                .unwrap_or_default()
        }));
        fields.push(
            time_axis
                .get(row)
                .copied()
                .map(format_f64)
                .unwrap_or_default(),
        );
        fields.extend(wavelength_indices.iter().map(|index| {
            matrix
                .get(*index)
                .and_then(|values| values.get(row))
                .copied()
                .map(format_f64)
                .unwrap_or_default()
        }));
        writeln!(file, "{}", fields.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(vec![0, kinetics_x_column])
}

#[allow(clippy::too_many_arguments)]
fn write_spectra_table(
    path: &Path,
    wave_axis: &[f64],
    spectra: &[Vec<f64>],
    descriptor: &serde_json::Value,
    fit_metadata: Option<&serde_json::Value>,
    time_unit: &str,
    spectral_unit: &str,
    kind: &str,
) -> Result<(), String> {
    let labels = descriptor["labels"].as_array();
    let lifetimes = descriptor["lifetimes"].as_array();
    let metadata = fit_metadata.and_then(serde_json::Value::as_object);
    let hide_irf_limited = metadata
        .and_then(|value| value.get("originHideIrfLimited"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let irf_limited = metadata
        .and_then(|value| value.get("irfLimited"))
        .and_then(serde_json::Value::as_array);
    let visible_indices: Vec<usize> = (0..spectra.len())
        .filter(|index| {
            !hide_irf_limited
                || !irf_limited
                    .and_then(|values| values.get(*index))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        })
        .collect();

    let mut headers = vec![format!("Wavelength ({spectral_unit})")];
    headers.extend(visible_indices.iter().map(|index| {
        let label = labels
            .and_then(|values| values.get(*index))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{kind} {}", index + 1));
        let lifetime = lifetimes
            .and_then(|values| values.get(*index))
            .and_then(serde_json::Value::as_f64);
        let lifetime_text = lifetime
            .filter(|value| value.is_finite())
            .map(|value| format!(", tau={} {time_unit}", format_f64(value)))
            .unwrap_or_default();
        let limited = irf_limited
            .and_then(|values| values.get(*index))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let status = if limited { " (IRF-limited)" } else { "" };
        format!("{label}{lifetime_text}{status}")
    }));
    headers.iter_mut().for_each(|value| {
        *value = sanitize_labtalk_label(value);
    });

    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    writeln!(file, "{}", headers.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    for (row, wavelength) in wave_axis.iter().enumerate() {
        let mut fields = vec![format_f64(*wavelength)];
        fields.extend(visible_indices.iter().map(|index| {
            spectra
                .get(*index)
                .and_then(|values| values.get(row))
                .copied()
                .map(format_f64)
                .unwrap_or_default()
        }));
        writeln!(file, "{}", fields.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

fn representative_indices(length: usize, selected_index: usize, base_count: usize) -> Vec<usize> {
    if length == 0 {
        return Vec::new();
    }
    if length <= base_count {
        return (0..length).collect();
    }
    let mut indices: Vec<usize> = (0..base_count)
        .map(|position| {
            ((position as f64) * ((length - 1) as f64) / ((base_count - 1) as f64)).round() as usize
        })
        .collect();
    indices.push(selected_index.min(length - 1));
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn format_f64(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value == f64::INFINITY {
        "Infinity".to_string()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        value.to_string()
    }
}

/// Sanitize a dataset name for LabTalk (ASCII-safe, no special chars).
fn sanitize_for_labtalk(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .replace(' ', "_")
        .chars()
        .take(25)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_preserves_ascii() {
        assert_eq!(sanitize_for_labtalk("VIS_Probe_1"), "VIS_Probe_1");
    }

    #[test]
    fn sanitize_replaces_unicode() {
        // 4 Chinese characters → 4 underscores
        assert_eq!(sanitize_for_labtalk("样品数据"), "____");
    }

    #[test]
    fn sanitize_truncates_long_names() {
        let long = "a".repeat(50);
        assert_eq!(sanitize_for_labtalk(&long).len(), 25);
    }

    #[test]
    fn stages_a_valid_origin_bundle_without_inventing_a_matrix_header() {
        use std::io::Cursor;
        use zip::write::SimpleFileOptions;

        let root = std::env::temp_dir().join(format!(
            "sfl-labtalk-valid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let bundle = root.join("valid.sflorigin");
        let manifest = serde_json::json!({
            "bundleSchema": "specflowlab.origin_bundle.v1",
            "sourceProjectSchema": "specflowlab.desktop_preview.v3",
            "appVersion": "test",
            "folders": [{"id": "folder-1", "name": "VIS"}],
            "datasets": [{
                "id": "dataset-1",
                "folderId": "folder-1",
                "directory": "datasets/0001",
                "projectLabel": "VIS sample",
                "sampleNote": "Round trip",
                "source": {"fileName": "sample.csv", "format": "csv"},
                "units": {"time": "ps", "spectral": "nm", "signal": "Delta A"},
                "selection": {"timeIndex": 2, "wavelengthIndex": 1},
                "analysis": {
                    "metadata": {"provenance": [{"label": "Baseline", "status": "applied"}]},
                    "timeAxis": {"entry": "datasets/0001/treated-time.f64", "length": 3},
                    "spectralAxis": {"entry": "datasets/0001/treated-wavelength.f64", "length": 2},
                    "matrix": {"entry": "datasets/0001/treated-matrix.f64", "rows": 2, "cols": 3}
                },
                "fit": {
                    "metadata": {
                        "componentCount": 2,
                        "lifetimes": [0.5, 12],
                        "irfLimited": [false, false],
                        "originHideIrfLimited": true,
                        "rmse": 0.001
                    },
                    "fittedMatrix": {"entry": "datasets/0001/fitted-matrix.f64", "rows": 2, "cols": 3},
                    "residualMatrix": {"entry": "datasets/0001/residual-matrix.f64", "rows": 2, "cols": 3},
                    "das": {
                        "entry": "datasets/0001/das-spectra.f64",
                        "rows": 2,
                        "cols": 2,
                        "labels": ["DAS 1", "DAS 2"],
                        "lifetimes": [0.5, 12]
                    },
                    "eas": {
                        "entry": "datasets/0001/eas-spectra.f64",
                        "rows": 2,
                        "cols": 2,
                        "labels": ["EAS 1", "EAS 2"],
                        "lifetimes": [0.5, 12]
                    }
                }
            }]
        });
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        for (name, values) in [
            ("datasets/0001/treated-time.f64", vec![-1.0, 0.0, 1.5]),
            ("datasets/0001/treated-wavelength.f64", vec![500.0, 510.0]),
            (
                "datasets/0001/treated-matrix.f64",
                vec![1.0, 2.0, 3.0, 4.0, f64::NAN, 6.123456789012345],
            ),
            (
                "datasets/0001/fitted-matrix.f64",
                vec![0.9, 1.9, 2.9, 3.9, 4.9, 5.9],
            ),
            (
                "datasets/0001/residual-matrix.f64",
                vec![0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
            ),
            (
                "datasets/0001/das-spectra.f64",
                vec![10.0, 11.0, 20.0, 21.0],
            ),
            (
                "datasets/0001/eas-spectra.f64",
                vec![30.0, 31.0, 40.0, 41.0],
            ),
        ] {
            writer.start_file(name, options).unwrap();
            for value in values {
                writer.write_all(&value.to_le_bytes()).unwrap();
            }
        }
        let bytes = writer.finish().unwrap().into_inner();
        fs::write(&bundle, bytes).unwrap();

        let stage = stage_labtalk_import(&bundle).unwrap();
        assert_eq!(stage.dataset_count, 1);
        assert_eq!(stage.sheet_count, 8);
        let table = fs::read_to_string(
            stage
                .run_directory
                .join("0001-VIS_sample")
                .join("treated-vm.txt"),
        )
        .unwrap();
        assert_eq!(
            table,
            "Wavelength (nm)\t\t\t\n\t-1\t0\t1.5\n500\t1\t2\t3\n510\t4\tNaN\t6.123456789012345\n"
        );
        let metadata = fs::read_to_string(
            stage
                .run_directory
                .join("0001-VIS_sample")
                .join("metadata.txt"),
        )
        .unwrap();
        assert!(metadata.contains("Display name\tVIS sample"));
        assert!(metadata.contains("Folder\tVIS"));
        assert!(metadata.contains("Treatment metadata\t{\"provenance\""));
        let das = fs::read_to_string(stage.run_directory.join("0001-VIS_sample").join("das.txt"))
            .unwrap();
        assert_eq!(
            das,
            "Wavelength (nm)\tDAS 1, tau=0.5 ps\tDAS 2, tau=12 ps\n500\t10\t20\n510\t11\t21\n"
        );
        let com_manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&stage.manifest_path).unwrap()).unwrap();
        assert_eq!(com_manifest["schema"], "specflowlab.origin_com_import.v2");
        assert_eq!(com_manifest["datasets"][0]["workbookName"], "SFL0001");
        assert_eq!(com_manifest["datasets"][0]["label"], "VIS_sample");
        let sheet_names: Vec<&str> = com_manifest["datasets"][0]["sheets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|sheet| sheet["name"].as_str())
            .collect();
        assert_eq!(
            sheet_names,
            [
                "Metadata",
                "TreatedVM",
                "Selected",
                "FitSummary",
                "FittedVM",
                "ResidualVM",
                "DAS",
                "EAS"
            ]
        );
        let _ = fs::remove_dir_all(&stage.run_directory);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stages_from_empty_zip_fails() {
        let dir = std::env::temp_dir().join("sfl-labtalk-empty");
        let _ = fs::create_dir_all(&dir);
        let bundle = dir.join("empty.sflorigin");
        fs::write(&bundle, b"not a zip").unwrap();
        let result = stage_labtalk_import(&bundle);
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn representative_indices_include_selection_without_duplicates() {
        assert_eq!(representative_indices(3, 1, 5), vec![0, 1, 2]);
        assert_eq!(representative_indices(10, 4, 5), vec![0, 2, 4, 5, 7, 9]);
    }
}
