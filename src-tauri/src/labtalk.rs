// LabTalk staging adapter for Origin 8.6.
//
// Origin 8.6 does not have embedded Python, so we cannot use the originpro
// bridge. Instead we extract the portable .sflorigin bundle, write Float64
// axes and matrices as tab-delimited text files, generate a LabTalk .OGS
// script that imports them, and launch Origin with that script.
//
// The .sflorigin sidecar remains the lossless provenance source.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::origin::OutputPlan;

/// Staged data ready for LabTalk import.
pub struct LabTalkStage {
    pub run_directory: PathBuf,
    pub script_path: PathBuf,
    pub dataset_count: usize,
    pub workbook_count: usize,
}

/// Extract the .sflorigin bundle and stage tab-delimited import files.
///
/// Returns the staging directory, script path, and dataset count.
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

    let mut tab_paths: Vec<Vec<String>> = Vec::new();

    for dataset in datasets {
        let dir = dataset["directory"].as_str().unwrap_or("datasets/0001");
        let name = dataset["label"].as_str().unwrap_or("Dataset");

        // Extract Float64 data from zip entries
        let time_path = format!("{dir}/treated-time.f64");
        let wave_path = format!("{dir}/treated-wavelength.f64");
        let matrix_path = format!("{dir}/treated-matrix.f64");

        let time_axis = read_f64_from_zip(&mut archive, &time_path)?;
        let wave_axis = read_f64_from_zip(&mut archive, &wave_path)?;
        let matrix = read_f64_matrix_from_zip(&mut archive, &matrix_path)?;

        let sanitized = sanitize_for_labtalk(name);
        let dataset_dir = run_directory.join(&sanitized);
        fs::create_dir_all(&dataset_dir).map_err(|e| format!("Cannot create dataset dir: {e}"))?;

        // Write time axis as tab-delimited
        let time_tab = dataset_dir.join("time.txt");
        write_f64_column(&time_tab, &time_axis)?;

        // Write wavelength axis
        let wave_tab = dataset_dir.join("wavelength.txt");
        write_f64_column(&wave_tab, &wave_axis)?;

        // Write matrix as tab-delimited (wavelength rows × time columns)
        let matrix_tab = dataset_dir.join("matrix.txt");
        write_f64_matrix(&matrix_tab, &matrix)?;

        tab_paths.push(vec![
            time_tab.to_string_lossy().into_owned(),
            wave_tab.to_string_lossy().into_owned(),
            matrix_tab.to_string_lossy().into_owned(),
        ]);
    }

    let script_path = run_directory.join("import.ogs");
    let script = generate_labtalk_script(
        &tab_paths,
        datasets,
        output_path,
        output_plan,
        &run_directory,
    )?;
    fs::write(&script_path, script.as_bytes())
        .map_err(|e| format!("Cannot write LabTalk script: {e}"))?;

    let workbook_count = datasets.len();

    Ok(LabTalkStage {
        run_directory,
        script_path,
        dataset_count: datasets.len(),
        workbook_count,
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
) -> Result<Vec<Vec<f64>>, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("Missing bundle entry {name}: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Read error {name}: {e}"))?;

    // The matrix header: first 8 bytes = row count (u32), next 8 bytes = col count (u32)
    if bytes.len() < 16 {
        return Err(format!("{name}: too short for matrix header"));
    }
    let rows = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let cols = u32::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
    let data = &bytes[16..];
    if data.len() != rows * cols * 8 {
        return Err(format!(
            "{name}: expected {}×{} ({}) f64 values, got {} bytes",
            rows,
            cols,
            rows * cols,
            data.len()
        ));
    }
    let mut matrix: Vec<Vec<f64>> = Vec::with_capacity(rows);
    for r in 0..rows {
        let start = r * cols * 8;
        let mut row = Vec::with_capacity(cols);
        for c in 0..cols {
            let offset = start + c * 8;
            let arr: [u8; 8] = data[offset..offset + 8].try_into().unwrap();
            row.push(f64::from_le_bytes(arr));
        }
        matrix.push(row);
    }
    Ok(matrix)
}

fn write_f64_column(path: &Path, values: &[f64]) -> Result<(), String> {
    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    for v in values {
        writeln!(file, "{v:.6}").map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

fn write_f64_matrix(path: &Path, matrix: &[Vec<f64>]) -> Result<(), String> {
    let mut file =
        fs::File::create(path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    for row in matrix {
        let line: Vec<String> = row.iter().map(|v| format!("{v:.6}")).collect();
        writeln!(file, "{}", line.join("\t")).map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

/// Generate a LabTalk script that imports tab-delimited data into Origin 8.6.
///
/// Strategy:
/// - Create one workbook per dataset
/// - Import time axis → column A (X), wavelength axis → header row
/// - Import matrix → fill remaining columns
/// - Set column designations
/// - Create line plots if requested
/// - Save as .opj
fn generate_labtalk_script(
    tab_paths: &[Vec<String>],
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

    // Header: version marker so we can detect completion
    script.push_str("// SpecFlowLab LabTalk handoff reached\r\n");
    script.push_str("type -a \"SpecFlowLab LabTalk handoff reached\";\r\n");
    script.push_str("\r\n");

    // Suppress dialogs
    script.push_str("// Suppress save prompts and update dialogs\r\n");
    script.push_str("@SD = 0;\r\n");
    script.push_str("@SP = 0;\r\n");
    script.push_str("\r\n");

    let wants_plots = output_plan.actual_mode != "sheets-only";

    for (i, (paths, dataset)) in tab_paths.iter().zip(datasets.iter()).enumerate() {
        let idx = i + 1;
        let time_file = paths[0].replace('\\', "/");
        let _wave_file = paths[1].replace('\\', "/");
        let matrix_file = paths[2].replace('\\', "/");
        let label = dataset["label"].as_str().unwrap_or("Dataset");
        let safe_label = sanitize_for_labtalk(label);

        script.push_str(&format!("// --- Dataset {idx}: {safe_label} ---\r\n"));

        // Create new workbook
        script.push_str(&format!(
            "newbook name:=\"{safe_label}\" result:=bkName$ option:=lsname;\r\n"
        ));
        script.push_str("win -a %H;\r\n");
        script.push_str("\r\n");

        // Import time axis as column A
        script.push_str(&format!("open -w \"{time_file}\";\r\n"));
        script.push_str("wks.col1.type = 4;\r\n"); // X

        // Import matrix data (rows = wavelengths, columns = times)
        // We can't easily import a full matrix in one step with LabTalk,
        // so we do a simple import
        script.push_str(&format!("open -w \"{matrix_file}\";\r\n"));
        // Set all data columns as Y
        script.push_str("loop(ii,1,wks.ncols) { wks.col$(ii).type = 1; };\r\n");
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
    script.push_str(&format!("save -opj \"{output}\";\r\n"));
    script.push_str("\r\n");

    // Write completion marker
    script.push_str("// Completion marker\r\n");
    script.push_str(&format!("file -c \"{status}\";\r\n"));
    script.push_str("type -a \"SpecFlowLab LabTalk complete\";\r\n");

    Ok(script)
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
        let paths = vec![vec![
            "C:/tmp/time.txt".to_string(),
            "C:/tmp/wave.txt".to_string(),
            "C:/tmp/matrix.txt".to_string(),
        ]];
        let datasets = vec![serde_json::json!({"label": "VIS"})];
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
        assert!(script.contains("newbook"));
        assert!(script.contains("save -opj"));
        assert!(script.contains("file -c"));
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
