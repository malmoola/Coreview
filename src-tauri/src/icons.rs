//! Local icon library.
//!
//! LiveTopo ships 26 self-drawn glyphs and no vendor artwork. This module lets
//! an operator point the app at a folder of their own SVGs — a licensed vendor
//! set, a corporate kit — which is indexed at runtime. The artwork is never
//! bundled into the binary and never committed to the repository.
//!
//! Two independent defences against a hostile SVG:
//!
//! 1. The frontend renders library icons through `<img src="data:image/svg+xml">`.
//!    A browser does not execute script in an SVG loaded as an image, so even a
//!    malicious file cannot run in the app's origin. This is the real barrier.
//! 2. `sanitise` below strips the obvious vectors anyway — script elements,
//!    event-handler attributes, and non-fragment hrefs — so the stored text is
//!    also clean. Defence in depth, not the only line.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Refuse anything implausibly large for a glyph.
const MAX_SVG_BYTES: u64 = 512 * 1024;
/// Refuse a runaway directory.
const MAX_ICONS: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconEntry {
    pub id: String,
    pub name: String,
    pub category: String,
    /// Sanitised SVG source.
    pub svg: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconLibrary {
    pub dir: String,
    pub icons: Vec<IconEntry>,
    /// Files that were skipped, with the reason, so the UI can be honest
    /// instead of silently showing fewer icons than the folder contains.
    pub skipped: Vec<String>,
}

/// Strip script, event handlers and external references.
///
/// Deliberately conservative: anything it is unsure about is removed. It works
/// on the raw text rather than a DOM because the output is never executed —
/// see the module note.
pub fn sanitise(input: &str) -> String {
    let mut s = strip_elements(input, "script");
    s = strip_elements(&s, "foreignObject");
    s = strip_elements(&s, "image");
    s = strip_attributes(&s);
    s
}

fn strip_elements(input: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let lower = input.to_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while let Some(rel) = lower[i..].find(&open) {
        let start = i + rel;
        out.push_str(&input[i..start]);
        // Self-closing or paired?
        let after = &lower[start..];
        let end_of_open = after.find('>').map(|p| start + p + 1);
        let paired = after.find(&close).map(|p| start + p + close.len());
        i = match (end_of_open, paired) {
            (Some(eo), Some(p)) => {
                // If the open tag self-closes before the paired close, drop just it.
                if input[start..eo].trim_end().ends_with("/>") {
                    eo
                } else {
                    p
                }
            }
            (Some(eo), None) => eo,
            _ => input.len(),
        };
    }
    out.push_str(&input[i.min(input.len())..]);
    out
}

/// Remove `on*="..."` handlers and any href that is not a local `#fragment`.
fn strip_attributes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Find the start of an attribute name candidate.
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b':' {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b'_' | b':'))
            {
                i += 1;
            }
            let name = &input[start..i];
            let local = name.rsplit(':').next().unwrap_or(name).to_ascii_lowercase();

            // Look ahead for = "value"
            let mut j = i;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'=' {
                let mut k = j + 1;
                while k < bytes.len() && (bytes[k] as char).is_whitespace() {
                    k += 1;
                }
                if k < bytes.len() && (bytes[k] == b'"' || bytes[k] == b'\'') {
                    let quote = bytes[k];
                    let vstart = k + 1;
                    let mut vend = vstart;
                    while vend < bytes.len() && bytes[vend] != quote {
                        vend += 1;
                    }
                    let value = &input[vstart..vend.min(input.len())];
                    let drop = local.starts_with("on")
                        || (local == "href" && !value.trim_start().starts_with('#'));
                    if drop {
                        i = (vend + 1).min(bytes.len());
                        continue; // emit nothing for this attribute
                    }
                    out.push_str(&input[start..(vend + 1).min(input.len())]);
                    i = (vend + 1).min(bytes.len());
                    continue;
                }
            }
            out.push_str(name);
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("icon")
        .to_string()
}

/// Title-case a slug for display when there is no index.json entry.
fn humanise(id: &str) -> String {
    id.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Index a directory of SVGs. Optional `index.json` supplies names/categories:
/// `{"icons":[{"id","name","category","file"}]}`.
pub fn scan(dir: &str) -> Result<IconLibrary, String> {
    let root = PathBuf::from(dir);
    if !root.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }

    let mut meta: std::collections::HashMap<String, (String, String)> = Default::default();
    if let Ok(text) = std::fs::read_to_string(root.join("index.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(list) = v.get("icons").and_then(|i| i.as_array()) {
                for e in list {
                    let file = e.get("file").and_then(|x| x.as_str()).unwrap_or_default();
                    let name = e.get("name").and_then(|x| x.as_str()).unwrap_or_default();
                    let cat = e.get("category").and_then(|x| x.as_str()).unwrap_or("Custom");
                    if !file.is_empty() {
                        meta.insert(file.to_string(), (name.to_string(), cat.to_string()));
                    }
                }
            }
        }
    }

    let mut icons = Vec::new();
    let mut skipped = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("svg"))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();

    for path in entries {
        if icons.len() >= MAX_ICONS {
            skipped.push(format!("stopped at {MAX_ICONS} icons"));
            break;
        }
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        match std::fs::metadata(&path) {
            Ok(m) if m.len() > MAX_SVG_BYTES => {
                skipped.push(format!("{file_name}: larger than {} KB", MAX_SVG_BYTES / 1024));
                continue;
            }
            Err(e) => {
                skipped.push(format!("{file_name}: {e}"));
                continue;
            }
            _ => {}
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                skipped.push(format!("{file_name}: {e}"));
                continue;
            }
        };
        if !raw.to_lowercase().contains("<svg") {
            skipped.push(format!("{file_name}: not an SVG"));
            continue;
        }
        let id = stem(&path);
        let (name, category) = meta
            .get(&file_name)
            .cloned()
            .unwrap_or_else(|| (humanise(&id), "Custom".to_string()));
        icons.push(IconEntry {
            id,
            name,
            category,
            svg: sanitise(&raw),
        });
    }

    Ok(IconLibrary {
        dir: dir.to_string(),
        icons,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_script_elements() {
        let s = sanitise(r#"<svg><script>alert(1)</script><path d="M0 0"/></svg>"#);
        assert!(!s.to_lowercase().contains("<script"));
        assert!(!s.contains("alert(1)"));
        assert!(s.contains("<path"), "vector content must survive: {s}");
    }

    #[test]
    fn strips_event_handlers() {
        let s = sanitise(r#"<svg><circle onload="steal()" onclick="x()" r="4"/></svg>"#);
        assert!(!s.contains("onload"), "{s}");
        assert!(!s.contains("onclick"), "{s}");
        assert!(s.contains("r=\"4\""), "harmless attributes must survive: {s}");
    }

    #[test]
    fn strips_external_href_but_keeps_fragments() {
        // r##..##: the body contains `"#`, which would close an r#".."# literal.
        let s = sanitise(
            r##"<svg><use href="https://evil.test/x.svg#a"/><use href="#local"/></svg>"##,
        );
        assert!(!s.contains("evil.test"), "{s}");
        assert!(s.contains("#local"), "internal references must survive: {s}");
    }

    #[test]
    fn strips_embedded_images() {
        let s = sanitise(r#"<svg><image href="http://x/y.png" x="0"/><path d="M1 1"/></svg>"#);
        assert!(!s.to_lowercase().contains("<image"), "{s}");
        assert!(s.contains("<path"), "{s}");
    }

    #[test]
    fn leaves_clean_svg_essentially_intact() {
        let clean = r#"<svg viewBox="0 0 24 24"><path d="M2 2 L20 20" stroke="currentColor"/></svg>"#;
        let s = sanitise(clean);
        assert!(s.contains("viewBox"));
        assert!(s.contains("M2 2 L20 20"));
        assert!(s.contains("currentColor"));
    }

    #[test]
    fn humanises_slugs() {
        assert_eq!(humanise("asr-9000"), "Asr 9000");
        assert_eq!(humanise("l2_switch"), "L2 Switch");
    }

    #[test]
    fn scan_rejects_a_non_directory() {
        assert!(scan("/definitely/not/here").is_err());
    }
}
