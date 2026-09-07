use runescript_session::{detect, GameProcess, GameSession, Request, Response};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct Desktop {
    session: Mutex<Option<GameSession>>,
}

#[tauri::command]
async fn detect_game() -> Result<Vec<GameProcess>, String> {
    tauri::async_runtime::spawn_blocking(|| detect().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn inject(app: tauri::AppHandle, pid: u32) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Response> {
        let state = app.state::<Desktop>();
        let mut session = state
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("Session lock poisoned"))?;

        if let Some(current) = session.as_mut() {
            anyhow::ensure!(current.pid == pid, "Detach the current game first");
            return current.request(Request::Status);
        }

        let game = detect()?
            .into_iter()
            .find(|game| game.pid == pid)
            .ok_or_else(|| anyhow::anyhow!("DELTARUNE process disappeared"))?;
        let agent = if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../target/debug/librunescript_agent.dylib")
        } else {
            app.path().resource_dir()?.join("librunescript_agent.dylib")
        };

        let mut connected = GameSession::inject(&game, &agent)?;
        let response = connected.request(Request::Status)?;
        *session = Some(connected);
        Ok(response)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn execute(app: tauri::AppHandle, request: Request) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Response> {
        let state = app.state::<Desktop>();
        let mut session = state
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("Session lock poisoned"))?;
        let detach = matches!(request, Request::Detach);
        let result = session
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Inject first"))?
            .request(request);

        // a dead socket is not a session... make the next click start cleanly!
        if detach || result.is_err() {
            *session = None;
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(Desktop::default())
        .invoke_handler(tauri::generate_handler![detect_game, inject, execute])
        .run(tauri::generate_context!())
        .expect("RuneScript failed to start");
}
