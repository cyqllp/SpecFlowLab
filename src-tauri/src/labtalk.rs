// LabTalk staging adapter for Origin 8.6.
//
// Origin 8.6 does not have embedded Python, so we cannot use the originpro
// bridge. Instead we extract the portable .sflorigin bundle, write Float64
// axes and matrices as tab-delimited text files, generate a LabTalk .OGS
// script that imports them, and launch Origin with that script.
//
// The .sflorigin sidecar remains the lossless provenance source.
#![allow(dead_code)]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::origin::OutputPlan;

#[derive(Debug)]
pub struct LabTalkStage {
    pub run_directory: PathBuf,
    pub script_path: PathBuf,
    pub dataset_count: usize,
}

/// Extract the .sflorigin bundle and stage tab-delimited import files.
///
/// Returns the generated LabTalk stage and its expected dataset count.
pub fn stage_labtalk_import(
    bundle_path: &Path,
    output_path: &Path,
    output_plan: &OutputPlan,
) -> Result<LabTalkStage, String> {
    let run_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("timestamp error: {e}"))?
        .as_millis();
    let run_directory = std::env::temp_dir()
        .join("SpecFlowLab-LabTalk")
        .join(format!("{}-{run_id}", std::process::id()));
    fs::create_dir_all(&run_directory)
        .map_err(|e| format!("Cannot create LabTalk staging directory: {e}"))?;

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

    let mut table_paths: Vec<String> = Vec::new();

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

        // One deterministic wide worksheet: wavelength in column A, exact
        // time coordinates in the header row, signal values in B onward.
        let table_path = dataset_dir.join("worksheet.txt");
        write_wide_table(&table_path, &time_axis, &wave_axis, &matrix)?;
        table_paths.push(table_path.to_string_lossy().into_owned());
    }

    let script_path = run_directory.join("import.ogs");
    let script = generate_labtalk_script(
        &table_paths,
        datasets,
        output_path,
        output_plan,
        &run_directory,
    )?;
    fs::write(&script_path, script.as_bytes())
        .map_err(|e| format!("Cannot write LabTalk script: {e}"))?;

    Ok(LabTalkStage {
        run_directory,
        script_path,
        dataset_count: datasets.len(),
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

fn write_wide_table(
    path: &Path,
    time_axis: &[f64],
    wave_axis: &[f64],
    matrix: &[Vec<f64>],
) -> Result<(), String> {
    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    let mut header = vec!["Wavelength_nm".to_string()];
    header.extend(time_axis.iter().map(|value| format_f64(*value)));
    writeln!(file, "{}", header.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    for (wavelength, row) in wave_axis.iter().zip(matrix.iter()) {
        let mut fields = Vec::with_capacity(row.len() + 1);
        fields.push(format_f64(*wavelength));
        fields.extend(row.iter().map(|value| format_f64(*value)));
        writeln!(file, "{}", fields.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

fn format_f64(value: f64) -> String {
    if value.is_finite() {
        value.to_string()
    } else {
        String::new()
    }
}

/// Generate a LabTalk script that imports tab-delimited data into Origin 8.6.
///
/// Strategy:
/// - Create one workbook per dataset
/// - Import wavelength axis into column A (X)
/// - Store exact time coordinates in the remaining column long names
/// - Import the matrix into the remaining Y columns
/// - Set column designations
/// - Create line plots if requested
/// - Save as .opj
fn generate_labtalk_script(
    table_paths: &[String],
    datasets: &[serde_json::Value],
    output_path: &Path,
    output_plan: &OutputPlan,
    run_directory: &Path,
) -> Result<String, String> {
    let output = output_path.to_string_lossy().replace('\\', "/");
    let _run_dir = run_directory.to_string_lossy().replace('\\', "/");
    let status_path = output_path.with_extension("origin-status.json");
    let status = status_path.to_string_lossy().replace('\\', "/");

    let mut script = String::new();

    script.push_str("[Main]\r\n");

    // Header: version marker so the startup log confirms the handoff.
    script.push_str("// SpecFlowLab LabTalk handoff reached\r\n");
    script.push_str("type -a \"SpecFlowLab LabTalk handoff reached\";\r\n");
    script.push_str("\r\n");

    push_status_json(&mut script, &status, "started", datasets.len());

    // Suppress dialogs
    script.push_str("// Suppress save prompts and update dialogs\r\n");
    script.push_str("@SD = 0;\r\n");
    script.push_str("@SP = 0;\r\n");
    script.push_str("\r\n");

    let wants_plots = output_plan.actual_mode != "sheets-only";

    for (i, (table_path, dataset)) in table_paths.iter().zip(datasets.iter()).enumerate() {
        let idx = i + 1;
        let table_file = table_path.replace('\\', "/");
        let label = dataset["projectLabel"].as_str().unwrap_or("Dataset");
        let safe_label = sanitize_for_labtalk(label);
        let workbook_name = format!("SFL{idx:04}");

        script.push_str(&format!("// --- Dataset {idx}: {safe_label} ---\r\n"));

        // Create new workbook
        script.push_str(&format!(
            "newbook name:=\"{workbook_name}\" result:=bkName$ option:=lsname;\r\n"
        ));
        script.push_str("win -a %H;\r\n");
        script.push_str(&format!("page.label$ = \"{safe_label}\";\r\n"));
        script.push_str("\r\n");

        // The first row becomes column Long Names. Column A contains the
        // wavelength axis; B onward contain signals at the exact time values
        // recorded in their Long Names.
        script.push_str("wo -k 1;\r\n");
        script.push_str(&format!("open -w \"{table_file}\";\r\n"));
        script.push_str("wks.col1.type = 4;\r\n");
        script.push_str("wks.col1.lname$ = \"Wavelength\";\r\n");
        script.push_str("wks.col1.units$ = \"nm\";\r\n");
        script.push_str("loop(ii,2,wks.ncols) { wks.col$(ii).type = 1; };\r\n");
        script.push_str(&format!("wks.name$ = \"{safe_label}\";\r\n"));
        script.push_str("\r\n");

        // Line plots
        if wants_plots {
            script.push_str("plotxy iy:=(1,2) plot:=200 ogl:=[<new>]!;\r\n");
            script.push_str(&format!(
                "label -s -px 0 -py 0 -sa -n MyGraph Legend \"{safe_label}\";\r\n"
            ));
            script.push_str("\r\n");
        }
    }

    // Save project
    script.push_str("// Save project\r\n");
    script.push_str(&format!("save \"{output}\";\r\n"));
    script.push_str("\r\n");

    // Atomic replacement is unavailable in Origin 8.6 LabTalk. Write the
    // completed JSON only after save returns; the Rust monitor validates the
    // non-empty OPJ before reporting success.
    push_status_json(&mut script, &status, "completed", datasets.len());
    script.push_str("type -a \"SpecFlowLab LabTalk complete\";\r\n");

    Ok(script)
}

fn push_status_json(script: &mut String, status_path: &str, state: &str, dataset_count: usize) {
    script.push_str(&format!("type -gbef \"{status_path}\";\r\n"));
    script.push_str(&format!(
        "type \"{{\\x22state\\x22:\\x22{state}\\x22,\\x22datasetCount\\x22:{dataset_count},\\x22workbookCount\\x22:{dataset_count},\\x22graphCount\\x22:0,\\x22warnings\\x22:[]}}\";\r\n"
    ));
    script.push_str("type -ge;\r\n");
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
    fn labtalk_script_includes_save_and_status() {
        let paths = vec!["C:/tmp/worksheet.txt".to_string()];
        let datasets = vec![serde_json::json!({"projectLabel": "VIS"})];
        let plan = OutputPlan {
            actual_mode: "sheets-only".to_string(),
            created_graph_types: vec![],
            omitted_graph_types: vec![],
            omission_reasons: vec![],
        };
        let script = generate_labtalk_script(
            &paths,
            &datasets,
            Path::new("C:/output/project.opj"),
            &plan,
            Path::new("C:/tmp/SpecFlowLab-LabTalk"),
        )
        .unwrap();

        assert!(script.contains("SpecFlowLab LabTalk handoff reached"));
        assert!(script.contains("[Main]"));
        assert!(script.contains("newbook"));
        assert!(script.contains("open -w \"C:/tmp/worksheet.txt\""));
        assert!(script.contains("save \"C:/output/project.opj\""));
        assert!(script.contains("type -gbef"));
        assert!(script.contains("\\x22state\\x22:\\x22completed\\x22"));
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
            "datasets": [{
                "directory": "datasets/0001",
                "projectLabel": "VIS sample",
                "analysis": {
                    "timeAxis": {"entry": "datasets/0001/treated-time.f64", "length": 3},
                    "spectralAxis": {"entry": "datasets/0001/treated-wavelength.f64", "length": 2},
                    "matrix": {"entry": "datasets/0001/treated-matrix.f64", "rows": 2, "cols": 3}
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
        ] {
            writer.start_file(name, options).unwrap();
            for value in values {
                writer.write_all(&value.to_le_bytes()).unwrap();
            }
        }
        let bytes = writer.finish().unwrap().into_inner();
        fs::write(&bundle, bytes).unwrap();

        let stage = stage_labtalk_import(
            &bundle,
            Path::new("C:/out.opj"),
            &OutputPlan {
                actual_mode: "sheets-only".to_string(),
                created_graph_types: vec![],
                omitted_graph_types: vec![],
                omission_reasons: vec![],
            },
        )
        .unwrap();
        assert_eq!(stage.dataset_count, 1);
        let table = fs::read_to_string(
            stage
                .run_directory
                .join("0001-VIS_sample")
                .join("worksheet.txt"),
        )
        .unwrap();
        assert_eq!(
            table,
            "Wavelength_nm\t-1\t0\t1.5\n500\t1\t2\t3\n510\t4\t\t6.123456789012345\n"
        );
        let script = fs::read_to_string(&stage.script_path).unwrap();
        assert!(!script.contains("run.python"));
        assert!(!script.contains("projectLabel"));
        let _ = fs::remove_dir_all(&stage.run_directory);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stages_from_empty_zip_fails() {
        let dir = std::env::temp_dir().join("sfl-labtalk-empty");
        let _ = fs::create_dir_all(&dir);
        let bundle = dir.join("empty.sflorigin");
        fs::write(&bundle, b"not a zip").unwrap();
        let result = stage_labtalk_import(
            &bundle,
            Path::new("C:/out.opj"),
            &OutputPlan {
                actual_mode: "sheets-only".to_string(),
                created_graph_types: vec![],
                omitted_graph_types: vec![],
                omission_reasons: vec![],
            },
        );
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
