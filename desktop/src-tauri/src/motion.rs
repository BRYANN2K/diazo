//! `motion_*` commands: a Motion Studio render on the desktop — the only
//! deterministic renderer in the MVP. A hidden webview loads the app's own
//! render page, the injected driver seeks the timeline frame by frame
//! (`window.__doopMotionSeek(t)` then `__doopMotionCapture()` → a png data
//! URL — the page implements both), posts each frame back through
//! `motion_render_frame`, and `motion_render_done` ends the capture. Rust
//! then encodes the PNGs with an `ffmpeg` it found itself — the login
//! shell's PATH and the fixed install prefixes, never a path or arguments
//! the page supplied — and answers the job's caller.
//!
//! Why the split: `eval` returns nothing, so frames and the end signal
//! arrive as invokes from the hidden page, exactly like live.rs's
//! snapshot. Those two commands are all the render window may invoke
//! (capabilities/motion-render.json); `motion_render` and
//! `motion_read_render` belong to the app window only (default.json).
//!
//! The URL is checked natively before any window exists: the active
//! server's own origin or loopback — a render is the app driving its own
//! page, never a page opening somewhere else. Keep `allowed_url` in step
//! with the render URL the app builds (src/lib/motionRender.ts).

use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

/// Progress events for the app window to listen on.
const PROGRESS_EVENT: &str = "motion-render://progress";
/// One render, start to finish, gets this long — a stall anywhere ends it
/// rather than holding a hidden webview forever.
const RENDER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45 * 60);
/// Bounds an individual frame's png payload reaching IPC.
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
/// The most frames one job may ask for (5 min at 60 fps is 18 000).
const MAX_FRAMES: u32 = 20_000;
/// The settle the driver gives the page after load before the first seek.
const SETTLE_MS: u32 = 800;

/// A render in flight, keyed by its hidden window's label. `done` is
/// `motion_render_done`'s way back to the await in `motion_render`.
struct RenderCtx {
    job: String,
    dir: PathBuf,
    total: u32,
    got: AtomicUsize,
    done: Mutex<Option<oneshot::Sender<Result<(), String>>>>,
}

#[derive(Default)]
pub struct MotionState(Mutex<HashMap<String, std::sync::Arc<RenderCtx>>>);

#[derive(Serialize)]
pub struct Rendered {
    path: String,
    bytes: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    job: String,
    phase: &'static str,
    done: usize,
    total: u32,
}

fn progress(app: &AppHandle, job: &str, phase: &'static str, done: usize, total: u32) {
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress { job: job.to_string(), phase, done, total },
    );
}

/* ------------------------------------------------------------------ */
/* validation — pure, and the unit tests hammer it                     */
/* ------------------------------------------------------------------ */

/// `[a-zA-Z0-9_-]`, short — the job id becomes a directory name.
fn valid_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// mp4 or webm — the only containers the encode step knows.
fn valid_format(format: &str) -> bool {
    matches!(format, "mp4" | "webm")
}

/// The page the timeline renders on must be the app's own: the server the
/// shell points at, or a loopback address a dev build serves from.
fn allowed_url(url: &tauri::Url, active: &tauri::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback()) {
        return true;
    }
    url.origin() == active.origin()
}

/// Encode geometry ffmpeg's yuv420p accepts; odd sizes pad rather than fail.
fn valid_size(px: u32) -> bool {
    (16..=8192).contains(&px)
}

/// Everything ffmpeg runs with. The only inputs the numbers are the job's;
/// every flag and every path is decided here. `dir` holds frame_%06d.png.
fn ffmpeg_args(format: &str, fps: u32, dir: &Path, out: &Path) -> Vec<String> {
    let input = dir.join("frame_%06d.png");
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-framerate".to_string(),
        fps.to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
        "-vf".to_string(),
        "pad=ceil(iw/2)*2:ceil(ih/2)*2".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-r".to_string(),
        fps.to_string(),
    ];
    if format == "webm" {
        args.extend(["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32"].map(String::from));
    } else {
        args.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart"].map(String::from));
    }
    args.push(out.to_string_lossy().into_owned());
    args
}

/// Every place an ffmpeg may be: the login shell's PATH first (where the
/// user installed it), the app's own PATH, then the fixed prefixes. First
/// hit wins; the name is fixed — a path is never taken from a caller.
fn ffmpeg_candidates(shell_path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for path in [shell_path.map(OsStr::to_os_string), std::env::var_os("PATH")]
        .into_iter()
        .flatten()
    {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .map(|dir| dir.join("ffmpeg"))
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

fn resolve_ffmpeg() -> Result<PathBuf, String> {
    let shell_path = crate::claude::login_shell_path(true);
    ffmpeg_candidates(shell_path.as_deref())
        .into_iter()
        .next()
        .ok_or_else(|| {
            "ffmpeg not found — install it (e.g. `brew install ffmpeg`) and the desktop render works".to_string()
        })
}

/// The job's scratch+output directory inside the app's renders folder.
fn render_dir(app: &AppHandle, job: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("renders");
    std::fs::create_dir_all(&base).map_err(|e| format!("could not create {}: {e}", base.display()))?;
    let dir = base.join(format!("{job}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The injected driver: seek, capture, post — one frame at a time, awaiting
/// each invoke so the page never outruns the disk. Any thrown error ends
/// the run through `motion_render_done`, which is also how a page without
/// the render harness fails fast instead of timing out.
const DRIVER_JS: &str = r#"(async function () {
  var post = function (cmd, payload) {
    return window.__TAURI_INTERNALS__.invoke(cmd, payload).catch(function () {});
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  try {
    await sleep(%SETTLE%);
    if (typeof window.__doopMotionSeek !== 'function' || typeof window.__doopMotionCapture !== 'function') {
      throw new Error('this page has no motion render harness (__doopMotionSeek/__doopMotionCapture)');
    }
    for (var i = 0; i < %FRAMES%; i++) {
      await window.__doopMotionSeek(i / %FPS%);
      var png = await window.__doopMotionCapture();
      await post('motion_render_frame', { i: i, png: png });
    }
    await post('motion_render_done', {});
  } catch (e) {
    await post('motion_render_done', { error: String(e && e.message ? e.message : e) });
  }
})();"#;

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/// Render `frames` frames of the timeline on `url` at `fps`, encode to
/// `format` under <appData>/renders/, and answer where it landed. The app
/// drives this per render job whose target is the desktop.
#[tauri::command]
pub async fn motion_render(
    app: AppHandle,
    state: State<'_, MotionState>,
    job_id: String,
    url: String,
    format: String,
    fps: u32,
    frames: u32,
    width: u32,
    height: u32,
) -> Result<Rendered, String> {
    /* every bound is re-proven natively — an invoke comes from a page */
    let job = job_id.trim().to_string();
    if !valid_job_id(&job) {
        return Err("job_id must be [a-zA-Z0-9_-], 1-64 chars".to_string());
    }
    if !valid_format(&format) {
        return Err("format must be mp4 or webm".to_string());
    }
    if fps == 0 || fps > 120 {
        return Err("fps must be in 1-120".to_string());
    }
    if frames == 0 || frames > MAX_FRAMES {
        return Err(format!("frames must be in 1-{MAX_FRAMES}"));
    }
    if !valid_size(width) || !valid_size(height) {
        return Err("width/height must be in 16-8192".to_string());
    }
    let target = tauri::Url::parse(url.trim()).map_err(|_| "not a URL".to_string())?;
    let active =
        tauri::Url::parse(crate::server::active(&app)).map_err(|_| "no active server".to_string())?;
    if !allowed_url(&target, &active) {
        return Err("a render only opens the app's own origin or a loopback URL".to_string());
    }

    let dir = render_dir(&app, &job)?;
    let label = format!("motion-render-{}", uuid::Uuid::new_v4());
    let (tx, rx) = oneshot::channel();
    let ctx = std::sync::Arc::new(RenderCtx {
        job: job.clone(),
        dir: dir.clone(),
        total: frames,
        got: AtomicUsize::new(0),
        done: Mutex::new(Some(tx)),
    });
    state.inner().0.lock().unwrap().insert(label.clone(), ctx.clone());

    let driver = DRIVER_JS
        .replace("%SETTLE%", &SETTLE_MS.to_string())
        .replace("%FRAMES%", &frames.to_string())
        .replace("%FPS%", &fps.to_string());
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
        .title("")
        .inner_size(f64::from(width), f64::from(height))
        .visible(false)
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(&driver);
            }
        })
        .build();
    let window = match window {
        Ok(w) => w,
        Err(e) => {
            state.inner().0.lock().unwrap().remove(&label);
            return Err(format!("couldn't open the render window: {e}"));
        }
    };

    let outcome = match tokio::time::timeout(RENDER_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the render window was closed".to_string()),
        Err(_) => Err("the render took too long".to_string()),
    };
    let _ = window.close();
    state.inner().0.lock().unwrap().remove(&label);
    outcome?;

    /* the frames are on disk: encode. ffmpeg resolves here, its args are
       built here, and nothing the page sent reaches either */
    progress(&app, &job, "encode", 0, frames);
    let ffmpeg = resolve_ffmpeg()?;
    let out = dir.join(format!("out.{format}"));
    let status = Command::new(&ffmpeg)
        .args(ffmpeg_args(&format, fps, &dir, &out))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("could not run {}: {e}", ffmpeg.display()))?;
    if !status.success() {
        return Err(format!("ffmpeg failed ({status})"));
    }
    let bytes = std::fs::metadata(&out).map_err(|e| format!("no output file: {e}"))?.len();
    /* the pngs have served; the video and an empty frames dir remain */
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("frame_")) {
            let _ = std::fs::remove_file(p);
        }
    }
    progress(&app, &job, "encode", frames as usize, frames);
    Ok(Rendered {
        path: out.to_string_lossy().into_owned(),
        bytes,
    })
}

/// One captured frame from the render page. Only the hidden window may
/// call it, and only while its job is registered — the frame number is
/// checked, the png is bounded, and the bytes land inside the job's dir.
#[tauri::command]
pub async fn motion_render_frame(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, MotionState>,
    i: u32,
    png: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let Some(ctx) = state.inner().0.lock().unwrap().get(&label).cloned() else {
        return Err("no render on this window".to_string());
    };
    if i >= ctx.total {
        return Err("frame index out of range".to_string());
    }
    let data = png
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "frame must be a png data URL".to_string())?;
    if data.len() > MAX_FRAME_BYTES * 2 {
        return Err("frame too large".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "frame is not base64".to_string())?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("frame too large".to_string());
    }
    let file = ctx.dir.join(format!("frame_{i:06}.png"));
    std::fs::write(&file, bytes).map_err(|e| format!("could not write frame: {e}"))?;
    let got = ctx.got.fetch_add(1, Ordering::SeqCst) + 1;
    progress(&app, &ctx.job, "capture", got, ctx.total);
    Ok(())
}

/// The driver's end signal: success, or the page's error. Unblocks the
/// `motion_render` awaiting this window's job.
#[tauri::command]
pub async fn motion_render_done(
    window: WebviewWindow,
    state: State<'_, MotionState>,
    error: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let ctx = state.inner().0.lock().unwrap().get(&label).cloned();
    let _ = window.close();
    if let Some(ctx) = ctx {
        if let Some(tx) = ctx.done.lock().unwrap().take() {
            let result = match error {
                Some(e) => Err(format!("the page reported: {e}")),
                None => {
                    if ctx.got.load(Ordering::SeqCst) >= ctx.total as usize {
                        Ok(())
                    } else {
                        Err(format!(
                            "the page stopped early ({}/{} frames)",
                            ctx.got.load(Ordering::SeqCst),
                            ctx.total
                        ))
                    }
                }
            };
            let _ = tx.send(result);
        }
    }
    Ok(())
}

/// The rendered file back to the page, as base64 — the path is proven to
/// sit inside <appData>/renders/ before a byte is read.
#[tauri::command]
pub async fn motion_read_render(app: AppHandle, path: String) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("renders");
    let base = std::fs::canonicalize(&base).unwrap_or(base);
    let file = std::fs::canonicalize(&path).map_err(|_| "no such render".to_string())?;
    if !file.starts_with(&base) {
        return Err("only files under the app's renders dir can be read".to_string());
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("could not read the render: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_ids() {
        for id in ["abc", "a-b_c-9", &"x".repeat(64)] {
            assert!(valid_job_id(id), "{id}");
        }
        for id in ["", "a/b", "a;b", "a b", "../x", "a.b", &"x".repeat(65), "å"] {
            assert!(!valid_job_id(id), "{id}");
        }
    }

    #[test]
    fn formats() {
        assert!(valid_format("mp4") && valid_format("webm"));
        for f in ["", "mov", "MP4", "mp4;rm"] {
            assert!(!valid_format(f), "{f}");
        }
    }

    #[test]
    fn urls() {
        let active = tauri::Url::parse("https://app.example.com").unwrap();
        let ok = |raw: &str| allowed_url(&tauri::Url::parse(raw).unwrap(), &active);
        assert!(ok("https://app.example.com/c/abc?render=1"));
        assert!(ok("https://app.example.com:443/x"));
        assert!(ok("http://localhost:4300/c/abc"));
        assert!(ok("http://dev.localhost:4300"));
        assert!(ok("http://127.0.0.1:8080"));
        for bad in [
            "https://evil.example.com/c/abc",
            "https://app.example.com.evil.com",
            "http://user:pw@app.example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://192.168.1.5",
        ] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[test]
    fn sizes() {
        for px in [16, 1920, 8192] {
            assert!(valid_size(px), "{px}");
        }
        for px in [0, 15, 8193] {
            assert!(!valid_size(px), "{px}");
        }
    }

    #[test]
    fn ffmpeg_command_line() {
        let dir = Path::new("/tmp/r");
        let out = Path::new("/tmp/r/out.mp4");
        let args = ffmpeg_args("mp4", 30, dir, out);
        let joined = args.join(" ");
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("frame_%06d.png"));
        assert!(joined.ends_with("/tmp/r/out.mp4"));
        /* nothing the page sent can inject a flag: args are discrete and
           the only variable parts are fps and paths built by us */
        let webm = ffmpeg_args("webm", 24, dir, out).join(" ");
        assert!(webm.contains("-c:v libvpx-vp9"));
        assert!(webm.contains("-framerate 24"));
        assert_eq!(ffmpeg_args("mp4", 30, dir, out).len(), args.len());
    }
}
