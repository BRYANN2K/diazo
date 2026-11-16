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
//! render tools additionally need a recorded approval grant (`blender_approve`
//! after the person's own confirmation — the grant lives in
//! `blender-approvals.json` until `blender_revoke`). Python execution is
//! never allowlisted.
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
/// run. Persisted so the approval survives a restart of the same install —
/// and revocable from the same place.
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

fn grants_read(path: &PathBuf) -> BlenderGrants {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn grants_write(path: &PathBuf, grants: &BlenderGrants) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(grants).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The recorded grants — the page reads this to draw its approval UX.
#[tauri::command]
pub fn blender_approvals(app: AppHandle) -> Result<BlenderGrants, String> {
    Ok(grants_read(&grants_path(&app)?))
}

/// Record a grant after the person's own confirmation (`kind` is `write`
/// or `render`). The page calls this from its own approval dialog; there
/// is no programmatic approve path.
#[tauri::command]
pub fn blender_approve(app: AppHandle, kind: String) -> Result<BlenderGrants, String> {
    if !GRANT_KINDS.contains(&kind.as_str()) {
        return Err(format!("kind must be one of {}", GRANT_KINDS.join(", ")));
    }
    let path = grants_path(&app)?;
    let mut grants = grants_read(&path);
    match kind.as_str() {
        "write" => grants.write = true,
        _ => grants.render = true,
    }
    grants_write(&path, &grants)?;
    Ok(grants)
}

/// Withdraw a grant.
#[tauri::command]
pub fn blender_revoke(app: AppHandle, kind: String) -> Result<BlenderGrants, String> {
    if !GRANT_KINDS.contains(&kind.as_str()) {
        return Err(format!("kind must be one of {}", GRANT_KINDS.join(", ")));
    }
    let path = grants_path(&app)?;
    let mut grants = grants_read(&path);
    match kind.as_str() {
        "write" => grants.write = false,
        _ => grants.render = false,
    }
    grants_write(&path, &grants)?;
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

/// Relay one call. The tool name is allowlisted here, args pass through
/// verbatim (the server validates them), and the answer is bounded before
/// it crosses IPC back to the page. Write and render tools additionally
/// need their grant — the same check the page made when it queued the op.
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
    if class != "read" {
        let grants = grants_read(&grants_path(&app)?);
        let held = (class == "write" && grants.write) || (class == "render" && grants.render);
        if !held {
            return Err(format!("{tool} needs the {class} approval first (blender_approve)"));
        }
    }
    let mut guard = state.inner().0.lock().unwrap();
    let Some(server) = guard.as_mut() else {
        return Err("the Blender bridge is not running — call blender_start first".to_string());
    };
    let result = server.call(
        "tools/call",
        serde_json::json!({ "name": tool, "arguments": args.unwrap_or(serde_json::json!({})) }),
    );
    match result {
        Ok(value) => {
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
    fn grants_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blender-approvals.json");
        assert_eq!(grants_read(&path).write, false);
        let grants = BlenderGrants { write: true, render: false };
        grants_write(&path, &grants).unwrap();
        let read = grants_read(&path);
        assert!(read.write && !read.render);
    }

    #[test]
    fn grants_survive_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blender-approvals.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(!grants_read(&path).write);
    }
}
