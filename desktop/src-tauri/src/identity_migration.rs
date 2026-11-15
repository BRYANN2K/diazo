//! The one-time move from the doop bundle identifier to Diazo's.
//!
//! Up to 0.14 the shell was `design.doop.desktop`; from 0.15 it is
//! `dev.diazo.desktop`, so Tauri's app data folders moved with it. On the
//! first launch under the new identifier, while its folder is still missing
//! or empty, everything in the old one is copied over: the chosen server
//! (`server.json`), the picked Claude CLI (`cli.json`), the Chromium profile
//! (`cef/`, with the cookies and localStorage that keep the person signed in,
//! and the `webkit-migrated` marker, so src/webkit_migration.rs does not run
//! a second time) and, on Windows, WebView2's `EBWebView` in the local data
//! folder. The old folder is never changed or deleted: an official doop app
//! installed beside this one keeps using it.
//!
//! This runs first thing in main(), before the CEF runtime is configured
//! (it opens the profile at once) and before the app and its path resolver
//! exist, so the folders are worked out the way Tauri's resolver does:
//! `dirs::data_dir()` and `dirs::data_local_dir()` joined with the
//! identifier. The copy fills a staging folder that is renamed into place
//! only when complete, so a crash midway leaves nothing that would stop the
//! next launch from trying again.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Keep in step with both tauri.conf.json files (checked by a test).
pub const IDENTIFIER: &str = "dev.diazo.desktop";
/// The identifier the shell had up to 0.14.
pub const OLD_IDENTIFIER: &str = "design.doop.desktop";

/// Chromium's per-run lock files and its caches: rebuilt by the browser, and
/// the caches can run to hundreds of megabytes.
const SKIPPED: &[&str] = &[
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "component_crx_cache",
];

/// Copies the old identifier's data and local data folders into the new
/// ones where those are still empty. Errors are logged, never fatal: the
/// worst case is signing in again.
pub fn run() {
    let mut bases: Vec<PathBuf> = Vec::new();
    for base in [dirs::data_dir(), dirs::data_local_dir()]
        .into_iter()
        .flatten()
    {
        if !bases.contains(&base) {
            bases.push(base);
        }
    }
    for base in bases {
        match migrate(&base.join(OLD_IDENTIFIER), &base.join(IDENTIFIER)) {
            Ok(true) => eprintln!(
                "Copied the doop app's data from {}",
                base.join(OLD_IDENTIFIER).display()
            ),
            Ok(false) => {}
            Err(error) => eprintln!(
                "Could not copy the doop app's data from {}: {error}",
                base.display()
            ),
        }
    }
}

/// Copies `old` to `new` when `old` is a folder and `new` is missing or
/// empty; true when it copied. `old` is only read.
pub fn migrate(old: &Path, new: &Path) -> io::Result<bool> {
    if !old.is_dir() || has_entries(new) {
        return Ok(false);
    }
    let Some(name) = new.file_name() else {
        return Ok(false);
    };
    let mut staging_name = name.to_os_string();
    staging_name.push(".migrating");
    let staging = new.with_file_name(staging_name);
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    copy_dir(old, &staging)?;
    if new.exists() {
        fs::remove_dir(new)?;
    }
    fs::rename(&staging, new)?;
    Ok(true)
}

fn has_entries(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// Recursive copy of folders and regular files; symlinks (Chromium's lock
/// files are symlinks) and the SKIPPED names are left out.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if SKIPPED.iter().any(|skip| entry.file_name() == *skip) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn old_app(base: &Path) -> PathBuf {
        let old = base.join(OLD_IDENTIFIER);
        write(
            &old.join("server.json"),
            r#"{"url":"https://diazo.example.com"}"#,
        );
        write(&old.join("cli.json"), r#"{"path":"/opt/claude"}"#);
        write(&old.join("cef/Default/Cookies"), "cookies");
        write(&old.join("cef/webkit-migrated"), "");
        write(&old.join("cef/Default/Cache/data_0"), "big");
        write(&old.join("cef/Default/Code Cache/js/x"), "big");
        old
    }

    #[test]
    fn copies_the_old_data_into_a_missing_folder() {
        let base = tempfile::tempdir().unwrap();
        let old = old_app(base.path());
        let new = base.path().join(IDENTIFIER);
        assert!(migrate(&old, &new).unwrap());
        assert_eq!(
            fs::read_to_string(new.join("server.json")).unwrap(),
            r#"{"url":"https://diazo.example.com"}"#
        );
        assert!(new.join("cli.json").is_file());
        assert_eq!(
            fs::read_to_string(new.join("cef/Default/Cookies")).unwrap(),
            "cookies"
        );
        // the marker comes along, so the WebKit migration does not run again
        assert!(new.join("cef/webkit-migrated").is_file());
        assert!(!new.join("cef/Default/Cache").exists());
        assert!(!new.join("cef/Default/Code Cache").exists());
        // the old folder is untouched, and no staging folder is left behind
        assert!(old.join("server.json").is_file());
        assert!(old.join("cef/Default/Cache/data_0").is_file());
        assert!(!base.path().join(format!("{IDENTIFIER}.migrating")).exists());
    }

    #[test]
    fn fills_an_empty_folder() {
        let base = tempfile::tempdir().unwrap();
        let old = old_app(base.path());
        let new = base.path().join(IDENTIFIER);
        fs::create_dir_all(&new).unwrap();
        assert!(migrate(&old, &new).unwrap());
        assert!(new.join("server.json").is_file());
    }

    #[test]
    fn never_overwrites_a_folder_in_use() {
        let base = tempfile::tempdir().unwrap();
        let old = old_app(base.path());
        let new = base.path().join(IDENTIFIER);
        write(&new.join("server.json"), "mine");
        assert!(!migrate(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("server.json")).unwrap(), "mine");
        assert!(!new.join("cli.json").exists());
    }

    #[test]
    fn does_nothing_without_an_old_app() {
        let base = tempfile::tempdir().unwrap();
        let new = base.path().join(IDENTIFIER);
        assert!(!migrate(&base.path().join(OLD_IDENTIFIER), &new).unwrap());
        assert!(!new.exists());
    }

    #[test]
    fn replaces_a_staging_folder_a_crash_left() {
        let base = tempfile::tempdir().unwrap();
        let old = old_app(base.path());
        write(
            &base.path().join(format!("{IDENTIFIER}.migrating/half")),
            "x",
        );
        let new = base.path().join(IDENTIFIER);
        assert!(migrate(&old, &new).unwrap());
        assert!(!new.join("half").exists());
        assert!(new.join("server.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn leaves_out_symlinks() {
        let base = tempfile::tempdir().unwrap();
        let old = old_app(base.path());
        std::os::unix::fs::symlink("host-123", old.join("cef/SingletonLock")).unwrap();
        std::os::unix::fs::symlink(old.join("server.json"), old.join("link.json")).unwrap();
        let new = base.path().join(IDENTIFIER);
        assert!(migrate(&old, &new).unwrap());
        assert!(fs::symlink_metadata(new.join("cef/SingletonLock")).is_err());
        assert!(fs::symlink_metadata(new.join("link.json")).is_err());
    }

    #[test]
    fn identifier_matches_both_configs() {
        for config in [
            include_str!("../tauri.conf.json"),
            include_str!("../../src-tauri-chromium/tauri.conf.json"),
        ] {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            assert_eq!(config["identifier"], IDENTIFIER);
            assert_eq!(config["productName"], "Diazo");
        }
    }
}
