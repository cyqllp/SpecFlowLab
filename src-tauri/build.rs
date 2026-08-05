fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") && tauri_build::is_dev() {
        panic!(
            "SpecFlowLab release builds require the custom-protocol feature so the frontend is embedded. Use `tauri build` or pass `--features custom-protocol`."
        );
    }
    tauri_build::build()
}
