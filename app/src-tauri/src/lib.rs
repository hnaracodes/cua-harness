// The shell is thin glue: all logic lives in the Python daemon, the webview
// renders and captures gestures.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Agent Oversight");
}
