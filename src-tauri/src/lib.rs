#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

#[cfg(any(target_os = "windows", test))]
use serde::Deserialize;
use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::{
    os::windows::process::CommandExt,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

mod labtalk;
mod origin;

#[cfg(target_os = "windows")]
const ORIGIN_BRIDGE_SOURCE: &str = include_str!("../../integrations/origin/specflowlab_origin.py");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct OriginLaunchResult {
    origin_executable: String,
    origin_display_name: String,
    origin_version: Option<String>,
    bitness: Option<u32>,
    backend: String,
    support_level: String,
    bundle_path: String,
    output_path: String,
    output_format: String,
    log_path: String,
    status_path: String,
    dataset_count: usize,
    workbook_count: usize,
    graph_count: usize,
    output_bytes: u64,
    warning_count: usize,
    create_plots: bool,
    #[allow(dead_code)]
    created_graph_types: Vec<String>,
    #[allow(dead_code)]
    omitted_graph_types: Vec<String>,
    #[allow(dead_code)]
    omission_reasons: Vec<String>,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
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
    #[serde(default)]
    created_graph_types: Option<Vec<String>>,
    #[serde(default)]
    omitted_graph_types: Option<Vec<String>>,
    #[serde(default)]
    omission_reasons: Option<Vec<String>>,
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
    output_format: Option<String>,
) -> Result<Option<OriginLaunchResult>, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(mut result) = create_origin_project_on_windows(
            &app,
            &default_name,
            &bytes,
            create_plots,
            output_format.as_deref(),
        )?
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
        result.omitted_graph_types = status.omitted_graph_types.unwrap_or_default();
        result.omission_reasons = status.omission_reasons.unwrap_or_default();
        Ok(Some(result))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, default_name, bytes, create_plots, output_format);
        Err("Create in OriginPro is available in the Windows SpecFlowLab app. Use Export Origin Bundle on this platform.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn create_origin_project_on_windows(
    app: &tauri::AppHandle,
    default_name: &str,
    bytes: &[u8],
    create_plots: bool,
    output_format: Option<&str>,
) -> Result<Option<OriginLaunchResult>, String> {
    let Some(origin_executable) = resolve_origin_executable(app)? else {
        return Ok(None);
    };

    // Resolve installation info for the selected executable
    let install_info = inspect_origin_executable(&origin_executable)?;
    let format = output_format
        .and_then(|f| match f {
            "opj" => Some(origin::OriginProjectFormat::Opj),
            "opju" => Some(origin::OriginProjectFormat::Opju),
            _ => None,
        })
        .unwrap_or(install_info.default_project_format);
    let ext = format.extension();

    let output_plan = if create_plots {
        origin::resolve_output_plan("sheets-plots", &install_info.capabilities)
    } else {
        origin::resolve_output_plan("sheets-only", &install_info.capabilities)
    };

    let default_ext = if ext == "opj" { "opj" } else { "opju" };
    let default_name =
        safe_default_name(default_name, &format!("SpecFlowLab_project.{default_ext}"));
    let selected = app
        .dialog()
        .file()
        .add_filter("Origin Project", &[default_ext])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut output_path = selected.into_path().map_err(|error| {
        format!("The selected Origin destination is not a writable file path: {error}")
    })?;
    let output_ext = output_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(default_ext);
    if !output_ext.eq_ignore_ascii_case(default_ext) {
        output_path.set_extension(default_ext);
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

    // Fork: LabTalk for Origin 8.6, Python bridge for 2021+
    let is_labtalk = matches!(
        install_info.backend,
        origin::OriginBackendKind::LabTalk | origin::OriginBackendKind::LegacyPyOrigin
    );

    if is_labtalk {
        // ---- LabTalk staging path (Origin 8.6, 2016–2020) ----
        let script_path = labtalk::stage_labtalk_import(&bundle_path, &output_path, &output_plan)?;
        let script_for_labtalk = labtalk_path(&script_path)?;
        let origin_startup_script = origin_startup_labtalk(&script_for_labtalk);
        Command::new(&origin_executable)
            .arg("-slog")
            .arg(&log_path)
            .arg("-rs")
            .raw_arg(origin_startup_script)
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not launch OriginPro (LabTalk) from {}: {error}",
                    origin_executable.display()
                )
            })?;
    } else {
        // ---- Python bridge path (Origin 2021+) ----
        let bridge_path = run_directory.join("specflowlab_origin.py");
        let launcher_path = run_directory.join("launch_specflowlab_origin.py");

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
            .raw_arg(origin_startup_script)
            .spawn()
            .map_err(|error| {
                format!(
                    "Could not launch OriginPro (Python) from {}: {error}",
                    origin_executable.display()
                )
            })?;
    }

    Ok(Some(OriginLaunchResult {
        origin_executable: origin_executable.to_string_lossy().into_owned(),
        origin_display_name: install_info.display_name.clone(),
        origin_version: install_info.product_version.clone(),
        bitness: install_info.bitness,
        backend: install_info.backend.to_string(),
        support_level: install_info.support_level.to_string(),
        bundle_path: bundle_path.to_string_lossy().into_owned(),
        output_path: output_path.to_string_lossy().into_owned(),
        output_format: format.extension().to_string(),
        log_path: log_path.to_string_lossy().into_owned(),
        status_path: status_path.to_string_lossy().into_owned(),
        dataset_count: 0,
        workbook_count: 0,
        graph_count: 0,
        output_bytes: 0,
        warning_count: 0,
        create_plots,
        created_graph_types: output_plan.created_graph_types,
        omitted_graph_types: output_plan.omitted_graph_types,
        omission_reasons: output_plan.omission_reasons,
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
    // 1. Environment variable overrides
    for variable in ["SPECFLOWLAB_ORIGIN_EXE", "ORIGIN_EXE"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            validate_origin_executable(&path)?;
            // Persist so the machine config stays in sync
            let info = inspect_origin_executable(&path)?;
            let _ = persist_installation(app, &info);
            return Ok(Some(path));
        }
    }

    // 2. Saved machine config
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve config directory: {e}"))?;
    let _ = origin::migrate_legacy_config(&config_dir);
    if let Ok(Some(config)) = origin::read_machine_config(&config_dir) {
        if let Some(selected) = config.selected {
            let path = PathBuf::from(&selected.executable_path);
            if path.is_file() && is_origin_executable_candidate(&path) {
                return Ok(Some(path));
            }
        }
    }

    // 3. Auto-discovery
    let discovered = discover_and_inspect_installations(app)?;
    if let Some(best) = discovered.into_iter().next() {
        let path = PathBuf::from(&best.executable_path);
        return Ok(Some(path));
    }

    // 4. Manual file picker
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
    let info = inspect_origin_executable(&path)?;
    let _ = persist_installation(app, &info);
    Ok(Some(path))
}

// Legacy helpers kept for test compatibility — delegate to origin.rs
#[cfg(any(target_os = "windows", test))]
fn is_origin_executable_candidate(path: &Path) -> bool {
    origin::is_origin_executable_candidate(path)
}

#[cfg(any(target_os = "windows", test))]
fn origin_candidate_score(path: &Path) -> u32 {
    origin::origin_candidate_score(path)
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

// ---------------------------------------------------------------------------
// Origin installation management commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_origin_installations(
    app: tauri::AppHandle,
) -> Result<Vec<origin::OriginInstallationInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        discover_and_inspect_installations(&app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn get_origin_installation(
    app: tauri::AppHandle,
) -> Result<Option<origin::OriginInstallationInfo>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve config directory: {e}"))?;
    // Migrate legacy config on first read
    let _ = origin::migrate_legacy_config(&config_dir);
    let Some(config) = origin::read_machine_config(&config_dir)? else {
        return Ok(None);
    };
    let Some(selected) = config.selected else {
        return Ok(None);
    };
    let path = PathBuf::from(&selected.executable_path);
    if !path.is_file() {
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        inspect_origin_executable(&path).map(Some)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(None)
    }
}

#[tauri::command]
async fn set_origin_installation(
    app: tauri::AppHandle,
    path: String,
) -> Result<origin::OriginInstallationInfo, String> {
    let exe_path = PathBuf::from(&path);
    #[cfg(target_os = "windows")]
    {
        validate_origin_executable(&exe_path)?;
        let info = inspect_origin_executable(&exe_path)?;
        persist_installation(&app, &info)?;
        Ok(info)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, exe_path);
        Err("Origin integration is available in the Windows SpecFlowLab app.".to_string())
    }
}

#[tauri::command]
async fn select_origin_installation(
    app: tauri::AppHandle,
) -> Result<Option<origin::OriginInstallationInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        // First check discovered installations
        let discovered = discover_and_inspect_installations(&app)?;
        if !discovered.is_empty() {
            // Return the best candidate; the frontend can show a picker
            let best = discovered.into_iter().next().unwrap();
            persist_installation(&app, &best)?;
            return Ok(Some(best));
        }
        // No automatic discovery — ask user to browse
        let selected = app
            .dialog()
            .file()
            .add_filter("OriginPro executable", &["exe"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|e| {
            format!("The selected OriginPro executable is not a local file path: {e}")
        })?;
        validate_origin_executable(&path)?;
        let info = inspect_origin_executable(&path)?;
        persist_installation(&app, &info)?;
        Ok(Some(info))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// Windows-only helpers
// ---------------------------------------------------------------------------

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
fn inspect_origin_executable(path: &Path) -> Result<origin::OriginInstallationInfo, String> {
    let display_name = origin::display_name_from_path(path);
    let mut warnings: Vec<String> = Vec::new();

    // 1. Try Win32 version resource
    let (major, minor, product_version, confidence) = read_executable_version(path);

    // 2. Fallback to file-name heuristic
    let (major, confidence) = if major.is_none() {
        let (fn_major, fn_conf) = origin::version_from_file_name(path);
        if fn_major.is_none() {
            warnings.push("Could not determine Origin version from the executable. Manual confirmation is required.".to_string());
        }
        (fn_major, fn_conf)
    } else {
        (major, confidence)
    };

    let major = major.unwrap_or(0);
    // When the file name maps to major 8 (origin86), assume 8.6 since the
    // file name alone cannot distinguish 8.5 from 8.6.
    let resolved_minor = minor.unwrap_or(if major == 8 { 6 } else { 0 });

    // 3. Resolve capabilities
    let capabilities = origin::resolve_capabilities(major, resolved_minor);
    let (backend, project_formats, default_format, support_level) =
        origin::resolve_backend_and_format(major, resolved_minor);

    // 4. Bitness
    let bitness = detect_bitness(path);

    if support_level == origin::SupportLevel::Unsupported {
        warnings.push(format!(
            "Origin version {} is not supported for direct automation. The portable .sflorigin bundle remains available.",
            major
        ));
    }

    Ok(origin::OriginInstallationInfo {
        executable_path: path.to_string_lossy().into_owned(),
        display_name,
        product_version,
        major_version: Some(major).filter(|v| *v > 0),
        minor_version: minor,
        bitness,
        detection_confidence: confidence,
        backend,
        project_formats,
        default_project_format: default_format,
        support_level,
        capabilities,
        warnings,
    })
}

#[cfg(target_os = "windows")]
fn read_executable_version(
    path: &Path,
) -> (
    Option<u32>,
    Option<u32>,
    Option<String>,
    origin::DetectionConfidence,
) {
    // Use Win32 version info APIs through the windows crate
    // For now, fall back to file-name heuristic (the windows crate dependency
    // will be added in a follow-up when the physical test matrix is performed)
    let _ = path;
    let (major, confidence) = origin::version_from_file_name(path);
    (major, None, None, confidence)
}

#[cfg(target_os = "windows")]
fn detect_bitness(path: &Path) -> Option<u32> {
    let lower = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if lower.contains("_64") {
        Some(64)
    } else if lower.contains("_32") {
        Some(32)
    } else {
        // On a 64-bit OS, check if the binary is 64-bit via PE header.
        // For now, default to 64 on modern systems.
        if std::env::consts::ARCH == "x86_64" {
            Some(64)
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn persist_installation(
    app: &tauri::AppHandle,
    info: &origin::OriginInstallationInfo,
) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve config directory: {e}"))?;
    let _ = origin::migrate_legacy_config(&config_dir);
    let config = origin::MachineConfig {
        schema: "specflowlab.origin_machine_config.v1".to_string(),
        selected: Some(origin::OriginInstallationSelection {
            executable_path: info.executable_path.clone(),
            display_name: info.display_name.clone(),
            product_version: info.product_version.clone(),
            major_version: info.major_version,
            minor_version: info.minor_version,
            bitness: info.bitness,
        }),
    };
    origin::write_machine_config(&config_dir, &config)
}

#[cfg(target_os = "windows")]
fn discover_and_inspect_installations(
    app: &tauri::AppHandle,
) -> Result<Vec<origin::OriginInstallationInfo>, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(program_files) = std::env::var_os(variable).map(PathBuf::from) {
            collect_origin_executables(&program_files.join("OriginLab"), 3, &mut candidates);
        }
    }
    candidates.sort_by(|left, right| {
        origin_candidate_score(right)
            .cmp(&origin_candidate_score(left))
            .then_with(|| right.cmp(left))
    });
    let mut results: Vec<origin::OriginInstallationInfo> = Vec::new();
    for candidate in candidates {
        match inspect_origin_executable(&candidate) {
            Ok(info) => results.push(info),
            Err(_) => continue,
        }
    }
    // Also check env-var overrides
    for variable in ["SPECFLOWLAB_ORIGIN_EXE", "ORIGIN_EXE"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            if path.is_file() && is_origin_executable_candidate(&path) {
                match inspect_origin_executable(&path) {
                    Ok(info) => {
                        if !results
                            .iter()
                            .any(|r| r.executable_path == info.executable_path)
                        {
                            results.push(info);
                        }
                    }
                    Err(_) => continue,
                }
            }
        }
    }
    let _ = app;
    Ok(results)
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

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            save_binary_file,
            create_origin_project,
            list_origin_installations,
            get_origin_installation,
            set_origin_installation,
            select_origin_installation
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
