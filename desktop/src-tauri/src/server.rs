//! Which Diazo server the shell opens. Official builds open the server on
//! this computer, `http://127.0.0.1:4400` (the all-in-one install of
//! scripts/install.sh, or `docker compose up`), or the `DOOP_APP_URL` they
//! were built with; the sign-in screen's server settings
//! (src/components/ServerSettings.tsx) let a person point the same build at
//! another instance instead, through `server_choose`.
//!
//! The choice is the server's origin in `server.json` in the app's data
//! directory (`server-dev.json` for debug builds, which otherwise open the
//! local dev server). It is read once at launch: the navigation allowlist,
//! the remote IPC grant and the first page all follow it, so changing it
//! restarts the app.
//!
//! The IPC grant is capabilities/default.json with a remote URL list of the
//! one server this launch opens, added at runtime (`grant`): that file is the
//! one list of what a page may ask the shell for, and the open server gets
//! exactly that. The bundled file names no remote origin, so no other site
//! ever gets IPC. doop.design and www.doop.design (upstream's hosted
//! service, whose pages this fork does not control) are refused as a server
//! outright (`refused`), and a saved choice of them is ignored.
//! It is also why a change needs the person's say-so in a native dialog. The
//! asking page is the current server's, and the next one can run Claude Code
//! on this computer, read fonts the person picks and write their Codex and
//! Claude settings.
//!
//! A server that never loads leaves no page to change it from. So at launch
//! the shell checks the server answers and, when it does not, asks in a
//! native dialog (every platform: Windows and Linux have no menu bar): a
//! chosen server offers Try Again or the server on this computer; the
//! default offers Try Again or "Choose a Server…", which opens the shell's
//! one bundled page (shell-dist/index.html) to type another address. On
//! macOS the app menu also has "Use this computer’s server…" while another
//! server is chosen.
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

const CAPABILITY: &str = include_str!("../capabilities/default.json");
const MOTION_CAPABILITY: &str = include_str!("../capabilities/motion-render.json");
const CONNECT: &str = "Connect";
const SWITCH: &str = "Switch";
const CANCEL: &str = "Cancel";
const RETRY: &str = "Try Again";
const CHOOSE: &str = "Choose a Server…";
/// How long a server gets to answer the check before it counts as absent.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

static ACTIVE: OnceLock<String> = OnceLock::new();

/// Upstream doop's hosted service. This fork does not control its pages, so
/// it never gets the shell's IPC: it cannot be chosen, nor be the default.
const REFUSED_HOSTS: &[&str] = &["doop.design", "www.doop.design"];

fn refused(server: &str) -> bool {
    Url::parse(server)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| REFUSED_HOSTS.contains(&host.as_str()))
}

/// The server the shell opens with nothing chosen.
pub fn default_url() -> String {
    let url = if cfg!(debug_assertions) {
        // A second worktree runs its dev pair on other ports (vite.config.ts);
        // DOOP_DEV_URL points a dev shell at it. Keep tauri.conf.json's devUrl
        // in step so IPC keeps treating the pages as local.
        option_env!("DOOP_DEV_URL").unwrap_or("http://localhost:4300")
    } else {
        crate::APP_URL
    };
    url.trim_end_matches('/').to_string()
}

/// The server this launch opens, without a trailing slash. Read from disk on
/// the first call (the menu or setup, both before any page loads).
pub fn active(app: &AppHandle) -> &'static str {
    ACTIVE.get_or_init(|| chosen(app).unwrap_or_else(default_url))
}

/// The server this launch opens, for code with no app handle; only valid
/// once the app is running.
pub fn active_url() -> String {
    ACTIVE.get().cloned().unwrap_or_else(default_url)
}

pub fn is_custom(app: &AppHandle) -> bool {
    !same_server(active(app), &default_url())
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(debug_assertions) {
        "server-dev.json"
    } else {
        "server.json"
    };
    app.path().app_data_dir().ok().map(|dir| dir.join(name))
}

fn chosen(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(config_file(app)?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    normalize(value.get("url")?.as_str()?).ok()
}

fn save(app: &AppHandle, url: Option<&str>) -> Result<(), String> {
    let file = config_file(app).ok_or("Could not find the app's data folder.")?;
    match url {
        None => match std::fs::remove_file(&file) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err("Could not reset the server setting.".into())
            }
            _ => Ok(()),
        },
        Some(url) => {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|_| "Could not create the app's data folder.")?;
            }
            std::fs::write(&file, json!({ "url": url }).to_string())
                .map_err(|_| "Could not save the server setting.".into())
        }
    }
}

/// A typed address as the origin it names: `doop.example.com`,
/// `https://doop.example.com/c/abc` and `HTTPS://Doop.Example.com/` are all
/// `https://doop.example.com`. Only a server it is safe to hand the shell's
/// IPC to: https, or http on this computer (see `secure`).
pub fn normalize(input: &str) -> Result<String, String> {
    let origin = parse_origin(input)?;
    secure(&origin)?;
    let origin = origin.origin().ascii_serialization();
    if refused(&origin) {
        return Err(format!(
            "{} is the original doop service, not a Diazo server. Use the doop app for it.",
            display(&origin)
        ));
    }
    Ok(origin)
}

/// Plain http is only for this computer. Anyone on the path of an http
/// connection to another machine can replace its pages, and a page from the
/// chosen server gets the shell's IPC (Claude Code, the Codex and Claude
/// settings) with no further question.
fn secure(url: &Url) -> Result<(), String> {
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if url.scheme() == "https" || loopback {
        Ok(())
    } else {
        Err(format!(
            "{} is not secure. Use an https:// address; plain http:// only works for a server on this computer.",
            url.origin().ascii_serialization()
        ))
    }
}

/// The typed address as a parsed http(s) URL with a host and no
/// credentials; whether it is safe to use is `secure`'s call.
fn parse_origin(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter the address of a Diazo server.".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| format!("“{input}” is not a web address."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The address must start with https:// or http://.".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("“{input}” is not a web address."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not contain a user name or password.".into());
    }
    Ok(url)
}

/// doop.design and www.doop.design are one server.
fn same_server(a: &str, b: &str) -> bool {
    let bare = |url: &str| url.trim_end_matches('/').replacen("://www.", "://", 1);
    bare(a) == bare(b)
}

/// Hosts whose pages stay in the window: the server's, with and without
/// `www.`, local addresses (the dev server, a local self-host) and the
/// bundled page's (`tauri.localhost` on Windows). Staying in the window is
/// not IPC: only the open server's exact origin gets that (`grant`).
pub fn app_hosts(server: &str) -> Vec<String> {
    let mut hosts: Vec<String> = vec![
        "localhost".into(),
        "127.0.0.1".into(),
        "tauri.localhost".into(),
    ];
    if let Some(host) = Url::parse(server).ok().as_ref().and_then(Url::host_str) {
        hosts.push(host.to_string());
        if host.parse::<std::net::IpAddr>().is_err() && host != "localhost" {
            hosts.push(match host.strip_prefix("www.") {
                Some(bare) => bare.to_string(),
                None => format!("www.{host}"),
            });
        }
    }
    hosts.dedup();
    hosts
}

/// The shell capability, granted to `server`.
fn capability_for(server: &str) -> Result<String, String> {
    let mut capability: Value =
        serde_json::from_str(CAPABILITY).map_err(|error| error.to_string())?;
    capability["identifier"] = json!("shell-chosen-server");
    capability["description"] =
        json!("capabilities/default.json, for the server picked in the app");
    capability["remote"] = json!({ "urls": [server] });
    Ok(capability.to_string())
}

/// The render webview's two invoke-backs, granted to `server` the same way.
fn motion_capability_for(server: &str) -> Result<String, String> {
    let mut capability: Value =
        serde_json::from_str(MOTION_CAPABILITY).map_err(|error| error.to_string())?;
    capability["identifier"] = json!("motion-render-chosen-server");
    capability["description"] =
        json!("capabilities/motion-render.json, for the server picked in the app");
    capability["remote"] = json!({ "urls": [server] });
    Ok(capability.to_string())
}

/// The remote origin this launch grants the shell's IPC to: the server it
/// opens, and nothing else. None for a debug build on its dev server, whose
/// pages count as local (tauri.conf.json devUrl), and for a refused server,
/// which `active` never returns but is checked again here.
fn granted_origin(server: &str, custom: bool, debug: bool) -> Option<String> {
    if (debug && !custom) || refused(server) {
        return None;
    }
    Some(server.trim_end_matches('/').to_string())
}

/// Lets the open server's pages use the shell's IPC. The bundled capability
/// names no remote origin, so this is the only grant a site ever gets.
pub fn grant(app: &AppHandle) -> Result<(), String> {
    let Some(server) = granted_origin(active(app), is_custom(app), cfg!(debug_assertions)) else {
        return Ok(());
    };
    let capability = capability_for(&server)?;
    app.add_capability(capability)
        .map_err(|error| error.to_string())?;
    let motion = motion_capability_for(&server)?;
    app.add_capability(motion)
        .map_err(|error| error.to_string())
}

/// Every Doop server answers this public route, so a typo or another site
/// is caught before the app restarts onto it. Resolves to the origin that
/// answered: an address that redirects (http to https, the bare host to
/// `www.`) is saved and granted as where the pages actually load, and that
/// one has to be secure too.
async fn probe(server: &str) -> Result<String, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let unreachable =
        || format!("No Diazo server answered at {server}. Check the address and try again.");
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{server}/api/locale-config"))
        .send()
        .await
        .map_err(|_| unreachable())?;
    if !response.status().is_success() {
        return Err(unreachable());
    }
    let answered = response.url().clone();
    let body: Value = response.json().await.map_err(|_| unreachable())?;
    if !matches!(body.get("defaultLocale"), Some(Value::String(_))) {
        return Err(unreachable());
    }
    secure(&answered)?;
    Ok(answered.origin().ascii_serialization())
}

/// Windows shows custom labels only with comctl v6 and otherwise answers
/// with plain OK / Cancel, so OK counts as the custom confirm.
fn accepted(choice: &MessageDialogResult, confirm: &str) -> bool {
    match choice {
        MessageDialogResult::Ok => true,
        MessageDialogResult::Custom(label) => label == confirm,
        _ => false,
    }
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

/// How the dialogs and the menu name the default server: the one on this
/// computer by that name, a self-hoster's own default by its host.
fn default_name() -> String {
    server_name(&default_url())
}

fn server_name(server: &str) -> String {
    if same_server(server, crate::local_server::LOCAL_URL)
        || same_server(server, "http://localhost:4400")
    {
        "this computer’s server".into()
    } else {
        display(server)
    }
}

/// The bundled page that asks for a server's address (shell-dist), as the
/// window loads it on this platform.
fn chooser_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

fn display(server: &str) -> String {
    Url::parse(server)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| server.to_string())
}

/// Asks, saves and restarts; false when the person said no. Going back to
/// the default needs no warning: it is this computer's own server.
async fn switch(app: &AppHandle, server: String) -> Result<bool, String> {
    let to_default = same_server(&server, &default_url());
    let choice = if to_default {
        dialog(
            app,
            &format!("Switch back to {}?", display(&server)),
            "Diazo will restart and open it.",
        )
        .set_buttons(MessageButtons::OkCancelCustom(SWITCH.into(), CANCEL.into()))
        .show()
        .await
    } else {
        dialog(
            app,
            &format!("Connect Diazo to {}?", display(&server)),
            &format!(
                "Diazo will restart and open {server}.\n\nThe server you connect to can use this app's access to your computer: it can run Claude Code here, read fonts you pick and add itself to your Codex and Claude settings. Only connect to a server you trust."
            ),
        )
        .set_level(MessageLevel::Warning)
        .set_buttons(MessageButtons::OkCancelCustom(CONNECT.into(), CANCEL.into()))
        .show()
        .await
    };
    if !accepted(&choice, if to_default { SWITCH } else { CONNECT }) {
        return Ok(false);
    }
    save(app, if to_default { None } else { Some(&server) })?;
    app.request_restart();
    Ok(true)
}

/// The launch check, nothing while the server answers (and nothing for a
/// debug build on its dev server). Otherwise the window shows the webview's
/// error page, so ask until the server answers, then load `entry` again. A
/// chosen server offers the default instead; the default offers the bundled
/// page that asks for another address. Closing the dialog leaves the window
/// as it is.
pub fn check_on_launch(app: &AppHandle, entry: Url) {
    let custom = is_custom(app);
    if cfg!(debug_assertions) && !custom {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let server = active(&app);
        let mut failed = false;
        while let Err(error) = probe(server).await {
            failed = true;
            let back = if custom {
                format!("Use {}", default_name())
            } else {
                CHOOSE.to_string()
            };
            let choice = dialog(&app, &format!("Can’t reach {}", display(server)), &error)
                .set_level(MessageLevel::Warning)
                .set_buttons(MessageButtons::OkCancelCustom(RETRY.into(), back.clone()))
                .show()
                .await;
            match launch_choice(&choice, &back) {
                LaunchChoice::Retry => continue,
                LaunchChoice::Default if !custom => {
                    if let (Some(window), Ok(url)) =
                        (app.get_webview_window("main"), Url::parse(chooser_url()))
                    {
                        let _ = window.navigate(url);
                    }
                    return;
                }
                LaunchChoice::Default => {
                    if let Err(error) = save(&app, None) {
                        dialog(&app, "Couldn’t switch servers", &error)
                            .set_level(MessageLevel::Error)
                            .show()
                            .await;
                        return;
                    }
                    app.request_restart();
                    return;
                }
                LaunchChoice::Dismissed => return,
            }
        }
        if failed {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.navigate(entry);
            }
        }
    });
}

#[derive(Debug, PartialEq)]
enum LaunchChoice {
    Retry,
    Default,
    Dismissed,
}

/// Windows without comctl v6 shows plain OK / Cancel: OK is the retry, and
/// Cancel there cannot be told from closing the dialog, so it does nothing.
fn launch_choice(choice: &MessageDialogResult, back: &str) -> LaunchChoice {
    match choice {
        MessageDialogResult::Ok => LaunchChoice::Retry,
        MessageDialogResult::Custom(label) if label == RETRY => LaunchChoice::Retry,
        MessageDialogResult::Custom(label) if label == back => LaunchChoice::Default,
        _ => LaunchChoice::Dismissed,
    }
}

#[tauri::command]
pub fn server_status(app: AppHandle) -> Value {
    json!({
        "url": active(&app),
        "defaultUrl": default_url(),
        "custom": is_custom(&app),
    })
}

/// Point the app at `url` (the default server's address resets the choice).
/// Resolves false when nothing changed: the same server, or a cancel.
#[tauri::command]
pub async fn server_choose(app: AppHandle, url: String) -> Result<bool, String> {
    // going back to the default needs no check: it is the way back
    let typed = parse_origin(&url)?.origin().ascii_serialization();
    let server = if same_server(&typed, &default_url()) {
        default_url()
    } else {
        probe(&normalize(&url)?).await?
    };
    if same_server(&server, active(&app)) {
        return Ok(false);
    }
    switch(&app, server).await
}

/// The app menu's way back while another server is chosen, for a server
/// that no longer loads.
#[cfg(target_os = "macos")]
pub mod menu {
    use super::*;
    use tauri::menu::MenuItem;

    pub const MENU_ID: &str = "server-reset";

    /// None while the default server is open.
    pub fn item(app: &AppHandle) -> tauri::Result<Option<MenuItem<crate::ShellRuntime>>> {
        if !is_custom(app) {
            return Ok(None);
        }
        let label = format!("Use {}…", default_name());
        MenuItem::with_id(app, MENU_ID, label, true, None::<&str>).map(Some)
    }

    pub fn reset(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = switch(&app, default_url()).await {
                dialog(&app, "Couldn’t switch servers", &error)
                    .set_level(MessageLevel::Error)
                    .show()
                    .await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_local_server_as_this_computers() {
        assert_eq!(
            server_name("http://127.0.0.1:4400"),
            "this computer’s server"
        );
        assert_eq!(
            server_name("http://localhost:4400/"),
            "this computer’s server"
        );
        assert_eq!(
            server_name("https://diazo.example.com"),
            "diazo.example.com"
        );
    }

    #[test]
    fn opens_the_server_on_this_computer_by_default() {
        if option_env!("DOOP_APP_URL").is_none() && !cfg!(debug_assertions) {
            assert_eq!(default_url(), crate::local_server::LOCAL_URL);
        }
        assert_eq!(
            crate::APP_URL,
            option_env!("DOOP_APP_URL").unwrap_or("http://127.0.0.1:4400")
        );
        assert!(!refused(crate::APP_URL));
    }

    #[test]
    fn refuses_doop_design_as_a_server() {
        for typed in [
            "doop.design",
            "https://doop.design/",
            "https://www.doop.design/c/abc",
            "HTTPS://WWW.DOOP.DESIGN",
        ] {
            assert!(
                normalize(typed).unwrap_err().contains("original doop"),
                "{typed}"
            );
        }
        assert!(normalize("https://doop.design.example.com").is_ok());
        assert!(normalize("https://notdoop.design").is_ok());
    }

    #[test]
    fn the_bundled_capabilities_grant_no_remote_origin_but_loopback_renders() {
        let shell: Value = serde_json::from_str(CAPABILITY).unwrap();
        assert!(
            shell.get("remote").is_none(),
            "default.json must name no remote origin"
        );
        for file in [
            MOTION_CAPABILITY,
            include_str!("../capabilities/live-snapshot.json"),
        ] {
            let capability: Value = serde_json::from_str(file).unwrap();
            for url in capability["remote"]["urls"].as_array().unwrap() {
                let url = url.as_str().unwrap();
                assert!(
                    url.starts_with("http://localhost")
                        || url.starts_with("https://localhost")
                        || url.starts_with("http://*.localhost")
                        || url.starts_with("https://*.localhost")
                        || url.starts_with("http://127.")
                        || url.starts_with("https://127."),
                    "{} grants {url}",
                    capability["identifier"]
                );
            }
        }
    }

    #[test]
    fn the_config_loads_no_remote_page_as_local() {
        // a frontendDist URL counts as local to Tauri's IPC check, which would
        // hand that site every bundled permission
        for conf in [
            include_str!("../tauri.conf.json"),
            include_str!("../../src-tauri-chromium/tauri.conf.json"),
        ] {
            let conf: Value = serde_json::from_str(conf).unwrap();
            let dist = conf["build"]["frontendDist"].as_str().unwrap();
            assert!(!dist.contains("://"), "frontendDist is {dist}");
            assert_eq!(
                conf["plugins"]["updater"]["endpoints"],
                json!(["https://github.com/BRYANN2K/diazo/releases/download/desktop-updates/latest.json"])
            );
        }
    }

    #[test]
    fn grants_ipc_to_the_open_server_only() {
        // a release build grants the server it opens, default or chosen
        assert_eq!(
            granted_origin("http://127.0.0.1:4400", false, false).as_deref(),
            Some("http://127.0.0.1:4400")
        );
        assert_eq!(
            granted_origin("https://diazo.example.com/", true, false).as_deref(),
            Some("https://diazo.example.com")
        );
        assert_eq!(
            granted_origin("https://diazo.example.com", true, true).as_deref(),
            Some("https://diazo.example.com")
        );
        // a debug build's dev server is local already
        assert_eq!(granted_origin("http://localhost:4300", false, true), None);
        // upstream's service never, whatever path got it here
        for server in ["https://doop.design", "https://www.doop.design"] {
            assert_eq!(granted_origin(server, true, false), None);
            assert_eq!(granted_origin(server, false, false), None);
        }
    }

    #[test]
    fn normalizes_typed_addresses_to_origins() {
        assert_eq!(
            normalize("doop.example.com").unwrap(),
            "https://doop.example.com"
        );
        assert_eq!(
            normalize(" HTTPS://Doop.Example.com/c/abc?x=1#y ").unwrap(),
            "https://doop.example.com"
        );
        assert_eq!(
            normalize("http://localhost:4400/").unwrap(),
            "http://localhost:4400"
        );
        assert_eq!(
            normalize("http://127.0.0.1:4400").unwrap(),
            "http://127.0.0.1:4400"
        );
        assert_eq!(normalize("http://[::1]:4400").unwrap(), "http://[::1]:4400");
        assert_eq!(
            normalize("https://doop.example.com:443").unwrap(),
            "https://doop.example.com"
        );
    }

    #[test]
    fn refuses_what_is_not_a_web_server() {
        assert!(normalize("").is_err());
        assert!(normalize("file:///etc/passwd").is_err());
        assert!(normalize("javascript://alert(1)").is_err());
        assert!(normalize("https://user:pass@doop.example.com").is_err());
        assert!(normalize("https://").is_err());
    }

    #[test]
    fn keeps_plain_http_to_this_computer() {
        for remote in [
            "http://doop.example.com",
            "http://192.168.1.20:4400",
            "http://localhost.example.com",
        ] {
            assert!(
                normalize(remote).unwrap_err().contains("not secure"),
                "{remote}"
            );
        }
    }

    /// Answers every request on a loopback port with `response`, once per
    /// connection, until the test ends.
    fn serve(response: String) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn saves_the_origin_a_redirect_lands_on() {
        let doop = serve(json_response(r#"{"defaultLocale":"en"}"#));
        let redirect = serve(format!(
            "HTTP/1.1 302 Found\r\nLocation: http://localhost:{doop}/api/locale-config\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ));
        let answered =
            tauri::async_runtime::block_on(probe(&format!("http://127.0.0.1:{redirect}")));
        assert_eq!(answered.unwrap(), format!("http://localhost:{doop}"));
    }

    #[test]
    fn refuses_a_server_that_is_not_doop() {
        let other = serve(json_response(r#"{"hello":"world"}"#));
        let answered = tauri::async_runtime::block_on(probe(&format!("http://127.0.0.1:{other}")));
        assert!(answered.unwrap_err().contains("No Diazo server answered"));
    }

    #[test]
    fn www_and_bare_hosts_are_one_server() {
        assert!(same_server(
            "https://www.doop.design",
            "https://doop.design/"
        ));
        assert!(!same_server(
            "https://doop.example.com",
            "https://doop.design"
        ));
    }

    #[test]
    fn keeps_the_chosen_hosts_in_the_window() {
        let hosts = app_hosts("https://doop.example.com");
        assert!(hosts.contains(&"doop.example.com".to_string()));
        assert!(hosts.contains(&"www.doop.example.com".to_string()));
        assert!(hosts.contains(&"localhost".to_string()));
        assert!(!hosts.contains(&"doop.design".to_string()));
        let local = app_hosts("http://127.0.0.1:4400");
        assert!(!local.iter().any(|host| host.starts_with("www.")));
        assert!(local.contains(&"tauri.localhost".to_string()));
    }

    #[test]
    fn grants_the_bundled_permissions_to_the_chosen_origin() {
        let capability: Value =
            serde_json::from_str(&capability_for("https://doop.example.com").unwrap()).unwrap();
        let bundled: Value = serde_json::from_str(CAPABILITY).unwrap();
        assert_eq!(
            capability["remote"]["urls"],
            json!(["https://doop.example.com"])
        );
        assert_eq!(capability["permissions"], bundled["permissions"]);
        assert_eq!(capability["windows"], bundled["windows"]);
        assert_ne!(capability["identifier"], bundled["identifier"]);
        // the runtime accepts it as a capability file
        assert!(capability_for("https://doop.example.com")
            .unwrap()
            .parse::<tauri::utils::acl::capability::CapabilityFile>()
            .is_ok());
    }

    #[test]
    fn reads_the_launch_dialog_by_its_buttons() {
        let back = "Use this computer’s server";
        let custom = |label: &str| MessageDialogResult::Custom(label.into());
        assert_eq!(launch_choice(&custom(RETRY), back), LaunchChoice::Retry);
        assert_eq!(
            launch_choice(&MessageDialogResult::Ok, back),
            LaunchChoice::Retry
        );
        assert_eq!(launch_choice(&custom(back), back), LaunchChoice::Default);
        assert_eq!(
            launch_choice(&MessageDialogResult::Cancel, back),
            LaunchChoice::Dismissed
        );
    }

    #[test]
    fn restarts_only_on_the_confirm_button() {
        assert!(accepted(
            &MessageDialogResult::Custom(CONNECT.into()),
            CONNECT
        ));
        assert!(accepted(&MessageDialogResult::Ok, CONNECT));
        assert!(!accepted(
            &MessageDialogResult::Custom(CANCEL.into()),
            CONNECT
        ));
        assert!(!accepted(&MessageDialogResult::Cancel, CONNECT));
    }
}
