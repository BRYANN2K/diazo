//! `orca_*` commands: the shell's typed bridge to the Orca CLI, behind the
//! `Send to Orca` flow (docs/orca.md, shared/devTasks.ts). The server hands
//! the page a `dev_task` job over the local-repo poll bridge; the page calls
//! these commands; every report goes back through `/api/dev-tasks/:id/report`.
//!
//! The boundary the repo grant already draws holds here: the worktree's path
//! and the repo folder's path stay inside this process — `run_orca` is the
//! only place they appear, as one argv element each, and nothing returns
//! them to the page. What the shell remembers between calls is the opaque
//! `wt2:` identity plus the environment it launched in (orca-tasks.json).
//!
//! There is no passthrough. Each command builds one argv vector from typed,
//! validated fields, always adds `--json`, and never adds `--surface`: the
//! person's Chat | CLI setting in Orca decides how the agent opens. Every
//! launch passes a native confirmation first.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const QUICK_TIMEOUT: Duration = Duration::from_secs(15);
const PS_TIMEOUT: Duration = Duration::from_secs(20);
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(60);
/// `worktree create` blocks on repo setup hooks and the agent launch reply.
const CREATE_TIMEOUT: Duration = Duration::from_secs(300);
const PS_LIMIT: &str = "100";
/// How much of one output stream `run_orca` keeps — `worktree ps` over a
/// busy install is the biggest answer and stays well under this.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// An identity stays watchable this long after its poll row went terminal —
/// enough for the terminal report to reach the server a few times before
/// the entry leaves `orca-tasks.json`.
const ENDED_PRUNE_MS: u64 = 5 * 60_000;
/// How many identities one `orca_untrack` call may name.
const MAX_UNTRACK: usize = 100;

/* field caps — mirror shared/devTasks.ts, keep in step */
const MAX_PROMPT_CHARS: usize = 8 * 1024;
const MAX_COMMENT_CHARS: usize = 500;
const MAX_NAME_CHARS: usize = 80;
const MAX_BRANCH_CHARS: usize = 200;
const MAX_FIELD_CHARS: usize = 120;
/// Agent ids the server offers; `--agent` accepts more upstream, but a dev
/// task only ever launches these (DEV_TASK_AGENTS in shared/devTasks.ts).
const ALLOWED_AGENTS: &[&str] = &["claude", "codex", "opencode", "devin"];
/// `programStatus.state` values treated as a terminal outcome by
/// DevTaskPollReport — anything else stays a working status.
const TERMINAL_OUTCOMES: &[&str] = &["success", "failure", "interruption", "cancellation"];

/* ------------------------------------------------------------------ */
/* the binary                                                          */
/* ------------------------------------------------------------------ */

/// Which `orca` this shell drives. `DOOP_ORCA_CLI` overrides everything
/// (tests point it at a fake binary); `ORCA_CLI_COMMAND` is what Orca itself
/// exports into managed sessions; then the install locations and PATH.
fn orca_bin() -> Option<PathBuf> {
    for var in ["DOOP_ORCA_CLI", "ORCA_CLI_COMMAND"] {
        if let Some(path) = std::env::var_os(var) {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let name = if cfg!(windows) { "orca.exe" } else { "orca" };
    let mut candidates = vec![
        PathBuf::from("/Applications/Orca.app/Contents/Resources/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/opt/homebrew/bin").join(name),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Drain one pipe on its own thread while the child runs — reading only
/// after exit deadlocks the moment output passes the pipe buffer (~64 KB)
/// and the child never finishes to be read. Past the cap the bytes are
/// still consumed and dropped, so a loud child can never block.
fn drain(pipe: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut pipe = pipe;
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                    if room > 0 {
                        kept.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
            }
        }
        let _ = tx.send(kept);
    });
    rx
}

/// Run `orca <args>` and return the envelope's `result` (or the whole
/// object when there is none). A non-zero exit, a timeout or an `ok:false`
/// envelope becomes the error text — the caller decides what it means.
fn run_orca(
    bin: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Value, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("orca would not start: {e}"))?;
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("orca did not answer within {}s", timeout.as_secs()));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not wait on orca: {e}"));
            }
        }
    }
    /* the child is reaped, so each drainer ends at EOF — a stray grandchild
       still holding the pipe forfeits what it has not sent after 5s */
    let collect = |rx: Option<mpsc::Receiver<Vec<u8>>>| {
        rx.and_then(|r| r.recv_timeout(Duration::from_secs(5)).ok())
            .unwrap_or_default()
    };
    let out = collect(stdout);
    let err = collect(stderr);
    let stdout = String::from_utf8_lossy(&out);
    let trimmed = stdout.trim();
    let parsed: Value = serde_json::from_str(trimmed).map_err(|_| {
        let detail = String::from_utf8_lossy(&err);
        let detail = detail.trim();
        let fallback: String = trimmed.chars().take(400).collect();
        format!(
            "orca did not answer with json: {}",
            if detail.is_empty() {
                fallback
            } else {
                detail.chars().take(400).collect()
            }
        )
    })?;
    if parsed.get("ok") == Some(&Value::Bool(false)) {
        let mut message = parsed
            .get("error")
            .map(|e| {
                e.get("message")
                    .or_else(|| e.get("detail"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| e.to_string())
            })
            .or_else(|| {
                parsed
                    .get("result")
                    .and_then(|r| r.get("error"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "orca reported a failure".to_string());
        if let Some(operation) = parsed
            .get("error")
            .and_then(|e| e.get("operationId"))
            .or_else(|| parsed.get("result").and_then(|r| r.get("operationId")))
            .and_then(Value::as_str)
        {
            message.push_str(&format!(" (retry with operationId {operation})"));
        }
        return Err(message);
    }
    Ok(parsed.get("result").cloned().unwrap_or(parsed))
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

/* ------------------------------------------------------------------ */
/* hosts and environments                                              */
/* ------------------------------------------------------------------ */

/// The saved paired servers `--environment` may name: every `environment`
/// row `orca host list` prints, as (name, id) pairs. Both are valid
/// selectors; the commands accept either spelling.
fn environments(bin: &Path) -> Result<Vec<(String, String)>, String> {
    let out = run_orca(bin, &argv(&["host", "list", "--json"]), None, QUICK_TIMEOUT)?;
    let hosts = out
        .get("hosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(hosts
        .iter()
        .filter(|h| h.get("kind").and_then(Value::as_str) == Some("environment"))
        .filter_map(|h| {
            Some((
                h.get("name").and_then(Value::as_str)?.to_string(),
                h.get("id").and_then(Value::as_str)?.to_string(),
            ))
        })
        .collect())
}

/// `--environment` takes a saved server's name or id only — anything else
/// is refused before it reaches argv.
fn checked_environment(bin: &Path, environment: Option<&str>) -> Result<Option<String>, String> {
    let Some(name) = environment else {
        return Ok(None);
    };
    let envs = environments(bin)?;
    if envs.iter().any(|(n, id)| n == name || id == name) {
        Ok(Some(name.to_string()))
    } else {
        Err(format!(
            "no Orca environment named \"{name}\" — orca host list shows the saved ones"
        ))
    }
}

/* ------------------------------------------------------------------ */
/* repo resolution                                                     */
/* ------------------------------------------------------------------ */

/// `git@host:owner/repo(.git)`, `ssh://…` and `https://…` remotes all
/// become `host/owner/repo` — the key `gitRemoteIdentity.canonicalKey`
/// carries on `repo list` rows.
fn canonical_remote_key(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
    /* scp-like: git@host:owner/repo */
    if let Some(rest) = url.strip_prefix("git@") {
        let key = rest.replacen(':', "/", 1);
        return key.contains('/').then_some(key);
    }
    /* scheme form: ssh://git@host:port/owner/repo, https://host/owner/repo */
    let rest = url.split_once("://")?.1;
    let host = rest.split('/').next()?;
    let host = host.rsplit('@').next()?.split(':').next()?;
    let path = rest.split('/').skip(1).collect::<Vec<_>>().join("/");
    if path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}"))
}

/// `git remote get-url origin` in the grant folder, when one is configured —
/// the repo's cross-machine identity, the only thing a VPS environment can
/// match on (the local path does not exist there).
fn remote_key_of(root: &Path) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    canonical_remote_key(&String::from_utf8_lossy(&out.stdout))
}

/// Pick the repo `repo list` returned for this grant: an exact path match
/// wins locally (grant_path is only passed for this machine); the git
/// remote key matches anywhere — the same checkout can live at a different
/// path on another environment. Nothing matches → the page tells the
/// person to add the project to Orca.
fn resolve_repo_in_list(
    repos: &[Value],
    grant_path: Option<&Path>,
    remote_key: Option<&str>,
) -> Option<Value> {
    let grant = grant_path.map(|p| p.to_string_lossy().to_string());
    repos
        .iter()
        .find(|r| {
            grant.as_deref().is_some() && r.get("path").and_then(Value::as_str) == grant.as_deref()
        })
        .or_else(|| {
            remote_key.and_then(|key| {
                repos.iter().find(|r| {
                    r.pointer("/gitRemoteIdentity/canonicalKey")
                        .and_then(Value::as_str)
                        == Some(key)
                })
            })
        })
        .cloned()
}

fn resolve_repo(
    app: &AppHandle,
    bin: &Path,
    link_id: &str,
    environment: Option<&str>,
) -> Result<Value, String> {
    let root = crate::repo::grant_root(app, link_id)?;
    let mut args = argv(&["repo", "list"]);
    if let Some(env) = environment {
        args.push(format!("--environment={env}"));
    }
    args.push("--json".to_string());
    let out = run_orca(bin, &args, None, QUICK_TIMEOUT)?;
    let repos = out
        .get("repos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    /* a path match is only meaningful for this machine's repos */
    let local = environment.is_none();
    let remote_key = remote_key_of(&root);
    let Some(repo) = resolve_repo_in_list(
        &repos,
        local.then_some(root.as_path()),
        remote_key.as_deref(),
    ) else {
        return Err(
            "that project is not an Orca repo — open Orca and add it (orca repo add) first"
                .to_string(),
        );
    };
    let matched_by_path = local && grant_path_matches(&repo, &root);
    Ok(json!({
        "found": true,
        "repoId": repo.get("id").and_then(Value::as_str),
        "repoName": repo.get("displayName").and_then(Value::as_str),
        "canonicalKey": repo
            .pointer("/gitRemoteIdentity/canonicalKey")
            .and_then(Value::as_str)
            .or(remote_key.as_deref()),
        "matchedBy": if matched_by_path { "path" } else { "remote" },
    }))
}

fn grant_path_matches(repo: &Value, root: &Path) -> bool {
    repo.get("path").and_then(Value::as_str) == Some(root.to_string_lossy().as_ref())
}

/* ------------------------------------------------------------------ */
/* the launches this shell owns — orca-tasks.json                      */
/* ------------------------------------------------------------------ */

/// Serialises every read-modify-write of `orca-tasks.json` — two launches
/// in flight must not lose each other's identity.
#[derive(Default)]
pub struct OrcaState {
    lock: Mutex<()>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrackedTask {
    task_id: String,
    environment: Option<String>,
    /// the Diazo server the launch rode in on — identities are only ever
    /// polled and activated for the server this shell is currently on
    #[serde(default)]
    server: String,
    branch: String,
    agent: String,
    at: u64,
    /// set on the first poll row that ended the task (terminal outcome or
    /// a worktree that vanished); pruned once it has been reported on
    #[serde(default)]
    ended: Option<u64>,
}

fn tasks_file(dir: &Path) -> PathBuf {
    dir.join("orca-tasks.json")
}

fn load_tasks(dir: &Path) -> BTreeMap<String, TrackedTask> {
    fs::read_to_string(tasks_file(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write-then-rename, like repo-grants.json.
fn save_tasks(dir: &Path, tasks: &BTreeMap<String, TrackedTask>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = tasks_file(dir);
    let tmp = file.with_extension("tmp");
    fs::write(
        &tmp,
        serde_json::to_string(tasks).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

fn tasks_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The Diazo server this shell currently opens — identities launched
/// under another server stay in the file but are never polled or
/// activated from here.
fn current_server() -> String {
    crate::server::active_url()
}

/// Load–mutate–save under the managed lock: `f` reports whether the map
/// changed so the file is only rewritten when it must be.
fn edit_tasks<R>(
    app: &AppHandle,
    f: impl FnOnce(&mut BTreeMap<String, TrackedTask>) -> (R, bool),
) -> Result<R, String> {
    let state = app.state::<OrcaState>();
    let _guard = state.lock.lock().map_err(|e| e.to_string())?;
    let dir = tasks_dir(app)?;
    let mut tasks = load_tasks(&dir);
    let (out, dirty) = f(&mut tasks);
    if dirty {
        save_tasks(&dir, &tasks)?;
    }
    Ok(out)
}

/// The identities this shell launched on one server + environment — polls
/// and activation are only ever allowed against that set.
fn tracked(
    tasks: &BTreeMap<String, TrackedTask>,
    environment: Option<&str>,
    server: &str,
) -> BTreeMap<String, TrackedTask> {
    tasks
        .iter()
        .filter(|(_, t)| t.environment.as_deref() == environment && t.server == server)
        .map(|(k, t)| (k.clone(), t.clone()))
        .collect()
}

/// Drop entries whose task ended long enough ago that the terminal report
/// has had every chance to land. Returns how many were removed.
fn prune_ended(tasks: &mut BTreeMap<String, TrackedTask>, now: u64) -> usize {
    let before = tasks.len();
    tasks.retain(|_, t| t.ended.is_none_or(|at| now.saturating_sub(at) < ENDED_PRUNE_MS));
    before - tasks.len()
}

/// A poll row that means the task is over: the worktree vanished from
/// `worktree ps`, or the main agent's program ended.
fn row_ended(row: &Value) -> bool {
    row.get("found") == Some(&Value::Bool(false))
        || row
            .get("outcome")
            .and_then(Value::as_str)
            .is_some_and(|o| TERMINAL_OUTCOMES.contains(&o))
}

/// Stamp `ended` on the watched identities this poll's rows just ended —
/// they keep being reported until `prune_ended` retires them.
fn mark_ended(tasks: &mut BTreeMap<String, TrackedTask>, rows: &[Value], now: u64) -> bool {
    let mut dirty = false;
    for row in rows {
        let Some(identity) = row.get("identity").and_then(Value::as_str) else {
            continue;
        };
        if row_ended(row) {
            if let Some(t) = tasks.get_mut(identity) {
                if t.ended.is_none() {
                    t.ended = Some(now);
                    dirty = true;
                }
            }
        }
    }
    dirty
}

fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

fn bad(what: &str) -> String {
    format!("invalid dev task field: {what}")
}

/// `doop/<change>` — letters, digits and git's safe punctuation; no
/// whitespace, no `..`, no leading dash or slash, no trailing dot.
fn valid_branch(branch: &str) -> bool {
    let first = branch.chars().next();
    let last = branch.chars().last();
    !branch.is_empty()
        && branch.chars().count() <= MAX_BRANCH_CHARS
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        && !branch.contains("..")
        && !matches!(first, Some('-' | '/'))
        && !matches!(last, Some('/' | '.' | '-'))
}

/// A single-line field value that must never read as a flag to `orca`:
/// no leading dash and no control characters. (`--flag=value` argv makes
/// this belt-and-suspenders; the parser can never see a bare `--x` value.)
fn valid_line(value: &str, max: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max
        && !value.starts_with('-')
        && !value.chars().any(|c| c.is_control())
}

/// A worktree name: printable, one line.
fn valid_name(name: &str) -> bool {
    valid_line(name, MAX_NAME_CHARS, false)
}

/// The `doop:` comment stamped on the worktree — one line, may be empty.
fn valid_comment(comment: &str) -> bool {
    valid_line(comment, MAX_COMMENT_CHARS, true)
}

/// The launch brief: a few lines of text — newlines and tabs pass, other
/// control characters and a leading dash do not.
fn valid_prompt(prompt: &str) -> bool {
    !prompt.is_empty()
        && prompt.chars().count() <= MAX_PROMPT_CHARS
        && !prompt.starts_with('-')
        && !prompt
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}

/// `wt2:<host>:<instance>` — the only worktree handle the server ever sees.
fn valid_identity(identity: &str) -> bool {
    identity.starts_with("wt2:")
        && identity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '.'))
}

/// A model id (`gpt-6-astra`, `claude-opus-4`) or an effort level — bounded
/// flag values, never a sentence, never flag-shaped themselves.
fn valid_flag_value(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.chars().count() <= MAX_FIELD_CHARS
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

fn valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.chars().count() <= 64
        && task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/* ------------------------------------------------------------------ */
/* the native confirmation                                             */
/* ------------------------------------------------------------------ */

/// The launch's yes/no. Tests can't show a dialog, so `cfg(test)` reads
/// DOOP_ORCA_CONFIRM=deny instead; production always asks.
#[cfg(test)]
fn confirm_launch(_summary: &str, _detail: &str) -> bool {
    std::env::var("DOOP_ORCA_CONFIRM").as_deref() != Ok("deny")
}

#[cfg(not(test))]
fn confirm_launch(summary: &str, detail: &str) -> bool {
    rfd::MessageDialog::new()
        .set_title(summary)
        .set_description(detail)
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show()
        == rfd::MessageDialogResult::Ok
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/// `orca_status` — what the page needs to render Send to Orca: whether the
/// CLI is there, the runtime's version, the environments launches may
/// target and which agents have accounts. Read-only.
#[tauri::command]
pub async fn orca_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(bin) = orca_bin() else {
            return Ok(json!({ "installed": false, "environments": [], "hosts": [], "agents": [] }));
        };
        let status = run_orca(&bin, &argv(&["status", "--json"]), None, QUICK_TIMEOUT).ok();
        let hosts = run_orca(&bin, &argv(&["host", "list", "--json"]), None, QUICK_TIMEOUT).ok();
        let accounts = run_orca(&bin, &argv(&["account", "list", "--json"]), None, QUICK_TIMEOUT).ok();
        let host_rows = hosts
            .as_ref()
            .and_then(|h| h.get("hosts"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let environments: Vec<Value> = host_rows
            .iter()
            .filter(|h| h.get("kind").and_then(Value::as_str) == Some("environment"))
            .map(|h| json!({ "name": h.get("name"), "id": h.get("id") }))
            .collect();
        let agent_list = accounts
            .as_ref()
            .and_then(Value::as_object)
            .map(|obj| {
                obj.iter()
                    .filter(|(_, v)| {
                        v.get("accounts")
                            .and_then(Value::as_array)
                            .is_some_and(|accounts| !accounts.is_empty())
                    })
                    .map(|(agent, _)| agent.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({
            "installed": true,
            "running": status.as_ref().and_then(|s| s.pointer("/app/running")).and_then(Value::as_bool),
            "version": status.as_ref().and_then(|s| s.pointer("/runtime/appVersion")).and_then(Value::as_str),
            "environments": environments,
            "hosts": host_rows.iter().map(|h| json!({
                "name": h.get("name"), "kind": h.get("kind"), "id": h.get("id"),
                "connected": h.get("connected"),
            })).collect::<Vec<_>>(),
            "agents": agent_list,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `orca_resolve_repo` — which Orca repo the linked folder is, on this
/// machine or on the named environment (matched by its git remote there).
/// Answers `{ found, repoId, repoName, canonicalKey, matchedBy }` — the
/// path never leaves.
#[tauri::command]
pub async fn orca_resolve_repo(
    app: AppHandle,
    link_id: String,
    environment: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = orca_bin().ok_or_else(|| "Orca is not installed on this computer".to_string())?;
        let environment = checked_environment(&bin, environment.as_deref())?;
        resolve_repo(&app, &bin, &link_id, environment.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Everything `worktree create` argv needs, already validated — held apart
/// from the launch's side effects so a test can pin the exact vector the
/// native confirmation gates.
struct LaunchSpec {
    worktree_name: String,
    repo_id: String,
    branch: String,
    agent: String,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
    comment: String,
    environment: Option<String>,
}

/// One `worktree create` argv: every value rides as `--flag=value`, so a
/// field's text can never be parsed as an option itself — never a shell
/// string — and never `--surface`, because Orca's own Chat | CLI setting
/// decides how the agent opens.
fn launch_args(spec: &LaunchSpec) -> Vec<String> {
    let mut args = argv(&["worktree", "create"]);
    args.push(format!("--name={}", spec.worktree_name));
    args.push(format!("--repo=id:{}", spec.repo_id));
    args.push(format!("--branch={}", spec.branch));
    args.push(format!("--agent={}", spec.agent));
    args.push(format!("--prompt={}", spec.prompt));
    args.push(format!("--comment={}", spec.comment));
    args.push("--no-parent".to_string());
    if let Some(model) = &spec.model {
        args.push(format!("--model={model}"));
    }
    if let Some(effort) = &spec.effort {
        args.push(format!("--effort={effort}"));
    }
    if let Some(env) = &spec.environment {
        args.push(format!("--environment={env}"));
    }
    args.push("--json".to_string());
    args
}

/// `orca_launch_task` — `orca worktree create` for a dev task. Everything
/// argv needs arrives typed from the server (DevTaskLaunchArgs); the repo
/// selector is resolved from the grant, never taken from the page; the
/// person's native confirmation gates the run.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn orca_launch_task(
    app: AppHandle,
    task_id: String,
    link_id: String,
    worktree_name: String,
    branch: String,
    agent: String,
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
    comment: String,
    environment: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        /* validate before anything runs — the page never builds argv */
        if !valid_task_id(&task_id) {
            return Err(bad("task_id"));
        }
        if !valid_name(&worktree_name) {
            return Err(bad("worktree_name"));
        }
        if !valid_branch(&branch) {
            return Err(bad("branch"));
        }
        if !ALLOWED_AGENTS.contains(&agent.as_str()) {
            return Err(bad("agent"));
        }
        if let Some(model) = &model {
            if !valid_flag_value(model) {
                return Err(bad("model"));
            }
        }
        if let Some(effort) = &effort {
            if model.is_none() {
                return Err(bad("effort needs --model"));
            }
            if !valid_flag_value(effort) {
                return Err(bad("effort"));
            }
        }
        if !valid_prompt(&prompt) {
            return Err(bad("prompt"));
        }
        if !valid_comment(&comment) {
            return Err(bad("comment"));
        }

        let bin = orca_bin().ok_or_else(|| "Orca is not installed on this computer".to_string())?;
        let environment = checked_environment(&bin, environment.as_deref())?;
        let repo = resolve_repo(&app, &bin, &link_id, environment.as_deref())?;
        let repo_id = repo
            .get("repoId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Orca did not name a repo id".to_string())?
            .to_string();
        let repo_name = repo
            .get("repoName")
            .and_then(Value::as_str)
            .unwrap_or(&repo_id)
            .to_string();
        let root = crate::repo::grant_root(&app, &link_id)?;

        let target = environment.as_deref().unwrap_or("this Mac");
        let mut detail = format!("Repo: {repo_name}\nTarget: {target}\nBranch: {branch}\nAgent: {agent}");
        if let Some(model) = &model {
            detail.push_str(&format!("\nModel: {model}"));
        }
        if let Some(effort) = &effort {
            detail.push_str(&format!(" · effort {effort}"));
        }
        if !comment.is_empty() {
            /* stamped on the Orca worktree metadata — the person sees it
               before it is written */
            detail.push_str(&format!("\nComment: {comment}"));
        }
        detail.push_str(&format!("\n\nThe agent starts with this brief:\n\n{prompt}"));
        if !confirm_launch(&format!("Create Orca worktree \"{worktree_name}\"?"), &detail) {
            return Ok(json!({ "ok": false, "cancelled": true }));
        }

        let spec = LaunchSpec {
            worktree_name,
            repo_id,
            branch,
            agent,
            model,
            effort,
            prompt,
            comment,
            environment,
        };
        let out = match run_orca(&bin, &launch_args(&spec), Some(&root), CREATE_TIMEOUT) {
            Ok(out) => out,
            Err(error) => return Ok(json!({ "ok": false, "error": error })),
        };
        let launch = out.get("launch");
        let identity = out
            .pointer("/identity/key")
            .and_then(Value::as_str)
            .or_else(|| out.get("identity").and_then(Value::as_str))
            .or_else(|| out.get("identityKey").and_then(Value::as_str));
        let final_branch = out
            .get("branch")
            .and_then(Value::as_str)
            .unwrap_or(&spec.branch)
            .trim_start_matches("refs/heads/")
            .to_string();
        let Some(identity) = identity.filter(|i| valid_identity(i)) else {
            return Ok(json!({
                "ok": false,
                "error": "orca created the worktree without an identity — check Orca before retrying",
                "operationId": launch.and_then(|l| l.get("operationId")).and_then(Value::as_str),
            }));
        };
        /* remember it: polls and activation only ever reach this set —
           the insert rides the managed lock so two launches cannot lose
           each other's identity */
        edit_tasks(&app, |tasks| {
            tasks.insert(
                identity.to_string(),
                TrackedTask {
                    task_id: task_id.clone(),
                    environment: spec.environment.clone(),
                    server: current_server(),
                    branch: final_branch.clone(),
                    agent: spec.agent.clone(),
                    at: millis(),
                    ended: None,
                },
            );
            ((), true)
        })?;

        Ok(launch_reply(&out, identity, &final_branch))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `worktree create`'s answer trimmed to what the page may see. The
/// worktree's own id embeds its absolute path (`<repoId>::<path>` — over
/// the report's caps as soon as the path is long), so it never crosses:
/// the server only ever gets the `wt2:` identity.
fn launch_reply(out: &Value, identity: &str, branch: &str) -> Value {
    let launch = out.get("launch");
    let outcome = launch.and_then(|l| l.get("outcome"));
    json!({
        "ok": true,
        "orcaIdentity": identity,
        "branch": branch,
        "launchKind": outcome.and_then(|o| o.get("kind")).and_then(Value::as_str),
        "launchHandle": outcome
            .and_then(|o| o.get("handle"))
            .and_then(Value::as_str)
            .or_else(|| out.get("agentTerminalHandle").and_then(Value::as_str)),
        "orcaSessionId": outcome.and_then(|o| o.get("orcaSessionId")).and_then(Value::as_str),
        "operationId": launch.and_then(|l| l.get("operationId")).and_then(Value::as_str),
    })
}

/// The main agent's row in a `worktree ps` entry: the one flagged
/// `mainAgent`, else the first agent in the list.
fn main_agent(row: &Value) -> Option<&Value> {
    let agents = row.get("agents")?.as_array()?;
    agents
        .iter()
        .find(|a| a.get("mainAgent").and_then(|m| m.get("state")).is_some())
        .or_else(|| agents.first())
}

/// One watched identity's trimmed report row — what DevTaskPollReport
/// carries, and nothing else (the path stays here).
fn poll_row(identity: &str, row: Option<&Value>) -> Value {
    let Some(row) = row else {
        return json!({ "identity": identity, "found": false });
    };
    let agent = main_agent(row);
    let outcome = agent
        .and_then(|a| a.pointer("/programStatus/state"))
        .and_then(Value::as_str)
        .filter(|s| TERMINAL_OUTCOMES.contains(s));
    json!({
        "identity": identity,
        "found": true,
        "status": row.get("status").and_then(Value::as_str),
        "agentState": agent
            .and_then(|a| a.pointer("/mainAgent/state"))
            .or_else(|| agent.and_then(|a| a.get("state")))
            .and_then(Value::as_str),
        "outcome": outcome,
        "lastAssistantMessage": agent.and_then(|a| a.get("lastAssistantMessage")).and_then(Value::as_str),
        /* Orca may report linkedPR as an object — the report schema takes
           a string, so reduce it to its URL here */
        "linkedPR": row
            .get("linkedPR")
            .and_then(|pr| pr.as_str().or_else(|| pr.get("url").and_then(Value::as_str))),
        "orcaSessionId": agent.and_then(|a| a.get("orcaSessionId")).and_then(Value::as_str),
        "branch": row
            .get("branch")
            .and_then(Value::as_str)
            .map(|b| b.trim_start_matches("refs/heads/")),
        "workspaceStatus": row.get("workspaceStatus").and_then(Value::as_str),
    })
}

/// `orca_poll` — `worktree ps --json` trimmed to the identities this shell
/// launched on the named environment (absent = this Mac) for the server
/// the shell currently opens. Rows for watched-but-gone identities come
/// back `found: false`. Entries whose row went terminal are marked here
/// and pruned once the terminal report has had time to land.
#[tauri::command]
pub async fn orca_poll(app: AppHandle, environment: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = orca_bin().ok_or_else(|| "Orca is not installed on this computer".to_string())?;
        let environment = checked_environment(&bin, environment.as_deref())?;
        let server = current_server();
        let watched = edit_tasks(&app, |tasks| {
            let dirty = prune_ended(tasks, millis()) > 0;
            (tracked(tasks, environment.as_deref(), &server), dirty)
        })?;
        if watched.is_empty() {
            return Ok(json!({ "rows": [] }));
        }
        let mut args = argv(&["worktree", "ps"]);
        args.push(format!("--limit={PS_LIMIT}"));
        if let Some(env) = &environment {
            args.push(format!("--environment={env}"));
        }
        args.push("--json".to_string());
        let out = run_orca(&bin, &args, None, PS_TIMEOUT)?;
        let rows = out
            .get("worktrees")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let trimmed: Vec<Value> = watched
            .keys()
            .map(|identity| {
                let row = rows.iter().find(|r| {
                    r.pointer("/identity/key").and_then(Value::as_str) == Some(identity.as_str())
                });
                poll_row(identity, row)
            })
            .collect();
        /* stamp `ended` under the lock — entries whose row ended keep
           reporting until prune_ended retires them */
        edit_tasks(&app, |tasks| ((), mark_ended(tasks, &trimmed, millis())))?;
        Ok(json!({ "rows": trimmed }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `orca_untrack` — stop watching identities: the page calls it once the
/// server has answered a terminal state for a task, or refused the task
/// outright. Only identities this shell tracks for the current server may
/// be dropped.
#[tauri::command]
pub async fn orca_untrack(app: AppHandle, identities: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if identities.len() > MAX_UNTRACK || identities.iter().any(|i| !valid_identity(i)) {
            return Err(bad("identities"));
        }
        let server = current_server();
        let removed = edit_tasks(&app, |tasks| {
            let before = tasks.len();
            tasks.retain(|id, t| !(t.server == server && identities.contains(id)));
            (before - tasks.len(), before != tasks.len())
        })?;
        Ok(json!({ "removed": removed }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `orca_ports` — `orca ports --worktree identity:<key> --json`: the
/// listening ports Orca tied to the worktree and the dev-server URL its
/// terminal printed. The report's `devUrl` is what a live frame or the
/// drift review points at. Only identities this shell launched may be
/// asked about.
#[tauri::command]
pub async fn orca_ports(
    app: AppHandle,
    identity: String,
    environment: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_identity(&identity) {
            return Err(bad("identity"));
        }
        let bin = orca_bin().ok_or_else(|| "Orca is not installed on this computer".to_string())?;
        let environment = checked_environment(&bin, environment.as_deref())?;
        let dir = tasks_dir(&app)?;
        if !tracked(&load_tasks(&dir), environment.as_deref(), &current_server())
            .contains_key(&identity)
        {
            return Err("this shell did not launch that worktree".to_string());
        }
        let mut args = argv(&["ports"]);
        args.push(format!("--worktree=identity:{identity}"));
        if let Some(env) = &environment {
            args.push(format!("--environment={env}"));
        }
        args.push("--json".to_string());
        let out = run_orca(&bin, &args, None, QUICK_TIMEOUT)?;
        Ok(json!({ "ports": trim_ports(&out) }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `orca ports` output trimmed to port/url/process — the pid and the
/// matched process's cwd stay here.
fn trim_ports(out: &Value) -> Vec<Value> {
    out.get("ports")
        .and_then(Value::as_array)
        .map(|ports| {
            ports
                .iter()
                .map(|p| {
                    json!({
                        "port": p.get("port").and_then(Value::as_u64),
                        "url": p.get("url").and_then(Value::as_str),
                        "process": p.get("process").and_then(Value::as_str),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `orca_activate` — bring the worktree forward in Orca (`worktree
/// activate`), e.g. "Open in Orca" on a task card. Only identities this
/// shell launched may be activated.
#[tauri::command]
pub async fn orca_activate(
    app: AppHandle,
    identity: String,
    environment: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_identity(&identity) {
            return Err(bad("identity"));
        }
        let bin = orca_bin().ok_or_else(|| "Orca is not installed on this computer".to_string())?;
        let environment = checked_environment(&bin, environment.as_deref())?;
        let dir = tasks_dir(&app)?;
        if !tracked(&load_tasks(&dir), environment.as_deref(), &current_server())
            .contains_key(&identity)
        {
            return Err("this shell did not launch that worktree".to_string());
        }
        let mut args = argv(&["worktree", "activate"]);
        args.push(format!("--worktree=identity:{identity}"));
        if let Some(env) = &environment {
            args.push(format!("--environment={env}"));
        }
        args.push("--json".to_string());
        run_orca(&bin, &args, None, ACTIVATE_TIMEOUT)?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::sync::Mutex;

    /// Env vars are process-wide — serialise every test that sets them.
    #[cfg(unix)]
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Write a fake `orca` that records each invocation's argv to
    /// $ORCA_ARGV_LOG and answers from $ORCA_FAKE_DIR/<cmd>_<sub>.json (or
    /// a canned ok envelope otherwise). A shebang script is unix-only.
    #[cfg(unix)]
    fn fake_orca(dir: &Path) -> PathBuf {
        let bin = dir.join("orca-fake");
        fs::write(
            &bin,
            r#"#!/bin/sh
echo "$@" >> "$ORCA_ARGV_LOG"
key="$(echo "$1_$2" | tr ' ' '_')"
file="$ORCA_FAKE_DIR/$key.json"
if [ -f "$file" ]; then cat "$file"; else echo '{"ok":true,"result":{}}'; fi
"#,
        )
        .unwrap();
        let mut perms = fs::metadata(&bin).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin, perms).unwrap();
        bin
    }

    #[cfg(unix)]
    struct Fake {
        dir: tempfile::TempDir,
        bin: PathBuf,
        argv_log: PathBuf,
    }

    #[cfg(unix)]
    impl Fake {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_orca(dir.path());
            let argv_log = dir.path().join("argv.log");
            std::env::set_var("DOOP_ORCA_CLI", &bin);
            std::env::set_var("ORCA_FAKE_DIR", dir.path());
            std::env::set_var("ORCA_ARGV_LOG", &argv_log);
            Self { dir, bin, argv_log }
        }
        fn answer(&self, name: &str, json_text: &str) {
            fs::write(self.dir.path().join(format!("{name}.json")), json_text).unwrap();
        }
        fn argv_lines(&self) -> Vec<String> {
            fs::read_to_string(&self.argv_log)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    #[cfg(unix)]
    impl Drop for Fake {
        fn drop(&mut self) {
            std::env::remove_var("DOOP_ORCA_CLI");
            std::env::remove_var("ORCA_FAKE_DIR");
            std::env::remove_var("ORCA_ARGV_LOG");
        }
    }

    fn launch_spec() -> LaunchSpec {
        LaunchSpec {
            worktree_name: "doop-new-screen-a1b2".to_string(),
            repo_id: "r-1".to_string(),
            branch: "doop/new-screen-a1b2".to_string(),
            agent: "claude".to_string(),
            model: None,
            effort: None,
            prompt: "implement the spec".to_string(),
            comment: "doop: https://diazo.test/c/c1?frame=f1 · task t1".to_string(),
            environment: None,
        }
    }

    #[test]
    fn argv_never_uses_a_shell() {
        /* the launch argv is a literal vector — no shell, and the surface
           stays the person's own Orca setting: --surface is never emitted */
        let args = launch_args(&LaunchSpec {
            model: Some("opus".to_string()),
            effort: Some("high".to_string()),
            environment: Some("vps".to_string()),
            ..launch_spec()
        });
        assert!(!args
            .iter()
            .any(|a| matches!(a.as_str(), "--surface" | "sh" | "bash" | "-c")));
        assert_eq!(&args[..2], ["worktree", "create"]);
    }

    #[test]
    fn launch_args_builds_the_worktree_create_argv() {
        /* every value rides as --flag=value: a field's text can never be
           parsed as an option itself */
        assert_eq!(
            launch_args(&launch_spec()),
            argv(&[
                "worktree", "create",
                "--name=doop-new-screen-a1b2",
                "--repo=id:r-1",
                "--branch=doop/new-screen-a1b2",
                "--agent=claude",
                "--prompt=implement the spec",
                "--comment=doop: https://diazo.test/c/c1?frame=f1 · task t1",
                "--no-parent",
                "--json",
            ])
        );
        /* --model, --effort and --environment slot in before --json */
        let full = LaunchSpec {
            model: Some("opus".to_string()),
            effort: Some("high".to_string()),
            environment: Some("vps".to_string()),
            ..launch_spec()
        };
        assert_eq!(
            launch_args(&full),
            argv(&[
                "worktree", "create",
                "--name=doop-new-screen-a1b2",
                "--repo=id:r-1",
                "--branch=doop/new-screen-a1b2",
                "--agent=claude",
                "--prompt=implement the spec",
                "--comment=doop: https://diazo.test/c/c1?frame=f1 · task t1",
                "--no-parent",
                "--model=opus",
                "--effort=high",
                "--environment=vps",
                "--json",
            ])
        );
    }

    #[test]
    fn validation_accepts_the_contract() {
        assert!(valid_branch("doop/new-screen-a1b2"));
        assert!(valid_branch("feat/x.y-z_w"));
        for bad_branch in ["", "-x", "/x", "a b", "a..b", "a/", "a."] {
            assert!(!valid_branch(bad_branch), "{bad_branch}");
        }
        assert!(!valid_branch(&"x".repeat(300)));
        assert!(valid_name("doop-checkout-1"));
        assert!(valid_name("A screen with spaces"));
        assert!(!valid_name("with\nnewline"));
        /* values that could read as flags to the CLI are refused outright —
           the --flag=value argv makes this belt-and-suspenders */
        assert!(!valid_name("--surface"));
        assert!(!valid_name("with\tcontrol"));
        assert!(!valid_name("with\u{7}bell"));
        assert!(valid_prompt("You are implementing a design.\nTwo lines.\tTabbed."));
        assert!(!valid_prompt("--surface"));
        assert!(!valid_prompt("with\u{7}bell"));
        assert!(!valid_prompt(""));
        assert!(valid_comment("doop: https://x/c/c1 · task t1"));
        assert!(valid_comment(""));
        assert!(!valid_comment("--agent=x"));
        assert!(!valid_comment("two\nlines"));
        assert!(valid_flag_value("gpt-6-astra"));
        assert!(!valid_flag_value("-x"));
        assert!(!valid_flag_value("--model"));
        assert!(valid_identity(
            "wt2:local:59ef3513-5c2d-4a86-a683-f11d3bfbc2f3"
        ));
        assert!(!valid_identity("../etc/passwd"));
        assert!(!valid_identity("wt2:x;rm -rf /"));
        assert!(valid_task_id("4YIJUBe1Yb"));
        assert!(valid_flag_value("gpt-6-astra"));
        assert!(!valid_flag_value("a b --evil"));
    }

    #[test]
    fn remote_keys_normalize() {
        assert_eq!(
            canonical_remote_key("git@github.com:BRYANN2K/diazo.git").as_deref(),
            Some("github.com/BRYANN2K/diazo")
        );
        assert_eq!(
            canonical_remote_key("https://github.com/BRYANN2K/diazo.git").as_deref(),
            Some("github.com/BRYANN2K/diazo")
        );
        assert_eq!(
            canonical_remote_key("ssh://git@gitlab.example:2222/team/app.git").as_deref(),
            Some("gitlab.example/team/app")
        );
        assert_eq!(canonical_remote_key("not a url"), None);
    }

    #[test]
    fn repo_match_prefers_path_then_remote() {
        let repos = vec![
            json!({"id":"r-local","path":"/tmp/grant","displayName":"Local"}),
            json!({"id":"r-remote","path":"/elsewhere","displayName":"Remote","gitRemoteIdentity":{"canonicalKey":"github.com/a/b"}}),
        ];
        let hit = resolve_repo_in_list(
            &repos,
            Some(Path::new("/tmp/grant")),
            Some("github.com/a/b"),
        );
        assert_eq!(hit.unwrap()["id"], "r-local");
        let hit = resolve_repo_in_list(&repos, Some(Path::new("/other")), Some("github.com/a/b"));
        assert_eq!(hit.unwrap()["id"], "r-remote");
        assert!(resolve_repo_in_list(&repos, None, Some("github.com/x/y")).is_none());
    }

    #[test]
    fn poll_trims_rows_to_the_contract() {
        let row = json!({
            "identity": {"key": "wt2:vps:inst-9"},
            "status": "working",
            "path": "/secret/path",
            "branch": "refs/heads/doop/x",
            "workspaceStatus": "in-review",
            "linkedPR": "https://github.com/a/b/pull/3",
            "agents": [{
                "state": "idle",
                "mainAgent": {"state": "working"},
                "programStatus": {"state": "success"},
                "lastAssistantMessage": "done",
                "orcaSessionId": "s-1"
            }]
        });
        let trimmed = poll_row("wt2:vps:inst-9", Some(&row));
        assert_eq!(trimmed["found"], true);
        assert_eq!(trimmed["agentState"], "working");
        assert_eq!(trimmed["outcome"], "success");
        assert_eq!(trimmed["branch"], "doop/x");
        assert_eq!(trimmed["linkedPR"], "https://github.com/a/b/pull/3");
        /* a linkedPR object reduces to its url; any other shape drops out */
        let obj = json!({"linkedPR": {"url": "https://github.com/a/b/pull/9", "title": "x"}});
        assert_eq!(
            poll_row("wt2:x:y", Some(&obj))["linkedPR"],
            "https://github.com/a/b/pull/9"
        );
        let odd_pr = json!({"linkedPR": {"htmlUrl": "https://x", "n": 1}});
        assert_eq!(poll_row("wt2:x:y", Some(&odd_pr))["linkedPR"], Value::Null);
        /* the absolute path is trimmed away, never reported */
        assert!(!trimmed.to_string().contains("/secret"));
        let missing = poll_row("wt2:vps:inst-9", None);
        assert_eq!(missing["found"], false);
        /* ports trim keeps port/url/process and drops pids and cwds */
        let ports = trim_ports(&json!({
            "ports": [
                {"port": 5173, "url": "http://localhost:5173/", "process": "vite", "pid": 42, "cwd": "/secret"},
                {"port": 3000}
            ]
        }));
        assert_eq!(ports[0]["url"], "http://localhost:5173/");
        assert_eq!(ports.len(), 2);
        assert!(!ports[0].to_string().contains("/secret"));
        /* an unrecognised terminal label is not reported as an outcome */
        let odd = json!({"agents":[{"programStatus":{"state":"done"},"state":"done"}]});
        assert_eq!(poll_row("wt2:x:y", Some(&odd))["outcome"], Value::Null);
        assert_eq!(poll_row("wt2:x:y", Some(&odd))["agentState"], "done");
    }

    #[test]
    fn the_launch_answer_never_carries_a_path() {
        /* `worktree create` answers the worktree id as `<repoId>::<abs
           path>`: nothing path-shaped may reach the page or the report —
           the server only ever gets the `wt2:` identity */
        let out = json!({
            "id": "r1::/Users/x/very/secret/project",
            "worktreeId": "r1::/Users/x/very/secret/project",
            "identity": {"key": "wt2:local:i1"},
            "branch": "refs/heads/doop/x",
            "path": "/Users/x/very/secret/project",
            "launch": {
                "operationId": "op-1",
                "outcome": {"kind": "structured", "handle": "chat-1", "orcaSessionId": "s-1"}
            }
        });
        let reply = launch_reply(&out, "wt2:local:i1", "doop/x");
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["orcaIdentity"], "wt2:local:i1");
        assert_eq!(reply["branch"], "doop/x");
        assert_eq!(reply["launchKind"], "structured");
        let text = reply.to_string();
        assert!(!text.contains("worktreeId"));
        assert!(!text.contains("/Users/") && !text.contains("secret"));
    }

    #[cfg(unix)]
    #[test]
    fn run_orca_parses_and_reports() {
        let _lock = ENV_LOCK.lock().unwrap();
        let fake = Fake::new();
        fake.answer("host_list", r#"{"ok":true,"result":{"hosts":[]}}"#);
        let bin = fake.bin.clone();
        let out = crate::test_support::within(Duration::from_secs(10), move || {
            run_orca(
                &bin,
                &argv(&["host", "list", "--json"]),
                None,
                QUICK_TIMEOUT,
            )
        })
        .unwrap();
        assert_eq!(out["hosts"], json!([]));
        fake.answer("bad_thing", r#"{"ok":false,"error":{"message":"nope"}}"#);
        let bin = fake.bin.clone();
        let err = crate::test_support::within(Duration::from_secs(10), move || {
            run_orca(
                &bin,
                &argv(&["bad", "thing", "--json"]),
                None,
                QUICK_TIMEOUT,
            )
        });
        assert!(err.unwrap_err().contains("nope"));
        assert!(fake.argv_lines().iter().any(|l| l.contains("host list")));
    }

    #[cfg(unix)]
    #[test]
    fn environments_come_from_host_list() {
        let _lock = ENV_LOCK.lock().unwrap();
        let fake = Fake::new();
        fake.answer(
            "host_list",
            r#"{"ok":true,"result":{"hosts":[
                {"kind":"local","name":"this machine","id":"local"},
                {"kind":"environment","name":"vps","id":"4a64568a-3145-413d-93be-f3a95f46e707"}
            ]}}"#,
        );
        let bin = fake.bin.clone();
        let (vps, by_id, bad_env, none_env) =
            crate::test_support::within(Duration::from_secs(10), move || {
                (
                    checked_environment(&bin, Some("vps")).ok().flatten(),
                    checked_environment(&bin, Some("4a64568a-3145-413d-93be-f3a95f46e707"))
                        .ok()
                        .flatten(),
                    checked_environment(&bin, Some("prod; rm -rf")),
                    checked_environment(&bin, None).ok().flatten(),
                )
            });
        assert_eq!(vps.as_deref(), Some("vps"));
        assert_eq!(
            by_id.as_deref(),
            Some("4a64568a-3145-413d-93be-f3a95f46e707")
        );
        assert!(bad_env.is_err());
        assert!(none_env.is_none());
    }

    fn tracked_task(environment: Option<&str>, server: &str) -> TrackedTask {
        TrackedTask {
            task_id: "t1".to_string(),
            environment: environment.map(str::to_string),
            server: server.to_string(),
            branch: "doop/x".to_string(),
            agent: "claude".to_string(),
            at: 1,
            ended: None,
        }
    }

    #[test]
    fn tracked_is_per_environment_and_server() {
        let tasks = BTreeMap::from([
            ("wt2:vps:inst-9".to_string(), tracked_task(Some("vps"), "https://a")),
            ("wt2:vps:other".to_string(), tracked_task(Some("vps"), "https://b")),
            ("wt2:local:i1".to_string(), tracked_task(None, "https://a")),
        ]);
        /* another server's entries stay in the file but are never watched */
        let on_a = tracked(&tasks, Some("vps"), "https://a");
        assert!(on_a.contains_key("wt2:vps:inst-9"));
        assert!(!on_a.contains_key("wt2:vps:other"));
        assert!(!tracked(&tasks, None, "https://a").contains_key("wt2:vps:inst-9"));
        assert!(tracked(&tasks, None, "https://a").contains_key("wt2:local:i1"));
        /* entries from before the server keying (empty `server`) match nothing */
        let mut legacy = BTreeMap::new();
        legacy.insert("wt2:vps:old".to_string(), TrackedTask {
            server: String::new(),
            ..tracked_task(Some("vps"), "https://a")
        });
        assert!(!tracked(&legacy, Some("vps"), "https://a").contains_key("wt2:vps:old"));
    }

    #[test]
    fn ended_entries_report_then_prune() {
        let mut tasks = BTreeMap::from([(
            "wt2:vps:inst-9".to_string(),
            tracked_task(Some("vps"), "https://a"),
        )]);
        /* a working row marks nothing */
        let working = json!([{ "identity": "wt2:vps:inst-9", "found": true, "agentState": "working" }]);
        assert!(!mark_ended(&mut tasks, working.as_array().unwrap(), 1000));
        /* a terminal outcome or a vanished worktree marks the entry */
        let gone = json!([{ "identity": "wt2:vps:inst-9", "found": false }]);
        assert!(mark_ended(&mut tasks, gone.as_array().unwrap(), 1000));
        assert_eq!(tasks["wt2:vps:inst-9"].ended, Some(1000));
        /* it stays watched and is reported again until the prune age */
        assert_eq!(prune_ended(&mut tasks, 1000 + ENDED_PRUNE_MS - 1), 0);
        assert_eq!(prune_ended(&mut tasks, 1000 + ENDED_PRUNE_MS), 1);
        assert!(tasks.is_empty());
    }

    #[test]
    fn tasks_store_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut tasks = BTreeMap::new();
        tasks.insert(
            "wt2:local:i1".to_string(),
            TrackedTask {
                task_id: "t".to_string(),
                environment: None,
                server: "https://diazo.example".to_string(),
                branch: "doop/a".to_string(),
                agent: "codex".to_string(),
                at: 2,
                ended: None,
            },
        );
        save_tasks(dir.path(), &tasks).unwrap();
        let loaded = load_tasks(dir.path());
        assert_eq!(loaded["wt2:local:i1"].task_id, "t");
        assert!(loaded["wt2:local:i1"].environment.is_none());
        /* and a file written before server/ended keys existed still loads */
        fs::write(
            tasks_file(dir.path()),
            r#"{"wt2:local:i2":{"taskId":"t2","worktreeId":"r::/q","environment":null,"branch":"b","agent":"claude","at":3}}"#,
        )
        .unwrap();
        let loaded = load_tasks(dir.path());
        assert_eq!(loaded["wt2:local:i2"].server, "");
        assert_eq!(loaded["wt2:local:i2"].ended, None);
    }
}
