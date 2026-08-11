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
    launch_diagnostic_path: String,
    command_probe_path: String,
    process_id: u32,
    dataset_count: usize,
    workbook_count: usize,
    sheet_count: usize,
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
    sheet_count: Option<usize>,
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
        let command_probe_path = PathBuf::from(&result.command_probe_path);
        let launch_diagnostic_path = PathBuf::from(&result.launch_diagnostic_path);
        let backend = result.backend.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            wait_for_origin_result(
                &status_path,
                &output_path,
                &log_path,
                &command_probe_path,
                &launch_diagnostic_path,
                &backend,
            )
        })
        .await
        .map_err(|error| format!("Could not monitor the OriginPro import task: {error}"))??;
        result.dataset_count = status.dataset_count.unwrap_or_default();
        result.workbook_count = status.workbook_count.unwrap_or_default();
        result.sheet_count = status.sheet_count.unwrap_or(result.sheet_count);
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
    if install_info.support_level == origin::SupportLevel::Unsupported
        || install_info.backend == origin::OriginBackendKind::None
    {
        return Err(format!(
            "{} is not supported for direct automation. SpecFlowLab supports OriginPro 8.6 or later; use Export Origin Bundle for Origin 8.5 and older.",
            install_info.display_name
        ));
    }
    let format = output_format
        .and_then(|f| match f {
            "opj" => Some(origin::OriginProjectFormat::Opj),
            "opju" => Some(origin::OriginProjectFormat::Opju),
            _ => None,
        })
        .unwrap_or(install_info.default_project_format);
    if !install_info.project_formats.contains(&format) {
        return Err(format!(
            "{} does not support {} output through the selected adapter.",
            install_info.display_name,
            format.extension().to_ascii_uppercase()
        ));
    }
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
    let launch_diagnostic_path = output_path.with_extension("origin-launch.json");
    let command_probe_path = run_directory.join("command-line-probe.txt");

    for generated_path in [&log_path, &status_path, &launch_diagnostic_path] {
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
    let is_labtalk = install_info.backend == origin::OriginBackendKind::LabTalk;
    let mut staged_dataset_count = 0;
    let mut staged_sheet_count = 0;
    let process_id;

    if is_labtalk {
        // ---- COM worksheet staging path (Origin 8.6, 2016–2020) ----
        let stage = labtalk::stage_labtalk_import(&bundle_path)?;
        staged_dataset_count = stage.dataset_count;
        staged_sheet_count = stage.sheet_count;
        let com_launcher_path = run_directory.join("launch_origin_com.ps1");
        process_id = spawn_origin_com_bridge(
            &origin_executable,
            &com_launcher_path,
            &stage.manifest_path,
            &log_path,
            &status_path,
            &command_probe_path,
            &launch_diagnostic_path,
            &output_path,
            stage.dataset_count,
            &install_info,
        )?;
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
        let probe_for_labtalk = labtalk_path(&command_probe_path)?;
        let origin_startup_script =
            origin_startup_labtalk(&launcher_for_labtalk, &probe_for_labtalk);
        process_id = spawn_origin_command_line_bridge(
            &origin_executable,
            &log_path,
            &status_path,
            &command_probe_path,
            &launch_diagnostic_path,
            &launcher_path,
            &output_path,
            &origin_startup_script,
            &install_info,
        )?;
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
        launch_diagnostic_path: launch_diagnostic_path.to_string_lossy().into_owned(),
        command_probe_path: command_probe_path.to_string_lossy().into_owned(),
        process_id,
        dataset_count: staged_dataset_count,
        workbook_count: staged_dataset_count,
        sheet_count: staged_sheet_count,
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
#[allow(clippy::too_many_arguments)]
fn spawn_origin_command_line_bridge(
    origin_executable: &Path,
    log_path: &Path,
    status_path: &Path,
    command_probe_path: &Path,
    launch_diagnostic_path: &Path,
    bridge_script_path: &Path,
    output_path: &Path,
    origin_startup_script: &str,
    install_info: &origin::OriginInstallationInfo,
) -> Result<u32, String> {
    let launch_timestamp_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create an Origin launch timestamp: {error}"))?;
    let launch_timestamp_unix_ms = u64::try_from(launch_timestamp_unix_ms.as_millis())
        .map_err(|_| "Origin launch timestamp exceeds the supported range".to_string())?;
    let working_directory = origin_executable.parent().ok_or_else(|| {
        format!(
            "The selected OriginPro executable has no parent directory: {}",
            origin_executable.display()
        )
    })?;
    let diagnostic = serde_json::json!({
        "schema": "specflowlab.origin_launch_diagnostic.v1",
        "state": "prepared",
        "launchTimestampUnixMs": launch_timestamp_unix_ms,
        "executablePath": origin_executable,
        "workingDirectory": working_directory,
        "originDisplayName": install_info.display_name,
        "originVersion": install_info.product_version,
        "bitness": install_info.bitness,
        "backend": install_info.backend.to_string(),
        "bridgeScriptPath": bridge_script_path,
        "commandProbePath": command_probe_path,
        "statusPath": status_path,
        "startupLogPath": log_path,
        "outputPath": output_path,
        "commandSummary": format!(
            "\"{}\" -slog \"{}\" -rs <{} LabTalk characters>",
            origin_executable.display(),
            log_path.display(),
            origin_startup_script.len()
        ),
    });
    std::fs::write(
        launch_diagnostic_path,
        serde_json::to_vec_pretty(&diagnostic)
            .map_err(|error| format!("Could not serialize Origin launch diagnostics: {error}"))?,
    )
    .map_err(|error| {
        format!(
            "Could not write Origin launch diagnostics {}: {error}",
            launch_diagnostic_path.display()
        )
    })?;

    let child = Command::new(origin_executable)
        .current_dir(working_directory)
        .arg("-slog")
        .arg(log_path)
        .arg("-rs")
        .raw_arg(origin_startup_script)
        .spawn()
        .map_err(|error| {
            format!(
                "Could not spawn OriginPro from {}: {error}. Launch diagnostics: {}",
                origin_executable.display(),
                launch_diagnostic_path.display()
            )
        })?;
    let process_id = child.id();
    let mut launched_diagnostic = diagnostic;
    launched_diagnostic["state"] = serde_json::json!("process-spawned");
    launched_diagnostic["processId"] = serde_json::json!(process_id);
    let _ = std::fs::write(
        launch_diagnostic_path,
        serde_json::to_vec_pretty(&launched_diagnostic).unwrap_or_default(),
    );
    Ok(process_id)
}

#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn spawn_origin_com_bridge(
    origin_executable: &Path,
    launcher_path: &Path,
    manifest_path: &Path,
    log_path: &Path,
    status_path: &Path,
    command_probe_path: &Path,
    launch_diagnostic_path: &Path,
    output_path: &Path,
    dataset_count: usize,
    install_info: &origin::OriginInstallationInfo,
) -> Result<u32, String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let bitness = install_info.bitness.ok_or_else(|| {
        format!(
            "Could not determine whether the selected Origin executable is 32-bit or 64-bit: {}",
            origin_executable.display()
        )
    })?;
    let powershell = windows_powershell_for_bitness(bitness)?;
    let working_directory = origin_executable.parent().ok_or_else(|| {
        format!(
            "The selected OriginPro executable has no parent directory: {}",
            origin_executable.display()
        )
    })?;
    let launcher_source = origin_com_launcher_source(
        origin_executable,
        manifest_path,
        log_path,
        status_path,
        command_probe_path,
        output_path,
        dataset_count,
    );
    let mut launcher_bytes = vec![0xEF, 0xBB, 0xBF];
    launcher_bytes.extend_from_slice(launcher_source.as_bytes());
    std::fs::write(launcher_path, launcher_bytes).map_err(|error| {
        format!(
            "Could not write the Origin COM launcher {}: {error}",
            launcher_path.display()
        )
    })?;

    let launch_timestamp_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create an Origin launch timestamp: {error}"))?;
    let launch_timestamp_unix_ms = u64::try_from(launch_timestamp_unix_ms.as_millis())
        .map_err(|_| "Origin launch timestamp exceeds the supported range".to_string())?;
    let diagnostic = serde_json::json!({
        "schema": "specflowlab.origin_launch_diagnostic.v1",
        "state": "prepared",
        "launchTimestampUnixMs": launch_timestamp_unix_ms,
        "executablePath": origin_executable,
        "workingDirectory": working_directory,
        "originDisplayName": install_info.display_name,
        "originVersion": install_info.product_version,
        "bitness": bitness,
        "backend": install_info.backend.to_string(),
        "bridgeTransport": "com-automation",
        "helperExecutablePath": &powershell,
        "bridgeScriptPath": launcher_path,
        "importManifestPath": manifest_path,
        "commandProbePath": command_probe_path,
        "statusPath": status_path,
        "startupLogPath": log_path,
        "outputPath": output_path,
        "commandSummary": "Origin.Application CreatePage/Worksheet.SetData/Save",
    });
    std::fs::write(
        launch_diagnostic_path,
        serde_json::to_vec_pretty(&diagnostic)
            .map_err(|error| format!("Could not serialize Origin launch diagnostics: {error}"))?,
    )
    .map_err(|error| {
        format!(
            "Could not write Origin launch diagnostics {}: {error}",
            launch_diagnostic_path.display()
        )
    })?;

    let child = Command::new(&powershell)
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(launcher_path)
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start the {}-bit Origin COM bridge with {}: {error}. Launch diagnostics: {}",
                bitness,
                powershell.display(),
                launch_diagnostic_path.display()
            )
        })?;
    let process_id = child.id();
    let mut launched_diagnostic = diagnostic;
    launched_diagnostic["state"] = serde_json::json!("bridge-spawned");
    launched_diagnostic["processId"] = serde_json::json!(process_id);
    let _ = std::fs::write(
        launch_diagnostic_path,
        serde_json::to_vec_pretty(&launched_diagnostic).unwrap_or_default(),
    );
    Ok(process_id)
}

#[cfg(target_os = "windows")]
fn windows_powershell_for_bitness(bitness: u32) -> Result<PathBuf, String> {
    let windows_directory = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let system_directory = match bitness {
        32 if windows_directory.join("SysWOW64").is_dir() => "SysWOW64",
        32 => "System32",
        64 if cfg!(target_pointer_width = "32") => "Sysnative",
        64 => "System32",
        other => return Err(format!("Unsupported Origin executable bitness: {other}")),
    };
    let powershell = windows_directory
        .join(system_directory)
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !powershell.is_file() {
        return Err(format!(
            "The required {}-bit Windows PowerShell COM host was not found at {}",
            bitness,
            powershell.display()
        ));
    }
    Ok(powershell)
}

#[cfg(any(target_os = "windows", test))]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(target_os = "windows", test))]
fn origin_com_launcher_source(
    origin_executable: &Path,
    manifest_path: &Path,
    log_path: &Path,
    status_path: &Path,
    command_probe_path: &Path,
    output_path: &Path,
    dataset_count: usize,
) -> String {
    let template = r#"$ErrorActionPreference = 'Stop'
$expectedExecutable = @@EXPECTED_EXECUTABLE@@
$manifestPath = @@MANIFEST_PATH@@
$logPath = @@LOG_PATH@@
$statusPath = @@STATUS_PATH@@
$probePath = @@PROBE_PATH@@
$outputPath = @@OUTPUT_PATH@@
$datasetCount = @@DATASET_COUNT@@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$origin = $null
$spawnedOrigin = $null
$warnings = New-Object System.Collections.Generic.List[string]
$bridgeFailed = $false

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Write-BridgeLog([string]$Message) {
    $line = ('{0:o} {1}' -f [DateTime]::UtcNow, $Message) + [Environment]::NewLine
    [System.IO.File]::AppendAllText($logPath, $line, $utf8NoBom)
}

function Write-FailedStatus([string]$Message, [string]$Trace) {
    $payload = [ordered]@{
        state = 'failed'
        error = $Message
        traceback = $Trace
        warnings = @($warnings)
    } | ConvertTo-Json -Compress
    Write-Utf8NoBom $statusPath $payload
}

try {
    Write-BridgeLog ('Starting Origin COM automation for ' + $expectedExecutable)
    $beforeIds = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match '(?i)^origin'
    } | ForEach-Object { $_.Id })

    $origin = New-Object -ComObject Origin.Application
    Start-Sleep -Milliseconds 300
    $spawnedCandidates = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match '(?i)^origin' -and $beforeIds -notcontains $_.Id
    })
    $spawnedOrigin = $spawnedCandidates | Where-Object {
        try {
            [String]::Equals(
                [System.IO.Path]::GetFullPath($_.Path),
                [System.IO.Path]::GetFullPath($expectedExecutable),
                [StringComparison]::OrdinalIgnoreCase
            )
        } catch { $false }
    } | Select-Object -First 1

    if ($null -eq $spawnedOrigin) {
        $actual = @($spawnedCandidates | ForEach-Object {
            try { $_.Path } catch { '<unavailable>' }
        }) -join ', '
        if ([String]::IsNullOrWhiteSpace($actual)) { $actual = '<no new Origin process>' }
        throw ('The {0}-bit Origin COM registration did not launch the selected executable. Selected: {1}. COM launched: {2}. Start the selected Origin once as the current Windows user, close every Origin window, and retry.' -f ([IntPtr]::Size * 8), $expectedExecutable, $actual)
    }

    Write-Utf8NoBom $probePath ('SFL_COM_OK' + [Environment]::NewLine)
    Write-BridgeLog ('COM connected to selected Origin process ' + $spawnedOrigin.Id)

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'specflowlab.origin_com_import.v2') {
        throw ('Unsupported Origin COM import manifest: ' + $manifest.schema)
    }
    if (@($manifest.datasets).Count -ne $datasetCount) {
        throw ('Origin COM import manifest dataset count does not match the staged bundle.')
    }

    $startedPayload = [ordered]@{
        state = 'started'
        datasetCount = $datasetCount
        warnings = @()
    } | ConvertTo-Json -Compress
    Write-Utf8NoBom $statusPath $startedPayload

    $datasetIndex = 0
    $sheetCount = 0
    foreach ($dataset in @($manifest.datasets)) {
        $datasetIndex += 1
        $pageName = [string]$origin.CreatePage(
            2,
            [string]$dataset.workbookName,
            'Origin',
            2
        )
        if ([String]::IsNullOrWhiteSpace($pageName)) {
            throw ('Origin could not create workbook ' + $dataset.workbookName)
        }
        if (@($dataset.sheets).Count -lt 1) {
            throw ('Origin COM import manifest has no worksheets for ' + $dataset.workbookName)
        }

        $sheetIndex = 0
        foreach ($sheetSpec in @($dataset.sheets)) {
            $sheetIndex += 1
            $sheetName = [string]$sheetSpec.name
            if ($sheetName -notmatch '^[A-Za-z][A-Za-z0-9_]{0,30}$') {
                throw ('Unsafe or unsupported Origin worksheet name: ' + $sheetName)
            }

            if ($sheetIndex -eq 1) {
                $sheet = $origin.FindWorksheet(('[' + $pageName + ']Sheet1'))
                if ($null -eq $sheet) {
                    throw ('Origin could not resolve [' + $pageName + ']Sheet1.')
                }
                if (-not [bool]$sheet.Execute(('wks.name$="' + $sheetName + '";'))) {
                    throw ('Origin could not rename [' + $pageName + ']Sheet1 to ' + $sheetName)
                }
                try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($sheet) | Out-Null } catch {}
            } else {
                $anchor = $origin.FindWorksheet(('[' + $pageName + ']' + [string]$dataset.sheets[0].name))
                if ($null -eq $anchor) {
                    throw ('Origin could not resolve the anchor worksheet in ' + $pageName)
                }
                if (-not [bool]$anchor.Execute(('newsheet name:=' + $sheetName + ';'))) {
                    throw ('Origin could not add worksheet ' + $sheetName + ' to ' + $pageName)
                }
                try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($anchor) | Out-Null } catch {}
            }

            $sheet = $origin.FindWorksheet(('[' + $pageName + ']' + $sheetName))
            if ($null -eq $sheet) {
                throw ('Origin could not resolve [' + $pageName + ']' + $sheetName)
            }
            $lines = [System.IO.File]::ReadAllLines([string]$sheetSpec.tablePath)
            if ($lines.Length -lt 1) {
                throw ('Staged worksheet is empty: ' + $sheetSpec.tablePath)
            }
            $headers = $lines[0].Split([char]9)
            $rowCount = $lines.Length - 1
            $columnCount = $headers.Length
            if ($columnCount -lt 1) {
                throw ('Staged worksheet has no columns: ' + $sheetSpec.tablePath)
            }

            if ($rowCount -gt 0) {
                if ([string]$sheetSpec.valueType -eq 'text') {
                    $data = New-Object 'string[,]' $rowCount,$columnCount
                } elseif ([string]$sheetSpec.valueType -eq 'numeric') {
                    $data = New-Object 'double[,]' $rowCount,$columnCount
                } else {
                    throw ('Unsupported worksheet value type: ' + $sheetSpec.valueType)
                }
                for ($row = 0; $row -lt $rowCount; $row += 1) {
                    $fields = $lines[$row + 1].Split([char]9)
                    if ($fields.Length -ne $columnCount) {
                        throw ('Staged worksheet row width mismatch in ' + $sheetSpec.tablePath)
                    }
                    for ($column = 0; $column -lt $columnCount; $column += 1) {
                        if ([string]$sheetSpec.valueType -eq 'text') {
                            $data[$row,$column] = [string]$fields[$column]
                        } elseif ([String]::IsNullOrWhiteSpace($fields[$column])) {
                            $data[$row,$column] = [double]::NaN
                        } else {
                            $data[$row,$column] = [double]::Parse(
                                $fields[$column],
                                [Globalization.NumberStyles]::Float,
                                [Globalization.CultureInfo]::InvariantCulture
                            )
                        }
                    }
                }
                if (-not [bool]$sheet.SetData($data, 0, 0)) {
                    throw ('Origin could not transfer data into [' + $pageName + ']' + $sheetName)
                }
            }

            try {
                $sheet.Rows = $rowCount
                $sheet.Cols = $columnCount
                $sheet.LongName = [string]$sheetSpec.longName
                $metadataCommands = New-Object System.Collections.Generic.List[string]
                for ($column = 0; $column -lt $columnCount; $column += 1) {
                    $columnNumber = $column + 1
                    if ([string]$sheetSpec.valueType -eq 'numeric') {
                        $columnType = if (@($sheetSpec.xColumns) -contains $column) { 4 } else { 1 }
                        $metadataCommands.Add(('wks.col' + $columnNumber + '.type=' + $columnType + ';')) | Out-Null
                    }
                    $metadataCommands.Add(('wks.col' + $columnNumber + '.lname$="' + $headers[$column] + '";')) | Out-Null
                }
                foreach ($metadataCommand in $metadataCommands) {
                    if (-not [bool]$sheet.Execute($metadataCommand)) {
                        throw ('Origin rejected worksheet metadata command: ' + $metadataCommand)
                    }
                }
                if ($sheetIndex -eq 1) {
                    $sheet.Execute(('page.label$="' + [string]$dataset.label + '";')) | Out-Null
                }
            } catch {
                $warnings.Add(('Worksheet [' + $pageName + ']' + $sheetName + ' metadata: ' + $_.Exception.Message)) | Out-Null
            } finally {
                try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($sheet) | Out-Null } catch {}
            }
            $sheetCount += 1
        }

        Write-BridgeLog ('Imported ' + @($dataset.sheets).Count + ' worksheets into ' + $pageName)

        $importingPayload = [ordered]@{
            state = 'importing'
            datasetCount = $datasetCount
            importedDatasetCount = $datasetIndex
            sheetCount = $sheetCount
            warnings = @($warnings)
        } | ConvertTo-Json -Compress
        Write-Utf8NoBom $statusPath $importingPayload
    }

    if (-not [bool]$origin.Save($outputPath)) {
        throw ('Origin.Application.Save returned false for ' + $outputPath)
    }
    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf) -or
        (Get-Item -LiteralPath $outputPath).Length -le 0) {
        throw ('Origin returned from Save without creating a non-empty project at ' + $outputPath)
    }
    Write-BridgeLog 'COM worksheet import and save completed'
} catch {
    $message = $_.Exception.Message
    Write-BridgeLog ('FAILED: ' + $message)
    Write-FailedStatus $message $_.ScriptStackTrace
    $bridgeFailed = $true
} finally {
    if ($null -ne $origin) {
        try { $origin.Exit() | Out-Null } catch {}
        try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($origin) | Out-Null } catch {}
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

if ($null -ne $spawnedOrigin) {
    try {
        if (-not $spawnedOrigin.HasExited -and -not $spawnedOrigin.WaitForExit(10000)) {
            $liveAutomation = Get-Process -Id $spawnedOrigin.Id -ErrorAction SilentlyContinue
            if ($null -ne $liveAutomation -and
                $liveAutomation.MainWindowHandle -eq 0 -and
                [String]::Equals(
                    [System.IO.Path]::GetFullPath($liveAutomation.Path),
                    [System.IO.Path]::GetFullPath($expectedExecutable),
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                $liveAutomation.Kill()
                $liveAutomation.WaitForExit(5000) | Out-Null
                Write-BridgeLog ('Forced cleanup of hidden automation process ' + $spawnedOrigin.Id)
            }
        }
    } catch {
        $warnings.Add(('Could not confirm automation process exit: ' + $_.Exception.Message)) | Out-Null
    }
}

if ($bridgeFailed) { exit 1 }

try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $expectedExecutable
    $startInfo.Arguments = '"' + $outputPath + '"'
    $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($expectedExecutable)
    $startInfo.UseShellExecute = $true
    $opened = [System.Diagnostics.Process]::Start($startInfo)
    $outputBytes = (Get-Item -LiteralPath $outputPath).Length
    $payload = [ordered]@{
        state = 'completed'
        datasetCount = $datasetCount
        workbookCount = $datasetCount
        graphCount = 0
        sheetCount = $sheetCount
        outputBytes = $outputBytes
        warnings = @($warnings)
        openedProcessId = $opened.Id
    } | ConvertTo-Json -Compress
    Write-Utf8NoBom $statusPath $payload
    Write-BridgeLog ('Opened saved project in selected Origin process ' + $opened.Id)
} catch {
    $message = 'The Origin project was saved, but reopening it failed: ' + $_.Exception.Message
    Write-BridgeLog ('FAILED: ' + $message)
    Write-FailedStatus $message $_.ScriptStackTrace
    exit 1
}
"#;

    template
        .replace(
            "@@EXPECTED_EXECUTABLE@@",
            &powershell_single_quoted(&origin_executable.to_string_lossy()),
        )
        .replace(
            "@@MANIFEST_PATH@@",
            &powershell_single_quoted(&manifest_path.to_string_lossy()),
        )
        .replace(
            "@@LOG_PATH@@",
            &powershell_single_quoted(&log_path.to_string_lossy()),
        )
        .replace(
            "@@STATUS_PATH@@",
            &powershell_single_quoted(&status_path.to_string_lossy()),
        )
        .replace(
            "@@PROBE_PATH@@",
            &powershell_single_quoted(&command_probe_path.to_string_lossy()),
        )
        .replace(
            "@@OUTPUT_PATH@@",
            &powershell_single_quoted(&output_path.to_string_lossy()),
        )
        .replace("@@DATASET_COUNT@@", &dataset_count.to_string())
}

#[cfg(target_os = "windows")]
fn wait_for_origin_result(
    status_path: &Path,
    output_path: &Path,
    log_path: &Path,
    command_probe_path: &Path,
    launch_diagnostic_path: &Path,
    backend: &str,
) -> Result<OriginJobStatus, String> {
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
    const IMPORT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
    const POLL_INTERVAL: Duration = Duration::from_millis(500);

    let is_com_adapter = backend == origin::OriginBackendKind::LabTalk.to_string();
    let started_at = Instant::now();
    let mut observed_bridge = false;
    loop {
        if status_path.is_file() {
            // The modern Python bridge and COM launcher replace this file in
            // one write. Origin 8.6 LabTalk writes its intermediate states
            // directly, so polling may briefly observe an empty or partial
            // file between `type -gbef` and `type -ge`.
            if let Ok(status_text) = std::fs::read_to_string(status_path) {
                if let Ok(status) = serde_json::from_str::<OriginJobStatus>(&status_text) {
                    observed_bridge = true;
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
                            if dataset_count == 0
                                || workbook_count != dataset_count
                                || actual_bytes == 0
                            {
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
                                .unwrap_or("Origin reported an unspecified bridge error.");
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
            }
        }

        let elapsed = started_at.elapsed();
        if !observed_bridge && elapsed >= STARTUP_TIMEOUT {
            if is_com_adapter {
                if command_probe_path.is_file() {
                    return Err(format!(
                        "The COM bridge connected to the selected Origin executable, but worksheet import did not start within 120 seconds. Probe: {}. Status: {}. Bridge log: {}. Launch diagnostics: {}{}",
                        command_probe_path.display(),
                        status_path.display(),
                        log_path.display(),
                        launch_diagnostic_path.display(),
                        origin_log_suffix(log_path)
                    ));
                }
                return Err(format!(
                    "The bitness-matched Origin COM bridge did not connect within 120 seconds. Start the selected Origin once as the current Windows user, close every Origin window, and retry. Status: {}. Bridge log: {}. Launch diagnostics: {}{}",
                    status_path.display(),
                    log_path.display(),
                    launch_diagnostic_path.display(),
                    origin_log_suffix(log_path)
                ));
            }
            if command_probe_path.is_file() {
                return Err(format!(
                    "Origin accepted the command-line LabTalk probe, but the {backend} bridge did not start within 120 seconds. The failure is in the generated bridge script or its path, not process launching. Probe: {}. Status: {}. Startup log: {}. Launch diagnostics: {}{}",
                    command_probe_path.display(),
                    status_path.display(),
                    log_path.display(),
                    launch_diagnostic_path.display(),
                    origin_log_suffix(log_path)
                ));
            }
            return Err(format!(
                "The Origin process was spawned, but it did not execute the minimal command-line LabTalk probe within 120 seconds. The selected executable is not accepting -rs/-slog; complete Origin licensing and User Files Folder setup, close every Origin process, and verify that this is an installed Origin copy. Probe: {}. Status: {}. Startup log: {}. Launch diagnostics: {}{}",
                command_probe_path.display(),
                status_path.display(),
                log_path.display(),
                launch_diagnostic_path.display(),
                origin_log_suffix(log_path)
            ));
        }
        if observed_bridge && elapsed >= IMPORT_TIMEOUT {
            return Err(format!(
                "Origin's {backend} bridge started but did not finish the import within 30 minutes. Status: {}. Startup log: {}{}",
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
fn origin_startup_labtalk(launcher_for_labtalk: &str, probe_for_labtalk: &str) -> String {
    format!(
        "type -gbef \"{probe_for_labtalk}\";\
type \"SFL_RS_OK\";\
type -ge;\
type -a \"SpecFlowLab LabTalk handoff reached\";\
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
        // This command is invoked by both Select and Change. Always let the
        // user choose the exact executable: one Origin installation can ship
        // 32-bit and 64-bit launchers whose COM registrations are independent.
        // Auto-discovery remains available to the launch fallback, but must
        // never override an explicit selection request.
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
    let (major, minor, confidence) = if major.is_none() {
        let (fn_major, fn_minor, fn_conf) = origin::version_details_from_file_name(path);
        if fn_major.is_none() {
            warnings.push("Could not determine Origin version from the executable. Manual confirmation is required.".to_string());
        }
        (fn_major, fn_minor, fn_conf)
    } else {
        (major, minor, confidence)
    };

    let major = major.unwrap_or(0);
    let resolved_minor = minor.unwrap_or(0);

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
    let (major, minor, confidence) = origin::version_details_from_file_name(path);
    (major, minor, None, confidence)
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
        read_pe_bitness(path)
    }
}

#[cfg(target_os = "windows")]
fn read_pe_bitness(path: &Path) -> Option<u32> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let mut dos_magic = [0_u8; 2];
    file.read_exact(&mut dos_magic).ok()?;
    if dos_magic != *b"MZ" {
        return None;
    }
    file.seek(SeekFrom::Start(0x3c)).ok()?;
    let mut pe_offset = [0_u8; 4];
    file.read_exact(&mut pe_offset).ok()?;
    file.seek(SeekFrom::Start(u32::from_le_bytes(pe_offset) as u64))
        .ok()?;
    let mut pe_header = [0_u8; 6];
    file.read_exact(&mut pe_header).ok()?;
    if pe_header[..4] != *b"PE\0\0" {
        return None;
    }
    match u16::from_le_bytes([pe_header[4], pe_header[5]]) {
        0x014c => Some(32),
        0x8664 | 0x0200 => Some(64),
        _ => None,
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
    #[cfg(target_os = "windows")]
    use super::detect_bitness;
    use super::{
        is_origin_executable_candidate, origin_candidate_score, origin_com_launcher_source,
        origin_launcher_source, origin_startup_labtalk, powershell_single_quoted,
        safe_default_name, OriginJobStatus,
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

    #[cfg(target_os = "windows")]
    #[test]
    fn detects_x86_from_the_pe_header_instead_of_the_host_architecture() {
        let path = std::env::temp_dir().join(format!(
            "specflowlab-pe-x86-{}-{}.exe",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = vec![0_u8; 0x86];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&(0x80_u32).to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&(0x014c_u16).to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(detect_bitness(&path), Some(32));
        let _ = std::fs::remove_file(path);
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
        let script = origin_startup_labtalk(
            "C:/Temp/SpecFlowLab-OriginBridge/launch_specflowlab_origin.py",
            "C:/Temp/SpecFlowLab-OriginBridge/command-line-probe.txt",
        );
        assert!(script.starts_with(
            "type -gbef \"C:/Temp/SpecFlowLab-OriginBridge/command-line-probe.txt\";"
        ));
        assert!(script.contains("type \"SFL_RS_OK\";type -ge;"));
        assert!(script.contains(
            "run.python(\"C:/Temp/SpecFlowLab-OriginBridge/launch_specflowlab_origin.py\",2);"
        ));
        assert!(script.ends_with("type -a \"SpecFlowLab Python call returned\";"));
        assert!(!script.contains('\r'));
        assert!(!script.contains('\n'));
    }

    #[test]
    fn origin_com_launcher_validates_the_selected_executable_and_reports_failures() {
        let source = origin_com_launcher_source(
            Path::new("C:/Program Files/OriginLab/Origin/origin86.exe"),
            Path::new("C:/Temp/com-import.json"),
            Path::new("C:/Data/project.origin-startup.log"),
            Path::new("C:/Data/project.origin-status.json"),
            Path::new("C:/Temp/command-line-probe.txt"),
            Path::new("C:/Data/project.opj"),
            3,
        );
        assert!(source.contains("New-Object -ComObject Origin.Application"));
        assert!(source.contains("$origin.CreatePage("));
        assert!(source.contains("$sheet.SetData($data, 0, 0)"));
        assert!(source.contains("newsheet name:="));
        assert!(source.contains("specflowlab.origin_com_import.v2"));
        assert!(source.contains("New-Object 'string[,]'"));
        assert!(source.contains("$origin.Save($outputPath)"));
        assert!(source.contains("$origin.FindWorksheet(('[' + $pageName + ']Sheet1'))"));
        assert!(!source.contains("open -w"));
        assert!(source.contains("COM registration did not launch the selected executable"));
        assert!(source.contains("SFL_COM_OK"));
        assert!(source.contains("state = 'failed'"));
        assert!(source.contains("state = 'completed'"));
        assert!(source.contains("$datasetCount = 3"));
        assert!(source.contains("[System.Diagnostics.Process]::Start($startInfo)"));
        assert!(source.contains("'C:/Program Files/OriginLab/Origin/origin86.exe'"));
    }

    #[test]
    fn powershell_literal_escapes_single_quotes() {
        assert_eq!(
            powershell_single_quoted("C:/O'Brien/a.ps1"),
            "'C:/O''Brien/a.ps1'"
        );
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
