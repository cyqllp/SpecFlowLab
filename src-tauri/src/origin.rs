// Many of the public items in this module are only called from Windows-gated code
// in lib.rs, so dead_code warnings on macOS/Linux are expected and harmless.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Serializable types shared with the JavaScript frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginInstallationInfo {
    pub executable_path: String,
    pub display_name: String,
    pub product_version: Option<String>,
    pub major_version: Option<u32>,
    pub minor_version: Option<u32>,
    pub bitness: Option<u32>,
    pub detection_confidence: DetectionConfidence,
    pub backend: OriginBackendKind,
    pub project_formats: Vec<OriginProjectFormat>,
    pub default_project_format: OriginProjectFormat,
    pub support_level: SupportLevel,
    pub capabilities: OriginCapabilities,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OriginCapabilities {
    pub worksheets: bool,
    pub line_plots: bool,
    pub virtual_matrix_heatmap: bool,
    pub residual_heatmap: bool,
    pub unicode_metadata: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DetectionConfidence {
    Metadata,
    Mapping,
    Heuristic,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OriginBackendKind {
    ModernPyOrigin,
    LegacyPyOrigin,
    LabTalk,
    None,
}

impl std::fmt::Display for OriginBackendKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OriginBackendKind::ModernPyOrigin => write!(f, "Python adapter"),
            OriginBackendKind::LegacyPyOrigin => write!(f, "Legacy PyOrigin"),
            OriginBackendKind::LabTalk => write!(f, "LabTalk"),
            OriginBackendKind::None => write!(f, "None"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SupportLevel {
    Verified,
    Experimental,
    Unsupported,
}

impl std::fmt::Display for SupportLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupportLevel::Verified => write!(f, "Verified"),
            SupportLevel::Experimental => write!(f, "Experimental"),
            SupportLevel::Unsupported => write!(f, "Unsupported"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OriginProjectFormat {
    Opj,
    Opju,
}

impl OriginProjectFormat {
    #[allow(dead_code)]
    pub fn extension(&self) -> &'static str {
        match self {
            OriginProjectFormat::Opj => "opj",
            OriginProjectFormat::Opju => "opju",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPlan {
    pub actual_mode: String,
    pub created_graph_types: Vec<String>,
    pub omitted_graph_types: Vec<String>,
    pub omission_reasons: Vec<String>,
}

// ---------------------------------------------------------------------------
// Machine configuration (JSON, never serialized into .sflproj)
// ---------------------------------------------------------------------------

const CONFIG_SCHEMA: &str = "specflowlab.origin_machine_config.v1";
const CONFIG_FILENAME: &str = "origin-config.json";
const LEGACY_FILENAME: &str = "origin-executable.txt";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineConfig {
    pub schema: String,
    pub selected: Option<OriginInstallationSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginInstallationSelection {
    pub executable_path: String,
    pub display_name: String,
    pub product_version: Option<String>,
    pub major_version: Option<u32>,
    pub minor_version: Option<u32>,
    pub bitness: Option<u32>,
}

// ---------------------------------------------------------------------------
// Capability resolver (pure — runs in `cargo test` on any OS)
// NOTE: some functions are only called from Windows-gated code in lib.rs.
// ---------------------------------------------------------------------------

pub fn resolve_capabilities(major: u32, minor: u32) -> OriginCapabilities {
    // Per the documented capability matrix (§5.4)
    match major {
        v if v >= 2023 => OriginCapabilities {
            worksheets: true,
            line_plots: true,
            virtual_matrix_heatmap: true,
            residual_heatmap: true,
            unicode_metadata: true,
        },
        2021..=2022 => OriginCapabilities {
            worksheets: true,
            line_plots: true,
            virtual_matrix_heatmap: true,
            residual_heatmap: true,
            unicode_metadata: true,
        },
        2018..=2020 => OriginCapabilities {
            worksheets: true,
            line_plots: true,
            virtual_matrix_heatmap: false,
            residual_heatmap: false,
            unicode_metadata: true,
        },
        2016..=2017 => OriginCapabilities {
            worksheets: true,
            line_plots: false,
            virtual_matrix_heatmap: false,
            residual_heatmap: false,
            unicode_metadata: false,
        },
        9..=2015 => OriginCapabilities {
            worksheets: true,
            line_plots: false,
            virtual_matrix_heatmap: false,
            residual_heatmap: false,
            unicode_metadata: false,
        },
        // 8.6 only — 8.0–8.5 is unsupported (no reliable LabTalk automation)
        8 if minor >= 6 => OriginCapabilities {
            worksheets: true,
            line_plots: false,
            virtual_matrix_heatmap: false,
            residual_heatmap: false,
            unicode_metadata: false,
        },
        // 8.0–8.5: no automation path verified
        8 => OriginCapabilities {
            worksheets: false,
            line_plots: false,
            virtual_matrix_heatmap: false,
            residual_heatmap: false,
            unicode_metadata: false,
        },
        _ => OriginCapabilities {
            worksheets: false,
            line_plots: false,
            virtual_matrix_heatmap: false,
            residual_heatmap: false,
            unicode_metadata: false,
        },
    }
}

pub fn resolve_backend_and_format(
    major: u32,
    minor: u32,
) -> (
    OriginBackendKind,
    Vec<OriginProjectFormat>,
    OriginProjectFormat,
    SupportLevel,
) {
    match major {
        v if v >= 2023 => (
            OriginBackendKind::ModernPyOrigin,
            vec![OriginProjectFormat::Opju],
            OriginProjectFormat::Opju,
            SupportLevel::Experimental, // verified only after physical test
        ),
        v if v >= 2021 => (
            OriginBackendKind::ModernPyOrigin,
            vec![OriginProjectFormat::Opju, OriginProjectFormat::Opj],
            OriginProjectFormat::Opju,
            SupportLevel::Verified,
        ),
        v if v >= 2018 => (
            OriginBackendKind::LegacyPyOrigin,
            vec![OriginProjectFormat::Opju, OriginProjectFormat::Opj],
            OriginProjectFormat::Opju,
            SupportLevel::Experimental,
        ),
        v if v >= 2016 => (
            OriginBackendKind::LegacyPyOrigin,
            vec![OriginProjectFormat::Opj],
            OriginProjectFormat::Opj,
            SupportLevel::Experimental,
        ),
        v if v >= 9 => (
            OriginBackendKind::LabTalk,
            vec![OriginProjectFormat::Opj],
            OriginProjectFormat::Opj,
            SupportLevel::Experimental,
        ),
        // 8.6 only — 8.0–8.5 falls through to Unsupported
        8 if minor >= 6 => (
            OriginBackendKind::LabTalk,
            vec![OriginProjectFormat::Opj],
            OriginProjectFormat::Opj,
            SupportLevel::Experimental,
        ),
        _ => (
            OriginBackendKind::None,
            vec![],
            OriginProjectFormat::Opj,
            SupportLevel::Unsupported,
        ),
    }
}

/// Resolves the actual output plan given the requested mode and installation capabilities.
pub fn resolve_output_plan(requested_mode: &str, capabilities: &OriginCapabilities) -> OutputPlan {
    let wants_plots =
        requested_mode == "sheets-plots" || requested_mode == "sheets-and-supported-plots";
    let mut created = vec!["worksheets".to_string()];
    let mut omitted: Vec<String> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();

    if wants_plots {
        if capabilities.line_plots {
            created.push("spectra/kinetics/DAS/EAS line plots".to_string());
        } else {
            omitted.push("line plots".to_string());
            reasons.push("selected Origin backend has no verified line-plot path".to_string());
        }
        if capabilities.virtual_matrix_heatmap {
            created.push("treated heatmap".to_string());
        } else {
            omitted.push("treated heatmap".to_string());
            reasons.push(
                "selected Origin backend has no verified irregular-axis heatmap path".to_string(),
            );
        }
        if capabilities.residual_heatmap {
            created.push("residual heatmap".to_string());
        } else {
            omitted.push("residual heatmap".to_string());
            reasons
                .push("selected Origin backend has no verified residual-heatmap path".to_string());
        }
    }

    OutputPlan {
        actual_mode: if wants_plots && capabilities.line_plots {
            "sheets-and-supported-plots".to_string()
        } else {
            "sheets-only".to_string()
        },
        created_graph_types: created,
        omitted_graph_types: omitted,
        omission_reasons: reasons,
    }
}

// ---------------------------------------------------------------------------
// Executable detection helpers (OS-agnostic)
// ---------------------------------------------------------------------------

/// Returns true when the filename pattern matches an Origin main executable.
/// Rejects crash reporters, updaters, uninstallers, and the standalone Viewer.
pub fn is_origin_executable_candidate(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = file_name.to_ascii_lowercase();
    lower.starts_with("origin")
        && lower.ends_with(".exe")
        && !["crash", "report", "update", "uninstall", "viewer"]
            .iter()
            .any(|fragment| lower.contains(fragment))
}

/// Scores a candidate path so the discovery routine can pick the best one.
/// Higher score → more likely to be the correct, modern Origin executable.
pub fn origin_candidate_score(path: &Path) -> u32 {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let file_stem = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut score: u32 = 0;

    // 64-bit
    if file_stem.contains("_64") {
        score += 500;
    }

    // Year-encoded paths (Origin2021, Origin2024, etc.)
    for year in 2000..=2099 {
        if lower.contains(&format!("origin{year}")) {
            score += 1000 + year;
            break;
        }
    }

    // Numeric version in the stem (Origin98_64 → 98)
    if file_stem
        .strip_prefix("origin")
        .and_then(|tail| tail.chars().next())
        .is_some_and(|c| c.is_ascii_digit())
    {
        score += 300;
    }

    score
}

/// Best-effort version guess from the executable file name alone.
/// Returns (major, confidence).
pub fn version_from_file_name(path: &Path) -> (Option<u32>, DetectionConfidence) {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    // Try to find a year in the path
    for year in (2000..=2099).rev() {
        if lower.contains(&format!("origin{year}")) || lower.contains(&format!("origin {year}")) {
            return (Some(year), DetectionConfidence::Heuristic);
        }
    }
    // Fallback mapping for known executable names
    let file_stem = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_stem.contains("origin98") || file_stem.contains("origin_98") {
        return (Some(2018), DetectionConfidence::Mapping);
    }
    if file_stem.contains("origin97") {
        return (Some(2017), DetectionConfidence::Mapping);
    }
    if file_stem.contains("origin96") {
        return (Some(2016), DetectionConfidence::Mapping);
    }
    (None, DetectionConfidence::Unknown)
}

/// Build a display name from path components.
pub fn display_name_from_path(path: &Path) -> String {
    let parent_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let exe_name = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Origin");
    if parent_dir.is_empty() {
        exe_name.to_string()
    } else {
        format!("{} ({})", parent_dir, exe_name)
    }
}

// ---------------------------------------------------------------------------
// Machine config I/O (OS-agnostic — tested everywhere)
// ---------------------------------------------------------------------------

pub fn config_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(CONFIG_FILENAME)
}

pub fn legacy_config_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(LEGACY_FILENAME)
}

pub fn read_machine_config(app_config_dir: &Path) -> Result<Option<MachineConfig>, String> {
    let path = config_path(app_config_dir);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let config: MachineConfig = serde_json::from_str(&text)
        .map_err(|e| format!("Origin machine config {} is invalid: {e}", path.display()))?;
    if config.schema != CONFIG_SCHEMA {
        return Ok(None); // unknown schema — treat as absent
    }
    Ok(Some(config))
}

pub fn write_machine_config(app_config_dir: &Path, config: &MachineConfig) -> Result<(), String> {
    let path = config_path(app_config_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create config directory: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Could not serialise Origin config: {e}"))?;
    std::fs::write(&path, text.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(())
}

/// Migrate legacy `origin-executable.txt` to JSON, then remove the text file.
/// Returns the migrated path if migration happened.
pub fn migrate_legacy_config(app_config_dir: &Path) -> Result<Option<PathBuf>, String> {
    let legacy = legacy_config_path(app_config_dir);
    if !legacy.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&legacy)
        .map_err(|e| format!("Could not read legacy config {}: {e}", legacy.display()))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        // Remove empty legacy file
        let _ = std::fs::remove_file(&legacy);
        return Ok(None);
    }
    let exe_path = PathBuf::from(trimmed);
    // Only migrate if the file still exists
    if !exe_path.is_file() {
        let _ = std::fs::remove_file(&legacy);
        return Ok(None);
    }
    // Write JSON first, then remove the text file only on success
    let config = MachineConfig {
        schema: CONFIG_SCHEMA.to_string(),
        selected: Some(OriginInstallationSelection {
            executable_path: exe_path.to_string_lossy().into_owned(),
            display_name: display_name_from_path(&exe_path),
            product_version: None,
            major_version: None,
            minor_version: None,
            bitness: None,
        }),
    };
    write_machine_config(app_config_dir, &config)?;
    let _ = std::fs::remove_file(&legacy);
    Ok(Some(config_path(app_config_dir)))
}

// ---------------------------------------------------------------------------
// Tests (pure functions — run on macOS, Linux, and Windows)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // --- Capability resolver ---

    #[test]
    fn modern_origin_has_full_capabilities() {
        let caps = resolve_capabilities(2024, 0);
        assert!(caps.worksheets);
        assert!(caps.line_plots);
        assert!(caps.virtual_matrix_heatmap);
        assert!(caps.residual_heatmap);
        assert!(caps.unicode_metadata);
    }

    #[test]
    fn origin_2021_has_full_capabilities() {
        let caps = resolve_capabilities(2021, 0);
        assert!(caps.worksheets);
        assert!(caps.line_plots);
        assert!(caps.virtual_matrix_heatmap);
    }

    #[test]
    fn origin_2019_has_worksheets_and_lines_only() {
        let caps = resolve_capabilities(2019, 0);
        assert!(caps.worksheets);
        assert!(caps.line_plots);
        assert!(!caps.virtual_matrix_heatmap);
        assert!(!caps.residual_heatmap);
    }

    #[test]
    fn origin_2016_is_worksheets_only() {
        let caps = resolve_capabilities(2016, 0);
        assert!(caps.worksheets);
        assert!(!caps.line_plots);
        assert!(!caps.virtual_matrix_heatmap);
    }

    #[test]
    fn origin_9_is_worksheets_only() {
        let caps = resolve_capabilities(9, 0);
        assert!(caps.worksheets);
        assert!(!caps.line_plots);
    }

    #[test]
    fn origin_8_6_is_worksheets_only() {
        let caps = resolve_capabilities(8, 6);
        assert!(caps.worksheets);
        assert!(!caps.line_plots);
    }

    #[test]
    fn origin_8_0_is_unsupported() {
        // 8.0: no automation path
        let caps = resolve_capabilities(8, 0);
        assert!(!caps.worksheets);
    }

    #[test]
    fn older_origin_is_unsupported() {
        let caps = resolve_capabilities(7, 0);
        assert!(!caps.worksheets);
    }

    // --- Backend & format ---

    #[test]
    fn modern_origin_uses_python_and_opju() {
        let (backend, formats, default, _support) = resolve_backend_and_format(2024, 0);
        assert!(matches!(backend, OriginBackendKind::ModernPyOrigin));
        assert_eq!(formats.len(), 1);
        assert!(matches!(default, OriginProjectFormat::Opju));
    }

    #[test]
    fn origin_2021_supports_both_formats() {
        let (_, formats, default, _) = resolve_backend_and_format(2021, 0);
        assert_eq!(formats.len(), 2);
        assert!(matches!(default, OriginProjectFormat::Opju));
    }

    #[test]
    fn origin_2016_is_opj_only() {
        let (backend, formats, default, _) = resolve_backend_and_format(2016, 0);
        assert!(matches!(backend, OriginBackendKind::LegacyPyOrigin));
        assert_eq!(formats, vec![OriginProjectFormat::Opj]);
        assert!(matches!(default, OriginProjectFormat::Opj));
    }

    #[test]
    fn origin_8_6_is_labtalk_opj() {
        let (backend, formats, default, support) = resolve_backend_and_format(8, 6);
        assert!(matches!(backend, OriginBackendKind::LabTalk));
        assert_eq!(formats, vec![OriginProjectFormat::Opj]);
        assert!(matches!(default, OriginProjectFormat::Opj));
        assert!(matches!(support, SupportLevel::Experimental));
    }

    #[test]
    fn origin_8_5_is_unsupported() {
        // 8.0–8.5 have no verified LabTalk automation path
        let caps = resolve_capabilities(8, 5);
        assert!(!caps.worksheets);
        let (backend, formats, _, support) = resolve_backend_and_format(8, 5);
        assert!(matches!(backend, OriginBackendKind::None));
        assert!(formats.is_empty());
        assert!(matches!(support, SupportLevel::Unsupported));
    }

    #[test]
    fn unknown_version_is_unsupported() {
        let (backend, formats, _, support) = resolve_backend_and_format(5, 0);
        assert!(matches!(backend, OriginBackendKind::None));
        assert!(formats.is_empty());
        assert!(matches!(support, SupportLevel::Unsupported));
    }

    // --- Output plan ---

    #[test]
    fn sheets_only_request_yields_sheets_only() {
        let caps = resolve_capabilities(2024, 0);
        let plan = resolve_output_plan("sheets-only", &caps);
        assert_eq!(plan.actual_mode, "sheets-only");
        assert!(plan.omitted_graph_types.is_empty());
    }

    #[test]
    fn sheets_and_plots_degraded_when_heatmaps_unsupported() {
        let caps = resolve_capabilities(2019, 0);
        let plan = resolve_output_plan("sheets-plots", &caps);
        assert_eq!(plan.actual_mode, "sheets-and-supported-plots");
        assert!(plan
            .created_graph_types
            .contains(&"spectra/kinetics/DAS/EAS line plots".to_string()));
        assert!(!plan.omitted_graph_types.is_empty());
        assert!(plan.omission_reasons.iter().any(|r| r.contains("heatmap")));
    }

    #[test]
    fn sheets_and_plots_becomes_sheets_only_when_no_plot_capability() {
        let caps = resolve_capabilities(2016, 0);
        let plan = resolve_output_plan("sheets-plots", &caps);
        assert_eq!(plan.actual_mode, "sheets-only");
        assert!(plan.omitted_graph_types.contains(&"line plots".to_string()));
    }

    // --- Executable detection ---

    #[test]
    fn accepts_known_origin_main_executables() {
        assert!(is_origin_executable_candidate(Path::new(
            "C:/Program Files/OriginLab/Origin2021/Origin98_64.exe"
        )));
        assert!(is_origin_executable_candidate(Path::new(
            "C:/Program Files/OriginLab/Origin2018/Origin97_64.exe"
        )));
        assert!(is_origin_executable_candidate(Path::new(
            "C:/OriginLab/Origin86/Origin86_64.exe"
        )));
    }

    #[test]
    fn rejects_helper_executables() {
        assert!(!is_origin_executable_candidate(Path::new(
            "OriginCrashReporter.exe"
        )));
        assert!(!is_origin_executable_candidate(Path::new(
            "OriginUpdate.exe"
        )));
        assert!(!is_origin_executable_candidate(Path::new(
            "OriginUninstall.exe"
        )));
        assert!(!is_origin_executable_candidate(Path::new(
            "OriginViewer.exe"
        )));
    }

    #[test]
    fn scores_64bit_higher_than_32bit() {
        let score_64 = origin_candidate_score(Path::new("C:/OriginLab/Origin2021/Origin98_64.exe"));
        let score_32 = origin_candidate_score(Path::new("C:/OriginLab/Origin2021/Origin98.exe"));
        assert!(score_64 > score_32);
    }

    #[test]
    fn version_extracted_from_year_in_path() {
        let (ver, conf) =
            version_from_file_name(Path::new("C:/OriginLab/Origin2021/Origin98_64.exe"));
        assert_eq!(ver, Some(2021));
        assert!(matches!(conf, DetectionConfidence::Heuristic));
    }

    #[test]
    fn version_from_mapped_exe_name() {
        let (ver, conf) = version_from_file_name(Path::new("C:/OriginLab/Origin98_64.exe"));
        assert_eq!(ver, Some(2018));
        assert!(matches!(conf, DetectionConfidence::Mapping));
    }

    #[test]
    fn unknown_exe_returns_no_version() {
        let (ver, conf) = version_from_file_name(Path::new("C:/some/unknown.exe"));
        assert_eq!(ver, None);
        assert!(matches!(conf, DetectionConfidence::Unknown));
    }

    // --- Machine config ---

    #[test]
    fn config_round_trips() {
        let dir = std::env::temp_dir().join("sfl-origin-test-config");
        let _ = std::fs::create_dir_all(&dir);
        let cfg = MachineConfig {
            schema: CONFIG_SCHEMA.to_string(),
            selected: Some(OriginInstallationSelection {
                executable_path: "C:/OriginLab/Origin2021/Origin98_64.exe".to_string(),
                display_name: "OriginPro 2021".to_string(),
                product_version: Some("9.8.0.200".to_string()),
                major_version: Some(2021),
                minor_version: Some(0),
                bitness: Some(64),
            }),
        };
        write_machine_config(&dir, &cfg).expect("write");
        let restored = read_machine_config(&dir).expect("read").expect("some");
        assert_eq!(restored.schema, CONFIG_SCHEMA);
        let sel = restored.selected.unwrap();
        assert_eq!(sel.major_version, Some(2021));
        assert_eq!(sel.bitness, Some(64));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_config_returns_none() {
        let dir = std::env::temp_dir().join("sfl-origin-missing-config");
        let result = read_machine_config(&dir);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn legacy_migration_creates_json_and_removes_txt() {
        let dir = std::env::temp_dir().join("sfl-origin-migrate-test");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        // Create a dummy executable so the migration doesn't skip it
        let exe_dir = dir.join("dummy_origin");
        let _ = std::fs::create_dir_all(&exe_dir);
        let dummy_exe = exe_dir.join("Origin98_64.exe");
        std::fs::write(&dummy_exe, b"dummy exe").expect("write dummy exe");
        let legacy_path_str = dummy_exe.to_string_lossy().into_owned();
        let legacy = dir.join("origin-executable.txt");
        std::fs::write(&legacy, format!("{legacy_path_str}\n")).expect("write");
        let result = migrate_legacy_config(&dir).expect("migrate");
        assert!(result.is_some());
        assert!(dir.join("origin-config.json").is_file());
        assert!(!legacy.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extension_for_opju() {
        assert_eq!(OriginProjectFormat::Opju.extension(), "opju");
    }

    #[test]
    fn extension_for_opj() {
        assert_eq!(OriginProjectFormat::Opj.extension(), "opj");
    }
}
