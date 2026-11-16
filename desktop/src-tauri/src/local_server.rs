//! The app menu's Local Server submenu (macOS): the Diazo server that
//! scripts/install.sh runs on this Mac, a container named `diazo` under
//! Apple's `container`, published on 127.0.0.1:4400 and started at login by
//! the LaunchAgent dev.bryann2k.diazo.server.
//!
//! The submenu shows its status (running, starting, stopped or not
//! installed, with its address) and can start, stop and restart it, open its
//! logs, point the app at it ("Use This Mac’s Server", through the server
//! choice of src/server.rs, which checks it answers, confirms and restarts)
//! or open the server settings to pick another one.
//!
//! Only fixed commands run: the `container` binary from its install folders
//! (or the login shell's PATH) with one of the argument lists of `Action`,
//! all naming the one `diazo` container. Nothing a page sends reaches a
//! command line: the page can only read the status (`local_server_status`,
//! advertised as `__DIAZO_LOCAL_SERVER__`), and every change of state is
//! asked in a native dialog first.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/// The server's address, as the app opens it (scripts/install.sh writes it to
/// server.json, and the container trusts it as an origin).
pub const LOCAL_URL: &str = "http://127.0.0.1:4400";
/// The container scripts/install-local.sh makes.
const CONTAINER: &str = "diazo";
/// Where Apple's installer puts the CLI (and where Homebrew would).
const KNOWN_BINARIES: &[&str] = &["/usr/local/bin/container", "/opt/homebrew/bin/container"];
const LAUNCH_AGENT: &str = "Library/LaunchAgents/dev.bryann2k.diazo.server.plist";
const LOG_DIR: &str = "Library/Logs/Diazo";
const INSTALL_DOCS: &str = "https://github.com/BRYANN2K/diazo#install";
/// The page hears every status change under this name.
pub const EVENT: &str = "local-server";
const POLL_EVERY: Duration = Duration::from_secs(15);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// Every command the submenu runs, each one fixed argument list.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    SystemStatus,
    SystemStart,
    Inspect,
    Start,
    Stop,
    Logs,
}

impl Action {
    fn args(self) -> &'static [&'static str] {
        match self {
            Action::SystemStatus => &["system", "status"],
            Action::SystemStart => &["system", "start", "--enable-kernel-install"],
            Action::Inspect => &["inspect", CONTAINER],
            Action::Start => &["start", CONTAINER],
            Action::Stop => &["stop", CONTAINER],
            Action::Logs => &["logs", "-n", "500", CONTAINER],
        }
    }

    /// Starting may pull the services up first; the rest answer quickly.
    fn timeout(self) -> Duration {
        match self {
            Action::SystemStart | Action::Start | Action::Stop => Duration::from_secs(120),
            _ => Duration::from_secs(20),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// the container runs and /healthz answers
    Running,
    /// the container runs, the server is not answering yet
    Starting,
    Stopped,
    NotInstalled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    state: State,
    url: &'static str,
    /// the app has this server open
    in_use: bool,
}

// ---------------------------------------------------------------- commands

/// The `container` CLI: an install folder, else the login shell's PATH.
fn container_binary() -> Option<PathBuf> {
    let known = KNOWN_BINARIES.iter().map(PathBuf::from);
    let on_path: Vec<PathBuf> = crate::claude::login_shell_path(false)
        .map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("container"))
                .collect()
        })
        .unwrap_or_default();
    known.chain(on_path).find(|candidate| candidate.is_file())
}

/// The PATH the CLI runs with: the login shell's, else the system one.
fn command_path() -> OsString {
    crate::claude::login_shell_path(false).unwrap_or_else(|| {
        OsString::from("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    })
}

/// Runs one action, its output to `stdout`; true when it exited 0 in time.
fn run(binary: &Path, action: Action, stdout: Stdio) -> Result<bool, String> {
    let mut child = Command::new(binary)
        .args(action.args())
        .env("PATH", command_path())
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not run {}: {error}", binary.display()))?;
    let deadline = Instant::now() + action.timeout();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "`container {}` did not finish in time.",
                    action.args().join(" ")
                ));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// `container inspect diazo`'s output, read into a file (a pipe read only
/// after the process ends could fill up).
fn inspect(binary: &Path) -> Option<String> {
    use std::io::{Read, Seek};
    let file = tempfile::tempfile().ok()?;
    let mut reader = file.try_clone().ok()?;
    if !run(binary, Action::Inspect, Stdio::from(file)).ok()? {
        return None;
    }
    // the clone shares the offset the writes left at the end
    reader.rewind().ok()?;
    let mut text = String::new();
    reader.read_to_string(&mut text).ok()?;
    Some(text)
}

/// The container's state in `container inspect`'s JSON: a list of
/// snapshots, the first one's `status` (`running`, `stopped`, ...).
fn parse_inspect(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    let first = match &value {
        Value::Array(items) => items.first()?,
        Value::Object(_) => &value,
        _ => return None,
    };
    first
        .get("status")
        .or_else(|| first.get("state"))
        .and_then(Value::as_str)
        .map(|status| status.to_ascii_lowercase())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The installer registered the server here, even while it is stopped.
fn installed_here() -> bool {
    home().is_some_and(|home| home.join(LAUNCH_AGENT).is_file())
}

/// What the commands say, before the health check.
fn container_state(services_up: bool, inspected: Option<&str>, registered: bool) -> State {
    if !services_up {
        return if registered {
            State::Stopped
        } else {
            State::NotInstalled
        };
    }
    match inspected.and_then(parse_inspect).as_deref() {
        Some("running") => State::Running,
        Some(_) => State::Stopped,
        None if registered => State::Stopped,
        None => State::NotInstalled,
    }
}

fn read_state() -> State {
    let Some(binary) = container_binary() else {
        return State::NotInstalled;
    };
    let up = run(&binary, Action::SystemStatus, Stdio::null()).unwrap_or(false);
    let inspected = if up { inspect(&binary) } else { None };
    container_state(up, inspected.as_deref(), installed_here())
}

async fn answers() -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() else {
        return false;
    };
    client
        .get(format!("{LOCAL_URL}/healthz"))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

fn uses_local(app: &AppHandle) -> bool {
    let active = crate::server::active(app);
    ["http://127.0.0.1:4400", "http://localhost:4400"].contains(&active)
}

pub async fn status(app: &AppHandle) -> Status {
    let state = tauri::async_runtime::spawn_blocking(read_state)
        .await
        .unwrap_or(State::NotInstalled);
    let state = match state {
        State::Running if !answers().await => State::Starting,
        other => other,
    };
    Status {
        state,
        url: LOCAL_URL,
        in_use: uses_local(app),
    }
}

/// Runs the actions in order on a blocking thread, stopping at the first
/// that fails.
async fn perform(actions: Vec<Action>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let binary = container_binary().ok_or("Apple’s container is not installed on this Mac.")?;
        for action in actions {
            if action == Action::SystemStart && run(&binary, Action::SystemStatus, Stdio::null())? {
                continue;
            }
            if !run(&binary, action, Stdio::null())? {
                return Err(format!(
                    "`container {}` failed. The logs may say why.",
                    action.args().join(" ")
                ));
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The last 500 lines of the container's log, in ~/Library/Logs/Diazo.
fn write_logs() -> Result<PathBuf, String> {
    let dir = home().ok_or("No home folder.")?.join(LOG_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let binary = container_binary().ok_or("Apple’s container is not installed on this Mac.")?;
    let path = dir.join("container.log");
    let file = std::fs::File::create(&path).map_err(|error| error.to_string())?;
    run(&binary, Action::Logs, Stdio::from(file))?;
    Ok(path)
}

#[tauri::command]
pub async fn local_server_status(app: AppHandle) -> Status {
    status(&app).await
}

// ---------------------------------------------------------------- the menu

#[cfg(target_os = "macos")]
pub use menu::{item_picked, start, submenu};

#[cfg(target_os = "macos")]
mod menu {
    use super::*;
    use std::sync::Mutex;

    use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
    use tauri::menu::{IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{Emitter, Manager, Url};
    use tauri_plugin_opener::OpenerExt;

    use crate::ShellRuntime;

    const PREFIX: &str = "local-server:";
    const STATUS: &str = "local-server:status";
    const START: &str = "local-server:start";
    const STOP: &str = "local-server:stop";
    const RESTART: &str = "local-server:restart";
    const LOGS: &str = "local-server:logs";
    const USE_LOCAL: &str = "local-server:use-local";
    const USE_OTHER: &str = "local-server:use-other";
    const INSTALL: &str = "local-server:install";

    struct Items {
        status: MenuItem<ShellRuntime>,
        start: MenuItem<ShellRuntime>,
        stop: MenuItem<ShellRuntime>,
        restart: MenuItem<ShellRuntime>,
        use_local: MenuItem<ShellRuntime>,
        install: MenuItem<ShellRuntime>,
    }

    /// The submenu's items of the bar now shown (the page rebuilds the bar,
    /// src/app_menu.rs, and each build makes new ones), and the last status.
    static ITEMS: Mutex<Option<Items>> = Mutex::new(None);
    static LAST: Mutex<Option<Status>> = Mutex::new(None);

    fn item(app: &AppHandle, id: &str, label: &str) -> tauri::Result<MenuItem<ShellRuntime>> {
        MenuItem::with_id(app, id, label, false, None::<&str>)
    }

    /// The Local Server submenu, for the app menu (main.rs `app_submenu`).
    pub fn submenu(app: &AppHandle) -> tauri::Result<Submenu<ShellRuntime>> {
        let items = Items {
            status: item(app, STATUS, "Checking…")?,
            start: item(app, START, "Start")?,
            stop: item(app, STOP, "Stop…")?,
            restart: item(app, RESTART, "Restart…")?,
            use_local: item(app, USE_LOCAL, "Use This Mac’s Server…")?,
            install: item(app, INSTALL, "How to Install It…")?,
        };
        let logs = MenuItem::with_id(app, LOGS, "Open Logs", true, None::<&str>)?;
        let use_other =
            MenuItem::with_id(app, USE_OTHER, "Use Another Server…", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let rows: [&dyn IsMenuItem<ShellRuntime>; 11] = [
            &items.status,
            &separator,
            &items.start,
            &items.stop,
            &items.restart,
            &separator,
            &logs,
            &items.install,
            &separator,
            &items.use_local,
            &use_other,
        ];
        let submenu = Submenu::with_items(app, "Local Server", true, &rows)?;
        let last = LAST.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(status) = &last {
            show(&items, status);
        }
        *ITEMS.lock().unwrap_or_else(|e| e.into_inner()) = Some(items);
        Ok(submenu)
    }

    fn show(items: &Items, status: &Status) {
        let _ = items.status.set_text(status_line(status));
        let running = matches!(status.state, State::Running | State::Starting);
        let installed = status.state != State::NotInstalled;
        let _ = items.start.set_enabled(status.state == State::Stopped);
        let _ = items.stop.set_enabled(running);
        let _ = items.restart.set_enabled(running);
        let _ = items.use_local.set_enabled(installed && !status.in_use);
        let _ = items.install.set_enabled(!installed);
    }

    /// Reads the status, shows it and tells the page.
    async fn refresh(app: &AppHandle) {
        let status = status(app).await;
        if let Some(items) = ITEMS.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            show(items, &status);
        }
        let changed = {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            let changed = last.as_ref() != Some(&status);
            *last = Some(status.clone());
            changed
        };
        if changed {
            let _ = app.emit(EVENT, status);
        }
    }

    /// Keeps the submenu's status current (setup, in main.rs).
    pub fn start(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                refresh(&app).await;
                tokio::time::sleep(POLL_EVERY).await;
            }
        });
    }

    fn dialog(app: &AppHandle, title: &str, description: &str) -> AsyncMessageDialog {
        let dialog = AsyncMessageDialog::new()
            .set_title(title)
            .set_description(description);
        match app.get_webview_window("main") {
            Some(window) => dialog.set_parent(&window),
            None => dialog,
        }
    }

    async fn confirm(app: &AppHandle, title: &str, description: &str, button: &str) -> bool {
        let choice = dialog(app, title, description)
            .set_buttons(MessageButtons::OkCancelCustom(
                button.into(),
                "Cancel".into(),
            ))
            .show()
            .await;
        match choice {
            MessageDialogResult::Ok => true,
            MessageDialogResult::Custom(label) => label == button,
            _ => false,
        }
    }

    async fn failed(app: &AppHandle, title: &str, error: &str) {
        dialog(app, title, error)
            .set_level(MessageLevel::Error)
            .show()
            .await;
    }

    /// Handles a pick in the submenu; false for any other menu id.
    pub fn item_picked(app: &AppHandle, id: &str) -> bool {
        if !id.starts_with(PREFIX) {
            return false;
        }
        let app = app.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move { picked(&app, &id).await });
        true
    }

    async fn picked(app: &AppHandle, id: &str) {
        let in_use = uses_local(app);
        let cut_off = if in_use {
            "\n\nThis window uses it: it loses its connection until the server is back."
        } else {
            ""
        };
        let change = match id {
            START => confirm(
                app,
                "Start this Mac’s Diazo server?",
                &format!("It starts the Diazo container at {LOCAL_URL}."),
                "Start",
            )
            .await
            .then(|| vec![Action::SystemStart, Action::Start]),
            STOP => confirm(
                app,
                "Stop this Mac’s Diazo server?",
                &format!(
                    "Canvases are kept. It starts again at login, or from this menu.{cut_off}"
                ),
                "Stop",
            )
            .await
            .then(|| vec![Action::Stop]),
            RESTART => confirm(
                app,
                "Restart this Mac’s Diazo server?",
                &format!("It stops and starts the Diazo container.{cut_off}"),
                "Restart",
            )
            .await
            .then(|| vec![Action::Stop, Action::SystemStart, Action::Start]),
            LOGS => {
                match tauri::async_runtime::spawn_blocking(write_logs).await {
                    Ok(Ok(path)) => {
                        let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
                    }
                    Ok(Err(error)) => failed(app, "Couldn’t read the logs", &error).await,
                    Err(error) => failed(app, "Couldn’t read the logs", &error.to_string()).await,
                }
                None
            }
            USE_LOCAL => {
                if let Err(error) =
                    crate::server::server_choose(app.clone(), LOCAL_URL.into()).await
                {
                    failed(app, "Couldn’t switch servers", &error).await;
                }
                None
            }
            USE_OTHER => {
                // the page's server settings collect the address; the shell
                // checks it and confirms (server_choose)
                let target = format!(
                    "{}/settings?pane=general&server=choose",
                    crate::server::active(app)
                );
                if let (Some(window), Ok(url)) =
                    (app.get_webview_window("main"), Url::parse(&target))
                {
                    let _ = window.navigate(url);
                }
                None
            }
            INSTALL => {
                let _ = app.opener().open_url(INSTALL_DOCS, None::<&str>);
                None
            }
            _ => None,
        };
        if let Some(actions) = change {
            if let Err(error) = perform(actions).await {
                failed(app, "The local server did not respond", &error).await;
            }
        }
        refresh(app).await;
    }
}

/// The submenu's first row.
fn status_line(status: &Status) -> String {
    match status.state {
        State::Running => format!("Running at {}", status.url),
        State::Starting => format!("Starting at {}…", status.url),
        State::Stopped => "Stopped".into(),
        State::NotInstalled => "Not installed on this Mac".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_only_fixed_commands_on_the_diazo_container() {
        let all = [
            Action::SystemStatus,
            Action::SystemStart,
            Action::Inspect,
            Action::Start,
            Action::Stop,
            Action::Logs,
        ];
        for action in all {
            let args = action.args();
            assert!(!args.is_empty());
            assert!(
                args.iter()
                    .all(|arg| !arg.contains(' ') && !arg.starts_with('/')),
                "{action:?}"
            );
            // a container action names the diazo container, last
            if !matches!(action, Action::SystemStatus | Action::SystemStart) {
                assert_eq!(args.last(), Some(&CONTAINER), "{action:?}");
            }
        }
        assert_eq!(Action::Start.args(), ["start", "diazo"]);
        assert_eq!(Action::Stop.args(), ["stop", "diazo"]);
        assert_eq!(Action::Inspect.args(), ["inspect", "diazo"]);
        assert_eq!(Action::Logs.args(), ["logs", "-n", "500", "diazo"]);
        assert_eq!(
            Action::SystemStart.args(),
            ["system", "start", "--enable-kernel-install"]
        );
    }

    #[test]
    fn reads_the_state_from_inspect() {
        assert_eq!(
            parse_inspect(r#"[{"status":"running","configuration":{"id":"diazo"}}]"#).as_deref(),
            Some("running")
        );
        assert_eq!(
            parse_inspect(r#"[{"status":"stopped"}]"#).as_deref(),
            Some("stopped")
        );
        assert_eq!(
            parse_inspect(r#"{"state":"Running"}"#).as_deref(),
            Some("running")
        );
        assert_eq!(parse_inspect("[]"), None);
        assert_eq!(parse_inspect("not json"), None);
        assert_eq!(parse_inspect(r#"[{"configuration":{}}]"#), None);
    }

    #[test]
    fn tells_stopped_from_not_installed() {
        let running = Some(r#"[{"status":"running"}]"#);
        let stopped = Some(r#"[{"status":"stopped"}]"#);
        assert_eq!(container_state(true, running, true), State::Running);
        assert_eq!(container_state(true, stopped, true), State::Stopped);
        // the services are off: stopped when the installer registered it
        assert_eq!(container_state(false, None, true), State::Stopped);
        assert_eq!(container_state(false, None, false), State::NotInstalled);
        // no such container
        assert_eq!(container_state(true, None, false), State::NotInstalled);
        assert_eq!(container_state(true, None, true), State::Stopped);
    }

    #[test]
    fn names_the_state_in_the_menu() {
        let line = |state| {
            status_line(&Status {
                state,
                url: LOCAL_URL,
                in_use: false,
            })
        };
        assert_eq!(line(State::Running), "Running at http://127.0.0.1:4400");
        assert_eq!(line(State::Stopped), "Stopped");
        assert_eq!(line(State::NotInstalled), "Not installed on this Mac");
    }

    #[test]
    fn reports_the_state_to_the_page_in_kebab_case() {
        let status = Status {
            state: State::NotInstalled,
            url: LOCAL_URL,
            in_use: true,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({ "state": "not-installed", "url": LOCAL_URL, "inUse": true })
        );
    }

    #[test]
    fn the_local_url_is_one_the_shell_may_open_over_http() {
        assert_eq!(crate::server::normalize(LOCAL_URL).unwrap(), LOCAL_URL);
    }
}
