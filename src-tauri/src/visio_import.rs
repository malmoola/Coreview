//! Reading a Visio drawing back as a topology (LT-110).
//!
//! The inverse of `visio.rs`. That module writes a `.vsdx` — shapes with
//! `<Text>`, connectors, and a `<Connects>` section gluing them — and this one
//! reads the same structure back out of somebody else's drawing.
//!
//! A `.vsdx` is OPC: plain XML inside a ZIP. `visio/pages/pageN.xml` holds the
//! shapes; `<Connects>` says which connector is glued to which shape. That
//! part is mechanical. Turning it into *devices with addresses and ports* is
//! not, because a drawing is a picture and the meaning is in a house style.
//!
//! What the sample drawings actually taught us, each of which shaped the code
//! below rather than being guessed at:
//!
//! - **The page XML is not always UTF-8.** One real file is UTF-16 with no
//!   BOM assumptions worth making. Read it as UTF-8 and you get an empty
//!   document and report "no shapes" — a silent wrong answer, the worst kind.
//!   `decode_xml` sniffs instead.
//! - **The caption is usually a separate shape.** A device icon frequently has
//!   no text of its own; `_ADMIN_SWITCH 172.16.2.17` is a text block sitting
//!   underneath it. So a name is found by proximity — and the first attempt
//!   grabbed the *port* label, because `Eth1/43` is often nearer to the icon
//!   than the caption is. Text has to be classified before it is chosen.
//! - **The master name is the device type, and often the model.** `ASA 5500`,
//!   `Workgroup switch`, `N9K-C93180YC-EX Front`. Free and reliable.
//! - **Shape Data beats every heuristic where it exists.** A connector
//!   carrying `Port_A_Port_Name` and `Port_A_IP_Address` has already filled in
//!   the link model; nothing should be inferred over the top of it.
//! - **Not every producer glues its connectors.** A Lucidchart export writes
//!   `com.lucidchart.Line` and no `<Connects>` at all. Those drawings carry no
//!   authoritative link data, so this reports what it found and says plainly
//!   that the links are missing rather than inventing them.

use std::collections::HashMap;
use std::io::Read;

use serde::Serialize;

/// One device read out of a drawing.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDevice {
    /// The shape's id within its page, so links can refer to it.
    pub id: String,
    /// Best available name: the shape's own text, else the nearest caption,
    /// else the master name.
    pub label: String,
    /// Addresses found in the caption.
    pub addresses: Vec<String>,
    /// Coreview device type, mapped from the master name.
    pub device_type: String,
    /// The master name verbatim — `N9K-C93180YC-EX Front` is a model number
    /// worth keeping even when the type mapping has already used it.
    pub model: String,
    /// Anything the drawing carried as Shape Data, kept as-is.
    pub properties: HashMap<String, String>,
    pub x: f64,
    pub y: f64,
}

/// One link read out of a drawing.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedLink {
    pub source: String,
    pub target: String,
    pub label: String,
    pub source_port: String,
    pub target_port: String,
    /// True when the connector was glued in the drawing. A false here means
    /// the link was inferred from geometry and should be reviewed, never
    /// presented as fact.
    pub glued: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPage {
    pub name: String,
    pub devices: Vec<ImportedDevice>,
    pub links: Vec<ImportedLink>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisioImport {
    pub pages: Vec<ImportedPage>,
    /// Things the reader wants the operator to know: a page with shapes but no
    /// glue, an unreadable page. Surfaced rather than logged, because a
    /// silently partial import is indistinguishable from a complete one.
    pub warnings: Vec<String>,
}

/// Decodes page XML, sniffing UTF-16 rather than assuming UTF-8.
///
/// Visio writes some files as UTF-16. Without this, such a page parses as an
/// empty document and the import reports no shapes at all.
pub fn decode_xml(bytes: &[u8]) -> String {
    let utf16le = bytes.starts_with(&[0xFF, 0xFE]);
    let utf16be = bytes.starts_with(&[0xFE, 0xFF]);
    // No BOM is not proof of UTF-8: one sample had none. Interleaved zero
    // bytes in ASCII-heavy XML are the giveaway.
    let looks_utf16 = !utf16le
        && !utf16be
        && bytes.len() > 32
        && bytes[..64.min(bytes.len())].iter().filter(|b| **b == 0).count() > 8;

    if utf16le || utf16be || looks_utf16 {
        let body = if utf16le || utf16be { &bytes[2..] } else { bytes };
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| {
                if utf16be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// A raw shape, before it is decided whether it is a device or a connector.
#[derive(Debug, Clone, Default)]
struct RawShape {
    id: String,
    master: String,
    text: String,
    x: Option<f64>,
    y: Option<f64>,
    props: HashMap<String, String>,
    /// A connector has begin/end geometry; a device does not.
    has_ends: bool,
    /// Where a connector starts and finishes, used to find the port label
    /// sitting beside each end.
    begin: Option<(f64, f64)>,
    end: Option<(f64, f64)>,
}

/// Maps a Visio master name onto a Coreview device type.
///
/// Ordered longest-idea-first: "wireless controller" must be tested before
/// "wireless", and "core switch" before "switch", or the coarser word wins and
/// every switch in the drawing arrives generic.
pub fn device_type_for(master: &str) -> &'static str {
    let m = master.to_ascii_lowercase();
    const RULES: &[(&str, &str)] = &[
        ("wireless controller", "wireless-controller"),
        ("wlc", "wireless-controller"),
        ("access point", "access-point"),
        ("wireless", "access-point"),
        ("firewall", "firewall"),
        ("asa", "firewall"),
        ("palo alto", "firewall"),
        ("fortigate", "firewall"),
        ("core switch", "core-switch"),
        ("distribution", "distribution-switch"),
        ("l3 switch", "core-switch"),
        ("layer 3 switch", "core-switch"),
        ("workgroup switch", "access-switch"),
        ("access switch", "access-switch"),
        ("switch", "access-switch"),
        ("router", "router"),
        ("internet", "internet"),
        ("cloud", "internet"),
        ("server", "server"),
        ("storage", "storage"),
        ("printer", "printer"),
        ("camera", "camera"),
        ("phone", "endpoint"),
        ("pc", "endpoint"),
        ("laptop", "endpoint"),
    ];
    for (needle, kind) in RULES {
        if m.contains(needle) {
            return kind;
        }
    }
    // Cisco model prefixes, where the master is a part number rather than a
    // word: N9K/N5K/N2K are Nexus switches, WS-C is a Catalyst, C9500 a
    // Catalyst 9500. Worth recognising because these drawings are full of them.
    if m.starts_with("n9k") || m.starts_with("n5k") || m.starts_with("n7k") {
        return "core-switch";
    }
    if m.starts_with("n2k") || m.starts_with("ws-c") || m.starts_with("c9") || m.starts_with("ms") {
        return "access-switch";
    }
    "generic"
}

/// Whether a piece of text is an interface name rather than a device name.
///
/// This is what stops a caption search returning `Eth1/43`: a port label often
/// sits nearer an icon than the icon's own caption does. Deliberately strict —
/// it must match the *whole* string, so `Main-fw01 10.1.1.42` is a name even
/// though it contains digits and slashes elsewhere.
pub fn is_port_label(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.len() > 24 {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "gi", "te", "fa", "eth", "et", "se", "po", "vl", "xe", "ge", "port", "twe", "fo", "hu",
    ];
    let Some(p) = PREFIXES.iter().find(|p| lower.starts_with(**p)) else {
        return false;
    };
    let rest = lower[p.len()..].trim_start_matches(|c: char| c.is_alphabetic());
    let rest = rest.trim_start();
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_digit() || c == '/' || c == '.' || c == '-' || c == ':')
}

/// Every IPv4 address in a string, without a regex crate.
pub fn addresses_in(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut octets = 0;
        let mut ok = true;
        let mut j = i;
        while octets < 4 {
            let ds = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let len = j - ds;
            if len == 0 || len > 3 {
                ok = false;
                break;
            }
            let val: u32 = bytes[ds..j].iter().collect::<String>().parse().unwrap_or(999);
            if val > 255 {
                ok = false;
                break;
            }
            octets += 1;
            if octets < 4 {
                if j < bytes.len() && bytes[j] == '.' {
                    j += 1;
                } else {
                    ok = false;
                    break;
                }
            }
        }
        if ok && octets == 4 {
            // Not part of a longer number-ish token (a version string, say).
            let after_ok = j >= bytes.len() || !bytes[j].is_ascii_digit();
            let before_ok = start == 0 || !bytes[start - 1].is_ascii_digit();
            if after_ok && before_ok {
                out.push(bytes[start..j].iter().collect());
                i = j;
                continue;
            }
        }
        i = start + 1;
    }
    out
}

/// The device name inside a caption, with any address stripped off.
///
/// Real captions run the two together: `Main-fw01 10.1.1.42`, and sometimes
/// with no space at all — `Main vpn0110.0.1.50`. Removing the address text
/// leaves the name.
pub fn name_without_address(caption: &str) -> String {
    let mut s = caption.to_string();
    for a in addresses_in(caption) {
        s = s.replace(&a, " ");
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn cell(node: roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .filter(|c| c.has_tag_name("Cell"))
        .find(|c| c.attribute("N") == Some(name))
        .and_then(|c| c.attribute("V"))
        .map(|s| s.to_string())
}

fn shape_text(node: roxmltree::Node) -> String {
    let Some(t) = node.children().find(|c| c.has_tag_name("Text")) else {
        return String::new();
    };
    // Text holds character-run markers (<cp/>, <fld/>) between the words;
    // descendant text nodes in order is the readable string.
    let raw: String = t.descendants().filter(|n| n.is_text()).filter_map(|n| n.text()).collect();
    raw.split('\n')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn shape_props(node: roxmltree::Node) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for sec in node.children().filter(|c| c.has_tag_name("Section")) {
        if sec.attribute("N") != Some("Property") {
            continue;
        }
        for row in sec.children().filter(|c| c.has_tag_name("Row")) {
            let key = row
                .children()
                .filter(|c| c.has_tag_name("Cell"))
                .find(|c| c.attribute("N") == Some("Label"))
                .and_then(|c| c.attribute("V"))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| row.attribute("N").map(|s| s.to_string()));
            let val = row
                .children()
                .filter(|c| c.has_tag_name("Cell"))
                .find(|c| c.attribute("N") == Some("Value"))
                .and_then(|c| c.attribute("V"));
            if let (Some(k), Some(v)) = (key, val) {
                if !v.is_empty() {
                    out.insert(k, v.to_string());
                }
            }
        }
    }
    out
}

/// Flattens every shape on a page, including shapes nested inside groups.
fn collect_shapes(node: roxmltree::Node, out: &mut Vec<RawShape>) {
    for shape in node.children().filter(|c| c.has_tag_name("Shape")) {
        let id = shape.attribute("ID").unwrap_or_default().to_string();
        if !id.is_empty() {
            let master = shape
                .attribute("NameU")
                .or_else(|| shape.attribute("Name"))
                .unwrap_or_default();
            // `Router.42` is the 42nd copy of the Router master, not a
            // different kind of thing.
            let master = master
                .rsplit_once('.')
                .filter(|(_, n)| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty())
                .map(|(head, _)| head)
                .unwrap_or(master)
                .to_string();
            let num = |n: &str| cell(shape, n).and_then(|v| v.parse::<f64>().ok());
            let (bx, by, ex, ey) = (num("BeginX"), num("BeginY"), num("EndX"), num("EndY"));
            out.push(RawShape {
                id,
                master,
                text: shape_text(shape),
                x: num("PinX"),
                y: num("PinY"),
                props: shape_props(shape),
                has_ends: bx.is_some() && ex.is_some(),
                begin: bx.zip(by),
                end: ex.zip(ey),
            });
        }
        // Groups hold their members in a nested <Shapes>.
        for inner in shape.children().filter(|c| c.has_tag_name("Shapes")) {
            collect_shapes(inner, out);
        }
    }
}

/// The nearest text that reads like a name rather than a port.
fn caption_near(target: &RawShape, shapes: &[RawShape]) -> String {
    let (Some(tx), Some(ty)) = (target.x, target.y) else {
        return String::new();
    };
    // Inches. Beyond roughly this, the text belongs to a different icon.
    let mut best = String::new();
    let mut best_d = 1.5_f64;
    for s in shapes {
        if s.id == target.id || s.text.is_empty() || s.has_ends {
            continue;
        }
        if is_port_label(&s.text) {
            continue;
        }
        let (Some(sx), Some(sy)) = (s.x, s.y) else { continue };
        let d = ((sx - tx).powi(2) + (sy - ty).powi(2)).sqrt();
        if d < best_d {
            best_d = d;
            best = s.text.clone();
        }
    }
    best
}

/// Splits `Gi1/2 <> Eth1/4` into the two ports it names.
///
/// The dominant convention in the sample drawings: a floating text shape
/// beside each link naming both ends at once. Accepted only when *both* halves
/// look like interfaces, so a label like `AT&T <> P2P` is left alone rather
/// than being read as ports.
pub fn split_port_pair(text: &str) -> Option<(String, String)> {
    for sep in ["<>", "<->", "->", "→", " -- "] {
        if let Some((l, r)) = text.split_once(sep) {
            let (l, r) = (l.trim(), r.trim());
            if is_port_label(l) && is_port_label(r) {
                return Some((l.to_string(), r.to_string()));
            }
        }
    }
    None
}

/// How far a point is from a line segment.
///
/// The label belongs to the *run*, not to its midpoint: a long connector can
/// carry its label near one end, far from the middle. Measuring to the segment
/// is what makes a long link and a short one behave the same.
fn distance_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    if len2 <= f64::EPSILON {
        return ((px - ax).powi(2) + (py - ay).powi(2)).sqrt();
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

/// The unused pair label lying closest to a connector's own run.
fn pair_near(
    conn: &RawShape,
    shapes: &[RawShape],
    used: &mut Vec<String>,
) -> Option<(String, String)> {
    let seg = conn.begin.zip(conn.end);
    let mut best: Option<(String, String)> = None;
    let mut best_id = String::new();
    // Inches from the line itself, so this does not need to grow with the
    // length of the run.
    let mut best_d = 0.75_f64;
    for s in shapes {
        if used.contains(&s.id) {
            continue;
        }
        let Some(pair) = split_port_pair(&s.text) else { continue };
        let (Some(sx), Some(sy)) = (s.x, s.y) else { continue };
        let d = match seg {
            Some(((ax, ay), (bx, by))) => distance_to_segment(sx, sy, ax, ay, bx, by),
            None => match conn.x.zip(conn.y) {
                Some((cx, cy)) => ((sx - cx).powi(2) + (sy - cy).powi(2)).sqrt(),
                None => continue,
            },
        };
        if d < best_d {
            best_d = d;
            best = Some(pair);
            best_id = s.id.clone();
        }
    }
    if !best_id.is_empty() {
        used.push(best_id);
    }
    best
}

/// The nearest port-looking text to a point — how a port label that is its own
/// shape gets attached to the right end of the right link.
fn port_near(x: f64, y: f64, shapes: &[RawShape], used: &mut Vec<String>) -> String {
    let mut best = String::new();
    let mut best_id = String::new();
    let mut best_d = 0.9_f64;
    for s in shapes {
        if s.text.is_empty() || !is_port_label(&s.text) || used.contains(&s.id) {
            continue;
        }
        let (Some(sx), Some(sy)) = (s.x, s.y) else { continue };
        let d = ((sx - x).powi(2) + (sy - y).powi(2)).sqrt();
        if d < best_d {
            best_d = d;
            best = s.text.clone();
            best_id = s.id.clone();
        }
    }
    if !best_id.is_empty() {
        used.push(best_id);
    }
    best
}

/// Reads one page's XML into devices and links.
pub fn parse_page(xml: &str, page_name: &str) -> Result<(ImportedPage, Vec<String>), String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("{page_name}: {e}"))?;
    let root = doc.root_element();

    let mut shapes = Vec::new();
    for group in root.children().filter(|c| c.has_tag_name("Shapes")) {
        collect_shapes(group, &mut shapes);
    }

    // Which connector is glued to which shape, by end.
    let mut ends: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for connects in root.children().filter(|c| c.has_tag_name("Connects")) {
        for c in connects.children().filter(|c| c.has_tag_name("Connect")) {
            let (Some(from), Some(to)) = (c.attribute("FromSheet"), c.attribute("ToSheet")) else {
                continue;
            };
            let at_start = c.attribute("FromCell").is_some_and(|v| v.starts_with("Begin"));
            let slot = ends.entry(from.to_string()).or_default();
            if at_start {
                slot.0 = Some(to.to_string());
            } else {
                slot.1 = Some(to.to_string());
            }
        }
    }

    let by_id: HashMap<&str, &RawShape> = shapes.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut warnings = Vec::new();
    let mut links = Vec::new();
    let mut used_ports: Vec<String> = Vec::new();
    let mut endpoint_ids: Vec<String> = Vec::new();

    for (conn_id, (a, b)) in &ends {
        let (Some(a), Some(b)) = (a, b) else { continue };
        if a == b || !by_id.contains_key(a.as_str()) || !by_id.contains_key(b.as_str()) {
            continue;
        }
        let conn = by_id.get(conn_id.as_str());
        let label = conn.map(|c| c.text.clone()).unwrap_or_default();
        let props = conn.map(|c| c.props.clone()).unwrap_or_default();

        // Shape Data first — it is stated, not inferred.
        let mut sp = props
            .get("Port_A_Port_Name")
            .or_else(|| props.get("Port_A"))
            .cloned()
            .unwrap_or_default();
        let mut tp = props
            .get("Port_B_Port_Name")
            .or_else(|| props.get("Port_B"))
            .cloned()
            .unwrap_or_default();

        // Then the connector's own label, when it names both ends at once:
        // `Gi1/2 <> Eth1/4` is a convention these drawings use.
        if sp.is_empty() {
            for sep in ["<>", "<->", "--", "→", "->"] {
                if let Some((l, r)) = label.split_once(sep) {
                    sp = l.trim().to_string();
                    tp = r.trim().to_string();
                    break;
                }
            }
        }
        if sp.is_empty() && is_port_label(&label) {
            sp = label.trim().to_string();
        }

        // Finally geometry: the label is its own text shape, beside the run.
        if let Some(c) = conn {
            // A pair label naming both ends at once is what these drawings
            // mostly use, so it is tried first: one label answers both
            // questions and cannot disagree with itself.
            if sp.is_empty() && tp.is_empty() {
                if let Some((a, b)) = pair_near(c, &shapes, &mut used_ports) {
                    sp = a;
                    tp = b;
                }
            }
            if sp.is_empty() {
                if let Some((x, y)) = c.begin {
                    sp = port_near(x, y, &shapes, &mut used_ports);
                }
            }
            if tp.is_empty() {
                if let Some((x, y)) = c.end {
                    tp = port_near(x, y, &shapes, &mut used_ports);
                }
            }
        }

        endpoint_ids.push(a.clone());
        endpoint_ids.push(b.clone());
        links.push(ImportedLink {
            source: a.clone(),
            target: b.clone(),
            label: if is_port_label(&label) { String::new() } else { label },
            source_port: sp,
            target_port: tp,
            glued: true,
        });
    }

    // A device is a shape a link lands on. Shapes that are only decoration —
    // titles, legends, the text blocks used as captions — are not imported as
    // devices, because a diagram full of empty boxes is not a topology.
    let mut devices = Vec::new();
    for id in {
        let mut seen: Vec<String> = endpoint_ids.clone();
        seen.sort();
        seen.dedup();
        seen
    } {
        let Some(s) = by_id.get(id.as_str()) else { continue };
        let caption = if !s.text.is_empty() && !is_port_label(&s.text) {
            s.text.clone()
        } else {
            caption_near(s, &shapes)
        };
        let label = if caption.is_empty() {
            s.master.clone()
        } else {
            name_without_address(&caption)
        };
        devices.push(ImportedDevice {
            id: s.id.clone(),
            label: if label.is_empty() { s.master.clone() } else { label },
            addresses: addresses_in(&caption),
            device_type: device_type_for(&s.master).to_string(),
            model: s.master.clone(),
            properties: s.props.clone(),
            x: s.x.unwrap_or(0.0),
            y: s.y.unwrap_or(0.0),
        });
    }

    if devices.is_empty() && !shapes.is_empty() {
        warnings.push(format!(
            "{page_name}: {} shapes, but nothing is glued to anything — this drawing carries no link information (a Lucidchart export does this), so its connections cannot be read.",
            shapes.len()
        ));
    }

    Ok((
        ImportedPage {
            name: page_name.to_string(),
            devices,
            links,
        },
        warnings,
    ))
}

/// Reads a whole `.vsdx`.
pub fn import_vsdx(bytes: &[u8]) -> Result<VisioImport, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| format!("This does not look like a .vsdx file: {e}"))?;

    // Page names live in pages.xml, keyed by the same order as the page parts.
    let mut names: Vec<String> = Vec::new();
    if let Ok(mut f) = zip.by_name("visio/pages/pages.xml") {
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_ok() {
            let text = decode_xml(&buf);
            if let Ok(doc) = roxmltree::Document::parse(&text) {
                for p in doc.descendants().filter(|n| n.has_tag_name("Page")) {
                    names.push(p.attribute("Name").unwrap_or_default().to_string());
                }
            }
        }
    }

    let mut page_parts: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        // `pages.xml` is the index, not a page — and it starts with the same
        // prefix, so it has to be excluded by name rather than by prefix.
        .filter(|n| {
            n.starts_with("visio/pages/page")
                && n.ends_with(".xml")
                && !n.contains("_rels")
                && n != "visio/pages/pages.xml"
        })
        .collect();
    // page2 before page10.
    page_parts.sort_by_key(|n| {
        n.trim_start_matches("visio/pages/page")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });

    if page_parts.is_empty() {
        return Err("No drawing pages found inside this .vsdx.".into());
    }

    let mut pages = Vec::new();
    let mut warnings = Vec::new();
    for (i, part) in page_parts.iter().enumerate() {
        let mut buf = Vec::new();
        {
            let mut f = zip
                .by_name(part)
                .map_err(|e| format!("Could not read {part}: {e}"))?;
            f.read_to_end(&mut buf)
                .map_err(|e| format!("Could not read {part}: {e}"))?;
        }
        let xml = decode_xml(&buf);
        let name = names
            .get(i)
            .filter(|n| !n.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("Page {}", i + 1));
        match parse_page(&xml, &name) {
            Ok((page, mut w)) => {
                warnings.append(&mut w);
                pages.push(page);
            }
            Err(e) => warnings.push(e),
        }
    }

    // Pages with nothing on them are not worth a tab.
    pages.retain(|p| !p.devices.is_empty() || !p.links.is_empty());
    if pages.is_empty() {
        return Err(
            "Nothing importable was found. If this drawing came out of Lucidchart, its connectors are not glued to the shapes, so it carries no link information."
                .into(),
        );
    }

    Ok(VisioImport { pages, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_page_xml_is_read_rather_than_seen_as_empty() {
        // A real sample drawing is UTF-16. Decoding it as UTF-8 yields a
        // document with no shapes in it, and an import that cheerfully reports
        // finding nothing — the failure mode this guards.
        let text = "<PageContents><Shapes/></PageContents>";
        let mut le: Vec<u8> = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_xml(&le), text);

        // The same thing without a BOM, which is how the real file arrives.
        let bare: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode_xml(&bare), text);

        // And plain UTF-8 still passes through untouched.
        assert_eq!(decode_xml(text.as_bytes()), text);
    }

    #[test]
    fn a_port_label_is_told_apart_from_a_device_name() {
        for p in ["Gi1/0/1", "Te0/1/0", "Eth1/43", "Po10", "Gi1", "Port 14", "xe-0/0/0"] {
            assert!(is_port_label(p), "{p} should read as a port");
        }
        // The reason this exists: these must NOT be mistaken for ports, or a
        // caption search returns the port label instead of the device name.
        for n in [
            "Main-fw01 10.1.1.42",
            "_ADMIN_SWITCH",
            "CUBE01",
            "SSDC-Anchor",
            "Poughkeepsie-RTR",
            "",
        ] {
            assert!(!is_port_label(n), "{n} should not read as a port");
        }
    }

    #[test]
    fn a_pair_label_names_both_ends() {
        assert_eq!(
            split_port_pair("Gi1/2 <> Eth1/4"),
            Some(("Gi1/2".into(), "Eth1/4".into()))
        );
        assert_eq!(split_port_pair("Te1<>Eth1/42"), Some(("Te1".into(), "Eth1/42".into())));
        // Both halves must look like interfaces, so a carrier label is left
        // alone rather than being read as ports.
        assert_eq!(split_port_pair("AT&T <> P2P"), None);
        assert_eq!(split_port_pair("Mobility Tunnel"), None);
    }

    #[test]
    fn addresses_are_found_and_the_name_survives_without_them() {
        assert_eq!(addresses_in("Main-fw01 10.1.1.42"), vec!["10.1.1.42"]);
        assert_eq!(addresses_in("no address here"), Vec::<String>::new());

        // A real caption from the sample runs the two together with no space:
        // `Main vpn0110.0.1.50`. That is genuinely ambiguous — vpn01 + 10.0.1.50,
        // vpn0 + 110.0.1.50, and vpn011 + 0.0.1.50 are all readings, and
        // nothing in the string decides between them. An imported address
        // becomes a monitoring target, so a wrong one is far worse than a
        // missing one: it would have Coreview check the wrong host and report
        // green for a device that is down. So nothing is taken here, and the
        // fix is a space in the drawing.
        assert_eq!(addresses_in("Main vpn0110.0.1.50"), Vec::<String>::new());
        // 999 is not an octet; nothing should be invented from it.
        assert_eq!(addresses_in("999.1.1.1"), Vec::<String>::new());
        assert_eq!(name_without_address("Main-fw01 10.1.1.42"), "Main-fw01");
        assert_eq!(name_without_address("CUBE01 10.0.1.36"), "CUBE01");
    }

    #[test]
    fn the_master_name_gives_the_device_type() {
        assert_eq!(device_type_for("ASA 5500"), "firewall");
        assert_eq!(device_type_for("Workgroup switch"), "access-switch");
        assert_eq!(device_type_for("Router"), "router");
        assert_eq!(device_type_for("L3 Switch"), "core-switch");
        assert_eq!(device_type_for("Cloud"), "internet");
        // Cisco part numbers, which is what these drawings are full of.
        assert_eq!(device_type_for("N9K-C93180YC-EX Front"), "core-switch");
        assert_eq!(device_type_for("WS-C4500X-16SFP+ Front"), "access-switch");
        assert_eq!(device_type_for("Something nobody has heard of"), "generic");
        // Order matters: the coarser word must not win.
        assert_eq!(device_type_for("Wireless Controller"), "wireless-controller");
    }

    #[test]
    fn a_drawing_with_no_glue_says_so_rather_than_inventing_links() {
        // A Lucidchart export: shapes, no <Connects> at all.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='com.lucidchart.NET_Switch'><Cell N='PinX' V='1'/><Cell N='PinY' V='1'/></Shape>
            <Shape ID='2' NameU='com.lucidchart.Line'><Cell N='BeginX' V='1'/><Cell N='EndX' V='2'/></Shape>
        </Shapes></PageContents>"#;
        let (page, warnings) = parse_page(xml, "Page-1").unwrap();
        assert!(page.links.is_empty());
        assert!(page.devices.is_empty());
        assert!(
            warnings.iter().any(|w| w.contains("glued")),
            "should say why nothing came out: {warnings:?}"
        );
    }

    #[test]
    fn a_glued_connector_becomes_a_link_between_two_devices() {
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>CORE-01 10.0.0.1</Text></Shape>
            <Shape ID='2' NameU='ASA 5500'><Cell N='PinX' V='4'/><Cell N='PinY' V='5'/><Text>FW-01 10.0.0.2</Text></Shape>
            <Shape ID='3' NameU='Dynamic connector'><Cell N='BeginX' V='1'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='4'/><Cell N='EndY' V='5'/></Shape>
            <Shape ID='4' NameU='Plain'><Cell N='PinX' V='2.5'/><Cell N='PinY' V='5'/><Text>Gi0/1 &lt;&gt; Eth1/2</Text></Shape>
        </Shapes>
        <Connects>
            <Connect FromSheet='3' FromCell='BeginX' ToSheet='1'/>
            <Connect FromSheet='3' FromCell='EndX' ToSheet='2'/>
        </Connects></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert_eq!(page.links.len(), 1, "one glued connector, one link");
        let l = &page.links[0];
        assert_eq!((l.source_port.as_str(), l.target_port.as_str()), ("Gi0/1", "Eth1/2"));
        assert!(l.glued);

        let core = page.devices.iter().find(|d| d.label == "CORE-01").expect("CORE-01");
        assert_eq!(core.addresses, vec!["10.0.0.1"]);
        assert_eq!(core.device_type, "router");
        let fw = page.devices.iter().find(|d| d.label == "FW-01").expect("FW-01");
        assert_eq!(fw.device_type, "firewall");
    }

    #[test]
    fn a_caption_beside_an_icon_beats_a_port_label_beside_it() {
        // The icon has no text; a port label sits nearer than the caption.
        // Taking the nearest text would name the device `Eth1/9`.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='5'/><Cell N='PinY' V='5'/></Shape>
            <Shape ID='2' NameU='Plain'><Cell N='PinX' V='5.1'/><Cell N='PinY' V='5.1'/><Text>Eth1/9</Text></Shape>
            <Shape ID='3' NameU='Plain'><Cell N='PinX' V='5'/><Cell N='PinY' V='4.6'/><Text>EDGE-RTR 10.9.9.9</Text></Shape>
            <Shape ID='4' NameU='Router'><Cell N='PinX' V='9'/><Cell N='PinY' V='5'/><Text>FAR-END</Text></Shape>
            <Shape ID='5' NameU='Dynamic connector'><Cell N='BeginX' V='5'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='9'/><Cell N='EndY' V='5'/></Shape>
        </Shapes>
        <Connects>
            <Connect FromSheet='5' FromCell='BeginX' ToSheet='1'/>
            <Connect FromSheet='5' FromCell='EndX' ToSheet='4'/>
        </Connects></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        let d = page.devices.iter().find(|d| d.id == "1").expect("the router");
        assert_eq!(d.label, "EDGE-RTR", "the port label must not become the name");
        assert_eq!(d.addresses, vec!["10.9.9.9"]);
    }

    /// The operator's own sample drawing, kept outside the repository (it is
    /// his file, not ours). Absent on any other machine and in CI, so this
    /// skips rather than fails there.
    const SAMPLE: &str = "/home/malmoola/coreview-samples/visio/Drawing2-sample-network.vsdx";

    #[test]
    fn reads_the_operators_sample_drawing() {
        let Ok(bytes) = std::fs::read(SAMPLE) else {
            eprintln!("skipping: {SAMPLE} not present");
            return;
        };
        let out = import_vsdx(&bytes).expect("the sample should import");
        let devices: usize = out.pages.iter().map(|p| p.devices.len()).sum();
        let links: usize = out.pages.iter().map(|p| p.links.len()).sum();
        let named = out
            .pages
            .iter()
            .flat_map(|p| &p.devices)
            .filter(|d| !d.label.is_empty() && d.label != d.model)
            .count();
        let addressed = out
            .pages
            .iter()
            .flat_map(|p| &p.devices)
            .filter(|d| !d.addresses.is_empty())
            .count();
        let ported = out
            .pages
            .iter()
            .flat_map(|p| &p.links)
            .filter(|l| !l.source_port.is_empty() || !l.target_port.is_empty())
            .count();

        eprintln!("pages={} devices={devices} links={links}", out.pages.len());
        eprintln!("  named {named}/{devices}, addressed {addressed}/{devices}, with a port {ported}/{links}");
        for p in &out.pages {
            for d in p.devices.iter().take(12) {
                eprintln!("  DEV {:28} {:16} {:?}", d.label, d.device_type, d.addresses);
            }
            for l in p.links.iter().take(12) {
                eprintln!("  LNK {} [{}]---[{}] {}", l.source, l.source_port, l.target_port, l.target);
            }
        }
        for w in &out.warnings {
            eprintln!("  WARN {w}");
        }
        assert!(devices > 0, "no devices read from the sample");
        assert!(links > 0, "no links read from the sample");
    }
}
