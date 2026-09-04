//! Local icon library.
//!
//! Coreview ships 26 self-drawn glyphs and no vendor artwork. This module lets
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

/// Refuse anything implausibly large for a glyph. LT-082: 512 KB refused a
/// real multi-shape icon sheet the operator had (a whole pack exported as
/// one SVG file, not a single glyph) — this guards against a runaway or
/// corrupt file, not against how much legitimate artwork one icon carries.
const MAX_SVG_BYTES: u64 = 8 * 1024 * 1024;
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

/// How deep to walk. A shape library is organised in folders by vendor and
/// family; it is not organised twenty levels deep, and a bound is what stops
/// a symlink loop or a home directory chosen by mistake from hanging the app.
const MAX_DEPTH: usize = 6;

/// Whether a file is a library's own paperwork rather than a shape.
fn is_paperwork(path: &Path, ext: &str) -> bool {
    if ["txt", "md", "json", "yml", "yaml", "toml"].iter().any(|e| ext.eq_ignore_ascii_case(e)) {
        return true;
    }
    path.file_name()
        .and_then(|f| f.to_str())
        .is_some_and(|f| f.starts_with('.'))
}

/// The palette group for a shape with no entry in `index.json`: the folder it
/// is in, relative to whichever of `roots` actually contains it. Nested
/// folders are joined so a set organised by vendor and family keeps both.
/// More than one root exists because a zip's contents (LT-081) are extracted
/// to a scratch directory, not the library folder itself, but the shapes
/// inside it should be grouped the same way a real subfolder would be —
/// by the zip's own name, then whatever was nested inside it.
fn folder_category(roots: &[&Path], path: &Path) -> String {
    let Some(parent) = path.parent() else {
        return "Custom".to_string();
    };
    let Some(rel) = roots.iter().find_map(|r| parent.strip_prefix(r).ok()) else {
        return "Custom".to_string();
    };
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .filter(|c| !c.is_empty())
        .map(humanise)
        .collect();
    if parts.is_empty() {
        "Custom".to_string()
    } else {
        parts.join(" / ")
    }
}

/// What a walk of the library folder found, sorted by what can be done
/// with it.
#[derive(Default)]
struct Found {
    svgs: Vec<PathBuf>,
    /// EMF and WMF — convertible here, through LibreOffice.
    convertible: Vec<PathBuf>,
    /// Visio files — stencils and drawings, read through libvisio.
    visio: Vec<PathBuf>,
    /// Lucidchart stencils, named so the report can be specific.
    lucid: Vec<PathBuf>,
    /// Zip archives — opened and read through like a folder (LT-081).
    zips: Vec<PathBuf>,
    /// Everything else this cannot read directly (a .pptx and the like).
    other_formats: Vec<PathBuf>,
}

/// Every shape file under a folder, including its subfolders.
///
/// Flat-only was the bug behind "1 icon" on a library of a thousand: shape
/// sets arrive as folders of folders, and only the top level was read.
fn collect(dir: &Path, depth: usize, found: &mut Found) -> Result<(), String> {
    if depth > MAX_DEPTH || found.svgs.len() >= MAX_ICONS {
        return Ok(());
    }
    let listing = match std::fs::read_dir(dir) {
        Ok(l) => l,
        // A folder that cannot be read is not fatal at depth: the rest of the
        // library is still worth having.
        Err(_) if depth > 0 => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in listing.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, depth + 1, found)?;
            continue;
        }
        match path.extension().and_then(|x| x.to_str()) {
            Some(ext) if ext.eq_ignore_ascii_case("svg") => found.svgs.push(path),
            // LT-003: an EMF is a shape, not a refusal. Converted below.
            Some(ext) if ext.eq_ignore_ascii_case("emf") || ext.eq_ignore_ascii_case("wmf") => {
                found.convertible.push(path)
            }
            // LT-012/LT-045: Visio stencils and drawings, old and new.
            Some(ext) if crate::shapeconv::visio_tool_for(ext).is_some() => {
                found.visio.push(path)
            }
            Some(ext) if ext.eq_ignore_ascii_case("lcsl") => found.lucid.push(path),
            // LT-081: a My Shapes folder is full of these — opened and
            // walked like a folder, not refused.
            Some(ext) if ext.eq_ignore_ascii_case("zip") => found.zips.push(path),
            // A library's own paperwork — the name and category index, a
            // licence, a readme — is not a shape that failed to load, and
            // counting it as one made a perfectly good folder report a
            // problem it did not have.
            Some(ext) if is_paperwork(&path, ext) => {}
            // Anything else is a shape file this cannot read directly, such
            // as a .pptx. Counted so the interface can say so rather than
            // silently showing an almost empty library.
            Some(_) => found.other_formats.push(path),
            None => {}
        }
    }
    Ok(())
}

/// Extract every zip in `found.zips` into its own folder under `scratch`,
/// named after the zip the way a real subfolder would be, then walk what
/// came out through `collect` the same as anything else in the library
/// (LT-081: "run scripts/import-shapes.mjs on them first" was the answer
/// even for a zip that held nothing but ordinary SVGs). A zip that will not
/// open, or an entry a path-traversal check refuses, is skipped by name
/// rather than silently dropped. Returns the scratch root so callers can
/// resolve categories against it alongside the library root.
fn expand_zips(root: &Path, found: &mut Found, skipped: &mut Vec<String>) -> Option<PathBuf> {
    let zips = std::mem::take(&mut found.zips);
    if zips.is_empty() {
        return None;
    }
    let scratch = std::env::temp_dir().join(format!("coreview-zip-{}", uuid::Uuid::new_v4()));
    for zip_path in &zips {
        let file_name = zip_path.file_name().and_then(|f| f.to_str()).unwrap_or("?").to_string();
        let file = match std::fs::File::open(zip_path) {
            Ok(f) => f,
            Err(e) => {
                skipped.push(format!("{file_name}: {e}"));
                continue;
            }
        };
        let mut archive = match zip::ZipArchive::new(file) {
            Ok(a) => a,
            Err(e) => {
                skipped.push(format!("{file_name}: {e}"));
                continue;
            }
        };
        // Extract to <scratch>/<the zip's own path relative to root, minus
        // ".zip"> — so a zip nested three folders deep keeps that context,
        // and folder_category sees it exactly as it would a real subfolder.
        let rel = zip_path.strip_prefix(root).unwrap_or(zip_path).with_extension("");
        let dest_root = scratch.join(&rel);
        let mut extracted_any = false;
        for i in 0..archive.len() {
            let Ok(mut entry) = archive.by_index(i) else { continue };
            if entry.is_dir() {
                continue;
            }
            // `enclosed_name` refuses anything with `..` or an absolute
            // path — a zip that tried to write outside its own folder.
            let Some(enclosed) = entry.enclosed_name() else { continue };
            let dest = dest_root.join(enclosed);
            if let Some(parent) = dest.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            let mut buf = Vec::new();
            if std::io::Read::read_to_end(&mut entry, &mut buf).is_err() {
                continue;
            }
            if std::fs::write(&dest, &buf).is_ok() {
                extracted_any = true;
            }
        }
        if !extracted_any {
            skipped.push(format!("{file_name}: nothing in it could be extracted"));
        }
    }
    let _ = collect(&scratch, 0, found);
    Some(scratch)
}

/// The name an icon shows in the palette. The chain the operator asked for in
/// LT-003: the index entry, else the de-slugified filename, else the raw
/// filename, and "Untitled" only when there is genuinely nothing to use.
fn display_name(given: &str, id: &str) -> String {
    let given = given.trim();
    if !given.is_empty() {
        return given.to_string();
    }
    let h = humanise(id);
    if !h.is_empty() {
        return h;
    }
    if !id.is_empty() {
        return id.to_string();
    }
    "Untitled".to_string()
}

/// Strip script, event handlers and external references.
///
/// Deliberately conservative: anything it is unsure about is removed. It works
/// on the raw text rather than a DOM because the output is never executed —
/// see the module note.
pub fn sanitise(input: &str) -> String {
    let mut s = strip_elements(input, "script");
    s = strip_elements(&s, "foreignObject");
    s = strip_attributes(&s);
    s
}

fn strip_elements(input: &str, tag: &str) -> String {
    // Both needles are lowercased because the haystack is. Without this only
    // all-lowercase tag names ever matched, which quietly excused the one tag
    // in the list that has a capital in it: `foreignObject` was searched for
    // as "<foreignObject" inside text that had already been lowercased, so it
    // was never found and everything it wrapped — an <iframe>, in the test
    // that caught this — was kept.
    let open = format!("<{}", tag.to_lowercase());
    let close = format!("</{}>", tag.to_lowercase());
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

/// Remove `on*="..."` handlers and any href that is neither a local
/// `#fragment` nor an inline `data:image/...` — the two reference kinds that
/// cannot reach the network. Embedded bitmaps ride in as data URIs, and an
/// icon that arrives with its raster stripped out is the "scrambled object"
/// of LT-003.
fn strip_attributes(input: &str) -> String {
    // Built as bytes and re-validated at the end: the first version pushed
    // each non-ASCII byte through `as char`, which re-encoded it — every
    // multi-byte glyph in an imported SVG came out as mojibake ("Décor" as
    // "DÃ©cor" in the palette).
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
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
                    let v = value.trim_start();
                    let drop = local.starts_with("on")
                        || (local == "href"
                            && !v.starts_with('#')
                            && !v.starts_with("data:image/"));
                    if drop {
                        i = (vend + 1).min(bytes.len());
                        continue; // emit nothing for this attribute
                    }
                    out.extend_from_slice(&bytes[start..(vend + 1).min(bytes.len())]);
                    i = (vend + 1).min(bytes.len());
                    continue;
                }
            }
            out.extend_from_slice(name.as_bytes());
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Only whole input slices and ASCII went in, so this cannot fail; the
    // fallback keeps a hostile edge case from panicking the scan.
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
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
    let mut found = Found::default();
    collect(&root, 0, &mut found)?;
    // LT-081: a zip is opened and walked like a folder, not refused —
    // whatever it holds joins the same svgs/convertible/visio/lucid lists a
    // real subfolder would have filled. Its contents categorise against
    // this scratch root, alongside the library root itself.
    let zip_root = expand_zips(&root, &mut found, &mut skipped);
    let roots: Vec<&Path> = std::iter::once(root.as_path()).chain(zip_root.as_deref()).collect();
    if !found.zips.is_empty() {
        skipped.push(format!(
            "{} zip archive(s) nested inside another zip were not opened",
            found.zips.len()
        ));
    }
    found.svgs.sort();
    found.convertible.sort();
    // A folder of Visio stencils and PPTX decks found one loose SVG and
    // reported "1 icon", which reads as an empty library rather than as a
    // library of files this cannot open. Say what was there — by the
    // extensions actually seen, not a guess at what a My Shapes folder
    // usually holds (LT-081: that guess once named `.vssx`, which this same
    // scan already reads, and `.zip`, which it now opens instead of
    // refusing).
    if !found.other_formats.is_empty() {
        let mut exts: Vec<String> = found
            .other_formats
            .iter()
            .filter_map(|p| p.extension().and_then(|e| e.to_str()))
            .map(|e| format!(".{}", e.to_lowercase()))
            .collect();
        exts.sort();
        exts.dedup();
        skipped.push(format!(
            "{} file(s) are in formats Coreview cannot read directly ({}) — run scripts/import-shapes.mjs on them first",
            found.other_formats.len(),
            exts.join(", ")
        ));
    }
    for path in &found.lucid {
        let n = path.file_name().and_then(|f| f.to_str()).unwrap_or("?");
        skipped.push(format!("{n}: a Lucidchart stencil — its converter is not built yet"));
    }
    let entries = std::mem::take(&mut found.svgs);

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
            // The folder a shape sits in is what it is: Fortinet, Nexus 9000,
            // Wireless. Calling a thousand icons "Custom" is a list nobody can
            // find anything in.
            .unwrap_or_else(|| (String::new(), folder_category(&roots, &path)));
        icons.push(IconEntry {
            name: display_name(&name, &id),
            id,
            category,
            svg: sanitise(&raw),
        });
    }

    // LT-012/LT-045: a Visio file — a My Shapes folder full of .vss and
    // .vssx, or a loose .vsd — converts through libvisio. A stencil's
    // masters each become their own icon; a drawing's pages likewise.
    if !found.visio.is_empty() {
        if !crate::shapeconv::libvisio_available() {
            skipped.push(format!(
                "{} Visio file(s) need libvisio-tools to convert — install it and reload",
                found.visio.len()
            ));
        } else {
            found.visio.sort();
            'files: for src in &found.visio {
                let file_name =
                    src.file_name().and_then(|f| f.to_str()).unwrap_or("?").to_string();
                let svgs = match crate::shapeconv::convert_visio(src) {
                    Ok(v) => v,
                    Err(e) => {
                        skipped.push(format!("{file_name}: {e}"));
                        continue;
                    }
                };
                let many = svgs.len() > 1;
                let base = stem(src);
                let category = folder_category(&roots, src);
                for (n, svg) in svgs.iter().enumerate() {
                    if icons.len() >= MAX_ICONS {
                        skipped.push(format!("stopped at {MAX_ICONS} icons"));
                        break 'files;
                    }
                    let Some(tidied) = crate::shapeconv::tidy_converted(svg) else {
                        // An empty master — stencils often carry one.
                        continue;
                    };
                    let id = if many { format!("{base}-{}", n + 1) } else { base.clone() };
                    let name = if many {
                        format!("{} {}", display_name("", &base), n + 1)
                    } else {
                        display_name("", &base)
                    };
                    icons.push(IconEntry {
                        id,
                        name,
                        category: category.clone(),
                        svg: sanitise(&tidied),
                    });
                }
            }
        }
    }

    // LT-003: EMF and WMF convert here rather than being refused with a
    // count. LibreOffice draws them; the tidy pass is the same one the PPTX
    // pipeline needed — crop the A4 page away, make the bitmaps legal.
    if !found.convertible.is_empty() {
        if !crate::shapeconv::soffice_available() {
            skipped.push(format!(
                "{} EMF/WMF file(s) need LibreOffice to convert — install libreoffice-draw and reload",
                found.convertible.len()
            ));
        } else {
            let work = std::env::temp_dir().join(format!("coreview-conv-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&work);
            for batch in found.convertible.chunks(25) {
                if icons.len() >= MAX_ICONS {
                    skipped.push(format!("stopped at {MAX_ICONS} icons"));
                    break;
                }
                let produced = match crate::shapeconv::convert_batch(batch, &work) {
                    Ok(p) => p,
                    Err(e) => {
                        skipped.push(e);
                        continue;
                    }
                };
                for src in batch {
                    let file_name =
                        src.file_name().and_then(|f| f.to_str()).unwrap_or("?").to_string();
                    let out = work.join(src.file_stem().unwrap_or_default()).with_extension("svg");
                    if !produced.contains(&out) {
                        skipped.push(format!("{file_name}: LibreOffice could not draw it"));
                        continue;
                    }
                    let raw = match std::fs::read_to_string(&out) {
                        Ok(t) => t,
                        Err(e) => {
                            skipped.push(format!("{file_name}: {e}"));
                            continue;
                        }
                    };
                    let Some(tidied) = crate::shapeconv::tidy_converted(&raw) else {
                        skipped.push(format!("{file_name}: converted, but nothing was drawn"));
                        continue;
                    };
                    let id = stem(src);
                    let (name, category) = meta
                        .get(&file_name)
                        .cloned()
                        .unwrap_or_else(|| (String::new(), folder_category(&roots, src)));
                    icons.push(IconEntry {
                        name: display_name(&name, &id),
                        id,
                        category,
                        svg: sanitise(&tidied),
                    });
                }
            }
            let _ = std::fs::remove_dir_all(&work);
        }
    }

    if let Some(scratch) = zip_root {
        let _ = std::fs::remove_dir_all(scratch);
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

    /// The tag whose name is not all lowercase. There was no test for it, and
    /// it was the one the stripper silently ignored.
    #[test]
    fn strips_foreign_objects_whatever_their_casing() {
        for tag in ["foreignObject", "foreignobject", "FOREIGNOBJECT", "ForeignObject"] {
            let svg = format!(
                r#"<svg><{tag}><iframe src="http://evil.example"></iframe></{tag}><circle r="8"/></svg>"#
            );
            let s = sanitise(&svg).to_lowercase();
            assert!(!s.contains("foreignobject"), "{tag} survived: {s}");
            assert!(!s.contains("<iframe"), "an iframe survived inside {tag}: {s}");
            assert!(s.contains("<circle"), "the drawing must survive: {s}");
        }
    }

    /// LT-003 changed the spec here: an `<image>` used to be deleted
    /// wholesale, which blanked the artwork out of every icon that carries
    /// an embedded bitmap. Now the element stays and only a fetching href is
    /// removed — a data URI cannot reach the network.
    #[test]
    fn keeps_embedded_bitmaps_but_not_fetching_ones() {
        let s = sanitise(r#"<svg><image href="http://x/y.png" x="0"/><path d="M1 1"/></svg>"#);
        assert!(!s.contains("http://x"), "an external image href survived: {s}");
        assert!(s.contains("<path"), "{s}");

        let s = sanitise(r#"<svg><image href="data:image/png;base64,iVBOR" width="8"/></svg>"#);
        assert!(s.contains("data:image/png;base64,iVBOR"), "an inline bitmap was stripped: {s}");

        let s = sanitise(r#"<svg><image href="data:text/html,<script>x</script>" width="8"/></svg>"#);
        assert!(!s.contains("data:text"), "only image data URIs may stay: {s}");
    }

    #[test]
    fn leaves_clean_svg_essentially_intact() {
        let clean = r#"<svg viewBox="0 0 24 24"><path d="M2 2 L20 20" stroke="currentColor"/></svg>"#;
        let s = sanitise(clean);
        assert!(s.contains("viewBox"));
        assert!(s.contains("M2 2 L20 20"));
        assert!(s.contains("currentColor"));
    }

    /// LT-003: a multi-element SVG must come through whole — sibling groups
    /// and paths intact, nested transforms kept as written, text unmangled.
    /// The palette renders the sanitised text verbatim, so anything sanitise
    /// bends here is what the operator sees scrambled on the canvas.
    #[test]
    fn a_multi_element_svg_survives_sanitising_whole() {
        let svg = r##"<svg viewBox="0 0 100 100">
  <g transform="translate(10,20)">
    <g transform="scale(2)"><path d="M0 0 L10 0" stroke="currentColor"/></g>
    <path d="M5 5 L5 15"/>
  </g>
  <path d="M50 50 L60 60"/>
  <text x="1" y="2">Décor — étage</text>
</svg>"##;
        let s = sanitise(svg);
        assert_eq!(s.matches("<path").count(), 3, "a sibling path was lost: {s}");
        assert_eq!(s.matches("transform=").count(), 2, "a transform was dropped: {s}");
        assert!(s.contains("translate(10,20)"), "{s}");
        assert!(s.contains("scale(2)"), "{s}");
        assert!(s.contains("Décor — étage"), "non-ASCII text was mangled: {s}");
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

    /// `sanitise` being correct is worth nothing if `scan` forgets to call it.
    /// This walks a real folder, which is the path the app actually takes.
    #[test]
    fn a_scanned_folder_comes_back_sanitised_and_honest_about_what_it_skipped() {
        let dir = std::env::temp_dir().join(format!("coreview-icons-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(
            dir.join("hostile.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="steal()">
                 <script>fetch('http://evil.example')</script>
                 <image href="http://evil.example/t.png"/>
                 <foreignObject><iframe src="http://evil.example"></iframe></foreignObject>
                 <circle cx="12" cy="12" r="8"/>
               </svg>"#,
        )
        .unwrap();
        std::fs::write(dir.join("clean.svg"), r#"<svg viewBox="0 0 24 24"><path d="M0 0h24"/></svg>"#).unwrap();
        // Over MAX_SVG_BYTES, so it must be reported rather than silently dropped.
        std::fs::write(dir.join("huge.svg"), "x".repeat((MAX_SVG_BYTES + 1) as usize)).unwrap();
        // Not a candidate at all.
        std::fs::write(dir.join("notes.txt"), "not an icon").unwrap();
        std::fs::write(
            dir.join("index.json"),
            r#"{"icons":[{"file":"clean.svg","name":"Load balancer","category":"Data centre"}]}"#,
        )
        .unwrap();

        let lib = scan(dir.to_str().unwrap()).expect("the folder should scan");

        assert_eq!(lib.icons.len(), 2, "clean.svg and hostile.svg: {:?}", lib.icons);
        let hostile = lib.icons.iter().find(|i| i.id.contains("hostile")).expect("hostile.svg");
        let lower = hostile.svg.to_lowercase();
        for bad in ["<script", "onload", "<foreignobject", "<iframe", "evil.example"] {
            assert!(!lower.contains(bad), "{bad} survived scan: {}", hostile.svg);
        }
        assert!(hostile.svg.contains("<circle"), "the drawing must survive: {}", hostile.svg);

        // Names and categories come from index.json where it has an entry.
        let clean = lib.icons.iter().find(|i| i.id.contains("clean")).unwrap();
        assert_eq!(clean.name, "Load balancer");
        assert_eq!(clean.category, "Data centre");

        assert!(
            lib.skipped.iter().any(|s| s.contains("huge.svg")),
            "an oversized file must be reported, not silently dropped: {:?}",
            lib.skipped
        );
        assert!(
            !lib.skipped.iter().any(|s| s.contains("notes.txt")),
            "a non-SVG is not a skipped icon: {:?}",
            lib.skipped
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// LT-082: "Unmaintained-Design-Icons_v2.0(2).svg" is a real file the
    /// operator had — a whole icon pack exported as one SVG, past the old
    /// 512 KB guard — refused with "larger than 512 KB" alongside files that
    /// really were runaway. The guard is meant to catch those, not to cap
    /// how much legitimate artwork one icon file may hold.
    #[test]
    fn a_large_but_legitimate_icon_sheet_still_loads() {
        let dir = std::env::temp_dir().join(format!("coreview-icons-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = String::new();
        for i in 0..11000 {
            body.push_str(&format!("<path id=\"icon-{i}\" d=\"M{i} {i} l10 0 l0 10 l-10 0 z\"/>"));
        }
        let svg =
            format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 6100 6100\">{body}</svg>");
        assert!(
            svg.len() as u64 > 512 * 1024,
            "fixture must exceed the old 512 KB cap: {} bytes",
            svg.len()
        );
        std::fs::write(dir.join("Unmaintained-Design-Icons_v2.0(2).svg"), &svg).unwrap();

        let lib = scan(dir.to_str().unwrap()).expect("the folder should scan");
        assert!(
            lib.icons.iter().any(|i| i.id.to_lowercase().contains("unmaintained")),
            "the icon sheet was refused: {:?}",
            lib.skipped
        );
        assert!(
            !lib.skipped.iter().any(|s| s.contains("larger than")),
            "still rejected for size: {:?}",
            lib.skipped
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod imported_library_tests {
    /// A folder produced by `scripts/shapes-from-pptx.mjs`, scanned the way
    /// the app scans one. Set CV_ICON_DIR to check a real import.
    #[test]
    fn an_imported_folder_scans() {
        let Ok(dir) = std::env::var("CV_ICON_DIR") else {
            return;
        };
        let lib = super::scan(&dir).expect("the folder should scan");
        println!(
            "scanned {} icons, {} skipped; first: {:?}",
            lib.icons.len(),
            lib.skipped.len(),
            lib.icons.first().map(|i| (&i.name, &i.category))
        );
        for s in lib.skipped.iter().take(5) {
            println!("  skipped: {s}");
        }
        assert!(!lib.icons.is_empty(), "nothing was indexed");
    }
}

#[cfg(test)]
mod folder_tests {
    use std::fs;

    fn write(path: &std::path::Path, body: &str) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        fs::write(path, body).expect("write");
    }

    const SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h4v4z"/></svg>"#;

    fn library() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(&root.join("loose.svg"), SVG);
        write(&root.join("Fortinet/fortigate.svg"), SVG);
        write(&root.join("Fortinet/fortiswitch.svg"), SVG);
        write(&root.join("Cisco/Nexus 9000/n9k-c93180.svg"), SVG);
        // The formats a real shape folder is actually full of.
        write(&root.join("Switches_Cisco_Nexus_9000.vss"), "binary-ish");
        write(&root.join("Deck.pptx"), "PK\u{3}\u{4}not-really-a-pptx");
        write(&root.join("Affinity-Native.lcsl"), "{}");
        dir
    }

    #[test]
    fn finds_shapes_in_subfolders() {
        // The bug behind "1 icon" on a library of a thousand: shape sets
        // arrive as folders of folders and only the top level was read.
        let dir = library();
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert_eq!(lib.icons.len(), 4, "found {:?}", lib.icons.iter().map(|i| &i.id).collect::<Vec<_>>());
    }

    #[test]
    fn names_the_group_after_the_folder() {
        // "Custom" for a thousand icons is a list nobody can find anything in.
        let dir = library();
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        let of = |id: &str| {
            lib.icons.iter().find(|i| i.id == id).map(|i| i.category.clone()).unwrap_or_default()
        };
        assert_eq!(of("fortigate"), "Fortinet");
        assert_eq!(of("n9k-c93180"), "Cisco / Nexus 9000");
        assert_eq!(of("loose"), "Custom");
    }

    #[test]
    fn says_when_a_folder_is_full_of_things_it_cannot_read() {
        // Silently reporting one icon reads as an empty library rather than
        // as a library of stencils that need converting first.
        let dir = library();
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert!(
            lib.skipped.iter().any(|s| s.contains("cannot read directly")),
            "skipped: {:?}",
            lib.skipped
        );
        // LT-003: a Lucid stencil is named, not folded into a count.
        assert!(
            lib.skipped.iter().any(|s| s.contains("Affinity-Native.lcsl") && s.contains("Lucid")),
            "skipped: {:?}",
            lib.skipped
        );
    }

    /// LT-003: an EMF routes to the converter instead of the refusal count —
    /// and when it cannot be converted, the report names the file or names
    /// the missing tool, never "N file(s) are not SVG".
    #[test]
    fn an_emf_is_routed_to_the_converter_not_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("router.emf"), "not really an emf");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert!(
            !lib.skipped.iter().any(|s| s.contains("cannot read directly")),
            "an EMF fell into the generic refusal: {:?}",
            lib.skipped
        );
        assert!(
            lib.skipped
                .iter()
                .any(|s| s.contains("router.emf") || s.contains("LibreOffice")),
            "a failed EMF must be reported by name or by missing tool: {:?}",
            lib.skipped
        );
    }

    /// LT-003, run against a real EMF from the Cisco deck (a committed
    /// fixture, per D-019). Skips where LibreOffice is not installed — the
    /// CI runners — because the soffice-missing branch is covered above;
    /// this one proves an actual conversion lands in the palette as a real,
    /// cropped icon.
    #[test]
    fn a_real_emf_becomes_a_palette_icon() {
        if !crate::shapeconv::soffice_available() {
            eprintln!("skipping: soffice not installed here");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/sample.emf");
        std::fs::copy(&fixture, dir.path().join("edge-router.emf")).expect("copy fixture");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert_eq!(lib.icons.len(), 1, "skipped: {:?}", lib.skipped);
        let icon = &lib.icons[0];
        assert_eq!(icon.name, "Edge Router", "named from the file: {}", icon.name);
        assert!(icon.svg.contains("viewBox"), "{}", &icon.svg[..icon.svg.len().min(200)]);
        // The crop must have replaced the A4 page: LibreOffice's page is
        // 21000x29700 hundredths of a millimetre, and an uncropped speck
        // would still carry it.
        let vb = icon.svg.split("viewBox=\"").nth(1).and_then(|r| r.split('"').next()).expect("vb");
        let n: Vec<f64> = vb.split(' ').filter_map(|v| v.parse().ok()).collect();
        assert!(n[2] < 21000.0 * 0.9, "not cropped: viewBox {vb}");
        assert!(icon.svg.contains("<path") || icon.svg.contains("<image"), "nothing drawn");
    }

    /// D-022/LT-058: what ships in the installer is the repo's `stencils/`
    /// folder, bundled as a resource — this scans that exact folder and holds
    /// the bar the palette depends on: a real set, categorised, every icon
    /// carrying usable SVG.
    #[test]
    fn the_shipped_stencils_scan_into_a_full_palette() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../stencils");
        let lib = super::scan(dir.to_str().expect("path")).expect("scan");
        assert!(lib.icons.len() >= 200, "only {} icons", lib.icons.len());
        let categories: std::collections::HashSet<_> =
            lib.icons.iter().map(|i| i.category.as_str()).collect();
        assert!(categories.len() >= 5, "categories: {categories:?}");
        for icon in &lib.icons {
            assert!(!icon.name.is_empty(), "{} has no name", icon.id);
            assert!(icon.svg.contains("viewBox"), "{} has no viewBox", icon.id);
        }
    }

    /// LT-012/LT-045: a Visio drawing in the library folder becomes icons at
    /// scan time. Real file from libvisio's test suite; skips where the
    /// tools are missing (CI). A .vss stencil follows the identical path
    /// through vss2xhtml — verified separately against an operator stencil.
    #[test]
    fn a_visio_file_in_the_folder_becomes_icons() {
        if !crate::shapeconv::libvisio_available() {
            eprintln!("skipping: libvisio-tools not installed here");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/blue-box.vsdx");
        std::fs::copy(&fixture, dir.path().join("blue-box.vsdx")).expect("copy");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert!(!lib.icons.is_empty(), "skipped: {:?}", lib.skipped);
        assert_eq!(lib.icons[0].name, "Blue Box");
        assert!(lib.icons[0].svg.contains("viewBox"));
        assert!(!lib.icons[0].svg.contains("svg:"));
    }

    /// LT-045/LT-080: the operator's own `.vss` — a Tripp Lite SmartRack
    /// stencil out of a Windows My Shapes folder — becomes one palette icon
    /// per master, and each icon carries artwork a webview can actually
    /// draw. libvisio hands the masters back as embedded EMF, which no
    /// browser renders: an icon whose only picture is `data:image/emf` is a
    /// blank tile, which is what this stencil produced before LT-083.
    #[test]
    fn a_real_operator_stencil_becomes_drawable_icons() {
        if !crate::shapeconv::libvisio_available() {
            eprintln!("skipping: libvisio-tools not installed here");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/tripp-lite-racks.vss");
        std::fs::copy(&fixture, dir.path().join("Tripp Lite SmartRack Racks.vss"))
            .expect("copy");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert_eq!(lib.icons.len(), 18, "skipped: {:?}", lib.skipped);
        assert!(lib.icons[0].name.starts_with("Tripp Lite SmartRack Racks"));
        for icon in &lib.icons {
            let vb = icon
                .svg
                .find("viewBox=\"")
                .map(|p| &icon.svg[p + 9..])
                .and_then(|s| s.split('"').next())
                .unwrap_or_else(|| panic!("{} has no viewBox", icon.id));
            let nums: Vec<f64> = vb.split_whitespace().filter_map(|v| v.parse().ok()).collect();
            assert_eq!(nums.len(), 4, "{}: malformed viewBox {vb:?}", icon.id);
            // Every master here is a rack, tall and narrow: a few hundred
            // units at most (the masters themselves declare 1-4 inches by
            // up to 11 inches). A viewBox in the thousands means the crop
            // ran on the picture's un-transformed source coordinates rather
            // than its coordinates in the master's own space.
            assert!(
                nums[2] < 1000.0 && nums[3] < 1000.0,
                "{}: viewBox {vb:?} is way past the master's own size — a splice left \
                 untransformed geometry behind for crop_to_content to measure",
                icon.id
            );
            assert!(
                !icon.svg.contains("data:image/emf") && !icon.svg.contains("data:image/wmf"),
                "{} is a blank tile: its artwork is still a metafile",
                icon.id
            );
        }
    }

    /// LT-081: "can we find a way to import vss" arrived with a My Shapes
    /// folder pasted in the app's own output — a zip full of stencils,
    /// reported as one of "46 file(s) ... Coreview cannot read directly".
    /// It is opened and walked like a folder: an SVG inside becomes an icon,
    /// categorised under the zip's own name the way a real subfolder would
    /// be, and a `.vss` inside converts exactly as a loose one would.
    #[test]
    fn a_zip_of_stencils_is_read_through_like_a_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("Vendor/loose.svg"), SVG);
        let zip_bytes = {
            let mut buf = std::io::Cursor::new(Vec::new());
            let mut zw = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("Racks/switch.svg", opts).unwrap();
            std::io::Write::write_all(&mut zw, SVG.as_bytes()).unwrap();
            zw.finish().unwrap();
            buf.into_inner()
        };
        std::fs::write(dir.path().join("Vendor/Net Equip.zip"), &zip_bytes).unwrap();

        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        let icon = lib
            .icons
            .iter()
            .find(|i| i.id.contains("switch"))
            .unwrap_or_else(|| panic!("the zip's SVG never became an icon: {:?}", lib.skipped));
        assert_eq!(icon.category, "Vendor / Net Equip / Racks", "{:?}", icon.category);
        assert!(lib.icons.iter().any(|i| i.id.contains("loose")), "the real subfolder still scans");
    }

    /// A zip that will not open at all is reported by name, the same way a
    /// broken Visio file is — never folded into a generic count.
    #[test]
    fn a_broken_zip_is_reported_by_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("corrupt.zip"), "PK\u{3}\u{4}not really a zip");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert!(lib.icons.is_empty());
        assert!(
            lib.skipped.iter().any(|s| s.contains("corrupt.zip")),
            "skipped: {:?}",
            lib.skipped
        );
    }

    /// LT-081: the refusal message once named `.vssx` and `.zip` as examples
    /// of what Coreview cannot read — both wrong, since `.vssx` has gone
    /// through the Visio route since LT-045 and `.zip` is opened by the test
    /// above. The message now names only extensions actually left over.
    #[test]
    fn the_refusal_message_never_names_a_format_it_actually_reads() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("stencil.vssx"), "binary-ish");
        write(&dir.path().join("Deck.pptx"), "not a real deck");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        let refusal = lib
            .skipped
            .iter()
            .find(|s| s.contains("cannot read directly"))
            .unwrap_or_else(|| panic!("no refusal message at all: {:?}", lib.skipped));
        assert!(refusal.contains(".pptx"), "{refusal}");
        assert!(!refusal.contains(".vssx"), "{refusal}");
        assert!(!refusal.contains(".zip"), "{refusal}");
    }

    /// A Visio file that cannot be read is reported by name (or by the
    /// missing tool), never folded into "N file(s) cannot be read".
    #[test]
    fn a_broken_visio_file_is_reported_by_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("corrupt.vss"), "not a stencil");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert!(lib.icons.is_empty());
        assert!(
            !lib.skipped.iter().any(|s| s.contains("cannot read directly")),
            "fell into the generic refusal: {:?}",
            lib.skipped
        );
        assert!(
            lib.skipped
                .iter()
                .any(|s| s.contains("corrupt.vss") || s.contains("libvisio-tools")),
            "skipped: {:?}",
            lib.skipped
        );
    }

    /// LT-003: the naming chain — index entry, else de-slugified filename,
    /// else the filename itself. "Untitled" is the last resort, not the
    /// default.
    #[test]
    fn an_unnamed_import_is_named_after_its_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("asr-9000-edge.svg"), SVG);
        write(&dir.path().join("___.svg"), SVG);
        std::fs::write(
            dir.path().join("index.json"),
            r#"{"icons":[{"file":"asr-9000-edge.svg","name":"","category":"Routers"}]}"#,
        )
        .expect("write index");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        let named = lib.icons.iter().find(|i| i.id == "asr-9000-edge").expect("icon");
        // The index gave an empty name; the filename is better than blank.
        assert_eq!(named.name, "Asr 9000 Edge");
        let odd = lib.icons.iter().find(|i| i.id == "___").expect("icon");
        assert_eq!(odd.name, "___", "a filename with nothing to humanise stays itself");
        assert!(lib.icons.iter().all(|i| !i.name.is_empty()));
    }

    #[test]
    fn a_librarys_own_paperwork_is_not_a_failed_shape() {
        // A folder built by the fetch script carries index.json and a licence
        // file. Counting those as unreadable made a perfectly good library
        // report a problem it did not have.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(&root.join("router.svg"), SVG);
        write(&root.join("index.json"), "{}");
        write(&root.join("LICENCES.txt"), "MIT");
        let lib = super::scan(root.to_str().expect("path")).expect("scan");
        assert_eq!(lib.icons.len(), 1);
        assert!(lib.skipped.is_empty(), "skipped: {:?}", lib.skipped);
    }

    #[test]
    fn an_empty_folder_is_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = super::scan(dir.path().to_str().expect("path")).expect("scan");
        assert!(lib.icons.is_empty());
    }
}
