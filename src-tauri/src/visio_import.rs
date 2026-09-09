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
//!   no text of its own; `_ACCESS_SW01 192.0.2.20` is a text block sitting
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
    /// The shape's pin — its centre — in inches from the page's bottom-left.
    pub x: f64,
    pub y: f64,
    /// The shape's own size in inches, where the drawing states one. A rack
    /// unit is two inches by a fifth of an inch and a router icon is roughly
    /// square; drawing them both the same size is a large part of why an
    /// import does not look like the drawing it came from.
    pub width: f64,
    pub height: f64,
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
    /// The colour the line was drawn in, as `#rrggbb`, or empty where the
    /// drawing left it to the theme. Operators colour their drawings on
    /// purpose — a carrier circuit in one colour, a fibre run in another — and
    /// an import that repaints everything the same has thrown that away.
    pub color: String,
}

/// Visio's colour, as `#rrggbb`.
///
/// Usually written straight out (`#0070c0`). Where it is an index instead, it
/// indexes the standard palette, whose first eight entries are fixed and are
/// what a hand-drawn line actually uses. An index beyond those is left alone
/// rather than guessed at: the wrong colour asserted confidently is worse than
/// the diagram's own default.
pub fn line_colour(v: &str) -> String {
    let v = v.trim();
    if v.starts_with('#') && (v.len() == 7 || v.len() == 4) {
        return v.to_ascii_lowercase();
    }
    const PALETTE: &[&str] = &[
        "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
    ];
    match v.parse::<usize>() {
        Ok(i) => PALETTE.get(i).map(|s| (*s).to_string()).unwrap_or_default(),
        Err(_) => String::new(),
    }
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
    /// Begin/end geometry. Necessary for a connector but not sufficient: a
    /// rack-mounted device shape has it too. See `is_connector`.
    has_ends: bool,
    /// Where a connector starts and finishes, used to find the port label
    /// sitting beside each end.
    begin: Option<(f64, f64)>,
    end: Option<(f64, f64)>,
    /// The shape's own box, when it states one. Used to measure a caption's
    /// distance to the shape rather than to its centre — a rack unit is two
    /// inches wide, so its caption is far from the middle and near the edge.
    width: Option<f64>,
    height: Option<f64>,
    /// Visio's own marker that this shape's box *is* its begin-to-end run:
    /// `Width` carries the formula `GUARD(EndX-BeginX)`. Only a connector is
    /// defined that way, which is what tells one apart from a 1-D device.
    spans_its_ends: bool,
    /// The colour the shape's line is drawn in, as `#rrggbb`.
    line_colour: String,
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
        // Cisco UCS: the chassis and its blades are servers, the fabric
        // interconnect that fronts them is a switch. All three appear in the
        // operator's drawing as rack-unit stencils.
        ("fabric interconnect", "core-switch"),
        ("ucs", "server"),
        ("hxaf", "server"),
        ("hyperflex", "server"),
        ("blade", "server"),
        ("storage", "storage"),
        ("array", "storage"),
        ("centera", "storage"),
        ("isilon", "storage"),
        ("netapp", "storage"),
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
    // A 4500X or a 6500 is a chassis switch doing distribution or core work; a
    // 2960 or a 3560 is an access switch. Both are `WS-C`.
    if m.starts_with("ws-c4") || m.starts_with("ws-c6") || m.starts_with("ws-c9") {
        return "core-switch";
    }
    if m.starts_with("n2k") || m.starts_with("ws-c") || m.starts_with("c9") || m.starts_with("ms") {
        return "access-switch";
    }
    // `6324 FI` — a UCS fabric interconnect named only by its part number.
    if m.ends_with(" fi") {
        return "core-switch";
    }
    "generic"
}

/// Whether a piece of text is an interface name rather than a device name.
///
/// This is what stops a caption search returning `Eth1/43`: a port label often
/// sits nearer an icon than the icon's own caption does. Deliberately strict —
/// it must match the *whole* string, so `EDGE-FW-01 192.0.2.10` is a name even
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
/// Real captions run the two together: `EDGE-FW-01 192.0.2.10`, and sometimes
/// with no space at all — `Site vpn01192.0.2.50`. Removing the address text
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

/// A cell's formula rather than its value.
fn cell_formula(node: roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .filter(|c| c.has_tag_name("Cell"))
        .find(|c| c.attribute("N") == Some(name))
        .and_then(|c| c.attribute("F"))
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
                width: num("Width"),
                height: num("Height"),
                line_colour: cell(shape, "LineColor").map(|v| line_colour(&v)).unwrap_or_default(),
                spans_its_ends: cell_formula(shape, "Width")
                    .is_some_and(|f| f.replace(' ', "").contains("EndX-BeginX")),
            });
        }
        // Groups hold their members in a nested <Shapes>.
        for inner in shape.children().filter(|c| c.has_tag_name("Shapes")) {
            collect_shapes(inner, out);
        }
    }
}

/// Whether a shape is a connector rather than a device.
///
/// The first version asked only whether the shape had begin/end geometry, and
/// that was wrong in a way that cost the operator the most important devices in
/// his drawing. **Rack-mounted equipment is 1-D too.** A `N9K-C93180YC-EX
/// Front`, a `WS-C4500X-16SFP+ Front`, a `UCS 5108 Rear` — every Cisco rack-unit
/// stencil carries `BeginX`/`EndX` so it snaps into a rack frame. Fourteen
/// devices, including all four Nexus 9000s and both Catalyst 4500Xs, were being
/// read as lines and thrown away, and the links that should have landed on them
/// went somewhere else.
///
/// What actually separates the two is what the box *means*. On a connector the
/// box is the run: Visio writes `Width` as the formula `GUARD(EndX-BeginX)`. On
/// a rack unit the width is the equipment's own, inherited from its master.
/// That formula, plus a master that says "connector" outright, identifies all
/// seventy connectors in the drawing and misses none of the thirty-seven
/// devices.
///
/// Glue is the third signal, and it needs the same care: a `6324 FI` fabric
/// interconnect is glued *into* its UCS chassis at both ends, so appearing in
/// `<Connects>` is not on its own a sign of being a connector. Only glue that
/// joins two *different* shapes counts.
fn is_connector(s: &RawShape, joins_two_shapes: bool) -> bool {
    s.has_ends && (s.spans_its_ends || master_says_connector(&s.master) || joins_two_shapes)
}

/// Whether a master name says outright that the shape is a line between things.
///
/// Matched as whole words, not as substrings. "Connector" and "Line" are
/// common enough as parts of equipment names — a line card, an inline power
/// injector — that `contains` would quietly turn a device into a cable.
/// `com.lucidchart.Line` splits to `com`, `lucidchart`, `line`, which is the
/// one that matters: a Lucidchart export names every cable that way and glues
/// none of them, so without this its lines are not links at all — and worse,
/// each one is imported as a *device*, because a shape that is not a connector
/// and has a master is taken for equipment.
fn master_says_connector(master: &str) -> bool {
    // The *last* word, not any word. A master names a kind of thing, and the
    // kind is the noun it ends on: `com.lucidchart.Line` and `Dynamic
    // connector` are cables, while `Catalyst 6500 Line Card 48-port` and
    // `Inline power injector` are equipment that merely mention one. Matching
    // any word turned the line card into a cable.
    let lower = master.to_ascii_lowercase();
    let Some(last) = lower.rsplit(|c: char| !c.is_ascii_alphanumeric()).find(|w| !w.is_empty())
    else {
        return false;
    };
    last.starts_with("connector") || last.starts_with("line") || last.starts_with("link")
}

/// The nearest text that reads like a name rather than a port.
/// A floating text block — a caption or a port label — rather than a device.
///
/// These carry text and no master worth the name, and a connector's free end
/// must never be resolved onto one: a link that lands on the words
/// `Gi0/0/1 <> Gi2/0/24` is worse than no link.
fn looks_like_a_text_block(s: &RawShape) -> bool {
    if s.text.is_empty() {
        return false;
    }
    let m = s.master.to_ascii_lowercase();
    // The masters these drawings use for plain text.
    m.is_empty() || m.starts_with("plain") || m.contains("text") || m.starts_with("base stencil")
}

/// The device shape nearest a point, for resolving a connector's free end.
fn nearest_device(
    x: f64,
    y: f64,
    candidates: &[&RawShape],
    exclude: &str,
) -> Option<String> {
    let mut best: Option<(f64, String)> = None;
    for s in candidates {
        if s.id == exclude {
            continue;
        }
        let (Some(sx), Some(sy)) = (s.x, s.y) else { continue };
        let d = ((sx - x).powi(2) + (sy - y).powi(2)).sqrt();
        // Close enough to be what the line was pointing at. A free end further
        // than this from anything is a line into empty space, and inventing a
        // device for it would be worse than dropping it.
        let nearer = match &best {
            Some((bd, _)) => d < *bd,
            None => true,
        };
        if d < 1.2 && nearer {
            best = Some((d, s.id.clone()));
        }
    }
    best.map(|(_, id)| id)
}

/// Whether a piece of text could be a device's name.
///
/// A single port (`Eth1/43`) is not, and neither is a *pair* label
/// (`Gi0/0/2 <> Gi1/0/13`) — which is the one that actually bit: a pair label
/// is not a port label by itself, so the first version happily used one as a
/// device name, and a router came in named after the cable plugged into it
/// rather than after itself.
pub fn could_be_a_name(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty() && !is_port_label(t) && split_port_pair(t).is_none()
}

/// How far a point is from a shape's box, rather than from its centre.
///
/// A rack unit is two inches wide and a fifth of an inch tall. Measured to the
/// centre, its own caption sits further away than a neighbour's does; measured
/// to the box, it does not. Shapes that state no size fall back to their pin,
/// which is what centre-distance already did.
fn distance_to_shape(px: f64, py: f64, s: &RawShape) -> Option<f64> {
    let (sx, sy) = (s.x?, s.y?);
    let hw = s.width.unwrap_or(0.0).abs() / 2.0;
    let hh = s.height.unwrap_or(0.0).abs() / 2.0;
    let dx = (sx - px).abs() - hw;
    let dy = (sy - py).abs() - hh;
    Some((dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt())
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

    // Glue counts towards "this is a connector" only when it joins two
    // different shapes; a rack unit glued into its own chassis at both ends is
    // still a device.
    let joins_two: std::collections::HashSet<&str> = ends
        .iter()
        .filter(|(_, (a, b))| match (a, b) {
            (Some(a), Some(b)) => a != b,
            _ => true,
        })
        .map(|(id, _)| id.as_str())
        .collect();
    let connectors: std::collections::HashSet<String> = shapes
        .iter()
        .filter(|s| is_connector(s, joins_two.contains(s.id.as_str())))
        .map(|s| s.id.clone())
        .collect();
    let connector = |s: &RawShape| connectors.contains(&s.id);

    let by_id: HashMap<&str, &RawShape> = shapes.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut warnings = Vec::new();
    let mut links = Vec::new();
    let mut used_ports: Vec<String> = Vec::new();
    let mut endpoint_ids: Vec<String> = Vec::new();

    // Shapes a connector could plausibly land on: not connectors, not the
    // floating text blocks that hold captions and port labels.
    let device_like: Vec<&RawShape> = shapes
        .iter()
        .filter(|s| !connector(s) && s.x.is_some() && !looks_like_a_text_block(s))
        .collect();

    // Every connector *shape*, not only those listed in `<Connects>`.
    //
    // Glue is the authoritative answer and wins wherever it exists, but it is
    // not always there: of 70 connectors in the operator's own drawing, 10 are
    // glued at one end only and 4 at neither — and one of those four is a real
    // AT&T uplink, drawn as a line that merely touches both shapes. Reading the
    // `<Connects>` table alone loses all fourteen silently. An end with no glue
    // is resolved to the nearest device shape and the link marked not-glued, so
    // it can be reviewed rather than being either lost or asserted as fact.
    let no_glue = (None, None);
    for c in shapes.iter().filter(|s| connector(s)) {
        let g = ends.get(&c.id).unwrap_or(&no_glue);
        let resolve = |glued: &Option<String>, at: Option<(f64, f64)>, other: &str| match glued {
            Some(id) => Some((id.clone(), true)),
            None => at
                .and_then(|(x, y)| nearest_device(x, y, &device_like, other))
                .map(|id| (id, false)),
        };
        let Some((a, a_glued)) = resolve(&g.0, c.begin, "") else { continue };
        let Some((b, b_glued)) = resolve(&g.1, c.end, &a) else { continue };
        let glued = a_glued && b_glued;

        if a == b || !by_id.contains_key(a.as_str()) || !by_id.contains_key(b.as_str()) {
            continue;
        }
        let (a, b) = (&a, &b);
        let conn = Some(c);
        let label = c.text.clone();
        let props = c.props.clone();

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
            glued,
            color: c.line_colour.clone(),
        });
    }

    // What counts as a device.
    //
    // A link endpoint is one, as before. But so is any shape drawn from a named
    // master that is not a connector and not a text block — a device the
    // operator drew and never joined to anything is still equipment he expects
    // to see, and leaving it out is how a nineteen-device drawing arrives with
    // fifteen. Decoration is still excluded: it has no master worth the name.
    let mut wanted: Vec<String> = endpoint_ids.clone();
    for s in &shapes {
        if !connector(s) && s.x.is_some() && !s.master.is_empty() && !looks_like_a_text_block(s) {
            wanted.push(s.id.clone());
        }
    }
    wanted.sort();
    wanted.dedup();

    // One caption belongs to one device, and the closest pairing wins.
    //
    // Assigning per device in id order let a caption be taken by a device it
    // merely sat near, leaving the device it actually belonged to named after
    // its master. Ordering every candidate pairing by distance and taking them
    // shortest-first gives each caption to the device it is nearest to.
    let mut pairings: Vec<(f64, String, String)> = Vec::new();
    for id in &wanted {
        let Some(t) = by_id.get(id.as_str()) else { continue };
        if could_be_a_name(&t.text) {
            continue;
        }
        for s in &shapes {
            if s.id == t.id || s.has_ends || !could_be_a_name(&s.text) {
                continue;
            }
            let (Some(sx), Some(sy)) = (s.x, s.y) else { continue };
            let Some(d) = distance_to_shape(sx, sy, t) else { continue };
            if d < 1.5 {
                pairings.push((d, id.clone(), s.id.clone()));
            }
        }
    }
    pairings.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));
    let mut caption_for: HashMap<&str, &str> = HashMap::new();
    let mut caption_used: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (_, dev, cap) in &pairings {
        if caption_for.contains_key(dev.as_str()) || caption_used.contains(cap.as_str()) {
            continue;
        }
        caption_for.insert(dev.as_str(), cap.as_str());
        caption_used.insert(cap.as_str());
    }

    let mut devices = Vec::new();
    for id in wanted {
        let Some(s) = by_id.get(id.as_str()) else { continue };
        let caption = if could_be_a_name(&s.text) {
            s.text.clone()
        } else {
            caption_for
                .get(id.as_str())
                .and_then(|c| by_id.get(*c))
                .map(|c| c.text.clone())
                .unwrap_or_default()
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
            width: s.width.unwrap_or(0.0).abs(),
            height: s.height.unwrap_or(0.0).abs(),
        });
    }

    if links.is_empty() && !shapes.is_empty() {
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
    // The pre-2013 binary format is an OLE compound file, and it starts with a
    // fixed signature. It is worth naming, because "this does not look like a
    // .vsdx file" is true but useless when the fix is one Save As away.
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return Err("This is a .vsd — the pre-2013 binary format, which carries \
none of the shape data an import needs. Open it in Visio and Save As .vsdx, \
then import that."
            .into());
    }
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
            "EDGE-FW-01 192.0.2.10",
            "_ACCESS_SW01",
            "VOICE01",
            "WLC-ANCHOR",
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
        assert_eq!(addresses_in("EDGE-FW-01 192.0.2.10"), vec!["192.0.2.10"]);
        assert_eq!(addresses_in("no address here"), Vec::<String>::new());

        // A real caption from the sample runs the two together with no space:
        // `Site vpn01192.0.2.50`. That is genuinely ambiguous — vpn01 + 10.0.1.50,
        // vpn0 + 110.0.1.50, and vpn011 + 0.0.1.50 are all readings, and
        // nothing in the string decides between them. An imported address
        // becomes a monitoring target, so a wrong one is far worse than a
        // missing one: it would have Coreview check the wrong host and report
        // green for a device that is down. So nothing is taken here, and the
        // fix is a space in the drawing.
        assert_eq!(addresses_in("Site vpn01192.0.2.50"), Vec::<String>::new());
        // 999 is not an octet; nothing should be invented from it.
        assert_eq!(addresses_in("999.1.1.1"), Vec::<String>::new());
        assert_eq!(name_without_address("EDGE-FW-01 192.0.2.10"), "EDGE-FW-01");
        assert_eq!(name_without_address("VOICE01 192.0.2.30"), "VOICE01");
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
        // A 4500X is a chassis switch, a 2960 is a wiring-closet one, and both
        // are `WS-C`. Reading them the same way put the operator's Catalysts in
        // the wrong tier.
        assert_eq!(device_type_for("WS-C4500X-16SFP+ Front"), "core-switch");
        assert_eq!(device_type_for("WS-C2960X-48FPD-L"), "access-switch");
        assert_eq!(device_type_for("N2K-C2348TQ Port Side"), "access-switch");
        // UCS: chassis and blades are servers, the fabric interconnect is not.
        assert_eq!(device_type_for("UCS 5108 Rear"), "server");
        assert_eq!(device_type_for("HXAF240c M4 Rear"), "server");
        assert_eq!(device_type_for("6324 FI"), "core-switch");
        assert_eq!(device_type_for("AllFlash Array back"), "storage");
        // `FirePower` contains the same two letters as a fabric interconnect
        // and must stay a firewall.
        assert_eq!(device_type_for("Cisco FirePower 2110 Firewall"), "firewall");
        assert_eq!(device_type_for("Something nobody has heard of"), "generic");
        // Order matters: the coarser word must not win.
        assert_eq!(device_type_for("Wireless Controller"), "wireless-controller");
    }

    #[test]
    fn a_line_keeps_the_colour_it_was_drawn_in() {
        assert_eq!(line_colour("#0070c0"), "#0070c0");
        assert_eq!(line_colour("#EA700D"), "#ea700d");
        // Index into Visio's standard palette, which is what a line drawn in
        // plain black carries instead of a hex value.
        assert_eq!(line_colour("0"), "#000000");
        assert_eq!(line_colour("2"), "#ff0000");
        // Beyond the fixed entries the palette is the document's own, so
        // nothing is claimed and the diagram's default style applies.
        assert_eq!(line_colour("41"), "");
        assert_eq!(line_colour("Themed"), "");
    }

    #[test]
    fn a_connector_carries_its_colour_onto_the_link() {
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>A</Text></Shape>
            <Shape ID='2' NameU='Router'><Cell N='PinX' V='4'/><Cell N='PinY' V='5'/><Text>B</Text></Shape>
            <Shape ID='3' NameU='Dynamic connector'><Cell N='BeginX' V='1'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='4'/><Cell N='EndY' V='5'/><Cell N='LineColor' V='#ea700d'/></Shape>
        </Shapes>
        <Connects>
            <Connect FromSheet='3' FromCell='BeginX' ToSheet='1'/>
            <Connect FromSheet='3' FromCell='EndX' ToSheet='2'/>
        </Connects></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert_eq!(page.links[0].color, "#ea700d");
    }

    #[test]
    fn a_rack_mounted_switch_is_a_device_and_not_a_line() {
        // Cisco's rack-unit stencils are 1-D: they carry BeginX/EndX so they
        // snap into a rack. Reading begin/end as "this is a connector" lost
        // the operator every Nexus and every Catalyst in his drawing.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='N9K-C93180YC-EX Front' Type='Group'>
              <Cell N='PinX' V='16.7'/><Cell N='PinY' V='17'/>
              <Cell N='Width' V='2.06' F='Inh'/><Cell N='Height' V='0.185' F='Inh'/>
              <Cell N='BeginX' V='15.67'/><Cell N='BeginY' V='17'/>
              <Cell N='EndX' V='17.73'/><Cell N='EndY' V='17'/>
            </Shape>
            <Shape ID='2' NameU='Plain'><Cell N='PinX' V='16.7'/><Cell N='PinY' V='16.8'/><Text>-CORE-SW01 198.51.100.10</Text></Shape>
        </Shapes></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert_eq!(page.links.len(), 0, "a rack unit is not a link");
        assert_eq!(page.devices.len(), 1);
        let d = &page.devices[0];
        assert_eq!(d.label, "-CORE-SW01");
        assert_eq!(d.addresses, vec!["198.51.100.10"]);
        assert_eq!(d.device_type, "core-switch");
        // And its real shape comes with it: wide and flat, not a square icon.
        assert!((d.width - 2.06).abs() < 1e-9);
        assert!((d.height - 0.185).abs() < 1e-9);
    }

    #[test]
    fn a_blade_glued_into_its_own_chassis_is_not_a_link() {
        // A `6324 FI` is glued to the UCS chassis at *both* ends: it is
        // mounted in it, not cabled to it. Treating glue alone as proof of
        // being a connector turned two fabric interconnects into lines.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='79' NameU='UCS 5108 Rear' Type='Group'><Cell N='PinX' V='10'/><Cell N='PinY' V='10'/><Cell N='Width' V='2' F='Inh'/><Cell N='Height' V='0.5' F='Inh'/><Cell N='BeginX' V='9'/><Cell N='EndX' V='11'/></Shape>
            <Shape ID='81' NameU='6324 FI' Type='Group'><Cell N='PinX' V='10'/><Cell N='PinY' V='9.8'/><Cell N='Width' V='1' F='Inh'/><Cell N='Height' V='0.2' F='Inh'/><Cell N='BeginX' V='9.5'/><Cell N='EndX' V='10.5'/></Shape>
        </Shapes>
        <Connects>
            <Connect FromSheet='81' FromCell='BeginX' ToSheet='79'/>
            <Connect FromSheet='81' FromCell='EndX' ToSheet='79'/>
        </Connects></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert_eq!(page.links.len(), 0);
        let mut labels: Vec<&str> = page.devices.iter().map(|d| d.label.as_str()).collect();
        labels.sort_unstable();
        assert_eq!(labels, vec!["6324 FI", "UCS 5108 Rear"]);
    }

    #[test]
    fn one_caption_names_one_device_and_the_nearest_pairing_wins() {
        // Two routers drawn close together, each with its own caption below
        // it. Assigning per device in id order let the first take the caption
        // nearest *it*, leaving the second one named after its master — which
        // is how the operator ended up with names on the wrong devices.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='5'/><Cell N='PinY' V='5'/></Shape>
            <Shape ID='2' NameU='Router'><Cell N='PinX' V='5'/><Cell N='PinY' V='4.4'/></Shape>
            <Shape ID='3' NameU='Plain'><Cell N='PinX' V='5'/><Cell N='PinY' V='4.9'/><Text>RTR-01 198.51.100.11</Text></Shape>
            <Shape ID='4' NameU='Plain'><Cell N='PinX' V='5'/><Cell N='PinY' V='4.3'/><Text>RTR-02 198.51.100.12</Text></Shape>
        </Shapes></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        let named = |id: &str| {
            page.devices.iter().find(|d| d.id == id).map(|d| d.label.clone()).unwrap_or_default()
        };
        assert_eq!(named("1"), "RTR-01");
        assert_eq!(named("2"), "RTR-02");
    }

    #[test]
    fn a_drawing_with_no_glue_says_so_rather_than_inventing_links() {
        // A Lucidchart export: shapes, no <Connects> at all.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='com.lucidchart.NET_Switch'><Cell N='PinX' V='1'/><Cell N='PinY' V='1'/></Shape>
            <Shape ID='2' NameU='com.lucidchart.Line'><Cell N='BeginX' V='1'/><Cell N='EndX' V='2'/></Shape>
        </Shapes></PageContents>"#;
        let (page, warnings) = parse_page(xml, "Page-1").unwrap();
        assert!(page.links.is_empty(), "no glue, so no link may be asserted");
        // The switch is still a switch the operator drew, and arrives as one.
        // Only the *connections* are missing, and the warning says so.
        assert_eq!(page.devices.len(), 1);
        assert_eq!(page.devices[0].id, "1");
        assert!(
            warnings.iter().any(|w| w.contains("glued")),
            "should say why the links are missing: {warnings:?}"
        );
    }

    #[test]
    fn a_glued_connector_becomes_a_link_between_two_devices() {
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>CORE-01 192.0.2.1</Text></Shape>
            <Shape ID='2' NameU='ASA 5500'><Cell N='PinX' V='4'/><Cell N='PinY' V='5'/><Text>FW-01 192.0.2.2</Text></Shape>
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
        assert_eq!(core.addresses, vec!["192.0.2.1"]);
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
            <Shape ID='3' NameU='Plain'><Cell N='PinX' V='5'/><Cell N='PinY' V='4.6'/><Text>EDGE-RTR 203.0.113.9</Text></Shape>
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
        assert_eq!(d.addresses, vec!["203.0.113.9"]);
    }

    #[test]
    fn a_connector_glued_at_one_end_is_still_a_link() {
        // The common case in a hand-drawn diagram, and the one that lost real
        // links: the line is glued to a device at one end and merely touches
        // the other. Reading the <Connects> table alone drops it entirely.
        // Each end now resolves on its own — glue where there is glue, nearest
        // shape where there is not — and the link says it was not fully glued
        // so it can be checked rather than trusted.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>RTR-01</Text></Shape>
            <Shape ID='2' NameU='Workgroup switch'><Cell N='PinX' V='4'/><Cell N='PinY' V='5'/><Text>SW-01</Text></Shape>
            <Shape ID='3' NameU='Dynamic connector'><Cell N='BeginX' V='1'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='4'/><Cell N='EndY' V='5'/><Cell N='Width' V='3' F='GUARD(EndX-BeginX)'/></Shape>
            <Shape ID='4' NameU='Plain'><Cell N='PinX' V='2.5'/><Cell N='PinY' V='5'/><Text>Gi0/1 &lt;&gt; Gi1/0/24</Text></Shape>
        </Shapes>
        <Connects>
            <Connect FromSheet='3' FromCell='BeginX' ToSheet='1'/>
        </Connects></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert_eq!(page.links.len(), 1, "a half-glued connector is still a cable");
        let l = &page.links[0];
        assert_eq!((l.source.as_str(), l.target.as_str()), ("1", "2"));
        // And the ports stay the right way round: the router's on the router.
        assert_eq!((l.source_port.as_str(), l.target_port.as_str()), ("Gi0/1", "Gi1/0/24"));
        assert!(!l.glued, "an end worked out from geometry is not a stated fact");
    }

    #[test]
    fn a_connector_glued_at_neither_end_still_joins_what_it_touches() {
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>RTR-01</Text></Shape>
            <Shape ID='2' NameU='Workgroup switch'><Cell N='PinX' V='4'/><Cell N='PinY' V='5'/><Text>SW-01</Text></Shape>
            <Shape ID='3' NameU='Dynamic connector'><Cell N='BeginX' V='1'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='4'/><Cell N='EndY' V='5'/><Cell N='Width' V='3' F='GUARD(EndX-BeginX)'/></Shape>
        </Shapes></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert_eq!(page.links.len(), 1);
        assert!(!page.links[0].glued);
    }

    #[test]
    fn a_drawing_that_glues_nothing_still_yields_its_links() {
        // The Lucidchart family: every cable is a `com.lucidchart.Line` and
        // there is no <Connects> section at all. Before, none of these was
        // recognised as a connector, so the drawing came in with no links --
        // and each line was imported as a *device*, since a shape with a
        // master that is not a connector is taken for equipment.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='com.lucidchart.NET_Switch'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>SW-01</Text></Shape>
            <Shape ID='2' NameU='com.lucidchart.NET_Router'><Cell N='PinX' V='4'/><Cell N='PinY' V='5'/><Text>RTR-01</Text></Shape>
            <Shape ID='3' NameU='com.lucidchart.Line'><Cell N='PinX' V='2.5'/><Cell N='PinY' V='5'/><Cell N='BeginX' V='1'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='4'/><Cell N='EndY' V='5'/></Shape>
        </Shapes></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        let mut labels: Vec<&str> = page.devices.iter().map(|d| d.label.as_str()).collect();
        labels.sort_unstable();
        assert_eq!(labels, vec!["RTR-01", "SW-01"], "a line is not a device");
        assert_eq!(page.links.len(), 1);
        assert!(!page.links[0].glued, "worked out from geometry, so flagged");
    }

    #[test]
    fn a_line_card_is_not_mistaken_for_a_cable() {
        // "Line" and "connector" turn up inside equipment names, so the master
        // is matched a word at a time rather than as a substring.
        assert!(master_says_connector("com.lucidchart.Line"));
        assert!(master_says_connector("Dynamic connector"));
        assert!(master_says_connector("com.lucidchart.LineElbow"), "a bent line is still a line");
        assert!(!master_says_connector("Catalyst 6500 Line Card 48-port"), "a line card is equipment");
        assert!(!master_says_connector("Inline power injector"));
        assert!(!master_says_connector("N9K-C93180YC-EX Front"));
    }

    #[test]
    fn the_old_binary_format_is_named_rather_than_just_refused() {
        let ole = [0xD0u8, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0];
        let err = import_vsdx(&ole).unwrap_err();
        assert!(err.contains(".vsd"), "{err}");
        assert!(err.contains("Save As"), "should say what to do about it: {err}");
    }

    #[test]
    fn a_line_into_empty_space_is_not_turned_into_a_link() {
        // The other half of the same rule. An unglued end far from anything
        // stays unresolved: inventing a device for it would be worse than
        // dropping the line.
        let xml = r#"<PageContents><Shapes>
            <Shape ID='1' NameU='Router'><Cell N='PinX' V='1'/><Cell N='PinY' V='5'/><Text>RTR-01</Text></Shape>
            <Shape ID='3' NameU='Dynamic connector'><Cell N='BeginX' V='1'/><Cell N='BeginY' V='5'/><Cell N='EndX' V='40'/><Cell N='EndY' V='5'/><Cell N='Width' V='39' F='GUARD(EndX-BeginX)'/></Shape>
        </Shapes></PageContents>"#;
        let (page, _) = parse_page(xml, "Page-1").unwrap();
        assert!(page.links.is_empty());
    }

    /// A real drawing to read, if the operator has one on this machine.
    ///
    /// Real drawings belong to the people who drew them, so none is kept in
    /// this repository and nothing about one is written down here — not a
    /// filename, not a device name, not an address. Point `COREVIEW_VISIO_DIR`
    /// at a folder of `.vsdx` files and this reads the first one it finds; with
    /// no such folder, as in CI and on every other machine, it skips.
    ///
    /// What it can still assert is everything that must hold for *any*
    /// drawing, which is where the real regressions were anyway: that a port
    /// label never becomes a device name, that a device is never nameless,
    /// that glue is read, and that ports come out attached to ends.
    fn a_drawing_to_read() -> Option<Vec<u8>> {
        let dir = std::env::var("COREVIEW_VISIO_DIR").ok()?;
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("vsdx")))
            .collect();
        files.sort();
        std::fs::read(files.first()?).ok()
    }

    #[test]
    fn a_real_drawing_reads_without_breaking_any_of_the_rules() {
        let Some(bytes) = a_drawing_to_read() else {
            eprintln!("skipping: set COREVIEW_VISIO_DIR to a folder of .vsdx files to run this");
            return;
        };
        let out = import_vsdx(&bytes).expect("a .vsdx should import");
        let devices: usize = out.pages.iter().map(|p| p.devices.len()).sum();
        let links: usize = out.pages.iter().map(|p| p.links.len()).sum();
        let ported = out
            .pages
            .iter()
            .flat_map(|p| &p.links)
            .filter(|l| !l.source_port.is_empty() || !l.target_port.is_empty())
            .count();
        // Counts only. Naming what was in somebody's drawing, even in a test
        // log, is how it ends up somewhere it should not be.
        eprintln!("pages={} devices={devices} links={links} ported={ported}", out.pages.len());
        assert!(devices > 0, "no devices read");

        for p in &out.pages {
            let ids: Vec<&str> = p.devices.iter().map(|d| d.id.as_str()).collect();
            for d in &p.devices {
                // A caption naming both ends of a cable is not a device.
                assert!(
                    split_port_pair(&d.label).is_none(),
                    "a port pair became a device name"
                );
                // Nor is a single interface.
                assert!(!is_port_label(&d.label), "a port label became a device name");
                assert!(!d.label.trim().is_empty(), "a device came out with no name at all");
            }
            for l in &p.links {
                // Every link joins two devices that were actually imported,
                // and never joins one to itself.
                assert!(ids.contains(&l.source.as_str()), "a link starts at no device");
                assert!(ids.contains(&l.target.as_str()), "a link ends at no device");
                assert_ne!(l.source, l.target, "a link joins a device to itself");
            }
        }
    }
}
