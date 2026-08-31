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
    let mut cmd = std::process::Command::new("soffice");
    cmd.args(["--headless", "--convert-to", "svg", "--outdir"]).arg(out_dir);
    for f in files {
        cmd.arg(f);
    }
    cmd.output().map_err(|e| format!("soffice failed to start: {e}"))?;
    Ok(files
        .iter()
        .filter_map(|f| {
            let candidate = out_dir.join(f.file_stem()?).with_extension("svg");
            candidate.exists().then_some(candidate)
        })
        .collect())
}

/// The full treatment for one LibreOffice-made SVG: cruft off, bitmaps made
/// legal, viewBox cropped to the drawing. `None` when there is nothing drawn.
pub fn tidy_converted(svg: &str) -> Option<String> {
    crop_to_content(&normalize_images(&strip_cruft(svg)))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn nothing_drawable_is_not_an_icon() {
        assert!(tidy_converted("<svg viewBox=\"0 0 10 10\"></svg>").is_none());
    }
}
