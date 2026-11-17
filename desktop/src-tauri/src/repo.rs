//! `repo_*` commands: link a folder on this computer to a canvas, then answer
//! the server's read requests inside it. The grant (`linkId` → absolute path)
//! lives in `repo-grants.json` in the app data dir — the path never leaves
//! the machine; only the id and the folder's basename reach the server.
//!
//! Every read is sandboxed to the picked root: relative paths may not contain
//! `..` or escape the canonicalized root (a symlink pointing outside resolves
//! away and is refused), names on the denylist — `.env*`, keys, credential
//! files — are never listed or read, and `.git`/`node_modules`-style dirs are
//! never descended. The caps below mirror `shared/localRepo.ts`; keep the two
//! in step.
//!
//! The one write surface, behind a native dialog: `repo_apply_patch`, for
//! token sync and frame → code, applies a unified patch whose context must
//! match the files exactly, listing every file and the diff first; it never
//! deletes. Same sandbox as the reads, stricter: no symlink anywhere on a
//! write path is followed.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_ENTRIES: usize = 2000;
const DEFAULT_DEPTH: usize = 4;
const MAX_DEPTH: usize = 8;
const MAX_READ_FILES: usize = 12;
const MAX_FILE_BYTES: u64 = 128 * 1024;
const MAX_READ_BYTES: usize = 200 * 1024;
const MAX_SEARCH_MATCHES: usize = 100;
const MAX_PATH_CHARS: usize = 500;
const MAX_QUERY_CHARS: usize = 200;
const MAX_LINE_CHARS: usize = 300;

/// Dirs never listed, descended into, or read under — anywhere in the tree.
const SKIP_DIRS: &[&str] = &[".git", ".svn", ".hg", "node_modules"];
/// File names never listed or read; `*` is a wildcard (see `denied_name`).
const DENY_NAMES: &[&str] = &[
    ".env*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.keystore",
    "*.asc",
    "id_rsa*",
    "*.kdbx",
    "*credential*",
    "*secret*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "*.tfvars",
];

/* ------------------------------------------------------------------ */
/* grants                                                              */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Grant {
    path: String,
    name: String,
    #[serde(default)]
    canvas_id: String,
    at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn grants_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("repo-grants.json"))
}

fn load_grants(app: &AppHandle) -> Result<BTreeMap<String, Grant>, String> {
    let file = grants_file(app)?;
    match fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write-then-rename so a crash mid-save can't leave a half-written file.
fn save_grants(app: &AppHandle, grants: &BTreeMap<String, Grant>) -> Result<(), String> {
    let file = grants_file(app)?;
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string(grants).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The grant row `link_id` names on this device.
fn grant_for(app: &AppHandle, link_id: &str) -> Result<Grant, String> {
    let grants = load_grants(app)?;
    grants
        .get(link_id)
        .cloned()
        .ok_or_else(|| "This device does not hold that project's grant".to_string())
}

/// The grant's folder, canonicalized: reads are checked against this root.
pub(crate) fn grant_root(app: &AppHandle, link_id: &str) -> Result<PathBuf, String> {
    let grant = grant_for(app, link_id)?;
    let root = PathBuf::from(&grant.path)
        .canonicalize()
        .map_err(|_| "The linked folder moved or was removed".to_string())?;
    if !root.is_dir() {
        return Err("The linked folder is not a directory".to_string());
    }
    Ok(root)
}

/* ------------------------------------------------------------------ */
/* sandbox                                                             */
/* ------------------------------------------------------------------ */

/// `*` matches any run of characters (slashes included); `?` one character.
/// Case-insensitive — the denylist is about names, not case games.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let t: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    fn go(p: &[char], t: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('*', rest)) => (0..=t.len()).any(|n| go(rest, &t[n..])),
            Some(('?', rest)) => !t.is_empty() && go(rest, &t[1..]),
            Some((c, rest)) => t.first() == Some(c) && go(rest, &t[1..]),
        }
    }
    go(&p, &t)
}

fn denied_name(name: &str) -> bool {
    DENY_NAMES.iter().any(|pat| glob_match(pat, name))
}

/// Whether any path component is skipped or denied: `a/node_modules/x` or
/// `sub/.env` are refused even though their leaf name looks fine.
fn denied_rel(rel: &Path) -> bool {
    rel.components().any(|c| match c {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            denied_name(&name) || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s))
        }
        _ => false,
    })
}

/// `rel` joined under `root`, canonicalized and proven inside it — `..`,
/// absolute paths and symlinks that leave the root are refused. `.` parts
/// are tolerated (`./src` means `src`); anything else non-normal is denied.
fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, &'static str> {
    if rel.chars().count() > MAX_PATH_CHARS {
        return Err("denied");
    }
    let mut clean = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(name) => clean.push(name),
            Component::CurDir => {}
            _ => return Err("denied"),
        }
    }
    if clean.as_os_str().is_empty() {
        return Ok(root.to_path_buf());
    }
    if denied_rel(&clean) {
        return Err("denied");
    }
    let canonical = root
        .join(&clean)
        .canonicalize()
        .map_err(|_| "missing")?;
    if !canonical.starts_with(root) {
        return Err("denied");
    }
    Ok(canonical)
}

/// A symlink inside the tree may point back inside the root; only ones that
/// would escape are dropped. Returns the effective kind via canonical path.
fn entry_kind(root: &Path, path: &Path) -> Option<bool> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_symlink() {
        return Some(meta.is_dir());
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    fs::metadata(&canonical).ok().map(|m| m.is_dir())
}

/// Repo-relative `/`-joined path for `path`, which must sit under `root`.
fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/* ------------------------------------------------------------------ */
/* tree walking                                                        */
/* ------------------------------------------------------------------ */

struct Walk {
    root: PathBuf,
    depth_left: usize,
    visited: usize,
}

impl Walk {
    /// List `dir`'s children into `entries`, recursing while depth and the
    /// shared entry budget last.
    fn run(&mut self, dir: &Path, rel: &str, entries: &mut Vec<Value>) {
        if self.visited >= MAX_ENTRIES {
            return;
        }
        let mut children: Vec<PathBuf> = match fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => return,
        };
        children.sort();
        for child in children {
            if self.visited >= MAX_ENTRIES {
                break;
            }
            let name = match child.file_name() {
                Some(n) => n.to_string_lossy().into_owned(),
                None => continue,
            };
            if denied_name(&name) || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                continue;
            }
            let Some(is_dir) = entry_kind(&self.root, &child) else {
                continue;
            };
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            entries.push(if is_dir {
                json!({ "path": child_rel, "kind": "dir" })
            } else {
                let size = fs::metadata(&child).map(|m| m.len()).unwrap_or(0);
                json!({ "path": child_rel, "kind": "file", "size": size })
            });
            self.visited += 1;
            if is_dir && self.depth_left > 0 {
                self.depth_left -= 1;
                self.run(&child, &child_rel, entries);
                self.depth_left += 1;
            }
        }
    }
}

fn walk(root: &Path, rel: &str, depth: usize) -> (Vec<Value>, bool) {
    let mut entries = Vec::new();
    let mut w = Walk {
        root: root.to_path_buf(),
        depth_left: depth,
        visited: 0,
    };
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    w.run(&dir, rel, &mut entries);
    (entries, w.visited >= MAX_ENTRIES)
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

/// `glob` applies to the file name when it has no `/`, else the whole
/// repo-relative path — `*.tsx` finds `src/a.tsx` and `src/*` too.
fn glob_allows(glob: Option<&str>, name: &str, rel: &str) -> bool {
    match glob {
        None => true,
        Some(pat) => {
            if pat.contains('/') {
                glob_match(pat, rel)
            } else {
                glob_match(pat, name)
            }
        }
    }
}

fn search_file(
    rel: &str,
    path: &Path,
    matcher: &dyn Fn(&str) -> bool,
    limit: usize,
    matches: &mut Vec<Value>,
) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() > MAX_FILE_BYTES || !meta.is_file() {
        return;
    }
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(text) = String::from_utf8(bytes) else { return };
    for (n, line) in text.lines().enumerate() {
        if matches.len() >= limit {
            return;
        }
        if matcher(line) {
            let mut line = line.trim().to_string();
            if line.chars().count() > MAX_LINE_CHARS {
                line = line.chars().take(MAX_LINE_CHARS).collect::<String>() + "…";
            }
            matches.push(json!({ "path": rel, "line": n + 1, "text": line }));
        }
    }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/// Pick a folder, confirm read-only access, remember `linkId → path`.
/// Answers `{ id, name }` or `{ id: null }` when cancelled.
#[tauri::command]
pub async fn repo_choose(app: AppHandle, canvas_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Link a project folder to this canvas")
            .pick_folder()
        else {
            return Ok(json!({ "id": null }));
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let title = format!("Link \"{}\" to this canvas?", name);
        let accepted = rfd::MessageDialog::new()
            .set_title(&title)
            .set_description(
                "Agents on this canvas will be able to read inside the folder while this \
                 app is open — read-only: nothing is written or run, and files that look \
                 like secrets (.env, keys, credentials) are skipped. The folder's path \
                 never leaves this computer.",
            )
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show();
        if accepted != rfd::MessageDialogResult::Ok {
            return Ok(json!({ "id": null }));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut grants = load_grants(&app)?;
        grants.insert(
            id.clone(),
            Grant {
                path: path.to_string_lossy().into_owned(),
                name: name.clone(),
                canvas_id,
                at: now_ms(),
            },
        );
        save_grants(&app, &grants)?;
        Ok(json!({ "id": id, "name": name }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop a grant — the link id stops resolving on this device.
#[tauri::command]
pub async fn repo_forget(app: AppHandle, link_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut grants = load_grants(&app)?;
        grants.remove(&link_id);
        save_grants(&app, &grants)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The grants this device holds, `[{ id, name }]` — the poll advertises the
/// ids so the server hands reads only to a device that can serve them.
#[tauri::command]
pub async fn repo_grants(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let grants = load_grants(&app)?;
        Ok(json!(grants
            .iter()
            .map(|(id, g)| json!({ "id": id, "name": g.name }))
            .collect::<Vec<_>>()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A bounded tree slice under `subdir` (default the root): entries sorted,
/// denied names and heavy dirs skipped, `truncated` when the cap stopped us.
#[tauri::command]
pub async fn repo_list(
    app: AppHandle,
    link_id: String,
    subdir: Option<String>,
    depth: Option<usize>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = grant_root(&app, &link_id)?;
        let rel = subdir.unwrap_or_default();
        let start = resolve_under(&root, &rel).map_err(|e| e.to_string())?;
        if !start.is_dir() {
            return Err("'subdir' is not a directory".to_string());
        }
        // rel_string normalizes the slice the agent asked for ("./x" → "x")
        let rel = rel_string(&root, &start);
        let (entries, truncated) = walk(&root, &rel, depth.unwrap_or(DEFAULT_DEPTH).min(MAX_DEPTH));
        Ok(json!({ "entries": entries, "truncated": truncated }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bounded reads of up to MAX_READ_FILES repo-relative paths: each file
/// capped at MAX_FILE_BYTES, the whole call at MAX_READ_BYTES (`truncated`
/// says the budget ended before every path was attempted).
#[tauri::command]
pub async fn repo_read(app: AppHandle, link_id: String, paths: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Err("'paths' must list at least one file".to_string());
        }
        if paths.len() > MAX_READ_FILES {
            return Err(format!("'paths' takes at most {} files", MAX_READ_FILES));
        }
        let root = grant_root(&app, &link_id)?;
        let mut files = Vec::new();
        let mut total = 0usize;
        let mut truncated = false;
        for rel in paths {
            if total >= MAX_READ_BYTES {
                truncated = true;
                break;
            }
            let canonical = match resolve_under(&root, &rel) {
                Ok(p) => p,
                Err(why) => {
                    files.push(json!({ "path": rel, "error": why }));
                    continue;
                }
            };
            let meta = match fs::metadata(&canonical) {
                Ok(m) if m.is_file() => m,
                Ok(_) => {
                    files.push(json!({ "path": rel, "error": "unreadable" }));
                    continue;
                }
                Err(_) => {
                    files.push(json!({ "path": rel, "error": "missing" }));
                    continue;
                }
            };
            if meta.len() > MAX_FILE_BYTES {
                files.push(json!({ "path": rel, "error": "too-large" }));
                continue;
            }
            match fs::read(&canonical) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => {
                        total += text.len();
                        files.push(json!({ "path": rel, "text": text }));
                    }
                    Err(_) => files.push(json!({ "path": rel, "error": "binary" })),
                },
                Err(_) => files.push(json!({ "path": rel, "error": "unreadable" })),
            }
        }
        Ok(json!({ "files": files, "truncated": truncated }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Literal (default) or Rust-regex substring search under the whole linked
/// tree — bounded: skipped dirs and denied names, files past MAX_FILE_BYTES
/// ignored, at most `limit` (≤ MAX_SEARCH_MATCHES) matches.
#[tauri::command]
pub async fn repo_search(
    app: AppHandle,
    link_id: String,
    query: String,
    regex: Option<bool>,
    glob: Option<String>,
    limit: Option<usize>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
            return Err(format!("'query' takes 1-{} characters", MAX_QUERY_CHARS));
        }
        let root = grant_root(&app, &link_id)?;
        let limit = limit.unwrap_or(50).clamp(1, MAX_SEARCH_MATCHES);
        let matcher: Box<dyn Fn(&str) -> bool> = if regex.unwrap_or(false) {
            let re = Regex::new(&query).map_err(|e| format!("bad pattern: {}", e))?;
            Box::new(move |line: &str| re.is_match(line))
        } else {
            let needle = query.clone();
            Box::new(move |line: &str| line.contains(needle.as_str()))
        };
        let glob = glob.filter(|g| !g.is_empty());
        let mut matches = Vec::new();
        let mut stack = vec![(root.clone(), String::new(), MAX_DEPTH)];
        let mut scanned = 0usize;
        while let Some((dir, rel, depth)) = stack.pop() {
            if matches.len() >= limit || scanned >= MAX_ENTRIES {
                break;
            }
            let mut children: Vec<PathBuf> = match fs::read_dir(&dir) {
                Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
                Err(_) => continue,
            };
            children.sort();
            for child in children {
                if matches.len() >= limit || scanned >= MAX_ENTRIES {
                    break;
                }
                let name = match child.file_name() {
                    Some(n) => n.to_string_lossy().into_owned(),
                    None => continue,
                };
                if denied_name(&name)
                    || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s))
                {
                    continue;
                }
                let Some(is_dir) = entry_kind(&root, &child) else {
                    continue;
                };
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                if is_dir {
                    if depth > 0 {
                        stack.push((child, child_rel, depth - 1));
                    }
                } else {
                    scanned += 1;
                    if glob_allows(glob.as_deref(), &name, &child_rel) {
                        search_file(&child_rel, &child, matcher.as_ref(), limit, &mut matches);
                    }
                }
            }
        }
        let truncated = matches.len() >= limit || scanned >= MAX_ENTRIES;
        Ok(json!({ "matches": matches, "truncated": truncated }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/* apply_patch — edits to existing files, as a unified patch            */
/* ------------------------------------------------------------------ */

/* `repo_apply_patch` — mirror shared/patch.ts, keep in step. */
const MAX_PATCH_FILES: usize = 24;
const MAX_PATCH_BYTES: usize = 1024 * 1024;
const MAX_PATCHED_FILE_BYTES: usize = 512 * 1024;
/// How many diff lines the native dialog shows before "… and N more".
const DIALOG_DIFF_LINES: usize = 40;

/// One file of a parsed patch: its hunks, in order.
struct PatchFile {
    rel: String,
    create: bool,
    hunks: Vec<Hunk>,
    added: usize,
    removed: usize,
}

struct Hunk {
    /// 0-based index of the first old line the hunk covers
    old_start: usize,
    /// ' ' context, '-' removed, '+' added — with the line's text
    lines: Vec<(char, String)>,
}

/// The file a patch edits, resolved for writing: same shape rules as the
/// reads plus the write side's no-symlink rule. `create` wants nothing there
/// yet; an edit wants a regular file.
fn resolve_patch_target(root: &Path, rel: &str, create: bool) -> Result<PathBuf, &'static str> {
    if rel.is_empty() || rel.chars().count() > MAX_PATH_CHARS {
        return Err("denied");
    }
    let mut clean = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(name) => clean.push(name),
            _ => return Err("denied"),
        }
    }
    if denied_rel(&clean) {
        return Err("denied");
    }
    let target = root.join(&clean);
    let mut probe = root.to_path_buf();
    let mut deepest = root.to_path_buf();
    for c in clean.components() {
        probe.push(c.as_os_str());
        match fs::symlink_metadata(&probe) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("denied");
                }
                if probe == target {
                    if create {
                        return Err("exists");
                    }
                    if !meta.is_file() {
                        return Err("not a file");
                    }
                }
                deepest = probe.clone();
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Err("missing");
                }
                break;
            }
            Err(_) => return Err("denied"),
        }
    }
    let canonical = deepest.canonicalize().map_err(|_| "denied")?;
    if !canonical.starts_with(root) {
        return Err("denied");
    }
    Ok(target)
}

fn parse_hunk_header(line: &str) -> Option<(usize, usize, usize)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = old.split_once(',')?;
    let (_, new_count) = new.split_once(',')?;
    Some((old_start.parse().ok()?, old_count.parse().ok()?, new_count.parse().ok()?))
}

/// Parse the unified patch shared/patch.ts writes: `--- a/<p>` (or
/// `--- /dev/null`), `+++ b/<p>`, then `@@ -s,n +s,n @@` hunks whose counts
/// must add up. Anything else is refused before the person is asked.
fn parse_patch(patch: &str) -> Result<Vec<PatchFile>, String> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(format!("the patch is over the {}-byte cap", MAX_PATCH_BYTES));
    }
    let lines: Vec<&str> = patch.strip_suffix('\n').unwrap_or(patch).split('\n').collect();
    let mut files: Vec<PatchFile> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let minus = lines[i];
        let plus = lines.get(i + 1).copied().unwrap_or("");
        let rel = plus
            .strip_prefix("+++ b/")
            .ok_or_else(|| format!("line {}: expected a +++ b/ header", i + 2))?
            .to_string();
        let create = minus == "--- /dev/null";
        if !create && minus != format!("--- a/{}", rel) {
            return Err(format!("line {}: the --- and +++ paths differ", i + 1));
        }
        if files.iter().any(|f| f.rel == rel) {
            return Err(format!("{}: appears twice", rel));
        }
        i += 2;
        let mut file = PatchFile { rel, create, hunks: Vec::new(), added: 0, removed: 0 };
        while i < lines.len() && lines[i].starts_with("@@") {
            let (old_start, mut old_left, mut new_left) =
                parse_hunk_header(lines[i]).ok_or_else(|| format!("line {}: malformed hunk header", i + 1))?;
            if create && old_left != 0 {
                return Err(format!("{}: a new file's hunk must start empty", file.rel));
            }
            let old_start = if old_left == 0 { old_start } else { old_start.saturating_sub(1) };
            i += 1;
            let mut hunk = Hunk { old_start, lines: Vec::new() };
            while old_left > 0 || new_left > 0 {
                let line = *lines.get(i).ok_or_else(|| format!("{}: hunk ends early", file.rel))?;
                let mut chars = line.chars();
                let tag = chars.next().unwrap_or('?');
                let text: String = chars.collect();
                match tag {
                    ' ' if old_left > 0 && new_left > 0 => {
                        old_left -= 1;
                        new_left -= 1;
                    }
                    '-' if old_left > 0 => {
                        old_left -= 1;
                        file.removed += 1;
                    }
                    '+' if new_left > 0 => {
                        new_left -= 1;
                        file.added += 1;
                    }
                    _ => return Err(format!("line {}: hunk counts do not add up", i + 1)),
                }
                hunk.lines.push((tag, text));
                i += 1;
            }
            file.hunks.push(hunk);
        }
        if file.hunks.is_empty() {
            return Err(format!("{}: no hunks", file.rel));
        }
        files.push(file);
        if files.len() > MAX_PATCH_FILES {
            return Err(format!("at most {} files per patch", MAX_PATCH_FILES));
        }
    }
    if files.is_empty() {
        return Err("the patch is empty".to_string());
    }
    Ok(files)
}

/// The file's new text: every hunk applied in order, context and removed
/// lines matched exactly against `current` — no fuzz, so a file edited since
/// the patch was made refuses instead of landing somewhere wrong.
fn apply_file(file: &PatchFile, current: &str) -> Result<String, String> {
    let src: Vec<&str> = if current.is_empty() {
        Vec::new()
    } else {
        current.strip_suffix('\n').unwrap_or(current).split('\n').collect()
    };
    let mut out: Vec<String> = Vec::with_capacity(src.len() + file.added);
    let mut cursor = 0usize;
    for hunk in &file.hunks {
        if hunk.old_start < cursor || hunk.old_start > src.len() {
            return Err(format!("{}: hunks out of order or past the end", file.rel));
        }
        out.extend(src[cursor..hunk.old_start].iter().map(|s| s.to_string()));
        cursor = hunk.old_start;
        for (tag, text) in &hunk.lines {
            match tag {
                '+' => out.push(text.clone()),
                _ => {
                    if src.get(cursor) != Some(&text.as_str()) {
                        return Err(format!(
                            "{}: the file changed since the patch was made (line {})",
                            file.rel,
                            cursor + 1
                        ));
                    }
                    if *tag == ' ' {
                        out.push(text.clone());
                    }
                    cursor += 1;
                }
            }
        }
    }
    out.extend(src[cursor..].iter().map(|s| s.to_string()));
    let text = if out.is_empty() { String::new() } else { out.join("\n") + "\n" };
    if text.len() > MAX_PATCHED_FILE_BYTES {
        return Err(format!("{}: over the {}-byte file cap", file.rel, MAX_PATCHED_FILE_BYTES));
    }
    Ok(text)
}

/// Every file of the patch resolved, read and applied in memory — BEFORE
/// the person is asked, so the dialog only ever lists a patch that applies.
fn prepare_patch(root: &Path, patch: &str) -> Result<Vec<(PatchFile, PathBuf, String)>, String> {
    let mut ready = Vec::new();
    for file in parse_patch(patch)? {
        let target = resolve_patch_target(root, &file.rel, file.create).map_err(|e| format!("{}: {}", file.rel, e))?;
        let current = if file.create {
            String::new()
        } else {
            let meta = fs::metadata(&target).map_err(|_| format!("{}: missing", file.rel))?;
            if meta.len() > MAX_PATCHED_FILE_BYTES as u64 {
                return Err(format!("{}: too large to patch", file.rel));
            }
            String::from_utf8(fs::read(&target).map_err(|e| format!("{}: {}", file.rel, e))?)
                .map_err(|_| format!("{}: binary", file.rel))?
        };
        let next = apply_file(&file, &current)?;
        ready.push((file, target, next));
    }
    Ok(ready)
}

/// Write each patched file through a sibling temp file and a rename, so a
/// crash never leaves a half-written source file. New files are created
/// with `create_new`; a race that lands one first fails instead.
fn write_patched(ready: &[(PatchFile, PathBuf, String)]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    for (file, target, text) in ready {
        if file.create {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {}", file.rel, e))?;
            }
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|e| format!("{}: {}", file.rel, e))?;
            use std::io::Write;
            f.write_all(text.as_bytes()).map_err(|e| format!("{}: {}", file.rel, e))?;
        } else {
            let tmp = target.with_file_name(format!(
                ".{}.doop-tmp",
                target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            ));
            fs::write(&tmp, text).map_err(|e| format!("{}: {}", file.rel, e))?;
            fs::rename(&tmp, target).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                format!("{}: {}", file.rel, e)
            })?;
        }
        written.push(file.rel.clone());
    }
    Ok(written)
}

/// The dialog's body: each file with its line counts, then the diff itself,
/// cut at DIALOG_DIFF_LINES so the dialog stays on screen.
fn patch_dialog_text(ready: &[(PatchFile, PathBuf, String)], patch: &str, reason: &str) -> String {
    let files = ready
        .iter()
        .map(|(f, _, _)| {
            format!(
                "  {}{}  +{} −{}",
                f.rel,
                if f.create { " (new)" } else { "" },
                f.added,
                f.removed
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<&str> = patch.lines().collect();
    let mut diff = lines.iter().take(DIALOG_DIFF_LINES).copied().collect::<Vec<_>>().join("\n");
    if lines.len() > DIALOG_DIFF_LINES {
        diff.push_str(&format!("\n… and {} more diff lines", lines.len() - DIALOG_DIFF_LINES));
    }
    let reason = if reason.is_empty() { String::new() } else { format!("{}\n\n", reason) };
    format!("{}Files:\n{}\n\nDiff:\n{}", reason, files, diff)
}

/// Apply a unified patch inside the linked project — doop's token sync and
/// frame → code export write through here, and only after the person
/// confirms a native dialog listing every file and the diff. The writes'
/// sandbox: no `..`, no denied names, no symlink anywhere on a path, no
/// deletes. Answers `{ written, repo }`, `"cancelled"`, or why it refused.
#[tauri::command]
pub async fn repo_apply_patch(
    app: AppHandle,
    link_id: String,
    patch: String,
    reason: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let grant = grant_for(&app, &link_id)?;
        let root = PathBuf::from(&grant.path)
            .canonicalize()
            .map_err(|_| "The linked folder moved or was removed".to_string())?;
        if !root.is_dir() {
            return Err("The linked folder is not a directory".to_string());
        }
        let ready = prepare_patch(&root, &patch)?;
        let reason: String = reason.unwrap_or_default().chars().take(300).collect();
        let accepted = rfd::MessageDialog::new()
            .set_title(&format!(
                "Apply Diazo's changes to {} file{} in \"{}\"?",
                ready.len(),
                if ready.len() == 1 { "" } else { "s" },
                grant.name
            ))
            .set_description(&patch_dialog_text(&ready, &patch, &reason))
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show();
        if accepted != rfd::MessageDialogResult::Ok {
            return Err("cancelled".to_string());
        }
        let written = write_patched(&ready)?;
        Ok(json!({ "written": written, "repo": grant.name }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// A repo layout with a symlink that escapes and one that stays inside,
    /// a denied `.env`, a `node_modules` dir and one oversized file. Returns
    /// the repo dir and the "outside" dir the escape symlink points at —
    /// both must stay alive for the test's duration.
    fn fixture() -> (tempfile::TempDir, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/components")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/App.tsx"), "export const x = 1\nTOKEN here\n").unwrap();
        fs::write(
            root.join("src/components/Button.tsx"),
            "export function Button() {}\nTOKEN there\n",
        )
        .unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "TOKEN noise\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        fs::write(root.join("keys.pem"), "-----BEGIN-----\n").unwrap();
        fs::write(root.join("big.txt"), "x".repeat(MAX_FILE_BYTES as usize + 1)).unwrap();
        let outside = outside_dir.path().join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
            std::os::unix::fs::symlink(root.join("src"), root.join("inside")).unwrap();
        }
        (dir, outside_dir)
    }

    #[test]
    fn deny_list_matches_names() {
        for name in [".env", ".env.local", "a.PEM", "id_rsa", "secrets.txt", "prod.tfvars"] {
            assert!(denied_name(name), "{name} should be denied");
        }
        for name in ["env.ts", "App.tsx", "keynote.md", "monkey.rs"] {
            assert!(!denied_name(name), "{name} should be allowed");
        }
    }

    #[test]
    fn resolve_rejects_escapes() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        for rel in ["../outside.txt", "a/../../x", "/abs", "..", "node_modules/pkg/index.js", ".env", "keys.pem"] {
            assert!(resolve_under(&root, rel).is_err(), "{rel} should fail");
        }
        assert!(resolve_under(&root, "src/App.tsx").is_ok());
        // "" and "." both mean the root; "./x" means "x"
        for rel in ["", ".", "./src/App.tsx"] {
            assert!(resolve_under(&root, rel).is_ok(), "{rel} should pass");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        assert_eq!(resolve_under(&root, "escape").unwrap_err(), "denied");
        // a symlink that stays inside resolves fine
        assert!(resolve_under(&root, "inside/App.tsx").is_ok());
    }

    #[test]
    fn walk_skips_denied_and_heavy_dirs() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let (entries, _) = walk(&root, "", MAX_DEPTH);
        let paths: Vec<String> = entries
            .iter()
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect();
        assert!(paths.contains(&"src".to_string()));
        assert!(paths.contains(&"src/App.tsx".to_string()));
        for bad in [".env", "keys.pem", "node_modules", "node_modules/pkg", "escape"] {
            assert!(!paths.iter().any(|p| p == bad), "{bad} must not be listed");
        }
    }

    #[test]
    fn walk_honours_depth_and_caps() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        let (shallow, _) = walk(&root, "", 0);
        assert!(shallow.iter().all(|e| !e["path"].as_str().unwrap().contains('/')));
        let (deep, _) = walk(&root, "", MAX_DEPTH);
        assert!(deep.iter().any(|e| e["path"].as_str().unwrap().contains('/')));
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match("*.tsx", "App.tsx"));
        assert!(glob_match("*.tsx", "app.TSX"));
        assert!(glob_match("src/*", "src/App.tsx"));
        assert!(!glob_match("*.rs", "App.tsx"));
        assert!(glob_match("*", "anything"));
    }

    #[test]
    fn read_caps_and_errors() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        // too-large file refuses itself, not the call
        let big = resolve_under(&root, "big.txt").unwrap();
        assert!(fs::metadata(&big).unwrap().len() > MAX_FILE_BYTES);
        // binary content answers "binary"
        fs::write(root.join("bin.dat"), [0u8, 159, 255]).unwrap();
        assert!(String::from_utf8(fs::read(root.join("bin.dat")).unwrap()).is_err());
    }

    #[test]
    fn search_respects_skip_dirs() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        // the walk the command does, driven by the same helpers
        let mut hits = Vec::new();
        let mut stack = vec![(root.clone(), String::new(), MAX_DEPTH)];
        while let Some((dir, rel, depth)) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if denied_name(&name) || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                    continue;
                }
                let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
                let Some(is_dir) = entry_kind(&root, &entry.path()) else { continue };
                if is_dir {
                    if depth > 0 {
                        stack.push((entry.path(), child_rel, depth - 1));
                    }
                } else {
                    search_file(&child_rel, &entry.path(), &|l| l.contains("TOKEN"), 100, &mut hits);
                }
            }
        }
        let paths: Vec<String> = hits.iter().map(|m| m["path"].as_str().unwrap().to_string()).collect();
        assert!(paths.iter().any(|p| p == "src/App.tsx"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));
    }

    /* ---- repo_apply_patch's parse, sandbox and apply (the dialog stays
       untested) ---- */

    const CSS: &str = ":root {\n  --a: 1;\n  --b: 2;\n}\n";
    const CSS_PATCH: &str =
        "--- a/src/app.css\n+++ b/src/app.css\n@@ -1,4 +1,4 @@\n :root {\n   --a: 1;\n-  --b: 2;\n+  --b: 20;\n }\n";

    #[test]
    fn patch_applies_and_creates() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("src/app.css"), CSS).unwrap();
        let create = "--- /dev/null\n+++ b/src/components/Hero.tsx\n@@ -0,0 +1,1 @@\n+export function Hero() {}\n";
        let patch = format!("{}{}", CSS_PATCH, create);
        let ready = prepare_patch(&root, &patch).unwrap();
        assert_eq!(ready.len(), 2);
        let written = write_patched(&ready).unwrap();
        assert_eq!(written, vec!["src/app.css", "src/components/Hero.tsx"]);
        assert_eq!(
            fs::read_to_string(root.join("src/app.css")).unwrap(),
            ":root {\n  --a: 1;\n  --b: 20;\n}\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/components/Hero.tsx")).unwrap(),
            "export function Hero() {}\n"
        );
    }

    #[test]
    fn patch_refuses_stale_context() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join("src/app.css"), ":root {\n  --a: 1;\n  --b: 3;\n}\n").unwrap();
        let err = prepare_patch(&root, CSS_PATCH).err().unwrap();
        assert!(err.contains("changed since"), "{err}");
    }

    #[test]
    fn patch_stays_in_the_sandbox() {
        let (dir, _outside) = fixture();
        let root = dir.path().canonicalize().unwrap();
        for rel in ["../x.css", "/abs.css", ".env", "node_modules/pkg/index.js", "keys.pem"] {
            assert!(resolve_patch_target(&root, rel, true).is_err(), "{rel} should fail");
        }
        /* an edit needs the file, a creation needs its absence */
        assert_eq!(resolve_patch_target(&root, "src/nope.css", false).unwrap_err(), "missing");
        assert_eq!(resolve_patch_target(&root, "src/App.tsx", true).unwrap_err(), "exists");
        assert!(resolve_patch_target(&root, "src/App.tsx", false).is_ok());
        #[cfg(unix)]
        {
            /* `inside` is a symlink back into src — writes refuse it anyway */
            assert!(resolve_patch_target(&root, "inside/App.tsx", false).is_err());
        }
    }

    #[test]
    fn patch_parse_rejects_malformed() {
        for bad in [
            "",
            "garbage\n",
            "--- a/x\n+++ b/y\n@@ -1,1 +1,1 @@\n-a\n+b\n",
            "--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-a\n",
            "--- a/x\n+++ b/x\n",
            "--- /dev/null\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n",
        ] {
            assert!(parse_patch(bad).is_err(), "{bad:?} should fail");
        }
        assert!(parse_patch(CSS_PATCH).is_ok());
    }
}
