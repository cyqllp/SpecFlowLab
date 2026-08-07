#[cfg(any(target_os = "windows", test))]
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
#[cfg(target_os = "windows")]
use std::{
    os::windows::process::CommandExt,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
const ORIGIN_BRIDGE_SOURCE: &str = include_str!("../../integrations/origin/specflowlab_origin.py");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginLaunchResult {
    origin_executable: String,
    bundle_path: String,
    output_path: String,
    log_path: String,
    status_path: String,
    dataset_count: usize,
    workbook_count: usize,
    graph_count: usize,
    output_bytes: u64,
    warning_count: usize,
    create_plots: bool,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginJobStatus {
    state: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    traceback: Option<String>,
    #[serde(default)]
    dataset_count: Option<usize>,
    #[serde(default)]
    workbook_count: Option<usize>,
    #[serde(default)]
    graph_count: Option<usize>,
    #[serde(default)]
    output_bytes: Option<u64>,
    #[serde(default)]
    warnings: Vec<String>,
}

fn safe_default_name(default_name: &str, fallback: &str) -> String {
    Path::new(default_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn extension_filter(file_type: &str) -> (&'static str, &'static [&'static str]) {
    match file_type {
        "project" => ("SpecFlowLab Project", &["sflproj"]),
        "origin" => ("SpecFlowLab Origin Bundle", &["sflorigin"]),
        "origin-project" => ("Origin Project", &["opju"]),
        "markdown" => ("Markdown", &["md"]),
        "csv" => ("CSV", &["csv"]),
        "png" => ("PNG Image", &["png"]),
        "txt" => ("Tab-delimited Text", &["txt"]),
        _ => ("File", &["txt"]),
    }
}

#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    default_name: String,
    file_type: String,
    contents: String,
) -> Result<Option<String>, String> {
    let (label, extensions) = extension_filter(&file_type);
    let default_name = safe_default_name(&default_name, "SpecFlowLab_export.txt");
    let selected = app
        .dialog()
        .file()
        .add_filter(label, extensions)
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| {
        format!("The selected destination is not a writable file path: {error}")
    })?;
    std::fs::write(&path, contents.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn save_binary_file(
    app: tauri::AppHandle,
    default_name: String,
    file_type: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let (label, extensions) = extension_filter(&file_type);
    let default_name = safe_default_name(&default_name, "SpecFlowLab_export.bin");
    let selected = app
        .dialog()
        .file()
        .add_filter(label, extensions)
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| {
        format!("The selected destination is not a writable file path: {error}")
    })?;
    std::fs::write(&path, bytes)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn create_origin_project(
    app: tauri::AppHandle,
    default_name: String,
    bytes: Vec<u8>,
    create_plots: bool,
) -> Result<Option<OriginLaunchResult>, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(mut result) =
            create_origin_project_on_windows(&app, &default_name, &bytes, create_plots)?
        else {
            return Ok(None);
        };
        let status_path = PathBuf::from(&result.status_path);
        let output_path = PathBuf::from(&result.output_path);
        let log_path = PathBuf::from(&result.log_path);
        let status = tauri::async_runtime::spawn_blocking(move || {
            wait_for_origin_result(&status_path, &output_path, &log_path)
        })
        .await
        .map_err(|error| format!("Could not monitor the OriginPro import task: {error}"))??;
        result.dataset_count = status.dataset_count.unwrap_or_default();
        result.workbook_count = status.workbook_count.unwrap_or_default();
        result.graph_count = status.graph_count.unwrap_or_default();
        result.output_bytes = status.output_bytes.unwrap_or_default();
        result.warning_count = status.warnings.len();
        Ok(Some(result))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, default_name, bytes, create_plots);
        Err("Create in OriginPro is available in the Windows SpecFlowLab app. Use Export Origin Bundle on this platform.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn create_origin_project_on_windows(
    app: &tauri::AppHandle,
    default_name: &str,
    bytes: &[u8],
    create_plots: bool,
) -> Result<Option<OriginLaunchResult>, String> {
    let Some(origin_executable) = resolve_origin_executable(app)? else {
        return Ok(None);
    };

    let default_name = safe_default_name(default_name, "SpecFlowLab_project.opju");
    let selected = app
        .dialog()
        .file()
        .add_filter("Origin Project", &["opju"])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut output_path = selected.into_path().map_err(|error| {
        format!("The selected Origin destination is not a writable file path: {error}")
    })?;
    if !output_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("opju"))
    {
        output_path.set_extension("opju");
    }

    let parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "The Origin project destination has no parent folder.".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not prepare the Origin project folder {}: {error}",
            parent.display()
        )
    })?;

    let bundle_path = unique_sidecar_path(&output_path, "sflorigin");
    std::fs::write(&bundle_path, bytes).map_err(|error| {
        format!(
            "Could not write the Origin provenance bundle {}: {error}",
            bundle_path.display()
        )
    })?;

    let run_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create an Origin launch timestamp: {error}"))?
        .as_millis();
    let run_directory = std::env::temp_dir()
        .join("SpecFlowLab-OriginBridge")
        .join(format!("{}-{run_id}", std::process::id()));
    std::fs::create_dir_all(&run_directory).map_err(|error| {
        format!(
            "Could not prepare the Origin bridge folder {}: {error}",
            run_directory.display()
        )
    })?;

    let bridge_path = run_directory.join("specflowlab_origin.py");
    let launcher_path = run_directory.join("launch_specflowlab_origin.py");
    let log_path = output_path.with_extension("origin-startup.log");
    let status_path = output_path.with_extension("origin-status.json");

    for generated_path in [&log_path, &status_path] {
        if generated_path.exists() {
            std::fs::remove_file(generated_path).map_err(|error| {
                format!(
                    "Could not replace the previous Origin diagnostic file {}: {error}",
                    generated_path.display()
                )
            })?;
        }
    }
    if output_path
        .metadata()
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(false)
    {
        std::fs::remove_file(&output_path).map_err(|error| {
            format!(
                "Could not remove the empty Origin save-dialog placeholder {}: {error}",
                output_path.display()
            )
        })?;
    }

    std::fs::write(&bridge_path, ORIGIN_BRIDGE_SOURCE.as_bytes()).map_err(|error| {
        format!(
            "Could not prepare the embedded Origin bridge {}: {error}",
            bridge_path.display()
        )
    })?;
    std::fs::write(
        &launcher_path,
        origin_launcher_source(
            &run_directory,
            &bundle_path,
            &output_path,
            &status_path,
            create_plots,
        ),
    )
    .map_err(|error| {
        format!(
            "Could not prepare the Origin Python launcher {}: {error}",
            launcher_path.display()
        )
    })?;
    let launcher_for_labtalk = labtalk_path(&launcher_path)?;
    let origin_startup_script = origin_startup_labtalk(&launcher_for_labtalk);
    Command::new(&origin_executable)
        .arg("-slog")
        .arg(&log_path)
        .arg("-rs")
        // Origin parses everything after -RS as raw LabTalk. Normal Windows
        // argv quoting can wrap this entire expression so it is not executed.
        .raw_arg(origin_startup_script)
        .spawn()
        .map_err(|error| {
            format!(
                "Could not launch OriginPro from {}: {error}",
                origin_executable.display()
            )
        })?;

    Ok(Some(OriginLaunchResult {
        origin_executable: origin_executable.to_string_lossy().into_owned(),
        bundle_path: bundle_path.to_string_lossy().into_owned(),
        output_path: output_path.to_string_lossy().into_owned(),
        log_path: log_path.to_string_lossy().into_owned(),
        status_path: status_path.to_string_lossy().into_owned(),
        dataset_count: 0,
        workbook_count: 0,
        graph_count: 0,
        output_bytes: 0,
        warning_count: 0,
        create_plots,
    }))
}

#[cfg(target_os = "windows")]
fn wait_for_origin_result(
    status_path: &Path,
    output_path: &Path,
    log_path: &Path,
) -> Result<OriginJobStatus, String> {
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
    const IMPORT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
    const POLL_INTERVAL: Duration = Duration::from_millis(500);

    let started_at = Instant::now();
    let mut observed_python = false;
    loop {
        if status_path.is_file() {
            let status_text = std::fs::read_to_string(status_path).map_err(|error| {
                format!(
                    "Could not read Origin status file {}: {error}",
                    status_path.display()
                )
            })?;
            let status: OriginJobStatus = serde_json::from_str(&status_text).map_err(|error| {
                format!(
                    "Origin wrote an invalid status file {}: {error}",
                    status_path.display()
                )
            })?;
            observed_python = true;
            match status.state.as_str() {
                "completed" => {
                    let dataset_count = status.dataset_count.unwrap_or_default();
                    let workbook_count = status.workbook_count.unwrap_or_default();
                    let actual_bytes = output_path
                        .metadata()
                        .map_err(|error| {
                            format!(
                                "Origin reported completion, but the project {} is unavailable: {error}",
                                output_path.display()
                            )
                        })?
                        .len();
                    if dataset_count == 0 || workbook_count != dataset_count || actual_bytes == 0 {
                        return Err(format!(
                            "Origin reported completion without a valid populated project (datasets: {dataset_count}, workbooks: {workbook_count}, bytes: {actual_bytes}). Status: {}. Startup log: {}.",
                            status_path.display(),
                            log_path.display()
                        ));
                    }
                    return Ok(status);
                }
                "failed" => {
                    let error = status
                        .error
                        .as_deref()
                        .unwrap_or("Origin's embedded Python reported an unspecified error.");
                    let traceback = status.traceback.as_deref().unwrap_or("");
                    return Err(format!(
                        "Origin import failed: {error}\n{traceback}\nStatus: {}\nStartup log: {}{}",
                        status_path.display(),
                        log_path.display(),
                        origin_log_suffix(log_path)
                    ));
                }
                _ => {}
            }
        }

        let elapsed = started_at.elapsed();
        if !observed_python && elapsed >= STARTUP_TIMEOUT {
            return Err(format!(
                "OriginPro opened, but its embedded Python did not start the SpecFlowLab bridge within 120 seconds. Close all Origin windows and retry once. Status: {}. Startup log: {}{}",
                status_path.display(),
                log_path.display(),
                origin_log_suffix(log_path)
            ));
        }
        if observed_python && elapsed >= IMPORT_TIMEOUT {
            return Err(format!(
                "Origin's embedded Python started but did not finish the import within 30 minutes. Status: {}. Startup log: {}{}",
                status_path.display(),
                log_path.display(),
                origin_log_suffix(log_path)
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(target_os = "windows")]
fn origin_log_suffix(log_path: &Path) -> String {
    let Ok(log) = std::fs::read_to_string(log_path) else {
        return String::new();
    };
    let tail_reversed: String = log.chars().rev().take(4000).collect();
    let tail: String = tail_reversed.chars().rev().collect();
    if tail.trim().is_empty() {
        String::new()
    } else {
        format!("\nOrigin startup log tail:\n{tail}")
    }
}

#[cfg(target_os = "windows")]
fn resolve_origin_executable(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    for variable in ["SPECFLOWLAB_ORIGIN_EXE", "ORIGIN_EXE"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            validate_origin_executable(&path)?;
            persist_origin_executable(app, &path);
            return Ok(Some(path));
        }
    }

    if let Some(path) = saved_origin_executable(app) {
        return Ok(Some(path));
    }
    if let Some(path) = discover_origin_executable() {
        persist_origin_executable(app, &path);
        return Ok(Some(path));
    }

    let selected = app
        .dialog()
        .file()
        .add_filter("OriginPro executable", &["exe"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| {
        format!("The selected OriginPro executable is not a local file path: {error}")
    })?;
    validate_origin_executable(&path)?;
    persist_origin_executable(app, &path);
    Ok(Some(path))
}

#[cfg(target_os = "windows")]
fn validate_origin_executable(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "The configured OriginPro executable does not exist: {}",
            path.display()
        ));
    }
    if !is_origin_executable_candidate(path) {
        return Err(format!(
            "Please select the main OriginPro executable (for OriginPro 2021 this is commonly Origin98_64.exe), not {}.",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn origin_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("origin-executable.txt"))
}

#[cfg(target_os = "windows")]
fn saved_origin_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = std::fs::read_to_string(origin_config_path(app)?).ok()?;
    let path = PathBuf::from(path.trim());
    path.is_file()
        .then_some(path)
        .filter(|path| is_origin_executable_candidate(path))
}

#[cfg(target_os = "windows")]
fn persist_origin_executable(app: &tauri::AppHandle, origin_executable: &Path) {
    let Some(config_path) = origin_config_path(app) else {
        return;
    };
    if let Some(parent) = config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(config_path, origin_executable.to_string_lossy().as_bytes());
}

#[cfg(target_os = "windows")]
fn discover_origin_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(program_files) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        collect_origin_executables(&program_files.join("OriginLab"), 3, &mut candidates);
    }
    candidates.sort_by(|left, right| {
        origin_candidate_score(right)
            .cmp(&origin_candidate_score(left))
            .then_with(|| right.cmp(left))
    });
    candidates.into_iter().next()
}

#[cfg(target_os = "windows")]
fn collect_origin_executables(directory: &Path, depth: usize, candidates: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_origin_executables(&path, depth - 1, candidates);
        } else if is_origin_executable_candidate(&path) {
            candidates.push(path);
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_origin_executable_candidate(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lower = file_name.to_ascii_lowercase();
    lower.starts_with("origin")
        && lower.ends_with(".exe")
        && !["crash", "report", "update", "uninstall", "viewer"]
            .iter()
            .any(|fragment| lower.contains(fragment))
}

#[cfg(any(target_os = "windows", test))]
fn origin_candidate_score(path: &Path) -> u32 {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let file_name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut score = 0;
    if file_name.contains("_64") {
        score += 500;
    }
    if file_name
        .strip_prefix("origin")
        .and_then(|tail| tail.chars().next())
        .is_some_and(|character| character.is_ascii_digit())
    {
        score += 300;
    }
    for year in 2000..=2099 {
        if lower.contains(&format!("origin{year}")) {
            score += 1000 + year;
        }
    }
    score
}

#[cfg(target_os = "windows")]
fn unique_sidecar_path(output_path: &Path, extension: &str) -> PathBuf {
    let desired = output_path.with_extension(extension);
    if !desired.exists() {
        return desired;
    }
    let parent = output_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("SpecFlowLab_project");
    for index in 2..=9999 {
        let candidate = parent.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-{}.{}", std::process::id(), extension))
}

#[cfg(any(target_os = "windows", test))]
fn origin_startup_labtalk(launcher_for_labtalk: &str) -> String {
    format!(
        "type -a \"SpecFlowLab LabTalk handoff reached\";\
run.python(\"{launcher_for_labtalk}\",2);\
type -a \"SpecFlowLab Python call returned\";"
    )
}

#[cfg(any(target_os = "windows", test))]
fn origin_launcher_source(
    run_directory: &Path,
    bundle_path: &Path,
    output_path: &Path,
    status_path: &Path,
    create_plots: bool,
) -> String {
    let run_directory = python_string(run_directory);
    let bundle_path = python_string(bundle_path);
    let output_path = python_string(output_path);
    let status_path = python_string(status_path);
    let create_plots = if create_plots { "True" } else { "False" };
    format!(
        "import datetime\r\nimport json\r\nimport sys\r\nimport time\r\nimport traceback\r\nfrom pathlib import Path\r\n\r\nRUN_DIRECTORY = Path({run_directory})\r\nBUNDLE_PATH = Path({bundle_path})\r\nOUTPUT_PATH = Path({output_path})\r\nSTATUS_PATH = Path({status_path})\r\nCREATE_PLOTS = {create_plots}\r\n\r\ndef write_status(payload):\r\n    payload = dict(payload)\r\n    payload[\"updatedAt\"] = datetime.datetime.now(datetime.timezone.utc).isoformat()\r\n    temporary = Path(str(STATUS_PATH) + \".tmp\")\r\n    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding=\"utf-8\")\r\n    temporary.replace(STATUS_PATH)\r\n\r\nwrite_status({{\"state\": \"started\", \"bundlePath\": str(BUNDLE_PATH), \"outputPath\": str(OUTPUT_PATH), \"createPlots\": CREATE_PLOTS}})\r\ntry:\r\n    sys.path.insert(0, str(RUN_DIRECTORY))\r\n    import specflowlab_origin as sfo\r\n    project = sfo.load_project(BUNDLE_PATH)\r\n    write_status({{\"state\": \"importing\", \"datasetCount\": len(project.datasets), \"createPlots\": CREATE_PLOTS}})\r\n    result = sfo.import_project_into_origin(project, create_plots=CREATE_PLOTS, save_path=OUTPUT_PATH)\r\n    for _ in range(50):\r\n        if OUTPUT_PATH.is_file() and OUTPUT_PATH.stat().st_size > 0:\r\n            break\r\n        time.sleep(0.2)\r\n    if not OUTPUT_PATH.is_file() or OUTPUT_PATH.stat().st_size == 0:\r\n        raise RuntimeError(\"Origin returned from save without creating a non-empty OPJU project\")\r\n    completed = dict(result)\r\n    completed.update({{\"state\": \"completed\", \"outputBytes\": OUTPUT_PATH.stat().st_size}})\r\n    write_status(completed)\r\nexcept BaseException as error:\r\n    write_status({{\"state\": \"failed\", \"error\": str(error), \"traceback\": traceback.format_exc()}})\r\n    raise\r\n"
    )
}

#[cfg(any(target_os = "windows", test))]
fn python_string(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).expect("paths serialize as JSON strings")
}

#[cfg(target_os = "windows")]
fn labtalk_path(path: &Path) -> Result<String, String> {
    let path = path.to_string_lossy().replace('\\', "/");
    if path.contains('"') || path.contains('\r') || path.contains('\n') {
        return Err(format!(
            "Origin cannot safely quote the generated bridge path: {}",
            path
        ));
    }
    Ok(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            save_binary_file,
            create_origin_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running SpecFlowLab");
}

#[cfg(test)]
mod tests {
    use super::{
        is_origin_executable_candidate, origin_candidate_score, origin_launcher_source,
        origin_startup_labtalk, safe_default_name, OriginJobStatus,
    };
    use std::path::Path;

    #[test]
    fn accepts_originpro_2021_main_executable() {
        let path = Path::new("C:/Program Files/OriginLab/Origin2021/Origin98_64.exe");
        assert!(is_origin_executable_candidate(path));
        assert!(origin_candidate_score(path) > 3000);
    }

    #[test]
    fn rejects_origin_helper_executables() {
        assert!(!is_origin_executable_candidate(Path::new(
            "OriginCrashReporter.exe"
        )));
        assert!(!is_origin_executable_candidate(Path::new(
            "OriginUpdate.exe"
        )));
    }

    #[test]
    fn strips_directory_components_from_default_names() {
        assert_eq!(
            safe_default_name("../unsafe/project.opju", "fallback.opju"),
            "project.opju"
        );
    }

    #[test]
    fn origin_launcher_reports_started_importing_completed_and_failed_states() {
        let source = origin_launcher_source(
            Path::new("C:/Temp/SpecFlowLab-OriginBridge"),
            Path::new("C:/Data/project.sflorigin"),
            Path::new("C:/Data/project.opju"),
            Path::new("C:/Data/project.origin-status.json"),
            true,
        );
        for marker in [
            "\"state\": \"started\"",
            "\"state\": \"importing\"",
            "\"state\": \"completed\"",
            "\"state\": \"failed\"",
            "\"traceback\"",
            "\"outputBytes\"",
        ] {
            assert!(source.contains(marker), "launcher is missing {marker}");
        }
        assert!(source.contains("import_project_into_origin"));
        assert!(source.contains("CREATE_PLOTS = True"));
        assert!(source.contains("create_plots=CREATE_PLOTS"));
        assert!(source.contains("OUTPUT_PATH.stat().st_size > 0"));
    }

    #[test]
    fn origin_startup_script_calls_python_directly_and_records_handoff_markers() {
        let script =
            origin_startup_labtalk("C:/Temp/SpecFlowLab-OriginBridge/launch_specflowlab_origin.py");
        assert!(script.starts_with("type -a \"SpecFlowLab LabTalk handoff reached\";"));
        assert!(script.contains(
            "run.python(\"C:/Temp/SpecFlowLab-OriginBridge/launch_specflowlab_origin.py\",2);"
        ));
        assert!(script.ends_with("type -a \"SpecFlowLab Python call returned\";"));
        assert!(!script.contains('\r'));
        assert!(!script.contains('\n'));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn generated_origin_launcher_is_valid_python() {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };

        let source = origin_launcher_source(
            Path::new("C:/Temp/SpecFlowLab-OriginBridge"),
            Path::new("C:/Data/project.sflorigin"),
            Path::new("C:/Data/project.opju"),
            Path::new("C:/Data/project.origin-status.json"),
            false,
        );
        assert!(source.contains("CREATE_PLOTS = False"));
        let mut child = Command::new("python3")
            .args([
                "-c",
                "import sys; compile(sys.stdin.read(), '<SpecFlowLab launcher>', 'exec')",
            ])
            .stdin(Stdio::piped())
            .spawn()
            .expect("python3 should be available for launcher syntax validation");
        child
            .stdin
            .as_mut()
            .expect("Python syntax-check stdin should be available")
            .write_all(source.as_bytes())
            .expect("launcher source should be writable to Python");
        let status = child
            .wait()
            .expect("Python launcher syntax check should finish");
        assert!(status.success(), "generated launcher must parse as Python");
    }

    #[test]
    fn parses_completed_origin_status() {
        let status: OriginJobStatus = serde_json::from_str(
            r#"{
                "state": "completed",
                "datasetCount": 20,
                "workbookCount": 20,
                "graphCount": 100,
                "outputBytes": 123456,
                "warnings": []
            }"#,
        )
        .expect("completed Origin status should parse");
        assert_eq!(status.state, "completed");
        assert_eq!(status.dataset_count, Some(20));
        assert_eq!(status.workbook_count, Some(20));
        assert_eq!(status.graph_count, Some(100));
        assert_eq!(status.output_bytes, Some(123456));
        assert!(status.warnings.is_empty());
        assert!(status.error.is_none());
        assert!(status.traceback.is_none());
    }

    #[test]
    fn parses_failed_origin_status() {
        let status: OriginJobStatus = serde_json::from_str(
            r#"{
                "state": "failed",
                "error": "Origin import failed",
                "traceback": "Traceback (most recent call last):\n  File \"launcher.py\", line 1",
                "warnings": ["sheet skipped"]
            }"#,
        )
        .expect("failed Origin status should parse");
        assert_eq!(status.state, "failed");
        assert_eq!(status.error.as_deref(), Some("Origin import failed"));
        assert!(status
            .traceback
            .as_deref()
            .is_some_and(|traceback| traceback.starts_with("Traceback")));
        assert_eq!(status.warnings, vec!["sheet skipped"]);
    }
}
