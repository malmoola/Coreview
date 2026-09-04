//! EMF/WMF → SVG for the icon library.
//!
//! A vendor shape arrives as an EMF more often than as an SVG. LibreOffice
//! can draw it, so when a library folder contains EMF or WMF files they are
//! converted through `soffice` at scan time instead of being counted and
//! refused. The conversion has the same two problems the PPTX pipeline
//! (scripts/import-pptx-stencils.mjs) solved, and this module is a port of
//! its answers: LibreOffice puts the artwork in the corner of a full A4 page
//! (the "Untitled Drawing" speck), so the viewBox is cropped to the real
//! content; and it writes embedded bitmaps with a negative height, which is
//! invalid SVG drawn upside down, so those are rewritten as positive
//! geometry plus an explicit mirror. Change one port and change the other.

use base64::Engine as _;
use std::path::{Path, PathBuf};

/// Every point a path's commands touch, control points included — enough for
/// a bounding box, which is all the crop needs.
pub fn path_points(d: &str) -> Vec<(f64, f64)> {
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in d.chars() {
        if ch.is_ascii_alphabetic() {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
            tokens.push(ch.to_string());
        } else if ch.is_ascii_digit() || ch == '.' || ch == 'e' || ch == 'E' {
            cur.push(ch);
        } else if ch == '-' {
            // A minus both separates numbers and signs the next one: "10-20"
            // is two tokens, "1e-5" is one.
            if cur.ends_with('e') || cur.ends_with('E') || cur.is_empty() {
                cur.push(ch);
            } else {
                tokens.push(std::mem::take(&mut cur));
                cur.push(ch);
            }
        } else if !cur.is_empty() {
            tokens.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }

    let mut out = Vec::new();
    let (mut x, mut y, mut sx, mut sy) = (0f64, 0f64, 0f64, 0f64);
    let mut i = 0usize;
    let mut cmd = ' ';
    let num = |i: &mut usize, tokens: &[String]| -> f64 {
        let v = tokens.get(*i).and_then(|t| t.parse().ok()).unwrap_or(0.0);
        *i += 1;
        v
    };
    while i < tokens.len() {
        if tokens[i].len() == 1 && tokens[i].chars().next().unwrap().is_ascii_alphabetic() {
            cmd = tokens[i].chars().next().unwrap();
            i += 1;
        }
        let rel = cmd.is_ascii_lowercase() && cmd != 'z';
        match cmd.to_ascii_uppercase() {
            'M' | 'L' | 'T' => {
                let (nx, ny) = (num(&mut i, &tokens), num(&mut i, &tokens));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                if cmd.eq_ignore_ascii_case(&'M') {
                    sx = x;
                    sy = y;
                }
                out.push((x, y));
            }
            'H' => {
                let n = num(&mut i, &tokens);
                x = if rel { x + n } else { n };
                out.push((x, y));
            }
            'V' => {
                let n = num(&mut i, &tokens);
                y = if rel { y + n } else { n };
                out.push((x, y));
            }
            'C' => {
                for _ in 0..2 {
                    let (cx, cy) = (num(&mut i, &tokens), num(&mut i, &tokens));
                    out.push((if rel { x + cx } else { cx }, if rel { y + cy } else { cy }));
                }
                let (nx, ny) = (num(&mut i, &tokens), num(&mut i, &tokens));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                out.push((x, y));
            }
            'S' | 'Q' => {
                let (cx, cy) = (num(&mut i, &tokens), num(&mut i, &tokens));
                out.push((if rel { x + cx } else { cx }, if rel { y + cy } else { cy }));
                let (nx, ny) = (num(&mut i, &tokens), num(&mut i, &tokens));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                out.push((x, y));
            }
            'A' => {
                i += 5;
                let (nx, ny) = (num(&mut i, &tokens), num(&mut i, &tokens));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                out.push((x, y));
            }
            'Z' => {
                x = sx;
                y = sy;
            }
            _ => i += 1,
        }
    }
    out
}

/// The value of `name="..."` inside one tag's text, if present.
fn attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let mut from = 0usize;
    while let Some(rel) = tag[from..].find(&needle) {
        let at = from + rel;
        // Must be a whole attribute name, not the tail of a longer one.
        let ok = at == 0
            || !tag.as_bytes()[at - 1].is_ascii_alphanumeric()
                && tag.as_bytes()[at - 1] != b'-'
                && tag.as_bytes()[at - 1] != b':';
        let start = at + needle.len();
        let end = tag[start..].find('"')?;
        if ok {
            return Some(tag[start..start + end].to_string());
        }
        from = start + end + 1;
    }
    None
}

/// Every `<tag ...>` occurrence, as the tag's own text.
fn tags<'a>(svg: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}");
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = svg[i..].find(&open) {
        let start = i + rel;
        // "<path" must not match "<pattern".
        let after = svg.as_bytes().get(start + open.len()).copied().unwrap_or(b'>');
        if after.is_ascii_alphanumeric() {
            i = start + open.len();
            continue;
        }
        let end = svg[start..].find('>').map(|p| start + p + 1).unwrap_or(svg.len());
        out.push(&svg[start..end]);
        i = end;
    }
    out
}

fn parse(v: Option<String>) -> Option<f64> {
    v.and_then(|s| s.parse().ok())
}

/// Rewrites the viewBox to the drawn content plus ~2% padding, and drops
/// width/height so the icon scales to its container. `None` when nothing
/// drawable was found.
pub fn crop_to_content(svg: &str) -> Option<String> {
    let mut pts: Vec<(f64, f64)> = Vec::new();
    for t in tags(svg, "path") {
        if let Some(d) = attr(t, "d") {
            pts.extend(path_points(&d));
        }
    }
    for t in tags(svg, "rect") {
        if let (Some(x), Some(y), Some(w), Some(h)) = (
            parse(attr(t, "x")),
            parse(attr(t, "y")),
            parse(attr(t, "width")),
            parse(attr(t, "height")),
        ) {
            pts.push((x, y));
            pts.push((x + w, y + h));
        }
    }
    for name in ["circle", "ellipse"] {
        for t in tags(svg, name) {
            let r = parse(attr(t, "r"))
                .or_else(|| parse(attr(t, "rx")))
                .or_else(|| parse(attr(t, "ry")));
            if let (Some(cx), Some(cy), Some(r)) =
                (parse(attr(t, "cx")), parse(attr(t, "cy")), r)
            {
                pts.push((cx - r, cy - r));
                pts.push((cx + r, cy + r));
            }
        }
    }
    for t in tags(svg, "image") {
        if let (Some(x), Some(y), Some(w), Some(h)) = (
            parse(attr(t, "x")),
            parse(attr(t, "y")),
            parse(attr(t, "width")),
            parse(attr(t, "height")),
        ) {
            pts.push((x, y));
            pts.push((x + w, y + h));
        }
    }
    if pts.is_empty() {
        return None;
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (x, y) in pts {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    let w = (max_x - min_x).max(1.0);
    let h = (max_y - min_y).max(1.0);
    let pad = w.max(h) * 0.02;
    let r2 = |n: f64| (n * 100.0).round() / 100.0;
    let vb = format!(
        "{} {} {} {}",
        r2(min_x - pad),
        r2(min_y - pad),
        r2(w + pad * 2.0),
        r2(h + pad * 2.0)
    );

    // Rewrite the root <svg> tag alone: drop viewBox/width/height, add ours.
    let start = svg.find("<svg")?;
    let end = svg[start..].find('>')? + start;
    let mut root = svg[start..=end].to_string();
    for name in ["viewBox", "width", "height"] {
        if let Some(v) = attr(&root, name) {
            root = root.replace(&format!(" {name}=\"{v}\""), "");
        }
    }
    root = root.replacen("<svg", &format!("<svg viewBox=\"{vb}\""), 1);
    Some(format!("{}{}{}", &svg[..start], root, &svg[end + 1..]))
}

/// LibreOffice writes EMF bitmaps bottom-up and leans on a negative height to
/// flip them — invalid SVG, drawn upside down where drawn at all, and
/// invisible to the crop. Positive geometry plus an explicit mirror says the
/// same thing legally.
pub fn normalize_images(svg: &str) -> String {
    let mut out = svg.to_string();
    for t in tags(svg, "image") {
        let (Some(x), Some(y), Some(w), Some(h)) = (
            parse(attr(t, "x")),
            parse(attr(t, "y")),
            parse(attr(t, "width")),
            parse(attr(t, "height")),
        ) else {
            continue;
        };
        if w >= 0.0 && h >= 0.0 {
            continue;
        }
        let (mut x, mut y, mut w, mut h) = (x, y, w, h);
        let mut flip = String::new();
        if h < 0.0 {
            y += h;
            h = -h;
            flip = format!(" transform=\"matrix(1 0 0 -1 0 {})\"", 2.0 * y + h);
        }
        if w < 0.0 {
            x += w;
            w = -w;
        }
        let mut fixed = t.to_string();
        for (name, v) in [("x", x), ("y", y), ("width", w), ("height", h)] {
            if let Some(old) = attr(&fixed, name) {
                fixed = fixed.replace(
                    &format!("{name}=\"{old}\""),
                    &format!("{name}=\"{v}\""),
                );
            }
        }
        fixed = fixed.replacen("<image", &format!("<image{flip}"), 1);
        out = out.replace(t, &fixed);
    }
    out
}

/// Drop the XML prolog, DOCTYPE, LibreOffice's boilerplate defs and the
/// page-sized clip wrappers — everything that is about the A4 page rather
/// than the drawing.
pub fn strip_cruft(svg: &str) -> String {
    let mut s = svg.to_string();
    for open in ["<?xml", "<!DOCTYPE"] {
        while let Some(start) = s.find(open) {
            let end = s[start..].find('>').map(|p| start + p + 1).unwrap_or(s.len());
            s.replace_range(start..end, "");
        }
    }
    // <defs class="...ClipPathGroup..."> ... </defs> and friends.
    loop {
        let mut removed = false;
        let mut i = 0usize;
        while let Some(rel) = s[i..].find("<defs") {
            let start = i + rel;
            let open_end = s[start..].find('>').map(|p| start + p + 1).unwrap_or(s.len());
            let head = &s[start..open_end];
            let boiler = ["ClipPathGroup", "EmbeddedBulletChars", "TextShapeIndex", "BackgroundShapes"]
                .iter()
                .any(|k| attr(head, "class").is_some_and(|c| c.contains(k)));
            if boiler {
                let close = s[start..]
                    .find("</defs>")
                    .map(|p| start + p + "</defs>".len())
                    .unwrap_or(s.len());
                s.replace_range(start..close, "");
                removed = true;
                break;
            }
            i = open_end;
        }
        if !removed {
            break;
        }
    }
    // A <g> that only carried the page clip contributes nothing without it.
    let mut i = 0usize;
    while let Some(rel) = s[i..].find("<g ") {
        let start = i + rel;
        let end = s[start..].find('>').map(|p| start + p + 1).unwrap_or(s.len());
        if attr(&s[start..end], "clip-path").is_some() && !s[start..end].contains("id=") {
            s.replace_range(start..end, "<g>");
        }
        i = start + 3;
    }
    for _ in 0..3 {
        while let Some(p) = s.find("<g></g>") {
            s.replace_range(p..p + "<g></g>".len(), "");
        }
        let mut changed = false;
        let mut j = 0usize;
        while let Some(rel) = s[j..].find("<g>") {
            let start = j + rel;
            let after = start + 3;
            let rest = s[after..].trim_start();
            if rest.starts_with("</g>") {
                let close = s[after..].find("</g>").unwrap() + after + 4;
                s.replace_range(start..close, "");
                changed = true;
            } else {
                j = after;
            }
        }
        if !changed {
            break;
        }
    }
    s
}

/// Which libvisio CLI reads a Visio file of this extension: stencils through
/// vss2xhtml, drawings through vsd2xhtml. `None` when it is not a Visio file.
pub fn visio_tool_for(ext: &str) -> Option<&'static str> {
    if ext.eq_ignore_ascii_case("vss") || ext.eq_ignore_ascii_case("vssx") {
        Some("vss2xhtml")
    } else if ext.eq_ignore_ascii_case("vsd") || ext.eq_ignore_ascii_case("vsdx") {
        Some("vsd2xhtml")
    } else {
        None
    }
}

/// LT-080: `libvisio-tools` is a Linux package with no Windows equivalent —
/// on Windows the CLIs are carried in `vendor/libvisio-win64` and installed
/// as a bundled resource (`src-tauri/tauri.windows.conf.json`) instead of
/// asking every operator to build libvisio themselves. `main.rs`'s `setup`
/// resolves that resource directory once, through the only place in this
/// crate with an `AppHandle`, and hands it here — which is why this is a
/// `set` rather than a parameter every caller in this module would
/// otherwise have to thread through. Every test, dev run and Linux build
/// leaves it unset, so `tool_command` falls straight through to `PATH`
/// exactly as it always did.
static TOOL_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Called once, from `main.rs`'s `setup`.
pub fn set_tool_dir(dir: Option<PathBuf>) {
    let _ = TOOL_DIR.set(dir);
}

/// The command to run for a libvisio CLI by name: the bundled copy if one
/// was set and the file is actually there, otherwise the bare name, which
/// `Command` resolves against `PATH` the way it always has.
fn tool_command(name: &str) -> PathBuf {
    resolve_tool(name, TOOL_DIR.get().and_then(|d| d.as_deref()))
}

/// The resolution `tool_command` does, as a pure function of an explicit
/// directory rather than the process-wide `TOOL_DIR` — a `OnceLock` can only
/// be set once per process, which makes it untestable directly in a test
/// binary that runs many tests together. This is what is actually under
/// test; `tool_command` is a one-line wrapper around it.
fn resolve_tool(name: &str, dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = dir {
        let candidate = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

/// Whether the libvisio CLIs are installed.
pub fn libvisio_available() -> bool {
    std::process::Command::new(tool_command("vss2xhtml"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

/// Split a `vss2xhtml`/`vsd2xhtml` document into standalone SVGs — one per
/// stencil master (or drawing page). The tools write every element with an
/// `svg:` prefix and no default namespace; browsers want the opposite, so
/// the prefix comes off and the namespace becomes the default. Attributes
/// arrive unprefixed already.
pub fn split_visio_xhtml(xhtml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = xhtml[i..].find("<svg:svg") {
        let start = i + rel;
        let Some(endrel) = xhtml[start..].find("</svg:svg>") else { break };
        let end = start + endrel + "</svg:svg>".len();
        let block = &xhtml[start..end];
        out.push(
            block
                .replace("<svg:", "<")
                .replace("</svg:", "</")
                .replace("xmlns:svg=", "xmlns="),
        );
        i = end;
    }
    out
}

/// Run the right libvisio CLI on one Visio file and return one standalone
/// SVG per master or page. The tools write XHTML to stdout.
pub fn convert_visio(path: &Path) -> Result<Vec<String>, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let tool = visio_tool_for(ext).ok_or_else(|| format!("not a Visio file: {ext}"))?;
    let out = std::process::Command::new(tool_command(tool))
        .arg(path)
        .output()
        .map_err(|e| format!("{tool} failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!("{tool}: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let xhtml = String::from_utf8_lossy(&out.stdout);
    let svgs = split_visio_xhtml(&xhtml);
    if svgs.is_empty() {
        return Err(format!("{tool} produced no drawings"));
    }
    Ok(resolve_embedded_metafiles(svgs))
}

/// One `<image>` found inside a master's SVG whose picture is an inline EMF
/// or WMF payload, pending conversion.
struct EmbeddedImage {
    master: usize,
    tag: String,
    ext: &'static str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bytes: Vec<u8>,
}

/// The slice of `s` up to and including its first `<svg ...>` open tag.
fn svg_open_tag(s: &str) -> &str {
    &s[..s.find('>').map(|p| p + 1).unwrap_or(s.len())]
}

/// LT-083: libvisio hands a stencil master back as an `<image>` pointing at
/// an inline `data:image/emf` or `data:image/wmf` payload — real Visio
/// artwork, but not something any webview rasterises from an SVG `<image>`
/// tag, so the master renders as a blank tile. Every embedded picture across
/// every master is decoded and run through `soffice` in one batched call —
/// the same conversion LT-003 already does for a standalone EMF file on
/// disk — then spliced back in as vector content, scaled onto the image's
/// original box. A picture soffice cannot draw keeps its `<image>` tag,
/// which stays a blank tile rather than failing the whole stencil.
fn resolve_embedded_metafiles(svgs: Vec<String>) -> Vec<String> {
    let mut found = Vec::new();
    for (master, svg) in svgs.iter().enumerate() {
        for t in tags(svg, "image") {
            let Some(href) = attr(t, "xlink:href").or_else(|| attr(t, "href")) else {
                continue;
            };
            let ext = if href.starts_with("data:image/emf;base64,") {
                "emf"
            } else if href.starts_with("data:image/wmf;base64,") {
                "wmf"
            } else {
                continue;
            };
            let Some((_, b64)) = href.split_once("base64,") else { continue };
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                continue;
            };
            let (Some(x), Some(y), Some(width), Some(height)) = (
                parse(attr(t, "x")),
                parse(attr(t, "y")),
                parse(attr(t, "width")),
                parse(attr(t, "height")),
            ) else {
                continue;
            };
            found.push(EmbeddedImage { master, tag: t.to_string(), ext, x, y, width, height, bytes });
        }
    }
    if found.is_empty() || !soffice_available() {
        return svgs;
    }
    let dir = unique_profile_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut files = Vec::new();
    for (i, item) in found.iter().enumerate() {
        let src = dir.join(format!("m{i}.{}", item.ext));
        if std::fs::write(&src, &item.bytes).is_ok() {
            files.push(src);
        }
    }
    let produced = convert_batch(&files, &dir).unwrap_or_default();
    let mut out = svgs;
    for (i, item) in found.iter().enumerate() {
        let stem = format!("m{i}");
        let Some(svg_path) =
            produced.iter().find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(stem.as_str()))
        else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(svg_path) else { continue };
        let Some(tidied) = tidy_converted(&raw) else { continue };
        let Some(vb) = attr(svg_open_tag(&tidied), "viewBox") else { continue };
        let nums: Vec<f64> = vb.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        if nums.len() != 4 || nums[2] == 0.0 || nums[3] == 0.0 {
            continue;
        }
        let (vx, vy, vw, vh) = (nums[0], nums[1], nums[2], nums[3]);
        let (sx, sy) = (item.width / vw, item.height / vh);
        let (tx, ty) = (item.x - vx * sx, item.y - vy * sy);
        let open_end = tidied.find('>').map(|p| p + 1).unwrap_or(0);
        let inner = tidied[open_end..].strip_suffix("</svg>").unwrap_or(&tidied[open_end..]);
        // The scale and offset are baked into every coordinate rather than
        // left as a wrapping `<g transform>`: crop_to_content, which runs on
        // this master again right after, reads path/rect/image coordinates
        // raw and does not follow a transform — a wrapped group would be
        // invisible to it and the master would crop to the picture's
        // original, unscaled extent.
        let wrapped = format!("<g>{}</g>", affine_transform(inner, sx, sy, tx, ty));
        out[item.master] = out[item.master].replacen(&item.tag, &wrapped, 1);
    }
    let _ = std::fs::remove_dir_all(&dir);
    out
}

/// Rewrite one numeric attribute by a linear map `v' = v*scale + shift`,
/// tolerating a trailing CSS unit like the `px` on libvisio/soffice's own
/// `font-size`. `None` when the tag has no such attribute.
fn map_attr(tag: &str, name: &str, scale: f64, shift: f64) -> Option<(String, String)> {
    let raw = attr(tag, name)?;
    let split = raw.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(raw.len());
    let (num, unit) = raw.split_at(split);
    let v: f64 = num.parse().ok()?;
    Some((raw.clone(), format!("{}{unit}", v * scale + shift)))
}

/// Bake `x' = x*sx + tx, y' = y*sy + ty` into every coordinate of a fragment
/// of already-converted SVG content: `<path d>`, and the point/size
/// attributes of `<rect>`, `<image>`, `<tspan>`, `<circle>` and `<ellipse>`.
/// Widths, radii and font sizes scale without translating. Written for
/// `resolve_embedded_metafiles`, which needs an embedded picture's geometry
/// already in the master's own coordinate space — see the note at its call
/// site for why a wrapping transform will not do.
type AttrScale = (&'static str, f64, f64);

fn affine_transform(svg: &str, sx: f64, sy: f64, tx: f64, ty: f64) -> String {
    let mut out = svg.to_string();
    for t in tags(svg, "path") {
        if let Some(d) = attr(t, "d") {
            let scaled = scale_path_d(&d, sx, sy, tx, ty);
            let fixed = t.replacen(&format!("d=\"{d}\""), &format!("d=\"{scaled}\""), 1);
            out = out.replace(t, &fixed);
        }
    }
    let by_tag: &[(&str, &[AttrScale])] = &[
        ("rect", &[("x", sx, tx), ("y", sy, ty), ("width", sx, 0.0), ("height", sy, 0.0)]),
        ("image", &[("x", sx, tx), ("y", sy, ty), ("width", sx, 0.0), ("height", sy, 0.0)]),
        (
            "tspan",
            &[("x", sx, tx), ("y", sy, ty), ("font-size", (sx + sy) / 2.0, 0.0), ("textLength", sx, 0.0)],
        ),
        ("circle", &[("cx", sx, tx), ("cy", sy, ty), ("r", (sx + sy) / 2.0, 0.0)]),
        ("ellipse", &[("cx", sx, tx), ("cy", sy, ty), ("rx", sx, 0.0), ("ry", sy, 0.0)]),
    ];
    for (tagname, attrs) in by_tag {
        let snapshot = out.clone();
        for t in tags(&snapshot, tagname) {
            let mut fixed = t.to_string();
            for (name, scale, shift) in *attrs {
                if let Some((old, new)) = map_attr(t, name, *scale, *shift) {
                    fixed = fixed.replace(&format!("{name}=\"{old}\""), &format!("{name}=\"{new}\""));
                }
            }
            out = out.replace(t, &fixed);
        }
    }
    out
}

/// Rewrite a path's `d` attribute by the same linear map `affine_transform`
/// applies elsewhere: absolute coordinates get the full affine; a relative
/// command's deltas get only the scale, since a translate cancels out of
/// the difference between two already-translated points. The tokeniser and
/// command table are `path_points`'s, copied rather than shared, because the
/// two walk the same syntax for different reasons — one measures, one
/// rewrites — and a change to how one reads a command letter must change
/// the other identically.
fn scale_path_d(d: &str, sx: f64, sy: f64, tx: f64, ty: f64) -> String {
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in d.chars() {
        if ch.is_ascii_alphabetic() {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
            tokens.push(ch.to_string());
        } else if ch.is_ascii_digit() || ch == '.' || ch == 'e' || ch == 'E' {
            cur.push(ch);
        } else if ch == '-' {
            if cur.ends_with('e') || cur.ends_with('E') || cur.is_empty() {
                cur.push(ch);
            } else {
                tokens.push(std::mem::take(&mut cur));
                cur.push(ch);
            }
        } else if !cur.is_empty() {
            tokens.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }

    let mut out = String::new();
    let mut i = 0usize;
    let mut cmd = ' ';
    let num = |i: &mut usize, tokens: &[String]| -> f64 {
        let v = tokens.get(*i).and_then(|t| t.parse().ok()).unwrap_or(0.0);
        *i += 1;
        v
    };
    while i < tokens.len() {
        if tokens[i].len() == 1 && tokens[i].chars().next().unwrap().is_ascii_alphabetic() {
            cmd = tokens[i].chars().next().unwrap();
            out.push(cmd);
            i += 1;
        }
        let rel = cmd.is_ascii_lowercase() && cmd != 'z';
        let (ox, oy) = if rel { (0.0, 0.0) } else { (tx, ty) };
        match cmd.to_ascii_uppercase() {
            'M' | 'L' | 'T' => {
                let x = num(&mut i, &tokens) * sx + ox;
                let y = num(&mut i, &tokens) * sy + oy;
                out.push_str(&format!(" {x} {y}"));
            }
            'H' => {
                let x = num(&mut i, &tokens) * sx + ox;
                out.push_str(&format!(" {x}"));
            }
            'V' => {
                let y = num(&mut i, &tokens) * sy + oy;
                out.push_str(&format!(" {y}"));
            }
            'C' => {
                for _ in 0..3 {
                    let x = num(&mut i, &tokens) * sx + ox;
                    let y = num(&mut i, &tokens) * sy + oy;
                    out.push_str(&format!(" {x} {y}"));
                }
            }
            'S' | 'Q' => {
                for _ in 0..2 {
                    let x = num(&mut i, &tokens) * sx + ox;
                    let y = num(&mut i, &tokens) * sy + oy;
                    out.push_str(&format!(" {x} {y}"));
                }
            }
            'A' => {
                let rx = num(&mut i, &tokens) * sx;
                let ry = num(&mut i, &tokens) * sy;
                let rot = num(&mut i, &tokens);
                let large = num(&mut i, &tokens);
                let sweep = num(&mut i, &tokens);
                let x = num(&mut i, &tokens) * sx + ox;
                let y = num(&mut i, &tokens) * sy + oy;
                out.push_str(&format!(" {rx} {ry} {rot} {large} {sweep} {x} {y}"));
            }
            'Z' => {}
            _ => i += 1,
        }
        out.push(' ');
    }
    out
}

/// Whether `soffice` is runnable here.
pub fn soffice_available() -> bool {
    std::process::Command::new("soffice")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Convert a batch of EMF/WMF files to SVG in `out_dir`, one soffice call for
/// the lot. Returns the paths written. soffice exits non-zero when any single
/// file will not load, even with the rest converted fine, so the exit code is
/// not the verdict — a file with no output is the failure, and the caller
/// reports those by name. Only a soffice that cannot start at all is an error.
pub fn convert_batch(files: &[PathBuf], out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    // LT-070: soffice serialises on a shared user profile, so two conversions
    // at once — cargo's parallel tests, or a user who already has LibreOffice
    // open — collided and one silently produced nothing. A private profile
    // per invocation removes the lock entirely.
    let profile = unique_profile_dir();
    let _ = std::fs::create_dir_all(&profile);
    let mut cmd = std::process::Command::new("soffice");
    cmd.arg(format!("-env:UserInstallation=file://{}", profile.display()))
        .args(["--headless", "--convert-to", "svg", "--outdir"])
        .arg(out_dir);
    for f in files {
        cmd.arg(f);
    }
    let result = cmd.output().map_err(|e| format!("soffice failed to start: {e}"));
    let produced = files
        .iter()
        .filter_map(|f| {
            let candidate = out_dir.join(f.file_stem()?).with_extension("svg");
            candidate.exists().then_some(candidate)
        })
        .collect();
    let _ = std::fs::remove_dir_all(&profile);
    result?;
    Ok(produced)
}

/// A temp directory unique to this invocation, for a soffice profile that no
/// other soffice shares. Process id plus a monotonic counter and the clock is
/// enough for the concurrency this sees.
fn unique_profile_dir() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("coreview-soffice-{}-{}-{}", std::process::id(), n, nanos))
}

/// The full treatment for one LibreOffice-made SVG: cruft off, bitmaps made
/// legal, viewBox cropped to the drawing. `None` when there is nothing drawn.
pub fn tidy_converted(svg: &str) -> Option<String> {
    crop_to_content(&normalize_images(&strip_cruft(svg)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// LT-080: on Windows, `vss2xhtml` is not on `PATH` — it has to resolve
    /// to the bundled copy `main.rs` points at, and it has to do that
    /// without breaking every other test's plain `vss2xhtml` (which is what
    /// `libvisio_available`'s tests rely on here on Linux, where it *is* on
    /// `PATH`). `resolve_tool` is the resolution logic pulled out into a
    /// pure function precisely so this can be tested without touching the
    /// real `TOOL_DIR`, which — being a `OnceLock` — can only be set once
    /// for the lifetime of the test binary.
    #[test]
    fn the_bundled_tool_wins_when_it_is_actually_there() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe_name = format!("vss2xhtml{}", std::env::consts::EXE_SUFFIX);
        std::fs::write(dir.path().join(&exe_name), "not really an executable").unwrap();

        let resolved = resolve_tool("vss2xhtml", Some(dir.path()));
        assert_eq!(resolved, dir.path().join(&exe_name));
    }

    #[test]
    fn a_missing_bundle_falls_back_to_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Nothing written into `dir`: the bundle directory exists but this
        // particular tool isn't in it.
        let resolved = resolve_tool("vss2xhtml", Some(dir.path()));
        assert_eq!(resolved, std::path::PathBuf::from("vss2xhtml"));
    }

    #[test]
    fn no_bundle_at_all_falls_back_to_path() {
        let resolved = resolve_tool("vss2xhtml", None);
        assert_eq!(resolved, std::path::PathBuf::from("vss2xhtml"));
    }

    const LO_STYLE_SVG: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 21000 29700">
 <defs class="ClipPathGroup"><clipPath id="p"><rect x="0" y="0" width="21000" height="29700"/></clipPath></defs>
 <g clip-path="url(#p)">
  <g><path d="M 500,400 L 1500,400 L 1500,1200 L 500,1200 Z" fill="#049fd9"/></g>
  <g></g>
 </g>
</svg>"##;

    #[test]
    fn crops_the_page_down_to_the_artwork() {
        // Same fixture and numbers as the JS pipeline's test: a 1000x800 icon
        // on an A4 page must not render as a speck.
        let out = tidy_converted(LO_STYLE_SVG).unwrap();
        let vb = attr(&out[out.find("<svg").unwrap()..], "viewBox").unwrap();
        let n: Vec<f64> = vb.split(' ').map(|v| v.parse().unwrap()).collect();
        assert!((n[0] - 480.0).abs() < 1.0, "{vb}");
        assert!((n[2] - 1040.0).abs() < 1.0, "{vb}");
        assert!((n[3] - 840.0).abs() < 1.0, "{vb}");
        assert!(!out.contains("width=\"210mm\""));
        assert!(!out.contains("height=\"297mm\""));
        assert!(!out.contains("DOCTYPE"));
        assert!(!out.contains("ClipPathGroup"));
        assert!(!out.contains("clip-path="));
    }

    #[test]
    fn follows_relative_path_commands() {
        let svg = r#"<svg viewBox="0 0 21000 29700"><path d="m 100,100 l 50,0 l 0,50 z"/></svg>"#;
        let out = crop_to_content(svg).unwrap();
        let vb = attr(&out, "viewBox").unwrap();
        let n: Vec<f64> = vb.split(' ').map(|v| v.parse().unwrap()).collect();
        assert!(n[0] < 100.0, "{vb}");
        assert!(n[0] + n[2] > 150.0 && n[0] + n[2] < 200.0, "{vb}");
    }

    #[test]
    fn an_image_extent_widens_the_box() {
        let svg = r#"<svg viewBox="0 0 21000 29700"><path d="M 1000,1000 L 1010,1000 L 1010,1010 Z"/><image x="500" y="400" width="1600" height="700" xlink:href="data:image/png;base64,x"/></svg>"#;
        let out = crop_to_content(svg).unwrap();
        let vb = attr(&out, "viewBox").unwrap();
        let n: Vec<f64> = vb.split(' ').map(|v| v.parse().unwrap()).collect();
        assert!(n[0] <= 500.0, "{vb}");
        assert!(n[0] + n[2] >= 2100.0, "{vb}");
    }

    #[test]
    fn a_negative_height_image_becomes_legal_svg() {
        let svg = r#"<svg viewBox="0 0 21000 29700"><image x="10039" y="15301" width="903" height="-903" xlink:href="data:image/png;base64,x"/></svg>"#;
        let out = normalize_images(svg);
        assert!(out.contains("y=\"14398\""), "{out}");
        assert!(out.contains("height=\"903\""), "{out}");
        assert!(out.contains("matrix(1 0 0 -1 0 29699)"), "{out}");
    }

    #[test]
    fn visio_xhtml_splits_into_standalone_svgs() {
        // The shape of vss2xhtml/vsd2xhtml output, reduced: svg:-prefixed
        // elements, unprefixed attributes, one svg:svg per master or page.
        let xhtml = r#"<html xmlns:svg="http://www.w3.org/2000/svg"><body>
<svg:svg version="1.1" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<svg:g><svg:path d="M0 0 L10 10"/></svg:g>
</svg:svg>
<svg:svg version="1.1" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
<svg:rect x="1" y="1" width="10" height="10"/>
</svg:svg>
</body></html>"#;
        let svgs = split_visio_xhtml(xhtml);
        assert_eq!(svgs.len(), 2, "one SVG per master");
        assert!(svgs[0].starts_with("<svg "), "prefix must come off: {}", &svgs[0][..40]);
        assert!(svgs[0].contains(r#"xmlns="http://www.w3.org/2000/svg""#), "{}", svgs[0]);
        assert!(svgs[0].contains(r#"<path d="M0 0 L10 10"/>"#), "{}", svgs[0]);
        assert!(!svgs[0].contains("svg:"), "no prefixes may remain: {}", svgs[0]);
        assert!(svgs[1].contains("<rect"), "{}", svgs[1]);
    }

    #[test]
    fn the_right_tool_reads_each_visio_extension() {
        assert_eq!(visio_tool_for("vss"), Some("vss2xhtml"));
        assert_eq!(visio_tool_for("VSSX"), Some("vss2xhtml"));
        assert_eq!(visio_tool_for("vsd"), Some("vsd2xhtml"));
        assert_eq!(visio_tool_for("vsdx"), Some("vsd2xhtml"));
        assert_eq!(visio_tool_for("svg"), None);
    }

    /// Against a real drawing from libvisio's own test suite (MPL, committed
    /// as a fixture). Skips where libvisio-tools is not installed — the CI
    /// runners — the way the soffice-gated test does.
    #[test]
    fn a_real_visio_drawing_converts() {
        if !libvisio_available() {
            eprintln!("skipping: libvisio-tools not installed here");
            return;
        }
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/blue-box.vsdx");
        let svgs = convert_visio(&fixture).expect("convert");
        assert!(!svgs.is_empty());
        assert!(svgs[0].contains("<svg "), "{}", &svgs[0][..60.min(svgs[0].len())]);
        assert!(!svgs[0].contains("svg:"));
    }

    /// LT-070: soffice serialises on a shared user profile, so two
    /// conversions at once (cargo's parallel tests, or a user with
    /// LibreOffice already open) collided and one produced nothing. Each
    /// invocation must now carry its own profile. Skips without soffice.
    #[test]
    fn concurrent_conversions_do_not_collide() {
        if !soffice_available() {
            eprintln!("skipping: soffice not installed here");
            return;
        }
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/sample.emf");
        let dirs: Vec<tempfile::TempDir> = (0..4).map(|_| tempfile::tempdir().unwrap()).collect();
        let handles: Vec<_> = dirs
            .iter()
            .map(|d| {
                let out = d.path().to_path_buf();
                let fx = fixture.clone();
                std::thread::spawn(move || convert_batch(&[fx], &out).map(|v| v.len()))
            })
            .collect();
        for h in handles {
            let n = h.join().unwrap().expect("convert");
            assert_eq!(n, 1, "a concurrent conversion produced nothing");
        }
    }

    #[test]
    fn nothing_drawable_is_not_an_icon() {
        assert!(tidy_converted("<svg viewBox=\"0 0 10 10\"></svg>").is_none());
    }
}
