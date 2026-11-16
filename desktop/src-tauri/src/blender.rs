//! `blender_*` commands: the first plank of the Blender bridge (Motion
//! Studio, phase 4). Diazo never renders through Blender itself — a local
//! Blender MCP server does, spawned here like the ACP CLIs: an allowlisted
//! binary name found on the login shell's PATH and the fixed prefixes,
//! started only when the human asks (the UI calls `blender_start` after
//! its own confirmation), and only read-only tools ever relayed.
//!
//! Disabled by default: `blender_start` refuses unless the shell was
//! launched with `DOOP_BLENDER_BRIDGE=1` — the read path exists so a page
//! can probe (`blender_status` → available / disabled / missing) without
//! the bridge being on. Write tools, Python execution and render
//! submission land with the approval UX that does not exist yet.
//!
//! Wire: MCP over stdio, newline JSON-RPC — initialize, tools/list and a
//! bounded tools/call for names in READ_ONLY_TOOLS. Anything else errors
//! before it reaches the child.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

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

/// Tool names the relay lets through — the comparison is exact and the
/// allowlist is fixed here.
fn read_only(tool: &str) -> bool {
    READ_ONLY_TOOLS.contains(&tool)
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

/// Relay one read-only call. The tool name is allowlisted here, args pass
/// through verbatim (the server validates them), and the answer is bounded
/// before it crosses IPC back to the page.
#[tauri::command]
pub fn blender_call(
    state: State<'_, BlenderState>,
    tool: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !enabled() {
        return Err("the Blender bridge is off".to_string());
    }
    if !read_only(&tool) {
        return Err(format!("{tool} is not in the read-only set the bridge relays"));
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
    fn read_only_set_is_closed() {
        for tool in READ_ONLY_TOOLS {
            assert!(read_only(tool), "{tool}");
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
            assert!(!read_only(tool), "{tool}");
        }
    }
}
