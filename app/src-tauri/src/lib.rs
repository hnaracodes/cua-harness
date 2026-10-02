// The shell is thin glue: it supervises the Python daemon and hosts the webview.
// All logic lives in the daemon; the webview renders and captures gestures.
mod supervisor;

use supervisor::{Supervisor, SupervisorStatus};
use tauri::{Manager, RunEvent};

#[tauri::command]
fn daemon_status(sup: tauri::State<'_, Supervisor>) -> SupervisorStatus {
    sup.status()
}

#[tauri::command]
fn daemon_log_tail(sup: tauri::State<'_, Supervisor>, lines: usize) -> String {
    sup.log_tail(lines.min(supervisor::LOG_CAPACITY))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Supervisor::start())
        .invoke_handler(tauri::generate_handler![daemon_status, daemon_log_tail])
        .build(tauri::generate_context!())
        .expect("error while building Agent Oversight");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Supervisor>().shutdown();
        }
    });
}
