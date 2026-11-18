//! Local agents over the Agent Client Protocol (ACP): the Devin CLI
//! (`devin acp`) and the Grok CLI (`grok agent stdio`), run on this computer
//! for a Doop account the way claude.rs runs Claude Code.
//!
//! The shell is the ACP client. It speaks JSON-RPC 2.0 over the agent's
//! stdio, one message per line: `initialize`, `session/new` (an empty private
//! working directory and the Doop run's MCP server, so the agent designs
//! through the canvas tools), `session/prompt`, the streamed
//! `session/update` notifications and `session/cancel`. What the agent asks
//! of the client is answered by policy: a permission request is granted only
//! for one of the run's Doop tools, never for an edit, a deletion or a shell
//! command, and the file system and terminal methods are refused (the client
//! advertises neither).
//!
//! Which program runs is fixed here: an allowlisted agent name picks the
//! binary (`devin` / `grok`) found on the login shell's PATH or a known
//! install location, never a path or an argument from the page. A model id
//! and an effort are the only values the page passes on, each checked by
//! shape before it becomes one argv element. Credentials stay with the CLI.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

/// The agents the shell will start. Adding one is a variant here and its
/// arguments below; nothing the page sends can name another program.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Agent {
    Devin,
    Grok,
}

pub(crate) const AGENTS: [Agent; 2] = [Agent::Devin, Agent::Grok];

impl Agent {
    pub(crate) fn parse(name: &str) -> Option<Agent> {
        match name {
            "devin" => Some(Agent::Devin),
            "grok" => Some(Agent::Grok),
            _ => None,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Agent::Devin => "devin",
            Agent::Grok => "grok",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Agent::Devin => "Devin",
            Agent::Grok => "Grok",
        }
    }

    fn binary(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Agent::Devin, false) => "devin",
            (Agent::Devin, true) => "devin.exe",
            (Agent::Grok, false) => "grok",
            (Agent::Grok, true) => "grok.exe",
        }
    }

    /// Where each installer puts the binary, besides the PATH.
    fn install_dirs(self, home: &Path) -> Vec<PathBuf> {
        match self {
            Agent::Devin => vec![home.join(".local/bin")],
            Agent::Grok => vec![home.join(".local/bin"), home.join(".grok/bin")],
        }
    }

    /// What the person runs in a terminal to sign the CLI in.
    fn login_command(self) -> &'static str {
        match self {
            Agent::Devin => "devin auth login",
            Agent::Grok => "grok login",
        }
    }

    fn login_hint(self) -> String {
        format!(
            "{} is not signed in on this computer. Run `{}` in your terminal, then Refresh.",
            self.title(),
            self.login_command()
        )
    }

    /// The effort the CLI takes as a flag. Devin has none: its effort is part
    /// of the model id (`swe-2-high`), which the server composes. Mirrors
    /// GROK_EFFORTS in shared/acpAgent.ts.
    fn valid_effort(self, effort: &str) -> bool {
        match self {
            Agent::Devin => false,
            Agent::Grok => ["low", "medium", "high", "xhigh"].contains(&effort),
        }
    }

    /// The argv that starts the agent as an ACP server on stdio. `model` is
    /// None for the CLI's own default.
    pub(crate) fn args(self, model: Option<&str>, effort: Option<&str>) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        match self {
            Agent::Devin => {
                args.push("acp".into());
                if let Some(model) = model {
                    args.extend(["--model".into(), model.into()]);
                }
            }
            Agent::Grok => {
                args.push("agent".into());
                if let Some(model) = model {
                    args.extend(["-m".into(), model.into()]);
                }
                if let Some(effort) = effort {
                    args.extend(["--reasoning-effort".into(), effort.into()]);
                }
                args.push("stdio".into());
            }
        }
        args
    }
}

/// Mirrors ACP_MODEL_ID in shared/acpAgent.ts: lowercase letters, digits,
/// dots, dashes and underscores, starting with a letter or digit. The value
/// becomes one argv element (never a flag: it cannot start with `-`), so the
/// shape rule is the whole guard. `default` means no flag at all.
pub(crate) fn valid_model(model: &str) -> bool {
    (1..=80).contains(&model.len())
        && model.as_bytes()[0].is_ascii_alphanumeric()
        && model
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
}

/// A Doop tool name as the run lists it.
fn valid_tool(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Default)]
pub struct AcpState {
    /// one run per agent at a time: its job id and its cancel flag
    active: Mutex<HashMap<Agent, (String, Arc<AtomicBool>)>>,
}

/// Cancel every run and wait (a moment) for the agents to be reaped before
/// the runtime goes away.
pub fn shutdown(state: &AcpState) {
    if let Ok(active) = state.active.lock() {
        for (_, cancel) in active.values() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if state.active.lock().map(|active| active.is_empty()).unwrap_or(true) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/* ---------------------------------------------------------------- */
/* finding the CLI                                                   */
/* ---------------------------------------------------------------- */

/// Every place the agent's binary may be: its installer's directories, the
/// login shell's PATH, the app's own PATH and the Homebrew prefixes. The
/// first one that exists runs: unlike Claude Code, neither CLI has a history
/// of stale installs worth out-voting by version.
fn candidates(agent: Agent, shell_path: Option<&OsStr>) -> Vec<PathBuf> {
    let name = agent.binary();
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.extend(agent.install_dirs(Path::new(&home)));
    }
    for path in [shell_path.map(OsStr::to_os_string), std::env::var_os("PATH")].into_iter().flatten() {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    let mut seen = HashSet::new();
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

struct Cli {
    path: PathBuf,
    /// the login shell's PATH, which every process started from `path` gets
    env_path: Option<OsString>,
}

fn resolve(agent: Agent, fresh: bool) -> Result<Cli, String> {
    let env_path = crate::claude::login_shell_path(fresh);
    let path = candidates(agent, env_path.as_deref()).into_iter().next().ok_or_else(|| {
        format!("{} CLI not found. Install it, then Refresh.", agent.title())
    })?;
    Ok(Cli { path, env_path })
}

fn command_at(cli: &Cli) -> Command {
    let mut cmd = Command::new(&cli.path);
    if let Some(path) = &cli.env_path {
        cmd.env("PATH", path);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        // its own process group, so a stop takes every helper it started too
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// Kills the agent and everything in its process group, then reaps it.
///
/// The group is signalled with kill(2) itself, before the reap, so the
/// leader's pid (and with it the group id) cannot have been reused. Never
/// through `/bin/kill`: procps' kill, given a group whose only member has
/// already exited, signals the caller's own process group instead, which
/// took down the app (and, under `cargo test`, the CI runner).
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    // a negative 0 or 1 would mean our own group or every process we may signal
    if let Some(group) = libc::pid_t::try_from(child.id()).ok().filter(|pid| *pid > 1) {
        // SAFETY: kill(2) takes no pointers; the target is the child's own group
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The bounded output of a short command (`--version`, `models`): its lines
/// and whether it exited cleanly in time.
fn short_output(mut cmd: Command, timeout: Duration) -> Option<(bool, Vec<String>)> {
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(line)) = read_line(&mut reader, 64_000) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let started = Instant::now();
    let mut lines = Vec::new();
    let ok = loop {
        if started.elapsed() > timeout {
            kill_tree(&mut child);
            break false;
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(line) if lines.len() < 2_000 => lines.push(line),
            Ok(_) => {}
            Err(RecvTimeoutError::Disconnected) => match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => break false,
            },
            Err(RecvTimeoutError::Timeout) => {}
        }
    };
    drop(receiver);
    let _ = reader.join();
    Some((ok, lines))
}

/// "devin 3000.12.57 (96542e9)" or "grok 1.0.77 (…) [stable]" -> the first
/// dotted number.
pub(crate) fn parse_version(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|word| {
            let mut parts = word.split('.');
            parts.clone().count() >= 2 && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_string)
}

/// `devin models`: a family header (`SWE-2 (swe-2)`) then its variants, each
/// `  <id>   <name>  [context, price]`. Returns every variant with its
/// family's display name; the server turns them into a menu with efforts.
pub(crate) fn parse_devin_models(lines: &[String]) -> Vec<Value> {
    let mut family = String::new();
    let mut models = Vec::new();
    for line in lines {
        if line.trim().is_empty() || line.starts_with("Available models") {
            continue;
        }
        if !line.starts_with(' ') {
            family = line.rsplit_once(" (").map_or(line.trim(), |(name, _)| name.trim()).to_string();
            continue;
        }
        let trimmed = line.trim();
        if trimmed.starts_with("aliases:") {
            continue;
        }
        let Some((id, rest)) = trimmed.split_once(char::is_whitespace) else { continue };
        if !valid_model(id) {
            continue;
        }
        let name = rest.split_once('[').map_or(rest, |(name, _)| name).trim();
        models.push(json!({"id": id, "name": if name.is_empty() { id } else { name }, "family": family}));
        if models.len() >= 400 {
            break;
        }
    }
    models
}

/// `grok models`: "You are logged in…", then `  * grok-4.7 (default)` and
/// `  - grok-4.6` lines.
pub(crate) fn parse_grok_models(lines: &[String]) -> (bool, Vec<Value>) {
    let logged_in = lines.iter().any(|l| l.to_ascii_lowercase().contains("logged in") && !l.to_ascii_lowercase().contains("not logged in"));
    let models = lines
        .iter()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("* ").or_else(|| line.trim().strip_prefix("- "))?;
            let id = rest.split_whitespace().next()?;
            valid_model(id).then(|| json!({"id": id, "name": id, "default": rest.contains("(default)")}))
        })
        .take(100)
        .collect();
    (logged_in, models)
}

/// What one status call learns from the CLI itself, kept for a while: the
/// model lists ask the provider's servers, too slow for every focus.
#[derive(Clone)]
struct Probe {
    at: Instant,
    path: PathBuf,
    version: Option<String>,
    connected: bool,
    models: Vec<Value>,
}

static PROBES: Mutex<Vec<(Agent, Probe)>> = Mutex::new(Vec::new());
const PROBE_TTL: Duration = Duration::from_secs(10 * 60);

fn probe(agent: Agent, fresh: bool) -> Result<Probe, String> {
    let cli = resolve(agent, fresh)?;
    if !fresh {
        if let Ok(cached) = PROBES.lock() {
            if let Some((_, p)) = cached.iter().find(|(a, p)| *a == agent && p.path == cli.path && p.at.elapsed() < PROBE_TTL) {
                return Ok(p.clone());
            }
        }
    }
    let run = |args: &[&str], secs: u64| {
        let mut cmd = command_at(&cli);
        cmd.args(args);
        short_output(cmd, Duration::from_secs(secs)).unwrap_or((false, Vec::new()))
    };
    let (_, version_lines) = run(&["--version"], 10);
    let version = version_lines.first().and_then(|l| parse_version(l));
    let (connected, models) = match agent {
        Agent::Devin => {
            let (ok, status) = run(&["auth", "status"], 20);
            let connected = ok && status.iter().any(|l| l.trim_start().starts_with("Logged in"));
            let models = if connected { parse_devin_models(&run(&["models"], 30).1) } else { Vec::new() };
            (connected, models)
        }
        Agent::Grok => {
            let (ok, lines) = run(&["models"], 30);
            let (logged_in, models) = parse_grok_models(&lines);
            (ok && logged_in, models)
        }
    };
    let probe = Probe { at: Instant::now(), path: cli.path, version, connected, models };
    if let Ok(mut cached) = PROBES.lock() {
        cached.retain(|(a, _)| *a != agent);
        cached.push((agent, probe.clone()));
    }
    Ok(probe)
}

/* ---------------------------------------------------------------- */
/* which Doop accounts may run each agent here                       */
/* ---------------------------------------------------------------- */

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("acp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

type Connections = HashMap<String, HashSet<String>>;

fn connections(app: &AppHandle) -> Result<Connections, String> {
    let path = directory(app)?.join("connections.json");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    Ok(serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).unwrap_or_default())
}

fn enabled(app: &AppHandle, agent: Agent, user_id: &str) -> Result<bool, String> {
    Ok(connections(app)?.get(agent.id()).is_some_and(|users| users.contains(user_id)))
}

fn agent_arg(name: &str) -> Result<Agent, String> {
    Agent::parse(name).ok_or_else(|| "Unknown local agent".to_string())
}

/// `fresh` (the Refresh button) asks the login shell and the CLI again.
#[tauri::command]
pub async fn acp_status(app: AppHandle, user_id: String, agent: String, fresh: Option<bool>) -> Result<Value, String> {
    let agent = agent_arg(&agent)?;
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = enabled(&app, agent, &user_id)?;
        let Ok(probe) = probe(agent, fresh.unwrap_or(false)) else {
            return Ok(json!({"agent": agent.id(), "installed": false, "connected": false, "enabled": enabled}));
        };
        Ok(json!({"agent": agent.id(), "installed": true, "connected": probe.connected, "enabled": enabled,
            "cliPath": probe.path.to_string_lossy(), "cliVersion": probe.version, "models": probe.models,
            "loginCommand": agent.login_command()}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn acp_connect(app: AppHandle, user_id: String, agent: String, enabled: bool) -> Result<(), String> {
    let agent = agent_arg(&agent)?;
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.is_empty() || user_id.len() > 256 {
            return Err("Invalid account".into());
        }
        let mut all = connections(&app)?;
        let users = all.entry(agent.id().to_string()).or_default();
        if enabled && !users.contains(&user_id) {
            let accepted = rfd::MessageDialog::new()
                .set_title(format!("Use local {} for Diazo?", agent.title()))
                .set_description(format!("Diazo will run your installed {} CLI on this computer for this Doop account's canvas tasks, using your {} login and usage limits. Doop answers its permission requests: only Doop canvas tools are allowed. Tasks run while this desktop app is open.", agent.title(), agent.title()))
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show();
            if accepted != rfd::MessageDialogResult::Ok {
                return Err("Connection cancelled".into());
            }
            users.insert(user_id);
        } else if !enabled {
            users.remove(&user_id);
        }
        std::fs::write(directory(&app)?.join("connections.json"), serde_json::to_vec(&all).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs the CLI's own sign-in (it opens the browser), bounded like Claude's.
#[tauri::command]
pub async fn acp_login(agent: String) -> Result<(), String> {
    let agent = agent_arg(&agent)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cli = resolve(agent, false)?;
        let mut cmd = command_at(&cli);
        cmd.args(agent.login_command().split_whitespace().skip(1));
        let (ok, _) = short_output(cmd, Duration::from_secs(180)).unwrap_or((false, Vec::new()));
        if let Ok(mut cached) = PROBES.lock() {
            cached.retain(|(a, _)| *a != agent);
        }
        if ok {
            Ok(())
        } else {
            Err(format!("Sign-in did not complete. Run `{}` in your terminal, then Refresh.", agent.login_command()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn acp_stop(agent: String, state: State<'_, AcpState>) -> Result<(), String> {
    let agent = agent_arg(&agent)?;
    if let Some((_, cancel)) = state.active.lock().map_err(|e| e.to_string())?.get(&agent) {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/* ---------------------------------------------------------------- */
/* one run                                                           */
/* ---------------------------------------------------------------- */

/// A job as the server hands it out (shared/localAgent.ts LocalAgentJob),
/// checked field by field.
#[derive(Debug, PartialEq)]
pub(crate) struct Job {
    pub agent: Agent,
    pub id: String,
    pub token: String,
    /// None: the CLI's own default model
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt: String,
    pub tools: Vec<String>,
}

pub(crate) fn parse_job(job: &Value) -> Result<Job, String> {
    let text = |name: &str| job[name].as_str().ok_or_else(|| format!("Missing {name}"));
    let agent = agent_arg(text("agent")?)?;
    let id = text("id")?.to_string();
    if !valid_id(&id) {
        return Err("Invalid run id".into());
    }
    let token = text("token")?.to_string();
    if !valid_token(&token) {
        return Err("Invalid run token".into());
    }
    let model = match job["model"].as_str() {
        None | Some("default") => None,
        Some(model) if valid_model(model) => Some(model.to_string()),
        Some(_) => return Err("Invalid model".into()),
    };
    let effort = match job["effort"].as_str() {
        None => None,
        Some(effort) if agent.valid_effort(effort) => Some(effort.to_string()),
        Some(_) => return Err("Invalid effort".into()),
    };
    let prompt = text("prompt")?;
    let system = text("system")?;
    if prompt.len() + system.len() > 1_000_000 {
        return Err("Task is too large".into());
    }
    // A session is one prompt under a wall clock — it cannot count turns,
    // so a budget beyond the ordinary ceiling is refused rather than
    // silently dropped. The mode that needs the bigger backstop is not
    // offered to this runner; anything larger reaching this point is a job
    // for the CLI runner that can pass it through.
    if job["maxTurns"].as_u64().unwrap_or(24) > 40 {
        return Err("Turn budget beyond what this runner can enforce".into());
    }
    let tools: Vec<String> = job["tools"]
        .as_array()
        .map(|tools| tools.iter().filter_map(Value::as_str).filter(|t| valid_tool(t)).map(str::to_string).take(300).collect())
        .unwrap_or_default();
    // ACP has no system prompt of its own: the brief leads the first message
    let prompt = if system.is_empty() {
        prompt.to_string()
    } else {
        format!("<doop_instructions>\n{system}\n</doop_instructions>\n\n{prompt}")
    };
    Ok(Job { agent, id, token, model, effort, prompt, tools })
}

#[tauri::command]
pub async fn acp_run(app: AppHandle, user_id: String, job: Value, state: State<'_, AcpState>) -> Result<Value, String> {
    let job = parse_job(&job)?;
    if !enabled(&app, job.agent, &user_id)? {
        return Err(format!("Connect {} on this device first", job.agent.title()));
    }
    let agent = job.agent;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active.lock().map_err(|e| e.to_string())?;
        if active.contains_key(&agent) {
            return Err(format!("{} is already running a task", agent.title()));
        }
        active.insert(agent, (job.id.clone(), cancel.clone()));
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_job(&handle, &job, cancel)).await;
    state.active.lock().map_err(|e| e.to_string())?.remove(&agent);
    result.map_err(|e| e.to_string())?
}

fn run_job(app: &AppHandle, job: &Job, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let cli = resolve(job.agent, false)?;
    // an empty private directory: the agent's own file tools find nothing
    let dir = directory(app)?.join(&job.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut cmd = command_at(&cli);
    cmd.current_dir(&dir).args(job.agent.args(job.model.as_deref(), job.effort.as_deref())).stdin(Stdio::piped());
    let spec = SessionSpec {
        agent: job.agent,
        cwd: dir.clone(),
        // the server URL is compiled into the app; a page cannot pick another target
        mcp_url: format!("{}/local-agent/mcp/{}", crate::base_url(), job.id),
        token: job.token.clone(),
        prompt: job.prompt.clone(),
        tools: job.tools.clone(),
    };
    let id = job.id.clone();
    let agent = job.agent.id();
    let result = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", job.agent.title())).and_then(|child| {
        run_session(child, &spec, cancel, Duration::from_secs(30 * 60), |text| {
            // human-readable progress only; MCP headers and tool payloads stay out
            let _ = app.emit_to("main", "acp-progress", json!({"agent": agent, "id": id, "text": text.chars().take(2000).collect::<String>()}));
        })
    });
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// What a session needs beyond the process itself.
pub(crate) struct SessionSpec {
    pub agent: Agent,
    pub cwd: PathBuf,
    pub mcp_url: String,
    pub token: String,
    pub prompt: String,
    pub tools: Vec<String>,
}

const MAX_LINE_BYTES: usize = 8_000_000;
const MAX_TEXT: usize = 100_000;

/// One line, bounded even when the agent never sends a newline.
fn read_line(reader: &mut impl BufRead, max: usize) -> Result<Option<String>, String> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|e| format!("Could not read the agent's output: {e}"))?;
        if buffer.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }
        let newline = buffer.iter().position(|b| *b == b'\n');
        let count = newline.unwrap_or(buffer.len());
        if line.len() + count > max {
            return Err("The agent sent a message over the 8 MB limit. The run was stopped.".into());
        }
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            break;
        }
    }
    String::from_utf8(line).map(Some).map_err(|_| "The agent's output was not valid UTF-8.".into())
}

/// Why waiting on the agent stopped.
#[derive(Debug)]
enum Wait {
    /// a JSON-RPC error answered the request
    Rpc { code: i64, message: String },
    Stopped,
    TimedOut,
    Failed(String),
}

/// The JSON-RPC side of a session: what was sent, what came back.
struct Rpc {
    stdin: ChildStdin,
    rx: Receiver<Result<String, String>>,
    next_id: u64,
    session_id: Option<String>,
    tools: Vec<String>,
    text: String,
    usage: Option<Value>,
    cost: Option<Value>,
    cancel_sent: bool,
}

impl Rpc {
    fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("The agent stopped reading: {e}"))
    }

    /// Sends one request and waits for its answer, dealing with whatever the
    /// agent sends meanwhile. On a stop the prompt gets `session/cancel` and
    /// `grace` to wind down before the wait gives up.
    fn call(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(&str),
    ) -> Result<Value, Wait> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).map_err(Wait::Failed)?;
        let mut stop_at: Option<(Instant, Wait)> = None;
        loop {
            if stop_at.is_none() {
                let reason = if cancel.load(Ordering::SeqCst) {
                    Some(Wait::Stopped)
                } else if Instant::now() > deadline {
                    Some(Wait::TimedOut)
                } else {
                    None
                };
                if let Some(reason) = reason {
                    // only a prompt can be asked to wind down; anything else just ends
                    if method != "session/prompt" {
                        return Err(reason);
                    }
                    self.cancel_session();
                    stop_at = Some((Instant::now() + Duration::from_secs(10), reason));
                }
            }
            if let Some((at, _)) = &stop_at {
                if Instant::now() > *at {
                    return Err(stop_at.take().map(|(_, r)| r).unwrap_or(Wait::Stopped));
                }
            }
            let line = match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => return Err(Wait::Failed(error)),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(stop_at.map(|(_, r)| r).unwrap_or_else(|| Wait::Failed("The agent exited before it answered.".into())))
                }
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            let is_response = message.get("method").is_none();
            if is_response {
                if message["id"].as_u64() != Some(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    return Err(Wait::Rpc {
                        code: error["code"].as_i64().unwrap_or(0),
                        message: error["message"].as_str().unwrap_or("").chars().take(500).collect(),
                    });
                }
                return Ok(message["result"].clone());
            }
            self.incoming(&message, progress).map_err(Wait::Failed)?;
        }
    }

    fn cancel_session(&mut self) {
        if self.cancel_sent {
            return;
        }
        self.cancel_sent = true;
        if let Some(session) = self.session_id.clone() {
            let _ = self.send(&json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}));
        }
    }

    /// A notification or a request from the agent.
    fn incoming(&mut self, message: &Value, progress: &mut dyn FnMut(&str)) -> Result<(), String> {
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        match (method, message.get("id")) {
            ("session/update", None) => {
                let update = &params["update"];
                match update["sessionUpdate"].as_str() {
                    Some("agent_message_chunk") => {
                        if let Some(text) = update["content"]["text"].as_str() {
                            if self.text.len() < MAX_TEXT {
                                self.text.push_str(text);
                            }
                            progress(text);
                        }
                    }
                    Some("usage_update") => {
                        if update.get("cost").is_some() {
                            self.cost = Some(update["cost"].clone());
                        }
                    }
                    _ => {}
                }
                Ok(())
            }
            (_, None) => Ok(()),
            ("session/request_permission", Some(id)) => {
                let outcome = permission_outcome(params, &self.tools, self.cancel_sent);
                self.send(&json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": outcome}}))
            }
            (_, Some(id)) => self.send(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Not supported by Doop"}})),
        }
    }
}

/// A permission request answered by policy: one of the run's Doop tools is
/// allowed once; anything else (a shell command, a file edit, another MCP
/// server's tool) is rejected, and after a stop everything is cancelled.
pub(crate) fn permission_outcome(params: &Value, tools: &[String], cancelled: bool) -> Value {
    if cancelled {
        return json!({"outcome": "cancelled"});
    }
    let call = &params["toolCall"];
    let kind = call["kind"].as_str().unwrap_or("other");
    let named = |field: &Value| field.as_str().is_some_and(|text| names_doop_tool(text, tools));
    let doop_tool = !["edit", "delete", "move", "execute"].contains(&kind) && (named(&call["title"]) || named(&call["toolCallId"]) || named(&call["rawInput"]["tool"]) || named(&call["rawInput"]["name"]));
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let pick = |kinds: &[&str]| {
        kinds.iter().find_map(|k| options.iter().find(|o| o["kind"] == *k)).and_then(|o| o["optionId"].as_str().map(str::to_string))
    };
    let choice = if doop_tool { pick(&["allow_once", "allow_always"]) } else { pick(&["reject_once", "reject_always"]) };
    match choice {
        Some(option) => json!({"outcome": "selected", "optionId": option}),
        None => json!({"outcome": "cancelled"}),
    }
}

/// Whether a tool call's title names one of the run's Doop tools: bare
/// (`create_frame`), or qualified by the Doop server the way agents print MCP
/// tools (`mcp__doop__create_frame`, `doop/create_frame`). A tool of the same
/// name on another server (`github/create_frame`) is not Doop's.
fn names_doop_tool(text: &str, tools: &[String]) -> bool {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '/'))
        .filter_map(|word| {
            if let Some(rest) = word.strip_prefix("mcp__") {
                return rest.strip_prefix("doop__");
            }
            match word.split_once('/') {
                Some((server, tool)) => (server == "doop").then_some(tool),
                None => Some(word),
            }
        })
        .any(|word| tools.iter().any(|t| t == word))
}

/// The whole conversation with one agent process: handshake, a session on
/// the Doop MCP server, one prompt, the answer. Always reaps the process.
pub(crate) fn run_session(
    mut child: Child,
    spec: &SessionSpec,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    mut progress: impl FnMut(&str),
) -> Result<Value, String> {
    let stdout = child.stdout.take().ok_or("Missing agent output")?;
    let stdin = child.stdin.take().ok_or("Missing agent input")?;
    let (sender, rx) = std::sync::mpsc::sync_channel(256);
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_line(&mut reader, MAX_LINE_BYTES) {
                Ok(Some(line)) => {
                    if sender.send(Ok(line)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });
    let mut rpc = Rpc {
        stdin,
        rx,
        next_id: 0,
        session_id: None,
        tools: spec.tools.clone(),
        text: String::new(),
        usage: None,
        cost: None,
        cancel_sent: false,
    };
    let title = spec.agent.title();
    let deadline = Instant::now() + timeout;
    let result = (|| {
        let describe = |wait: Wait| match wait {
            Wait::Stopped | Wait::TimedOut => format!("{title} run stopped or timed out. Retry when ready."),
            Wait::Failed(error) => error,
            Wait::Rpc { code, message } if is_auth_error(code, &message) => spec.agent.login_hint(),
            Wait::Rpc { message, .. } => format!("{title} refused the task: {message}"),
        };
        let handshake = (Instant::now() + Duration::from_secs(60)).min(deadline);
        let init = rpc
            .call(
                "initialize",
                json!({"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
                    "clientInfo": {"name": "doop-desktop", "version": env!("CARGO_PKG_VERSION")}}),
                handshake,
                &cancel,
                &mut progress,
            )
            .map_err(describe)?;
        if init["agentCapabilities"]["mcpCapabilities"]["http"] != true {
            return Err(format!("This {title} CLI cannot reach Diazo's canvas tools (it has no HTTP MCP support). Update it, then retry."));
        }
        let session = rpc
            .call(
                "session/new",
                json!({"cwd": spec.cwd.to_string_lossy(), "mcpServers": [{"type": "http", "name": "doop", "url": spec.mcp_url,
                    "headers": [{"name": "Authorization", "value": format!("Bearer {}", spec.token)}]}]}),
                (Instant::now() + Duration::from_secs(120)).min(deadline),
                &cancel,
                &mut progress,
            )
            .map_err(describe)?;
        let session_id = session["sessionId"].as_str().ok_or("The agent did not open a session.")?.to_string();
        rpc.session_id = Some(session_id.clone());
        let answer = rpc
            .call(
                "session/prompt",
                json!({"sessionId": session_id, "prompt": [{"type": "text", "text": spec.prompt}]}),
                deadline,
                &cancel,
                &mut progress,
            )
            .map_err(describe)?;
        let stop = answer["stopReason"].as_str().unwrap_or("");
        if answer.get("usage").is_some_and(Value::is_object) {
            rpc.usage = Some(answer["usage"].clone());
        }
        let success = stop == "end_turn";
        let text = if !rpc.text.trim().is_empty() {
            rpc.text.clone()
        } else if success {
            "Done.".to_string()
        } else {
            format!("{title} stopped without finishing ({}). Check its login and usage limits, then retry.", if stop.is_empty() { "no reason given" } else { stop })
        };
        Ok(json!({"success": success, "text": text, "stopReason": stop,
            "acpUsage": {"usage": rpc.usage, "cost": rpc.cost}}))
    })();
    drop(rpc);
    kill_tree(&mut child);
    let _ = reader.join();
    result
}

/// ACP's `auth_required` (-32000), or an agent that says so in words.
fn is_auth_error(code: i64, message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    code == -32000 || message.contains("auth") || message.contains("log in") || message.contains("login") || message.contains("sign in")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::test_support::within;

    #[test]
    fn only_allowlisted_agents_parse() {
        assert_eq!(Agent::parse("devin"), Some(Agent::Devin));
        assert_eq!(Agent::parse("grok"), Some(Agent::Grok));
        for name in ["claude", "Devin", "../devin", "/bin/sh", "", "grok "] {
            assert_eq!(Agent::parse(name), None, "{name}");
        }
        assert_eq!(AGENTS.map(Agent::id), ["devin", "grok"]);
    }

    #[test]
    fn model_ids_are_checked_by_shape() {
        for ok in ["swe-2-high", "claude-opus-5-5-max", "grok-4.7", "grok-4.7-build-fast", "gpt_6", "adaptive"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["", "-m", "--model", "Grok", "a b", "x;rm", "../x", "a/b", &"a".repeat(81)] {
            assert!(!valid_model(bad), "{bad}");
        }
    }

    #[test]
    fn arguments_start_an_acp_server() {
        assert_eq!(Agent::Devin.args(None, None), ["acp"]);
        assert_eq!(Agent::Devin.args(Some("swe-2-high"), None), ["acp", "--model", "swe-2-high"]);
        assert_eq!(Agent::Grok.args(None, None), ["agent", "stdio"]);
        assert_eq!(
            Agent::Grok.args(Some("grok-4.7"), Some("high")),
            ["agent", "-m", "grok-4.7", "--reasoning-effort", "high", "stdio"]
        );
        assert!(Agent::Grok.valid_effort("xhigh"));
        assert!(!Agent::Grok.valid_effort("max"));
        assert!(!Agent::Devin.valid_effort("high"));
    }

    fn job(overrides: Value) -> Value {
        let mut job = json!({"agent": "grok", "id": "0b8a3c9e-2f4d-4f3e-9a51-1c2d3e4f5a6b", "token": "a".repeat(64),
            "model": "grok-4.7", "effort": "high", "prompt": "Design a card", "system": "You are Doop.", "tools": ["create_frame", "Bad Name", "get_canvas"]});
        for (key, value) in overrides.as_object().unwrap() {
            job[key] = value.clone();
        }
        job
    }

    #[test]
    fn jobs_are_validated_field_by_field() {
        let parsed = parse_job(&job(json!({}))).unwrap();
        assert_eq!(parsed.agent, Agent::Grok);
        assert_eq!(parsed.model.as_deref(), Some("grok-4.7"));
        assert_eq!(parsed.tools, ["create_frame", "get_canvas"]);
        assert!(parsed.prompt.starts_with("<doop_instructions>\nYou are Doop."));
        assert!(parsed.prompt.ends_with("Design a card"));
        assert_eq!(parse_job(&job(json!({"model": "default"}))).unwrap().model, None);
        assert_eq!(parse_job(&job(json!({"agent": "claude"}))).unwrap_err(), "Unknown local agent");
        assert_eq!(parse_job(&job(json!({"model": "--help"}))).unwrap_err(), "Invalid model");
        assert_eq!(parse_job(&job(json!({"effort": "max"}))).unwrap_err(), "Invalid effort");
        assert_eq!(parse_job(&job(json!({"token": "short"}))).unwrap_err(), "Invalid run token");
        assert_eq!(parse_job(&job(json!({"id": "x"}))).unwrap_err(), "Invalid run id");
        assert_eq!(parse_job(&job(json!({"agent": "devin", "effort": "high"}))).unwrap_err(), "Invalid effort");
    }

    #[test]
    fn a_turn_budget_beyond_the_runner_is_refused() {
        // A session cannot count turns — the server never sends an animate
        // budget here, and a job that asks for one is told so rather than
        // run unbounded
        assert!(parse_job(&job(json!({"maxTurns": 24}))).is_ok());
        assert!(parse_job(&job(json!({"maxTurns": 40}))).is_ok());
        assert_eq!(
            parse_job(&job(json!({"maxTurns": 200}))).unwrap_err(),
            "Turn budget beyond what this runner can enforce"
        );
    }

    #[test]
    fn versions_and_model_lists_parse() {
        assert_eq!(parse_version("devin 3000.12.57 (96542e930752)").as_deref(), Some("3000.12.57"));
        assert_eq!(parse_version("grok 1.0.77 (50ca579fa996) [stable]").as_deref(), Some("1.0.77"));
        assert_eq!(parse_version("nothing here"), None);
        let lines: Vec<String> = [
            "Available models (51 families)",
            "",
            "SWE-2 (swe-2)",
            "  aliases: swe",
            "  swe-2-high                         SWE-2 High  [262K context, Free]",
            "  swe-2-max                          SWE-2 Max  [262K context, Free]",
            "Claude Opus 5.5 (claude-opus-5.5)",
            "  claude-opus-5-5-low                Claude Opus 5.5 Low  [1M context]",
        ]
        .map(String::from)
        .to_vec();
        let models = parse_devin_models(&lines);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0], json!({"id": "swe-2-high", "name": "SWE-2 High", "family": "SWE-2"}));
        assert_eq!(models[2]["family"], "Claude Opus 5.5");
        let grok: Vec<String> = ["You are logged in with grok.com.", "", "Available models:", "  * grok-4.7 (default)", "  - grok-4.6"]
            .map(String::from)
            .to_vec();
        let (logged_in, models) = parse_grok_models(&grok);
        assert!(logged_in);
        assert_eq!(models, vec![json!({"id": "grok-4.7", "name": "grok-4.7", "default": true}), json!({"id": "grok-4.6", "name": "grok-4.6", "default": false})]);
        assert!(!parse_grok_models(&["You are not logged in.".to_string()]).0);
    }

    fn permission(kind: &str, title: &str) -> Value {
        json!({"sessionId": "s", "toolCall": {"toolCallId": "call_1", "kind": kind, "title": title},
            "options": [{"optionId": "yes", "kind": "allow_once", "name": "Allow"}, {"optionId": "always", "kind": "allow_always", "name": "Always"}, {"optionId": "no", "kind": "reject_once", "name": "Reject"}]})
    }

    #[test]
    fn permissions_allow_only_doop_tools() {
        let tools = vec!["create_frame".to_string(), "get_canvas".to_string()];
        let allowed = json!({"outcome": "selected", "optionId": "yes"});
        let rejected = json!({"outcome": "selected", "optionId": "no"});
        assert_eq!(permission_outcome(&permission("other", "mcp__doop__create_frame"), &tools, false), allowed);
        assert_eq!(permission_outcome(&permission("other", "doop/get_canvas"), &tools, false), allowed);
        assert_eq!(permission_outcome(&permission("execute", "create_frame && rm -rf ~"), &tools, false), rejected);
        assert_eq!(permission_outcome(&permission("edit", "Edit create_frame.ts"), &tools, false), rejected);
        assert_eq!(permission_outcome(&permission("other", "github/create_issue"), &tools, false), rejected);
        assert_eq!(permission_outcome(&permission("other", "create_frames_everywhere"), &tools, false), rejected);
        assert_eq!(permission_outcome(&permission("other", "github/create_frame"), &tools, false), rejected);
        assert_eq!(permission_outcome(&permission("other", "mcp__github__create_frame"), &tools, false), rejected);
        assert_eq!(permission_outcome(&permission("other", "Doop: create_frame"), &tools, false), allowed);
        assert_eq!(permission_outcome(&permission("other", "mcp__doop__create_frame"), &tools, true), json!({"outcome": "cancelled"}));
        let no_reject = json!({"toolCall": {"kind": "execute", "title": "ls"}, "options": [{"optionId": "yes", "kind": "allow_once"}]});
        assert_eq!(permission_outcome(&no_reject, &tools, false), json!({"outcome": "cancelled"}));
    }

    #[test]
    fn lines_are_bounded() {
        let mut reader = std::io::Cursor::new(b"{\"a\":1}\r\nnext".to_vec());
        assert_eq!(read_line(&mut reader, 100).unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(read_line(&mut reader, 100).unwrap().as_deref(), Some("next"));
        assert_eq!(read_line(&mut reader, 100).unwrap(), None);
        let mut long = std::io::Cursor::new(vec![b'x'; 200]);
        assert!(read_line(&mut long, 100).is_err());
    }

    /* A fake agent in plain sh: our request ids are 1 (initialize), 2
       (session/new) and 3 (session/prompt), so it can answer by line. What
       the client sends back is written to files for the test to read. */
    #[cfg(unix)]
    fn fake_agent(name: &str, body: &str) -> (PathBuf, Command) {
        let dir = std::env::temp_dir().join(format!("doop-acp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("agent.sh");
        std::fs::write(&script, format!("#!/bin/sh\nset -u\nsay() {{ printf '%s\\n' \"$1\"; }}\n{body}\n")).unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.arg(&script).env("OUT", &dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        (dir, cmd)
    }

    #[cfg(unix)]
    fn spec(dir: &Path) -> SessionSpec {
        SessionSpec {
            agent: Agent::Grok,
            cwd: dir.to_path_buf(),
            mcp_url: "https://doop.test/local-agent/mcp/run".into(),
            token: "t".repeat(64),
            prompt: "Design a card".into(),
            tools: vec!["create_frame".into()],
        }
    }

    /// Far above what a session against the fake agent takes (well under a
    /// second), far below the 20 s each one is given.
    #[cfg(unix)]
    const SESSION_LIMIT: Duration = Duration::from_secs(60);

    /* The agent's group is killed once it has exited, which is the common
       case: it answered and quit. procps' /bin/kill, handed a group whose
       only member is an unreaped zombie, signals the caller's own group, so
       the shell-out killed the test run (and the CI runner with it). The
       helper it left behind must die, and we must not. */
    #[cfg(unix)]
    #[test]
    fn an_exited_agent_is_killed_with_its_helpers_and_nothing_else() {
        within(SESSION_LIMIT, || {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "sleep 30 & echo started"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }
            let mut child = cmd.spawn().unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap());
            assert_eq!(read_line(&mut stdout, 100).unwrap().as_deref(), Some("started"));
            // the leader exits (left unreaped, a zombie) while `sleep` keeps stdout open
            std::thread::sleep(Duration::from_millis(300));
            kill_tree(&mut child);
            // the pipe closes only once the helper is gone
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(read_line(&mut stdout, 100));
            });
            assert_eq!(receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(), None);
        });
    }

    #[cfg(unix)]
    const HANDSHAKE: &str = r#"read -r l; say '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true}}}}'
read -r l; printf '%s\n' "$l" > "$OUT/new.json"; say '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}'
read -r l; printf '%s\n' "$l" > "$OUT/prompt.json""#;

    #[cfg(unix)]
    #[test]
    fn runs_a_session_against_a_fake_agent() {
        within(SESSION_LIMIT, || {
            let (dir, mut cmd) = fake_agent(
                "run",
                &format!(
                    r#"{HANDSHAKE}
say '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"Made "}}}}}}}}'
say '{{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{{"sessionId":"s1","toolCall":{{"toolCallId":"c1","kind":"other","title":"mcp__doop__create_frame"}},"options":[{{"optionId":"ok","kind":"allow_once"}},{{"optionId":"no","kind":"reject_once"}}]}}}}'
read -r l; printf '%s\n' "$l" > "$OUT/perm1.json"
say '{{"jsonrpc":"2.0","id":"p2","method":"session/request_permission","params":{{"sessionId":"s1","toolCall":{{"toolCallId":"c2","kind":"execute","title":"rm -rf /"}},"options":[{{"optionId":"ok","kind":"allow_once"}},{{"optionId":"no","kind":"reject_once"}}]}}}}'
read -r l; printf '%s\n' "$l" > "$OUT/perm2.json"
say '{{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{{"sessionId":"s1","path":"/etc/passwd"}}}}'
read -r l; printf '%s\n' "$l" > "$OUT/fs.json"
say '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"usage_update","used":10,"size":100,"cost":{{"amount":0.25,"currency":"USD"}}}}}}}}'
say '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"a card."}}}}}}}}'
say '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn","usage":{{"inputTokens":120,"outputTokens":30,"totalTokens":150}}}}}}'"#
                ),
            );
            let mut seen = String::new();
            let result = run_session(cmd.spawn().unwrap(), &spec(&dir), Arc::new(AtomicBool::new(false)), Duration::from_secs(20), |t| seen.push_str(t)).unwrap();
            assert_eq!(result["success"], true);
            assert_eq!(result["text"], "Made a card.");
            assert_eq!(seen, "Made a card.");
            assert_eq!(result["acpUsage"]["usage"]["inputTokens"], 120);
            assert_eq!(result["acpUsage"]["cost"]["amount"], 0.25);
            let read = |name: &str| serde_json::from_str::<Value>(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap();
            let new = read("new.json");
            assert_eq!(new["method"], "session/new");
            assert_eq!(new["params"]["mcpServers"][0]["url"], "https://doop.test/local-agent/mcp/run");
            assert_eq!(new["params"]["mcpServers"][0]["headers"][0]["value"], format!("Bearer {}", "t".repeat(64)));
            assert_eq!(read("prompt.json")["params"]["prompt"][0]["text"], "Design a card");
            assert_eq!(read("perm1.json"), json!({"jsonrpc": "2.0", "id": "p1", "result": {"outcome": {"outcome": "selected", "optionId": "ok"}}}));
            assert_eq!(read("perm2.json")["result"]["outcome"]["optionId"], "no");
            assert_eq!(read("fs.json")["error"]["code"], -32601);
            std::fs::remove_dir_all(dir).unwrap();
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_stop_sends_session_cancel() {
        within(SESSION_LIMIT, || {
            let (dir, mut cmd) = fake_agent(
                "cancel",
                &format!(
                    r#"{HANDSHAKE}
read -r l; printf '%s\n' "$l" > "$OUT/cancel.json"
say '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"cancelled"}}}}'"#
                ),
            );
            let cancel = Arc::new(AtomicBool::new(false));
            let flag = cancel.clone();
            let stopper = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                flag.store(true, Ordering::SeqCst);
            });
            let started = Instant::now();
            let result = run_session(cmd.spawn().unwrap(), &spec(&dir), cancel, Duration::from_secs(20), |_| {}).unwrap();
            stopper.join().unwrap();
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_eq!(result["success"], false);
            assert_eq!(result["stopReason"], "cancelled");
            let sent: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("cancel.json")).unwrap()).unwrap();
            assert_eq!(sent, json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s1"}}));
            std::fs::remove_dir_all(dir).unwrap();
        });
    }

    #[cfg(unix)]
    #[test]
    fn signed_out_and_unsupported_agents_say_what_to_do() {
        within(SESSION_LIMIT, || {
            let (dir, mut cmd) = fake_agent(
                "auth",
                r#"read -r l; say '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true}}}}'
read -r l; say '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}'"#,
            );
            let error = run_session(cmd.spawn().unwrap(), &spec(&dir), Arc::new(AtomicBool::new(false)), Duration::from_secs(20), |_| {}).unwrap_err();
            assert_eq!(error, "Grok is not signed in on this computer. Run `grok login` in your terminal, then Refresh.");
            std::fs::remove_dir_all(dir).unwrap();

            let (dir, mut cmd) = fake_agent(
                "nohttp",
                r#"read -r l; say '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}'"#,
            );
            let error = run_session(cmd.spawn().unwrap(), &spec(&dir), Arc::new(AtomicBool::new(false)), Duration::from_secs(20), |_| {}).unwrap_err();
            assert!(error.contains("no HTTP MCP support"), "{error}");
            std::fs::remove_dir_all(dir).unwrap();

            let (dir, mut cmd) = fake_agent("dies", "exit 3");
            let error = run_session(cmd.spawn().unwrap(), &spec(&dir), Arc::new(AtomicBool::new(false)), Duration::from_secs(20), |_| {}).unwrap_err();
            assert!(error.contains("exited") || error.contains("stopped reading"), "{error}");
            std::fs::remove_dir_all(dir).unwrap();
        });
    }
}
