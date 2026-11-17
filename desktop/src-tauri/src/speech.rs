//! Local speech engines: one-click install of catalog model files from the
//! signed GitHub mirror or a pinned Hugging Face commit into Application
//! Support, SHA-256 and manifest-signature verification, resumable
//! downloads, and an allowlisted `diazo-speech` sidecar binary that turns
//! a claimed job's audio into a transcript, a voice-over, or a speaker map.
//!
//! Every bound is re-proven natively: the commands are reached over
//! `invoke` from a page, so ids, paths and engine names are validated here
//! even though the server already validated them.

use {
    serde::{Deserialize, Serialize},
    serde_json::{json, Value},
    std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::Mutex,
    },
    tauri::{AppHandle, Manager, State},
};

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/* The install contract is fixed once in `shared/speech.ts`'s SPEECH_LIMITS
   and mirrored here — tests/speechContract.test.ts holds the two equal. */
/// A single model file may be up to 4 GiB (large ASR weights).
const MAX_FILE_BYTES: u64 = 4 << 30;
/// ...one model in total is bounded too (weights + configs + tokens).
const MAX_MODEL_BYTES: u64 = 8 << 30;
/// A catalog row lists files, not a whole repo.
const MAX_FILES: usize = 64;
/// The signed manifest is small; a larger one is rejected outright.
const MAX_MANIFEST_BYTES: u64 = 1 << 20;
/// A model id / engine / file name is a short slug, never a path.
const MAX_NAME: usize = 128;
/// A job's input or output file riding the audio-in/audio-out commands.
const MAX_JOB_FILE_BYTES: usize = 256 << 20;
/// A multi-gigabyte download may run for hours: these bound the handshake,
/// a stall between chunks, and the small whole-body fetches — never the
/// transfer itself.
const HTTP_CONNECT_SECS: u64 = 30;
const HTTP_IDLE_SECS: u64 = 60;
const HTTP_FETCH_SECS: u64 = 120;
const ENGINE_TIMEOUT_SECS: u64 = 3600;

/// The Hugging Face repos the bundled catalog (shared/speech.ts) may
/// install from without asking — every other repo is a custom model and
/// gets the native confirmation before a byte downloads.
const HF_CATALOG_REPOS: &[&str] = &[
    "sherpa-onnx/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    "ggerganov/whisper.cpp",
    "mlx-community/VoxCPM2-8bit",
    "mlx-community/Qwen3-TTS-1.7B-8bit",
    "mlx-community/Ming-3.0-TTS-8bit",
    "Qwen/Qwen3-TTS-0.6B-GGUF",
    "sherpa-onnx/kokoro-en-v0_19",
    "sherpa-onnx/sherpa-onnx-pyannote-segmentation-3-0",
];

/// The release signature public key — the updater's minisign key
/// (B1375F7E88B8FC72), so speech mirrors are signed by the same release key
/// the desktop already trusts. Last 32 bytes of the decoded blob.
const RELEASE_PUBKEY_B64: &str = "RWRy/LiIfl83sfc5VX2Lcbc/h0yJSSMxY1t+J2taPwzdQB0kcvXgPa4L";

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

/// Model ids whose install is in flight right now.
#[derive(Default)]
pub struct SpeechState {
    installing: Mutex<Vec<String>>,
}

/* ------------------------------------------------------------------ */
/* installed manifest                                                  */
/* ------------------------------------------------------------------ */

/// One verified file that landed under a model's directory.
#[derive(Serialize, Deserialize, Clone)]
struct InstalledFile {
    name: String,
    size: u64,
    sha256: String,
}

/// What `installed.json` records for one model.
#[derive(Serialize, Deserialize)]
struct InstalledModel {
    engine: String,
    state: String,
    files: Vec<InstalledFile>,
}

fn speech_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("speech");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(speech_root(app)?.join("installed.json"))
}

fn load_manifest(app: &AppHandle) -> Result<BTreeMap<String, InstalledModel>, String> {
    let path = manifest_path(app)?;
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_slice(&bytes).map_err(|e| format!("installed.json is corrupt: {e}"))
}

fn save_manifest(app: &AppHandle, map: &BTreeMap<String, InstalledModel>) -> Result<(), String> {
    let path = manifest_path(app)?;
    let bytes =
        serde_json::to_vec_pretty(map).map_err(|e| format!("could not encode manifest: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/// Model ids, engines, runtimes, job ids: `[a-zA-Z0-9._-]+`.
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_NAME
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A file name inside a model dir: one component, no separators, no dots-only.
fn valid_file_name(s: &str) -> bool {
    valid_name(s) && s != "." && s != ".." && !s.starts_with('.')
}

fn valid_hash(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/* ------------------------------------------------------------------ */
/* hashing + signature                                                 */
/* ------------------------------------------------------------------ */

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    hex(digest.as_ref())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hash a file without holding it in memory.
fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(hex(ctx.finish().as_ref()))
}

/* -- BLAKE2b-512 (RFC 7693): the minisign "ED" prehash ----------------- */

const BLAKE2B_IV: [u64; 8] = [
    0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
    0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
];

const BLAKE2B_SIGMA: [[usize; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

fn blake2b_g(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}

fn blake2b_compress(h: &mut [u64; 8], block: &[u8; 128], t: u128, last: bool) {
    let mut m = [0u64; 16];
    for (i, w) in m.iter_mut().enumerate() {
        *w = u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().unwrap());
    }
    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&BLAKE2B_IV);
    v[12] ^= t as u64;
    v[13] ^= (t >> 64) as u64;
    if last {
        v[14] = !v[14];
    }
    for round in 0..12 {
        let s = &BLAKE2B_SIGMA[round % 10];
        blake2b_g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        blake2b_g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        blake2b_g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        blake2b_g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        blake2b_g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        blake2b_g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        blake2b_g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        blake2b_g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

fn blake2b512(data: &[u8]) -> [u8; 64] {
    let mut h = BLAKE2B_IV;
    h[0] ^= 0x0101_0000 | 64; // digest 64, fanout 1, depth 1
    if data.is_empty() {
        blake2b_compress(&mut h, &[0; 128], 0, true);
    } else {
        let mut t = 0u128;
        let mut chunks = data.chunks(128).peekable();
        while let Some(chunk) = chunks.next() {
            let mut block = [0u8; 128];
            block[..chunk.len()].copy_from_slice(chunk);
            t += chunk.len() as u128;
            blake2b_compress(&mut h, &block, t, chunks.peek().is_none());
        }
    }
    let mut out = [0u8; 64];
    for (i, w) in h.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&w.to_le_bytes());
    }
    out
}

/* -- minisign --------------------------------------------------------- */

fn release_pubkey() -> Result<[u8; 32], String> {
    use base64::Engine;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(RELEASE_PUBKEY_B64)
        .map_err(|e| format!("release pubkey is not base64: {e}"))?;
    if blob.len() < 32 {
        return Err("release pubkey blob is too short".to_string());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&blob[blob.len() - 32..]);
    Ok(key)
}

/// Parse a `.minisig` file: `untrusted comment` line, then a base64 blob of
/// `alg(2) || keynum(8) || signature(64)`. Returns (prehashed, signature).
fn parse_minisig(text: &str) -> Result<(bool, [u8; 64]), String> {
    use base64::Engine;
    let line = text
        .lines()
        .nth(1)
        .ok_or_else(|| "minisig has no signature line".to_string())?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(line.trim())
        .map_err(|e| format!("minisig is not base64: {e}"))?;
    if blob.len() != 74 {
        return Err(format!("minisig blob is {} bytes, expected 74", blob.len()));
    }
    let prehashed = match &blob[..2] {
        b"ED" => true,
        b"Ed" => false,
        other => return Err(format!("minisig alg {:?} is not Ed25519", other)),
    };
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&blob[10..]);
    Ok((prehashed, sig))
}

/// Check `data` against its `.minisig` text with the release key. "ED" signs
/// the Blake2b-512 prehash, "Ed" the raw bytes.
fn verify_minisig(data: &[u8], minisig: &str) -> Result<(), String> {
    let (prehashed, sig) = parse_minisig(minisig)?;
    let key = release_pubkey()?;
    let message = if prehashed {
        blake2b512(data).to_vec()
    } else {
        data.to_vec()
    };
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key)
        .verify(&message, &sig)
        .map_err(|_| "SHA256SUMS.minisig does not verify against the release key".to_string())
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

/// The GitHub repo whose releases carry the mirror (and the engines):
/// the same `BRYANN2K/diazo` the updater's feed lives on.
const MIRROR_REPO: &str = "BRYANN2K/diazo";

/// The `source` part of a `shared/speech.ts` `CatalogEntry` — same shapes,
/// same names.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SpeechSource {
    /// The GitHub mirror release `speech-models-v*`: `SHA256SUMS(.minisig)`
    /// + the weight files as release assets.
    Mirror { release: String },
    /// A pinned Hugging Face commit: per-file `{repo}/resolve/{commit}/{path}`.
    Hf { repo: String, commit: String },
    /// Files the person picked in the native panel (18.9): `speech_choose_files`
    /// already copied them under `staging/<id>/`; the install checks each hash
    /// and moves them in — nothing is ever downloaded for `local`.
    Local,
}

#[derive(Deserialize)]
struct SpeechFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
struct InstallEntry {
    id: String,
    runtime: String,
    files: Vec<SpeechFile>,
    source: SpeechSource,
}

fn valid_runtime(s: &str) -> bool {
    matches!(s, "sherpa-onnx" | "whisper.cpp" | "mlx-audio" | "pocket-tts" | "pyannote")
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(HTTP_CONNECT_SECS))
        .build()
        .map_err(|e| format!("could not build http client: {e}"))
}

async fn http_get(client: &reqwest::Client, url: &str, token: Option<&str>) -> Result<Vec<u8>, String> {
    let mut req = client.get(url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.map_err(|e| format!("GET {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GET {url}: {}", res.status()));
    }
    /* manifests and tree listings are small — one bounded whole-body read */
    let body = tokio::time::timeout(std::time::Duration::from_secs(HTTP_FETCH_SECS), res.bytes())
        .await
        .map_err(|_| format!("GET {url}: the response stalled past {HTTP_FETCH_SECS}s"))?
        .map_err(|e| format!("GET {url}: {e}"))?;
    Ok(body.to_vec())
}

/// Download `url` to `dest`, resuming a `.part` from its current size, and
/// verify size + sha256 before renaming into place.
async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    size: u64,
    sha256: &str,
    token: Option<&str>,
) -> Result<(), String> {
    if size > MAX_FILE_BYTES {
        return Err(format!("{} is {size} bytes, above the 4 GiB cap", dest.display()));
    }
    /* `<name>.part`, not `<stem>.part` — model.onnx and model.json must not
       share one resumable file */
    let part = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("download")
    ));
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(url);
    if have > 0 {
        if have >= size {
            std::fs::remove_file(&part).ok();
        } else {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
    }
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let mut res = req.send().await.map_err(|e| format!("GET {url}: {e}"))?;
    if have > 0 && have < size && res.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("GET {url}: resume refused ({})", res.status()));
    }
    if !res.status().is_success() {
        return Err(format!("GET {url}: {}", res.status()));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .map_err(|e| format!("could not open {}: {e}", part.display()))?;
    use std::io::Write;
    let mut written = have;
    /* the bound is on a stall, not the transfer: bytes may keep arriving
       for hours as long as no single gap exceeds the idle timeout */
    loop {
        let chunk = tokio::time::timeout(
            std::time::Duration::from_secs(HTTP_IDLE_SECS),
            res.chunk(),
        )
        .await
        .map_err(|_| format!("GET {url}: the download stalled past {HTTP_IDLE_SECS}s"))?
        .map_err(|e| format!("GET {url}: {e}"))?;
        let Some(chunk) = chunk else {
            break;
        };
        file.write_all(&chunk)
            .map_err(|e| format!("write {}: {e}", part.display()))?;
        written += chunk.len() as u64;
        if written > size {
            return Err(format!("{} grew past its catalog size", part.display()));
        }
    }
    if written != size {
        return Err(format!("{} is {written} bytes, catalog says {size}", part.display()));
    }
    drop(file);
    match sha256_file(&part) {
        Ok(h) if h == sha256 => {
            std::fs::rename(&part, dest)
                .map_err(|e| format!("could not move {}: {e}", dest.display()))
        }
        Ok(h) => Err(format!("{} SHA-256 is {h}, expected {sha256}", part.display())),
        Err(e) => Err(e),
    }
}

/// SHA256SUMS → `name -> sha256` (two-space BSD format).
fn parse_sums(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let (hash, name) = line
            .split_once("  ")
            .or_else(|| line.split_once(" *"))
            .ok_or_else(|| format!("bad SHA256SUMS line: {line:?}"))?;
        if !valid_hash(hash) || !valid_file_name(name) {
            return Err(format!("unsafe SHA256SUMS line: {line:?}"));
        }
        out.insert(name.to_string(), hash.to_string());
    }
    Ok(out)
}

fn model_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_name(id) {
        return Err("model id must be [a-zA-Z0-9._-], <=128 chars".to_string());
    }
    Ok(speech_root(app)?.join("models").join(id))
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/// The model ids + engines the poll reports as installed.
#[tauri::command]
pub async fn speech_models(app: AppHandle) -> Result<Value, String> {
    let map = load_manifest(&app)?;
    Ok(json!({
        "models": map.iter().map(|(id, m)| json!({
            "id": id, "engine": m.engine, "state": m.state,
        })).collect::<Vec<_>>()
    }))
}

/// Whether the `diazo-speech` sidecar binary resolves (engines dir, then
/// PATH) — the bridge analogue of `blender_status`.
#[tauri::command]
pub async fn speech_engine_status(app: AppHandle) -> Result<Value, String> {
    Ok(json!({ "sidecar": resolve_sidecar(&app).ok().map(|p| p.display().to_string()) }))
}

/// Pick a local model's files in the native panel (18.9): copies them
/// under `staging/<id>/`, reports each file's name, size and SHA-256 for
/// the registration, and `speech_install` moves them in — the page never
/// sees a path.
#[tauri::command]
pub async fn speech_choose_files(app: AppHandle) -> Result<Value, String> {
    /* rfd blocks the calling thread — off the async runtime */
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose the model's files")
            .add_filter("model files", &["safetensors", "onnx", "gguf", "ggml", "onnx_data"])
            .pick_files()
    })
    .await
    .map_err(|e| format!("the file panel failed: {e}"))?;
    let Some(paths) = picked else {
        return Ok(json!({ "staged": null, "files": [] }));
    };
    if paths.is_empty() {
        return Ok(json!({ "staged": null, "files": [] }));
    }
    if paths.len() > MAX_FILES {
        return Err(format!("a model lists at most {MAX_FILES} files"));
    }
    /* a pick whose install never comes is dead weight — sweep stale
       staging dirs each time a new one lands */
    let staging_root = speech_root(&app)?.join("staging");
    if let Ok(entries) = std::fs::read_dir(&staging_root) {
        let day = std::time::Duration::from_secs(24 * 3600);
        for e in entries.flatten() {
            let stale = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|age| age > day)
                .unwrap_or(false);
            if stale {
                std::fs::remove_dir_all(e.path()).ok();
            }
        }
    }
    let staged = format!(
        "pick-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let staging = staging_root.join(&staged);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("could not create {}: {e}", staging.display()))?;
    let mut files = Vec::new();
    let mut total: u64 = 0;
    for path in &paths {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if !valid_file_name(name) {
            return Err(format!("{name:?} cannot be a model file name — use [a-zA-Z0-9._-]"));
        }
        let size = std::fs::metadata(path)
            .map(|m| m.len())
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if size > MAX_FILE_BYTES {
            return Err(format!("{name} is {size} bytes, above the 4 GiB cap"));
        }
        total += size;
        if total > MAX_MODEL_BYTES {
            return Err("the picked files total over 8 GiB".to_string());
        }
        let dest = staging.join(name);
        std::fs::copy(path, &dest)
            .map_err(|e| format!("could not stage {name}: {e}"))?;
        files.push(json!({
            "path": name,
            "bytes": size,
            "sha256": sha256_file(&dest)?,
        }));
    }
    Ok(json!({ "staged": staged, "files": files }))
}

/// Install a catalog row's files under <appData>/speech/models/<id>/.
/// `entry` is the catalog row JSON; `token` is the owner's HF token for
/// gated repos (custom models only — it never reaches the mirror path);
/// `staged` is the id `speech_choose_files` returned for a `local` source.
#[tauri::command]
pub async fn speech_install(
    app: AppHandle,
    state: State<'_, SpeechState>,
    entry: Value,
    token: Option<String>,
    staged: Option<String>,
) -> Result<Value, String> {
    let entry: InstallEntry =
        serde_json::from_value(entry).map_err(|e| format!("bad catalog entry: {e}"))?;
    if !valid_name(&entry.id) {
        return Err("model id must be [a-zA-Z0-9._-], <=128 chars".to_string());
    }
    if !valid_runtime(&entry.runtime) {
        return Err(format!("runtime {:?} is not a known speech runtime", entry.runtime));
    }
    if entry.files.is_empty() {
        return Err("a catalog entry must list at least one file".to_string());
    }
    if entry.files.len() > MAX_FILES {
        return Err(format!("a catalog entry lists at most {MAX_FILES} files"));
    }
    let total: u64 = entry.files.iter().map(|f| f.bytes).sum();
    if total > MAX_MODEL_BYTES {
        return Err(format!("{} bytes of files, above the 8 GiB model cap", total));
    }
    for f in &entry.files {
        if !valid_file_name(&f.path) {
            return Err(format!("unsafe file name in catalog: {:?}", f.path));
        }
    }
    /* the HF repo name is validated on every hf install — not only when a
       file lacks a sha256 — and a repo outside the pinned catalog list is
       a custom model: it asks natively before a byte downloads, naming
       the repo, the pinned commit and the total size */
    if let SpeechSource::Hf { repo, commit } = &entry.source {
        let repo_ok = repo
            .split('/')
            .all(|part| valid_name(part) && !part.starts_with('.'))
            && repo.split('/').count() == 2;
        if !repo_ok {
            return Err(format!("hf repo {repo:?} must be owner/name"));
        }
        if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("hf source commit must be 40 hex".to_string());
        }
        if !HF_CATALOG_REPOS.contains(&repo.as_str()) {
            /* rfd blocks the calling thread — off the async runtime, as
               claude.rs's own confirm does */
            let question = format!(
                "This downloads {} files ({:.1} GiB) from huggingface.co/{repo} at commit {commit}. Only install if you added this model yourself.",
                entry.files.len(),
                total as f64 / (1u64 << 30) as f64,
            );
            let title = format!("Install speech model {}?", entry.id);
            let accepted = tauri::async_runtime::spawn_blocking(move || {
                rfd::MessageDialog::new()
                    .set_title(title)
                    .set_description(question)
                    .set_level(rfd::MessageLevel::Warning)
                    .set_buttons(rfd::MessageButtons::OkCancel)
                    .show()
            })
            .await
            .map_err(|e| format!("the confirm dialog failed: {e}"))?;
            if accepted != rfd::MessageDialogResult::Ok {
                return Err("the install was declined".to_string());
            }
        }
    }
    {
        let mut installing = state.installing.lock().map_err(|_| "speech state poisoned")?;
        if installing.contains(&entry.id) {
            return Err("this model is already installing".to_string());
        }
        installing.push(entry.id.clone());
    }
    let result = do_install(&app, &entry, token.as_deref(), staged.as_deref()).await;
    state
        .installing
        .lock()
        .map_err(|_| "speech state poisoned")?
        .retain(|id| id != &entry.id);
    result
}

async fn do_install(
    app: &AppHandle,
    entry: &InstallEntry,
    token: Option<&str>,
    staged: Option<&str>,
) -> Result<Value, String> {
    let client = http_client()?;
    let dir = model_dir(app, &entry.id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    // The mirror path ships a signed manifest: verify the signature before
    // trusting any hash in it. On the HF path a catalog row may leave a
    // file's sha256 empty — the hash then comes from HF's own file metadata
    // (`lfs.oid`) at the pinned commit, per shared/speech.ts's contract.
    let files: Vec<(String, u64, String)> = match &entry.source {
        SpeechSource::Local => {
            if token.is_some() {
                return Err("a local source takes no HF token".to_string());
            }
            entry
                .files
                .iter()
                .map(|f| Ok((f.path.clone(), f.bytes, f.sha256.clone())))
                .collect::<Result<_, String>>()?
        }
        SpeechSource::Mirror { release } => {
            if token.is_some() {
                return Err("a mirror source takes no HF token".to_string());
            }
            if !valid_name(release) {
                return Err("release must be [a-zA-Z0-9._-], <=128 chars".to_string());
            }
            let base = format!("https://github.com/{MIRROR_REPO}/releases/download/{release}");
            let sums = http_get(&client, &format!("{base}/SHA256SUMS"), None).await?;
            if sums.len() as u64 > MAX_MANIFEST_BYTES {
                return Err("SHA256SUMS is over 1 MiB".to_string());
            }
            let minisig = http_get(&client, &format!("{base}/SHA256SUMS.minisig"), None).await?;
            verify_minisig(&sums, &String::from_utf8_lossy(&minisig))?;
            let sums = parse_sums(&String::from_utf8_lossy(&sums))?;
            entry
                .files
                .iter()
                .map(|f| {
                    let hash = sums
                        .get(&f.path)
                        .ok_or_else(|| format!("{} is not in SHA256SUMS", f.path))?;
                    Ok((f.path.clone(), f.bytes, hash.clone()))
                })
                .collect::<Result<_, String>>()?
        }
        SpeechSource::Hf { repo, commit } => {
            if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("hf source commit must be 40 hex".to_string());
            }
            let need_metadata = entry.files.iter().any(|f| f.sha256.is_empty());
            let tree = if need_metadata {
                let body = http_get(
                    &client,
                    &format!("https://huggingface.co/api/models/{repo}/tree/{commit}"),
                    token,
                )
                .await?;
                let items: Value = serde_json::from_slice(&body)
                    .map_err(|e| format!("hf tree is not JSON: {e}"))?;
                let mut map = BTreeMap::new();
                for item in items.as_array().into_iter().flatten() {
                    if let (Some(path), Some(oid)) = (
                        item.get("path").and_then(Value::as_str),
                        item.get("lfs")
                            .and_then(|l| l.get("oid"))
                            .or_else(|| item.get("oid"))
                            .and_then(Value::as_str),
                    ) {
                        map.insert(path.to_string(), oid.to_string());
                    }
                }
                map
            } else {
                BTreeMap::new()
            };
            entry
                .files
                .iter()
                .map(|f| {
                    let hash = if f.sha256.is_empty() {
                        tree.get(&f.path)
                            .cloned()
                            .ok_or_else(|| format!("{} has no sha256 in HF metadata", f.path))?
                    } else {
                        f.sha256.clone()
                    };
                    Ok((f.path.clone(), f.bytes, hash))
                })
                .collect::<Result<_, String>>()?
        }
    };

    /* a `local` model downloads nothing: the files the person picked wait
       under staging/<id>/ and each one's size + SHA-256 is checked again
       before it moves into the model dir */
    let staging_dir = if let SpeechSource::Local = &entry.source {
        let id = staged.ok_or("a local model needs its picked files — choose them first")?;
        if !valid_name(id) {
            return Err("bad staging id".to_string());
        }
        Some(speech_root(app)?.join("staging").join(id))
    } else {
        None
    };
    for (name, size, hash) in &files {
        if !valid_hash(hash) {
            return Err(format!("{name} has a malformed sha256"));
        }
        if let Some(staging) = &staging_dir {
            let picked = staging.join(name);
            let len = std::fs::metadata(&picked)
                .map(|m| m.len())
                .map_err(|e| format!("{name} was not picked: {e}"))?;
            if len != *size {
                return Err(format!("{name} is {len} bytes, registration says {size}"));
            }
            let h = sha256_file(&picked)?;
            if h != *hash {
                return Err(format!("{name} SHA-256 is {h}, expected {hash}"));
            }
            std::fs::rename(&picked, dir.join(name))
                .map_err(|e| format!("could not move {name} into place: {e}"))?;
            continue;
        }
        let url = match &entry.source {
            SpeechSource::Mirror { release } => format!(
                "https://github.com/{MIRROR_REPO}/releases/download/{release}/{name}"
            ),
            SpeechSource::Hf { repo, commit } => {
                format!("https://huggingface.co/{repo}/resolve/{commit}/{name}")
            }
            SpeechSource::Local => unreachable!(),
        };
        download_verified(&client, &url, &dir.join(name), *size, hash, token).await?;
    }
    if let Some(staging) = &staging_dir {
        std::fs::remove_dir_all(staging).ok();
    }

    let mut map = load_manifest(app)?;
    map.insert(
        entry.id.clone(),
        InstalledModel {
            engine: entry.runtime.clone(),
            state: "ready".to_string(),
            files: files
                .iter()
                .map(|(name, size, sha256)| InstalledFile {
                    name: name.clone(),
                    size: *size,
                    sha256: sha256.clone(),
                })
                .collect(),
        },
    );
    save_manifest(app, &map)?;
    Ok(json!({ "modelId": entry.id, "state": "ready" }))
}

/// Remove an installed model and its files.
#[tauri::command]
pub async fn speech_uninstall(app: AppHandle, model_id: String) -> Result<Value, String> {
    let dir = model_dir(&app, &model_id)?;
    let mut map = load_manifest(&app)?;
    map.remove(&model_id);
    save_manifest(&app, &map)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {}: {e}", dir.display()))?;
    }
    Ok(json!({ "modelId": model_id, "state": "missing" }))
}

/* ------------------------------------------------------------------ */
/* the diazo-speech sidecar                                            */
/* ------------------------------------------------------------------ */

/// Where the `diazo-speech` sidecar may live: the app's engines dir, then
/// the login shell's PATH. The name is fixed — a path is never taken.
fn resolve_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(local) = speech_root(app).map(|d| d.join("engines").join("diazo-speech")) {
        if local.is_file() {
            return Ok(local);
        }
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = crate::claude::login_shell_path(true).or_else(|| std::env::var_os("PATH")) {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    dirs.into_iter()
        .map(|d| d.join("diazo-speech"))
        .find(|p| p.is_file())
        .ok_or_else(|| "diazo-speech sidecar not found — install a speech-engines release".to_string())
}

/// Run the sidecar once: `diazo-speech --kind <asr|tts|speakers> --engine <e>
/// --model <model_dir> --in <in> --out <out>` inside a per-job work dir
/// under <appData>/speech/work/<jobId>/. The input file must already sit in
/// the work dir (the poll downloaded it); the output path is returned.
#[tauri::command]
pub async fn speech_run(
    app: AppHandle,
    job_id: String,
    kind: String,
    engine: String,
    model_id: String,
    input_name: String,
    output_name: String,
) -> Result<Value, String> {
    if !valid_name(&job_id) {
        return Err("job_id must be [a-zA-Z0-9._-], <=128 chars".to_string());
    }
    if !matches!(kind.as_str(), "asr" | "tts" | "speakers") {
        return Err("kind must be asr, tts or speakers".to_string());
    }
    if !valid_runtime(&engine) {
        return Err(format!("engine {:?} is not a known speech runtime", engine));
    }
    if !valid_file_name(&input_name) || !valid_file_name(&output_name) {
        return Err("input/output must be plain file names".to_string());
    }
    let map = load_manifest(&app)?;
    let model = map
        .get(&model_id)
        .filter(|m| m.state == "ready")
        .ok_or_else(|| format!("model {model_id} is not installed"))?;
    if model.engine != engine {
        return Err(format!("model {model_id} is a {} model, not {engine}", model.engine));
    }
    let work = speech_root(&app)?.join("work").join(&job_id);
    std::fs::create_dir_all(&work).map_err(|e| format!("could not create {}: {e}", work.display()))?;
    let input = work.join(&input_name);
    if !input.is_file() {
        return Err(format!("{} is not in the job's work dir", input_name));
    }
    let output = work.join(&output_name);
    let sidecar = resolve_sidecar(&app)?;
    let model_dir = model_dir(&app, &model_id)?;

    // Engine stdout+stderr go to the work dir's diazo-speech.log: a pipe
    // could fill while we poll, and the log doubles as the run's record.
    let log = std::fs::File::create(work.join("diazo-speech.log"))
        .map_err(|e| format!("could not open engine log: {e}"))?;
    let mut child = std::process::Command::new(&sidecar)
        .current_dir(&work)
        .args(["--kind", &kind])
        .args(["--engine", &engine])
        .arg("--model")
        .arg(&model_dir)
        .arg("--in")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", sidecar.display()))?;
    let status = tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(ENGINE_TIMEOUT_SECS);
        loop {
            match child.try_wait() {
                Ok(Some(s)) => return Ok(s),
                Ok(None) if std::time::Instant::now() > deadline => {
                    let _ = child.kill();
                    return Err(format!("diazo-speech ran past the {ENGINE_TIMEOUT_SECS}s limit"));
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(e) => return Err(format!("could not wait on diazo-speech: {e}")),
            }
        }
    })
    .await
    .map_err(|e| format!("engine wait task failed: {e}"))??;
    if !status.success() {
        return Err(format!("diazo-speech failed ({status}) — see the job's diazo-speech.log"));
    }
    if !output.is_file() {
        return Err(format!("diazo-speech produced no {}", output_name));
    }
    Ok(json!({ "jobId": job_id, "output": output.display().to_string() }))
}

/* -- job audio in / results out --------------------------------------- */

fn job_dir(root: &Path, job_id: &str) -> Result<PathBuf, String> {
    if !valid_name(job_id) {
        return Err("job_id must be [a-zA-Z0-9._-], <=128 chars".to_string());
    }
    let dir = root.join("work").join(job_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn work_dir(app: &AppHandle, job_id: &str) -> Result<PathBuf, String> {
    job_dir(&speech_root(app)?, job_id)
}

/// Decode a staged job input: a plain file name and a base64 body under
/// the cap. Kept pure — the contract is tested without an AppHandle.
fn decode_stage_input(name: &str, data_base64: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if !valid_file_name(name) {
        return Err("input must be a plain file name".to_string());
    }
    if data_base64.len() > max_bytes * 4 / 3 + 8 {
        return Err("the audio input is over the 256 MiB job cap".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("input is not base64: {e}"))?;
    if bytes.len() > max_bytes {
        return Err("the audio input is over the 256 MiB job cap".to_string());
    }
    Ok(bytes)
}

/// Read one file out of a job's work dir: a plain file name, under the cap.
fn read_job_file(dir: &Path, name: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    if !valid_file_name(name) {
        return Err("output must be a plain file name".to_string());
    }
    let path = dir.join(name);
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if bytes.len() > max_bytes {
        return Err("the output file is over the 256 MiB job cap".to_string());
    }
    Ok(bytes)
}

/// Bring a claimed job's audio into the desktop path: the bytes ride the
/// call base64-encoded and land as `name` inside the job's work dir,
/// where `speech_run --in` then finds them. `name` is a plain file name —
/// never a path.
#[tauri::command]
pub async fn speech_stage_input(
    app: AppHandle,
    job_id: String,
    name: String,
    data_base64: String,
) -> Result<Value, String> {
    let bytes = decode_stage_input(&name, &data_base64, MAX_JOB_FILE_BYTES)?;
    let path = work_dir(&app, &job_id)?.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(json!({ "path": path.display().to_string(), "bytes": bytes.len() }))
}

/// The counterpart of speech_stage_input: read one file out of the job's
/// work dir — a transcript, a voice-over, a speaker map — for the page to
/// hand back to the server. `name` is a plain file name — never a path.
#[tauri::command]
pub async fn speech_read_output(app: AppHandle, job_id: String, name: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = read_job_file(&work_dir(&app, &job_id)?, &name, MAX_JOB_FILE_BYTES)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blake2b_rfc7693_empty_and_abc() {
        let empty = blake2b512(b"");
        assert_eq!(
            hex(&empty),
            "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"
        );
        let abc = blake2b512(b"abc");
        assert_eq!(
            hex(&abc),
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn sha256_known() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn names_reject_paths() {
        assert!(valid_name("pocket-tts"));
        assert!(!valid_name("../x"));
        assert!(!valid_name("a/b"));
        assert!(valid_file_name("model.safetensors"));
        assert!(!valid_file_name(".gitattributes"));
        assert!(!valid_file_name(".."));
        assert!(!valid_file_name(""));
    }

    #[test]
    fn sums_parse_and_reject() {
        let text = "54f9f0001ec62b6a53072a7c9d1b630e346ae51fca14a5799e54f0d918281872  config.json\n";
        let sums = parse_sums(text).unwrap();
        assert_eq!(
            sums["config.json"],
            "54f9f0001ec62b6a53072a7c9d1b630e346ae51fca14a5799e54f0d918281872"
        );
        assert!(parse_sums("notahash  config.json").is_err());
        assert!(parse_sums(&format!("{}  ../evil", "a".repeat(64))).is_err());
    }

    #[test]
    fn minisig_shape() {
        use base64::Engine;
        let mut blob = b"ED".to_vec();
        blob.extend_from_slice(&[0u8; 8]);
        blob.extend_from_slice(&[7u8; 64]);
        let text = format!(
            "untrusted comment: x\n{}\n",
            base64::engine::general_purpose::STANDARD.encode(&blob)
        );
        let (prehashed, sig) = parse_minisig(&text).unwrap();
        assert!(prehashed);
        assert_eq!(sig, [7u8; 64]);
        let mut wrong_alg = b"ZZ".to_vec();
        wrong_alg.extend_from_slice(&blob[2..]);
        let bad = format!(
            "untrusted comment: x\n{}\n",
            base64::engine::general_purpose::STANDARD.encode(&wrong_alg)
        );
        assert!(parse_minisig(&bad).is_err());
    }

    #[test]
    fn pubkey_decodes() {
        assert!(release_pubkey().is_ok());
    }

    #[test]
    fn staged_input_checks_name_and_cap() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"abc");
        assert_eq!(decode_stage_input("clip.wav", &b64, 4).unwrap(), b"abc");
        /* the decoded cap — three bytes do not fit a two-byte ceiling */
        assert!(decode_stage_input("clip.wav", &b64, 2).is_err());
        /* the base64-length cap fails before decoding */
        assert!(decode_stage_input("clip.wav", &"A".repeat(100), 20).is_err());
        /* a file name is never a path */
        for bad in ["../clip.wav", "a/b", "a\\b", ".hidden", "..", ""] {
            assert!(decode_stage_input(bad, &b64, 64).is_err(), "{bad:?} accepted");
        }
        assert!(decode_stage_input("clip.wav", "!!! not base64", 64).is_err());
    }

    #[test]
    fn job_files_read_only_plain_names_under_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("out.wav"), b"hello").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("out.wav"), b"nested").unwrap();
        assert_eq!(read_job_file(dir.path(), "out.wav", 16).unwrap(), b"hello");
        /* the cap applies to what leaves the shell */
        assert!(read_job_file(dir.path(), "out.wav", 4).is_err());
        /* a file name is never a path — even a real subdir is refused */
        for bad in ["sub/out.wav", "../out.wav", ".hidden", "..", ""] {
            assert!(read_job_file(dir.path(), bad, 16).is_err(), "{bad:?} accepted");
        }
        assert!(read_job_file(dir.path(), "missing.wav", 16).is_err());
        /* job ids are slugs too */
        assert!(job_dir(dir.path(), "../x").is_err());
        assert!(job_dir(dir.path(), "job-1").unwrap().ends_with("work/job-1"));
    }

    #[test]
    fn local_source_parses_the_shared_contract() {
        /* shared/speech.ts's `{ type: 'local' }` must deserialize — a model
           the server registers must be installable on the desktop */
        let entry: InstallEntry = serde_json::from_value(json!({
            "id": "mine",
            "runtime": "sherpa-onnx",
            "source": { "type": "local" },
            "files": [{ "path": "model.onnx", "bytes": 1, "sha256": "a".repeat(64) }],
        }))
        .unwrap();
        assert!(matches!(entry.source, SpeechSource::Local));
    }
}
