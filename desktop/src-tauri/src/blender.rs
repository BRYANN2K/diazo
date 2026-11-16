//! `blender_*` commands: the Blender bridge (Motion Studio, phase 4,
//! ADR 0011). Diazo never renders through Blender itself — a local Blender
//! MCP server does, spawned here like the ACP CLIs: an allowlisted binary
//! name found on the login shell's PATH and the fixed prefixes, started
//! only when the human asks (the UI calls `blender_start` after its own
//! confirmation).
//!
//! Disabled by default: `blender_start` refuses unless the shell was
//! launched with `DOOP_BLENDER_BRIDGE=1` — the read path exists so a page
//! can probe (`blender_status` → available / disabled / missing) without
//! the bridge being on. Read tools relay once the bridge is up; write and
//! render tools additionally need a recorded approval grant: `blender_approve`
//! shows a NATIVE confirmation naming the class and the connected server,
//! and the grant lives in `blender-approvals.json` scoped to that server
//! until `blender_revoke`. A render's output path is the shell's own, in
//! `blender-renders/` — callers never name one. Python execution is never
//! allowlisted.
//!
//! Wire: MCP over stdio, newline JSON-RPC — initialize, tools/list and a
//! bounded tools/call for names in the classed allowlist. Anything else
//! errors before it reaches the child.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// The env flag that turns the whole bridge on.
const FLAG: &str = "DOOP_BLENDER_BRIDGE";
/// Only these tools may cross the relay — reads a scene, never writes one.
/// (The upstream server's names; a server without them just answers an
/// "unknown tool" error the page sees verbatim.)
const READ_ONLY_TOOLS: &[&str] = &[
    "get_scene_info",
    "get_object_info",
    "get_viewport_screenshot",
    "get_polyhaven_status",
    "get_hyper3d_status",
    "get_sketchfab_status",
];
/// Scene writes — relayed only with a recorded `write` grant.
const WRITE_TOOLS: &[&str] = &["set_material", "add_light"];
/// Renders — relayed only with a recorded `render` grant.
const RENDER_TOOLS: &[&str] = &["render_frame", "render_animation"];
/// The approval classes a grant can cover — mirrors
/// shared/blender.ts's BLENDER_OP_CLASS.
const GRANT_KINDS: &[&str] = &["write", "render"];
/// One stdio exchange or process wait may take this long at most.
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// A tool answer bigger than this is cut before it crosses IPC.
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct BlenderStatus {
    enabled: bool,
    installed: bool,
    running: bool,
    tools: Vec<String>,
}

fn enabled() -> bool {
    std::env::var_os(FLAG).is_some_and(|v| !v.is_empty() && v != "0")
}

/// The allowlisted binary name — never a path from a caller.
const BINARY: &str = "blender-mcp";

/// Every place the server may live: the login shell's PATH, the app's own,
/// then the fixed prefixes — the same discovery the ACP agents get.
fn candidates(shell_path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for path in [shell_path.map(OsStr::to_os_string), std::env::var_os("PATH")]
        .into_iter()
        .flatten()
    {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .map(|dir| dir.join(BINARY))
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

fn resolve() -> Option<PathBuf> {
    candidates(crate::claude::login_shell_path(true).as_deref())
        .into_iter()
        .next()
}

/// The spawned server: stdin to write to, stdout lines on a thread with a
/// queue the calls read from — the same pattern acp.rs's probe uses.
struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: std::sync::mpsc::Receiver<String>,
    next_id: u64,
    tools: Vec<String>,
}

#[derive(Default)]
pub struct BlenderState(Mutex<Option<Server>>);

#[derive(Deserialize)]
struct RpcResult {
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

impl Server {
    fn spawn(path: &PathBuf) -> Result<Server, String> {
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start {BINARY}: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout on the spawned server")?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|n| n > 0) {
                if tx.send(std::mem::take(&mut line)).is_err() {
                    break;
                }
                line.clear();
            }
        });
        let stdin = child.stdin.take().ok_or("no stdin on the spawned server")?;
        Ok(Server { child, stdin, lines: rx, next_id: 0, tools: Vec::new() })
    }

    /// One request → the first response carrying its id, within the bound.
    fn call(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let body = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{body}").map_err(|e| format!("write failed: {e}"))?;
        self.stdin.flush().map_err(|e| format!("write failed: {e}"))?;
        let deadline = Instant::now() + IO_TIMEOUT;
        loop {
            let line = self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "the server did not answer in time".to_string())?;
            let parsed: RpcResult = match serde_json::from_str(&line) {
                Ok(p) => p,
                Err(_) => continue, // a notification or log line, not our answer
            };
            if let Some(error) = parsed.error {
                return Err(format!("{method} failed: {error}"));
            }
            if let Some(result) = parsed.result {
                return Ok(result);
            }
        }
    }

    fn handshake(&mut self) -> Result<(), String> {
        self.call(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "diazo-desktop", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        /* notifications carry no id — write it, no answer is expected */
        let note = serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        writeln!(self.stdin, "{note}").ok();
        self.stdin.flush().ok();
        let listed = self.call("tools/list", serde_json::json!({}))?;
        self.tools = listed
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|ts| {
                ts.iter()
                    .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(())
    }
}

/// Tool names the relay lets through, by the approval class they need —
/// the comparison is exact and the allowlist is fixed here. `None` means
/// the tool never crosses (Python execution and anything unlisted).
fn class_of(tool: &str) -> Option<&'static str> {
    if READ_ONLY_TOOLS.contains(&tool) {
        Some("read")
    } else if WRITE_TOOLS.contains(&tool) {
        Some("write")
    } else if RENDER_TOOLS.contains(&tool) {
        Some("render")
    } else {
        None
    }
}

/* -- recorded approvals ------------------------------------------------ */

/// The grants the person recorded: which classes of write the bridge may
/// run, per connected server — an approval given to one origin never
/// rides another. Persisted so the approval survives a restart of the
/// same install — and revocable from the same place.
#[derive(Serialize, Deserialize, Default, Clone)]
struct GrantFile {
    #[serde(default)]
    origins: std::collections::HashMap<String, BlenderGrants>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct BlenderGrants {
    pub write: bool,
    pub render: bool,
}

fn grants_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("blender-approvals.json"))
}

fn grants_read(path: &PathBuf, origin: &str) -> BlenderGrants {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<GrantFile>(&b).ok())
        .unwrap_or_default()
        .origins
        .get(origin)
        .cloned()
        .unwrap_or_default()
}

fn grants_write(path: &PathBuf, origin: &str, grants: &BlenderGrants) -> Result<(), String> {
    let mut file: GrantFile = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    file.origins.insert(origin.to_string(), grants.clone());
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The recorded grants for the server this shell is connected to — the
/// page reads this to draw its approval UX.
#[tauri::command]
pub fn blender_approvals(app: AppHandle) -> Result<BlenderGrants, String> {
    Ok(grants_read(&grants_path(&app)?, &crate::server::active_url()))
}

/// Record a grant after the person's own confirmation (`kind` is `write`
/// or `render`). The confirmation is a NATIVE dialog shown by the shell:
/// a page may call this command, but only the human at the machine can
/// grant — the dialog names the class and the server asking, and the
/// grant is scoped to that server.
#[tauri::command]
pub fn blender_approve(app: AppHandle, kind: String) -> Result<BlenderGrants, String> {
    if !GRANT_KINDS.contains(&kind.as_str()) {
        return Err(format!("kind must be one of {}", GRANT_KINDS.join(", ")));
    }
    let origin = crate::server::active_url();
    let accepted = rfd::MessageDialog::new()
        .set_title(format!("Allow Blender {kind} tools?"))
        .set_description(format!(
            "{origin} is asking to run Blender {kind} tools on this computer through the Diazo bridge. Only approve if you asked for this."
        ))
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show();
    if accepted != rfd::MessageDialogResult::Ok {
        return Err("the approval was declined".to_string());
    }
    let path = grants_path(&app)?;
    let mut grants = grants_read(&path, &origin);
    match kind.as_str() {
        "write" => grants.write = true,
        _ => grants.render = true,
    }
    grants_write(&path, &origin, &grants)?;
    Ok(grants)
}

/// Withdraw a grant on the connected server.
#[tauri::command]
pub fn blender_revoke(app: AppHandle, kind: String) -> Result<BlenderGrants, String> {
    if !GRANT_KINDS.contains(&kind.as_str()) {
        return Err(format!("kind must be one of {}", GRANT_KINDS.join(", ")));
    }
    let path = grants_path(&app)?;
    let origin = crate::server::active_url();
    let mut grants = grants_read(&path, &origin);
    match kind.as_str() {
        "write" => grants.write = false,
        _ => grants.render = false,
    }
    grants_write(&path, &origin, &grants)?;
    Ok(grants)
}

#[tauri::command]
pub fn blender_status(state: State<'_, BlenderState>) -> BlenderStatus {
    let guard = state.inner().0.lock().unwrap();
    BlenderStatus {
        enabled: enabled(),
        installed: resolve().is_some(),
        running: guard.is_some(),
        tools: guard.as_ref().map(|s| s.tools.clone()).unwrap_or_default(),
    }
}

/// Start the bridge after the human's confirmation: flag required, the
/// binary resolved here, the MCP handshake done, the tool list read back.
#[tauri::command]
pub fn blender_start(state: State<'_, BlenderState>) -> Result<BlenderStatus, String> {
    if !enabled() {
        return Err(format!("the Blender bridge is off — restart the app with {FLAG}=1 to try it"));
    }
    let path = resolve().ok_or_else(|| {
        format!("{BINARY} not found — install a Blender MCP server, then retry")
    })?;
    let mut guard = state.inner().0.lock().unwrap();
    if let Some(server) = guard.as_mut() {
        return Ok(BlenderStatus {
            enabled: true,
            installed: true,
            running: true,
            tools: server.tools.clone(),
        });
    }
    let mut server = Server::spawn(&path)?;
    server.handshake().inspect_err(|_| {
        let _ = server.child.kill();
    })?;
    let tools = server.tools.clone();
    *guard = Some(server);
    Ok(BlenderStatus { enabled: true, installed: true, running: true, tools })
}

/// The directory renders land in: inside app data, named by the shell —
/// a caller's filepath never reaches blender-mcp, so a render cannot
/// overwrite anything outside this folder.
fn renders_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("blender-renders");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The argument contract the server applies at submit (shared/blender.ts's
/// BLENDER_OP_ARGS), re-checked here in Rust before anything relays: an op
/// row could hold args no client ever validated, and the page may call
/// this command directly. Strict key sets; types and ranges checked.
fn validate_args(tool: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let obj = args
        .as_object()
        .ok_or_else(|| "args must be a JSON object".to_string())?;
    let only = |allowed: &[&str]| -> Result<(), String> {
        for key in obj.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!("unexpected argument {key}"));
            }
        }
        Ok(())
    };
    let str_arg = |key: &str, required: bool| -> Result<(), String> {
        match obj.get(key) {
            None if required => Err(format!("{key} is required")),
            None => Ok(()),
            Some(v) if v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 200) => Ok(()),
            _ => Err(format!("{key} must be a string of at most 200 chars")),
        }
    };
    match tool {
        "get_scene_info" | "get_viewport_screenshot" | "get_polyhaven_status" | "get_hyper3d_status"
        | "get_sketchfab_status" => only(&[])?,
        "get_object_info" => {
            only(&["name"])?;
            str_arg("name", true)?;
        }
        "set_material" => {
            only(&["object", "material"])?;
            str_arg("object", true)?;
            str_arg("material", true)?;
        }
        "add_light" => {
            only(&["light_type", "name", "location"])?;
            if let Some(v) = obj.get("light_type") {
                if !["POINT", "SUN", "SPOT", "AREA"].contains(&v.as_str().unwrap_or("")) {
                    return Err("light_type must be POINT, SUN, SPOT or AREA".to_string());
                }
            }
            str_arg("name", false)?;
            if let Some(v) = obj.get("location") {
                let ok = v
                    .as_array()
                    .is_some_and(|a| a.len() == 3 && a.iter().all(|n| n.is_number()));
                if !ok {
                    return Err("location must be [x, y, z]".to_string());
                }
            }
        }
        "render_frame" | "render_animation" => {
            /* filepath is absent on purpose: the shell picks it */
            only(&["engine"])?;
            if let Some(v) = obj.get("engine") {
                if !["eevee", "cycles", "octane"].contains(&v.as_str().unwrap_or("")) {
                    return Err("engine must be eevee, cycles or octane".to_string());
                }
            }
        }
        _ => return Err(format!("{tool} is not in the allowlist the bridge relays")),
    }
    Ok(args)
}

/// Relay one call. The tool name is allowlisted here, args are validated
/// against the same contract the server applies at submit, and the answer
/// is bounded before it crosses IPC back to the page. Write and render
/// tools additionally need their grant on the connected server — the same
/// check the page made when it queued the op. A render's output path is
/// the shell's own, injected after validation.
#[tauri::command]
pub fn blender_call(
    app: AppHandle,
    state: State<'_, BlenderState>,
    tool: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !enabled() {
        return Err("the Blender bridge is off".to_string());
    }
    let class = class_of(&tool)
        .ok_or_else(|| format!("{tool} is not in the allowlist the bridge relays"))?;
    let origin = crate::server::active_url();
    if class != "read" {
        let grants = grants_read(&grants_path(&app)?, &origin);
        let held = (class == "write" && grants.write) || (class == "render" && grants.render);
        if !held {
            return Err(format!("{tool} needs the {class} approval first (blender_approve)"));
        }
    }
    let mut args = validate_args(&tool, args.unwrap_or_else(|| serde_json::json!({})))?;
    let render_path = if matches!(tool.as_str(), "render_frame" | "render_animation") {
        let path = renders_dir(&app)?.join(format!("render-{}.png", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()));
        args["filepath"] = serde_json::json!(path.to_string_lossy());
        Some(path)
    } else {
        None
    };
    let mut guard = state.inner().0.lock().unwrap();
    let Some(server) = guard.as_mut() else {
        return Err("the Blender bridge is not running — call blender_start first".to_string());
    };
    let result = server.call(
        "tools/call",
        serde_json::json!({ "name": tool, "arguments": args }),
    );
    match result {
        Ok(mut value) => {
            if let Some(path) = render_path {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("output_path".to_string(), serde_json::json!(path.to_string_lossy()));
                }
            }
            let text = value.to_string();
            if text.len() > MAX_RESULT_BYTES {
                return Err("the answer is too large to relay".to_string());
            }
            Ok(value)
        }
        Err(e) => {
            /* a dead child is dropped so the next call respawns cleanly */
            if e.contains("write failed") || e.contains("did not answer") {
                if let Some(mut s) = guard.take() {
                    let _ = s.child.kill();
                }
            }
            Err(e)
        }
    }
}

/// Drop the child on app exit — called from main's RunEvent::Exit.
pub fn shutdown(state: &BlenderState) {
    if let Some(mut server) = state.0.lock().unwrap().take() {
        let _ = server.child.kill();
        let _ = server.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_cover_the_relay_set() {
        for tool in READ_ONLY_TOOLS {
            assert_eq!(class_of(tool), Some("read"), "{tool}");
        }
        for tool in WRITE_TOOLS {
            assert_eq!(class_of(tool), Some("write"), "{tool}");
        }
        for tool in RENDER_TOOLS {
            assert_eq!(class_of(tool), Some("render"), "{tool}");
        }
        for tool in [
            "",
            "execute_blender_code",
            "set_scene_info",
            "delete_object",
            "get_scene_info; rm -rf /",
            "render",
            "GET_SCENE_INFO",
        ] {
            assert_eq!(class_of(tool), None, "{tool}");
        }
    }

    #[test]
    fn grants_are_scoped_to_their_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blender-approvals.json");
        let origin = "https://a.example";
        assert!(!grants_read(&path, origin).write);
        let grants = BlenderGrants { write: true, render: false };
        grants_write(&path, origin, &grants).unwrap();
        let read = grants_read(&path, origin);
        assert!(read.write && !read.render);
        /* a different server sees no grant: approvals never ride origins */
        assert!(!grants_read(&path, "https://evil.example").write);
    }

    #[test]
    fn grants_survive_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blender-approvals.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(!grants_read(&path, "https://a.example").write);
    }

    #[test]
    fn args_are_validated_like_the_server_does() {
        /* the strict contract: unexpected keys refuse, required keys enforce */
        assert!(validate_args("get_object_info", serde_json::json!({ "name": "Cube" })).is_ok());
        assert!(validate_args("get_object_info", serde_json::json!({})).is_err());
        assert!(validate_args("get_object_info", serde_json::json!({ "name": "Cube", "x": 1 })).is_err());
        assert!(validate_args("set_material", serde_json::json!({ "object": "a", "material": "m" })).is_ok());
        assert!(validate_args("set_material", serde_json::json!({ "object": "a" })).is_err());
        assert!(validate_args("add_light", serde_json::json!({ "light_type": "SUN", "location": [0, 1, 2] })).is_ok());
        assert!(validate_args("add_light", serde_json::json!({ "light_type": "MOON" })).is_err());
        assert!(validate_args("add_light", serde_json::json!({ "location": [0, 1] })).is_err());
    }

    #[test]
    fn a_render_never_takes_a_filepath() {
        assert!(validate_args("render_frame", serde_json::json!({ "engine": "eevee" })).is_ok());
        assert!(validate_args("render_frame", serde_json::json!({ "engine": "vray" })).is_err());
        /* no matter the shape, a destination a caller picked is refused */
        for args in [
            serde_json::json!({ "filepath": "/etc/passwd" }),
            serde_json::json!({ "filepath": "../../.ssh/config" }),
            serde_json::json!({ "engine": "eevee", "filepath": "/tmp/out.png" }),
        ] {
            assert!(validate_args("render_frame", args).is_err());
        }
        assert!(validate_args("render_animation", serde_json::json!({ "filepath": "C:\\boot.ini" })).is_err());
    }

    #[test]
    fn args_must_be_an_object() {
        assert!(validate_args("set_material", serde_json::json!("string")).is_err());
        assert!(validate_args("set_material", serde_json::json!([1])).is_err());
    }
}
