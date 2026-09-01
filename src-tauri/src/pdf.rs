//! The diagram as a PDF (LT-077).
//!
//! SVG and PNG are for a screen; a change record, an approval package or an
//! email to someone who will print it wants a PDF. The drawing is already
//! produced as an SVG placed on the chosen paper — this turns that same SVG
//! into a real vector PDF rather than a bitmap dropped on a page, so text
//! stays selectable and a plotter gets clean lines.
//!
//! Fonts: the SVG names a system sans stack. `usvg` resolves those against
//! the machine's own fonts and converts glyphs to paths, so the PDF renders
//! identically on a machine that has none of them.

/// Render one SVG document to PDF bytes.
pub fn svg_to_pdf(svg: &str) -> Result<Vec<u8>, String> {
    let mut options = svg2pdf::usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    // Point the generic families at fonts this machine actually has. usvg
    // defaults to "Times New Roman", and where that is not installed — any
    // stock Linux, and plenty of locked-down Windows builds — every label in
    // the diagram was silently dropped and the PDF came out as boxes and
    // lines with no device names on it at all.
    resolve_generic_families(&mut options);
    let tree = svg2pdf::usvg::Tree::from_str(svg, &options)
        .map_err(|e| format!("the diagram could not be read as SVG: {e}"))?;
    svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    )
    .map_err(|e| format!("the diagram could not be written as PDF: {e}"))
}

/// Bind `sans-serif` and friends to a family the machine has, so text is
/// never dropped for want of a font nobody installed.
fn resolve_generic_families(options: &mut svg2pdf::usvg::Options) {
    // In preference order: what the app's own stack asks for, then the
    // dependable open families, then whatever the machine does have.
    const SANS: [&str; 8] = [
        "Segoe UI Variable", "Segoe UI", "Inter", "Noto Sans",
        "DejaVu Sans", "Liberation Sans", "Arial", "Tuffy",
    ];
    let db = options.fontdb_mut();
    let has = |db: &svg2pdf::usvg::fontdb::Database, name: &str| {
        db.faces().any(|f| f.families.iter().any(|(fam, _)| fam == name))
    };
    let sans = SANS
        .iter()
        .find(|name| has(db, name))
        .map(|s| s.to_string())
        .or_else(|| {
            db.faces()
                .next()
                .and_then(|f| f.families.first().map(|(fam, _)| fam.clone()))
        });
    if let Some(family) = sans {
        db.set_sans_serif_family(family.clone());
        // The document asks for a sans stack; make that the default too, so
        // an unrecognised family name still lands on something readable.
        options.font_family = family;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIAGRAM: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="842" height="595" viewBox="0 0 842 595">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="40" y="40" width="180" height="90" fill="none" stroke="#0b5fce" stroke-width="2"/>
  <text x="50" y="80" font-family="sans-serif" font-size="14" fill="#1a1a1a">HOME-MAIN-SW</text>
  <line x1="220" y1="85" x2="420" y2="85" stroke="#2fbf6b" stroke-width="2"/>
</svg>"##;

    #[test]
    fn writes_a_real_pdf() {
        let bytes = svg_to_pdf(DIAGRAM).expect("convert");
        // A PDF is identified by its header and ends with the EOF marker;
        // anything else is a file that will not open.
        assert!(bytes.starts_with(b"%PDF-"), "not a PDF: {:?}", &bytes[..8.min(bytes.len())]);
        let tail = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(32)..]).to_string();
        assert!(tail.contains("%%EOF"), "no EOF marker: {tail}");
        // Vector, not a bitmap of the page: an image XObject would be far
        // larger than the handful of paths this diagram holds.
        assert!(bytes.len() > 400, "suspiciously small: {} bytes", bytes.len());
    }

    #[test]
    fn the_page_keeps_the_diagram_size() {
        let bytes = svg_to_pdf(DIAGRAM).expect("convert");
        let text = String::from_utf8_lossy(&bytes);
        // 842x595 at 72 dpi is the A4 landscape box the SVG asked for.
        assert!(text.contains("842") && text.contains("595"), "page box missing");
    }

    /// A diagram shaped the way `renderDiagramSvg` emits one — title block,
    /// devices, a link with a port label — written out so it can be opened
    /// and looked at rather than only asserted about.
    #[test]
    fn a_realistic_diagram_converts_and_is_written_out() {
        let svg = r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="842" height="595" viewBox="0 0 842 595" font-family="ui-sans-serif, Segoe UI, Roboto, sans-serif">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="0" y="0" width="842" height="86" fill="#f1f1f1"/>
  <text x="18" y="30" fill="#1a1a1a" font-size="18" font-weight="600">Lab network</text>
  <text x="18" y="52" fill="#4d4d4d" font-size="12">Coreview - exported for a change record</text>
  <g transform="translate(48,140)">
    <rect x="0" y="0" width="176" height="96" rx="6" fill="none" stroke="#0b5fce" stroke-width="1.5"/>
    <text x="12" y="28" font-size="12" font-weight="600" fill="#1a1a1a">9300-LAB</text>
    <text x="12" y="46" font-size="10" fill="#4d4d4d">192.168.14.20</text>
    <line x1="176" y1="48" x2="420" y2="48" stroke="#0a8a3f" stroke-width="2"/>
    <text x="270" y="40" font-size="10" fill="#4d4d4d">Po1</text>
    <rect x="420" y="0" width="176" height="96" rx="6" fill="none" stroke="#0b5fce" stroke-width="1.5"/>
    <text x="432" y="28" font-size="12" font-weight="600" fill="#1a1a1a">Cisco-Rack1-3850</text>
    <text x="432" y="46" font-size="10" fill="#4d4d4d">192.168.14.111</text>
  </g>
</svg>"##;
        let bytes = svg_to_pdf(svg).expect("convert");
        assert!(bytes.starts_with(b"%PDF-"));
        let out = std::env::temp_dir().join("coreview-pdf-check.pdf");
        std::fs::write(&out, &bytes).expect("write");
        eprintln!("wrote {} ({} bytes)", out.display(), bytes.len());
    }

    #[test]
    fn rubbish_is_refused_in_words_rather_than_a_panic() {
        let err = svg_to_pdf("this is not an svg").unwrap_err();
        assert!(err.contains("could not be read"), "{err}");
    }
}

#[cfg(test)]
mod text_check {
    use super::*;

    /// A device name that does not reach the PDF is a diagram nobody can
    /// read. Text must arrive as glyph outlines (usvg converts it against
    /// the system fonts), so a page of pure text must not come out empty.
    #[test]
    fn device_names_reach_the_page() {
        let only_text = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100">
  <text x="10" y="50" font-family="sans-serif" font-size="20" fill="#000000">HOME-MAIN-SW</text>
</svg>"##;
        let bytes = svg_to_pdf(only_text).expect("convert");
        let text = String::from_utf8_lossy(&bytes);
        // Either glyph outlines (drawing operators) or an embedded font.
        let has_paths = text.contains(" m\n") || text.contains(" l\n") || text.contains(" c\n");
        let has_font = text.contains("/Font");
        assert!(
            has_paths || has_font,
            "the text vanished: {} bytes, no glyphs and no font",
            bytes.len()
        );
    }
}
