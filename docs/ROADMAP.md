# Roadmap

The single source of truth for what has been asked for. IDs are stable and are
never reused; items move between sections but are never deleted.

Acceptance criteria are written in the words they were asked in. Where what
shipped differs from what was asked, the Done entry says so.

---

## Now

*In progress or picked up next. Never more than three.*

### LT-001 — Neutral desk, white page, one colour token file
**Source:** asked 2026-08-30.
**Acceptance:**
- Canvas viewport is a neutral grey "desk"; the drawing surface is a real white
  "page" floating on it with a border and a soft shadow. "Visio and Lucidchart
  do NOT paint the viewport white."
- The palette is hue-neutral — "no blue shift anywhere". Tokens: `--desk
  #EDEDED`, `--page #FFFFFF`, `--page-border #D4D4D4`, `--grid-minor #EAEAEA`,
  `--grid-major #DCDCDC`, `--chrome #FAFAFA`, `--chrome-edge #E2E2E2`, `--ink
  #1A1A1A`, `--ink-muted #6B6B6B`, accent keeps the existing brand blue.
- Toolbar, palette and inspector read as chrome: `--chrome` background, 1px
  `--chrome-edge` divider, no drop shadows, and "slightly DARKER in value than
  the page, never lighter".
- Inspector inputs: `--page` background, 1px `--chrome-edge`, `--ink` text.
- Node names in `--ink`, status and secondary text in `--ink-muted`.
- The existing "Dark background" toggle keeps working by overriding the same
  tokens, not by a parallel set of hardcoded colours.
- `rg '#[0-9a-fA-F]{6}' src/` returns hits only in the token definition file.

**Audit already done (2026-08-30), for whoever picks this up:**
- No Tailwind. Styling is `src/styles.css` (85 hex literals) with CSS custom
  properties on `.cv-app`, plus `src/theme.ts` which holds the JS-side colours
  the canvas paints with.
- 162 hex literals across `src/**/*.ts(x)`. Outside `theme.ts` they are in
  `lib/diagram.ts`, `lib/tinting.ts`, `lib/topology.ts`, `lib/samples.ts`,
  `lib/exports.ts`, `components/inspector/Inspector.tsx`,
  `components/CsvImportPanel.tsx`.
- The blue-tinted off-white being complained about is `--bg: #f4f7fa` in the
  `.is-light` block of `src/styles.css`.
- The canvas background is painted by `.cv-app { background: var(--bg) }` and
  the grid by React Flow's `<Background>` in `src/components/Canvas.tsx`.

### LT-002 — Cisco PPTX stencil pipeline
**Source:** asked 2026-08-30. Supersedes the naive path in LT-020.
**Acceptance:**
- `scripts/import-pptx-stencils.mjs`: unzip, convert every `ppt/media/*.emf`
  with `libreoffice --headless --convert-to svg`, batched ~25 per invocation.
  "Fail loudly if soffice is missing — do not silently skip."
- Crop the viewBox to the real content bounding box plus ~2% padding and drop
  `width`/`height`, because LibreOffice emits each icon on a full A4 page with
  the artwork in the corner. "Without this every icon renders as a tiny speck
  in a huge empty canvas — this is the current 'Untitled Drawing' bug."
- Strip LibreOffice cruft: `presentation_clip_path` defs, the `ooo`/`smil`/
  `anim`/`presentation` namespaces, the DOCTYPE, empty `<g>` wrappers, `<svg>`
  stroke-width defaults; flatten `<g>` that carry only a clip-path.
- Name each icon from the nearest caption text box below the picture, using
  `<a:off>`/`<a:ext>` geometry; slide titles become categories; log any
  picture with no caption rather than inventing one.
- Expand `<p:grpSp>` groups into separate icons with the group transform
  applied — not merged into one shape.
- Output `stencils/cisco/<category>/<slug>.svg` plus `manifest.json`
  (`[{ id, name, category, file, slide }]`).
- Render a contact sheet of every produced SVG and confirm each icon is
  centred, fills its tile and is recognisable, before wiring the palette to it.
  Report converted / skipped / unnamed counts.

### LT-003 — Custom shape import bugs
**Source:** asked 2026-08-30, with screenshots.
**Acceptance:**
- A multi-element SVG imports as one palette entry and one node whose renderer
  draws the whole SVG. "One source file = one palette entry = one node" — stop
  collapsing sibling `<g>`/`<path>` into a single scrambled object.
- Nested transforms on grouped elements are not dropped: either apply parent
  transforms to children at import, or preserve `<g transform>` as-is. Pick one
  and be consistent.
- An unnamed import falls back to the de-slugified source filename before
  falling back to "Untitled".
- The importer accepts `.emf`, `.svg` and `.lcsl` directly and routes each to
  the right converter, instead of refusing non-SVG with a count in a toast.

---

## Next

*Accepted, not started.*

### LT-004 — A selected shape is outlined by its own outline
**Source:** asked 2026-08-30, with a screenshot of a router showing a square
selection box round a circular glyph.
**Acceptance:** selecting a shape highlights the shape itself, not a
rectangular bounding box round it. Resize handles may still sit on the box.

### LT-005 — Clearing the icon library
**Source:** reported 2026-08-30: "Icon library stuck and can't clear it".
**Acceptance:** a loaded icon library folder can be cleared or changed from the
palette without restarting the app, and the stored `iconLibraryDir` setting is
cleared with it.

### LT-006 — Lucidchart `.lcsl` import
**Source:** asked 2026-08-30. File `Affinity-Native.lcsl`, 65 shapes.
**Acceptance:**
- 35 shapes with real vector in `properties.Stencil.Shapes[]`: convert `Points`
  (normalised 0..1) and `Lines` (`p1`/`p2` indices, `n1`/`n2` cubic control
  *offsets*) into SVG paths in `viewBox "0 0 1 1"` — `C` where the offsets are
  present, `L` where they are not, closing when the chain returns to its start.
  Map `prop` values for FillColor/StrokeColor/LineWidth to `currentColor` or the
  shape's own colours.
- 24 `ImageFillProps` shapes and 3 `UserImage2Block` shapes reference remote
  Lucid assets. "Do not fabricate a placeholder that looks like a real icon."
  Skip them, write `stencils/lucid/unresolved.json` with name and url, and
  print "24 of 65 shapes reference remote Lucid assets and were skipped."
- The one `Group` ("Master.79") is expanded per Object or skipped entirely —
  "do NOT flatten it into a single unreadable blob".
- The 5 bare unit rectangles are skipped.

### LT-007 — Grid clipped to the page
**Source:** asked 2026-08-30 as part of the canvas redesign; kept separate
because it can ship independently of the tokens.
**Acceptance:** the grid is an SVG pattern inside the page so it stops at the
page edge rather than covering the desk. Minor lines every 12px in
`--grid-minor`, major every 60px in `--grid-major`. The current `<Background>`
component is removed if it paints the viewport.

### LT-008 — The page is not an object
**Source:** asked 2026-08-30 as part of the canvas redesign.
**Acceptance:** the page node is non-draggable, non-selectable,
non-connectable, `zIndex -1`, at 0,0, default 1584x1224 (11x8.5in @ 144dpi),
and never appears in the Monitored Objects table, exports, or save payloads —
filtered at each of those boundaries.

---

## Blocked

### LT-009 — Draw a port-channel as one link
**Source:** asked 2026-08-29.
**Blocked on:** a LAG configured on the lab switch. `show etherchannel summary`
answers "Number of channel-groups in use: 0", so there is no populated table to
write a parser against.
**Would unblock it:** two ports bonded on the test switch, then the parser is a
morning's work against real output.
**Note:** inferring a bundle from consecutive port numbers was tried and
reverted — see D-014.

### LT-010 — Verify against Catalyst 9000 / IOS-XE 17
**Source:** asked 2026-08-29.
**Blocked on:** access to a Catalyst 9000. The CDP and LLDP parsers are written
against a C2960CX, a FortiSwitch and a FortiGate only.

### LT-011 — Signed Windows installers on machines that do not trust the
internal CA
**Source:** asked 2026-08-29.
**Blocked on:** two GitHub secrets (`WINDOWS_CERTIFICATE`,
`WINDOWS_CERTIFICATE_PASSWORD`) being added, and separately on an OV/EV
certificate from a public CA if SmartScreen is to be cleared — the internal
COREVIEW-FGT-Root-CA cannot do that and never will.

### LT-012 — Legacy binary `.vss` stencils
**Source:** raised 2026-08-30; deferred by the operator the same day ("Skip the
.vss for now").
**Blocked on:** a converter. `.vss` from Visio 2003–2010 is a compound binary
file, not a zip. `libvisio-tools` can read it; installing a system package is
the operator's call.

---

## Done

### LT-013 — Crawl a network and draw it — 2026-08-29
Shipped: CDP and LLDP over SSH and telnet, FortiOS command set, backup
credentials, chassis-id→ARP resolution, SNMP fallback, subnet scoping.

### LT-014 — Live status that is actually live — 2026-08-29
Asked: "I need it show real time status not fake". Shipped: three probes five
seconds apart, an amber ring and "1 of 3 missed" while a device is failing, and
the time each result was last confirmed.

### LT-015 — Reach the FortiGate at 192.168.14.1 — 2026-08-30
Shipped: FortiOS ends its prompt in `$` for a non-super_admin profile, which
the prompt finder rejected, so the device was unreachable entirely. Also VDOM
prompts, `execute dhcp lease-list` for 44 named endpoints, managed FortiSwitch
over FortiLink, and FortiAP status including each AP's own LLDP — the only
evidence of the UniFi switch anywhere in the crawl.
**Differs from the ask:** `diagnose user-device-store device memory list` does
not exist on that profile; the lease list is used instead and is better for the
purpose.

### LT-016 — The eight drawing enhancements — 2026-08-30
Tidy layout, find a device, change report, right-angle routing, bulk edit, CSV
export, status history, fold a site.

### LT-017 — Links that follow their devices — 2026-08-30
Asked: links should "rotate" as devices move. Shipped: a full turn — any of the
four sides — recomputed on every render, with lanes so links off the same side
do not overlap, hops where they cross, and per-link colour, style and end
shapes.

### LT-018 — Colours that are not pale — 2026-08-30
Asked: "no pale colors". Shipped: an unwatched device is drawn by what it is
rather than by a health it has not got; the light ground is built against white
rather than dimmed from the dark one; contrast floors are held by test.

### LT-019 — A modern shape set — 2026-08-30
Shipped: `scripts/fetch-modern-shapes.mjs` pulls 118 curated shapes from Tabler
(MIT) and Simple Icons (CC0) with licences written beside them.

### LT-020 — Import a PowerPoint stencil deck — 2026-08-30
Shipped: `scripts/import-shapes.mjs` converts the Cisco deck's EMFs through
Inkscape and names them from slide captions; 217 written, indexed by the app.
**Superseded by LT-002**, which replaces Inkscape with LibreOffice, adds the
bounding-box crop the icons need, and expands groups.

### LT-021 — Views, sections, callouts, page setup — 2026-08-30
More than one drawing in one document; a labelled area that carries what stands
in it; a line that is a remark rather than a cable; and an export placed on A4,
A3, Letter or Tabloid.

### LT-022 — Drive it like Lucidchart and Visio — 2026-08-30
Asked 2026-08-30. Shipped: a click in the middle of a device selects it —
invisible connection handles were keeping their hit area and swallowing clicks
meant for neighbours; left-drag on bare canvas rubber-band selects and the
catch moves together; space held drags the whole diagram; double-click on bare
canvas writes borderless text that moves and groups like any other object.

### LT-023 — Work tracking in the repository — 2026-08-30
This file, `docs/DECISIONS.md`, `docs/OPEN-QUESTIONS.md` and `CLAUDE.md`.

---

## Icebox

*Raised but deliberately deferred. Not dropped.*

### LT-024 — Connection points on imported shapes
A Visio master carries named ports; an imported EMF is a picture. Reading ports
would let a link land on "Gi0/1" rather than on the right-hand side. Deferred:
the conversion path produces pictures, so there is nothing to read yet.

### LT-025 — Two roadmap files
`ROADMAP.md` at the repo root (64 lines, MVP-era) and `docs/ROADMAP.md` (310
lines) both existed and had drifted apart. `docs/ROADMAP.md` is now this file
and is authoritative; the root one should be deleted or made a pointer.

### LT-026 — Canvas performance above ~400 devices
Measured 2026-08-30: 400 devices open in ~2s, drag at ~15fps, pan at ~8fps;
120 devices at 33 and 18. The cost is ~60 DOM elements per device.
`onlyRenderVisibleElements` was tried and rejected (D-010). Not worth doing
until someone actually has a diagram that large.

### LT-027 — Colour by VLAN
Colour by subnet, tag and role shipped. VLAN needs a source of VLAN membership
per device, which the crawl does not collect yet.

### LT-028 — Multi-sheet export
`sheetsFor` is written and tested and the page menu reports how many sheets a
diagram would need, but the SVG export writes one sheet. Printing tiles
naturally; an SVG per tile does not.
