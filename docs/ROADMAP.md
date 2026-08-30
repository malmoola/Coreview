# Roadmap

The single source of truth for what has been asked for. IDs are stable and are
never reused; items move between sections but are never deleted.

Acceptance criteria are written in the words they were asked in. Where what
shipped differs from what was asked, the Done entry says so.

---

## Now

*In progress or picked up next. Never more than three — LT-029 is a standing
bar rather than a piece of work, and does not count against that.*

### LT-029 — No known bugs
**Source:** asked 2026-08-30 — "I don't want any bugs".
**Acceptance:** a standing bar rather than a task that finishes.
- Every bug you report gets its own roadmap item the moment it is reported,
  with the symptom in your words. It is not folded into whatever else is being
  worked on.
- A bug is not fixed until it has been *reproduced* first — by a test that
  fails without the fix — and then verified by running it. "It compiles" is
  not "it works", and neither is "I changed the thing that looked wrong".
- The known-bug list is the items below tagged **bug**. When that list is
  empty, this item says so with a date. It goes back to Now the moment
  anything lands on it.
- Where a bug cannot be fixed, it says why in plain words rather than being
  quietly closed.

**Known bugs, open:** LT-003 (custom shapes import scrambled, transforms
dropped, "Untitled Drawing"), LT-004 (selection draws a box round a round
shape), LT-005 (icon library cannot be cleared).
**Known bugs, closed:** LT-030, LT-031.

### LT-031 — **bug** Three CSS variables that were never defined — 2026-08-30
**Source:** found while doing LT-001, not reported.
**Was:** `.cv-muted`, `.cv-warn` and `.cv-link` read `var(--cv-text-dim, …)`,
`var(--cv-warn, …)` and `var(--cv-accent, …)`. No such variables exist anywhere
in the project and never have, so all three always fell through to the
hardcoded fallback — which meant three pieces of the interface ignored the
ground entirely and stayed dark-theme coloured on a white page.
**Fixed:** they read `--text-dim`, `--warning` and `--accent`, which are the
variables that were meant.

### LT-003 — **bug** Custom shape import bugs
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

### LT-037 — Smart guides: Alt disables
**Source:** asked 2026-08-30 (Item D1). Guides and snapping already exist
(LT-001-era work); the missing half is holding Alt to disable them during a
drag.
**Acceptance:** alignment lines + snap when a dragged node lines up with a
neighbour's edge or centre; hold Alt to disable.

### LT-038 — Align/distribute on the keyboard
**Source:** asked 2026-08-30 (Item D2). The context-menu half already exists.
**Acceptance:** align left/right/top/bottom and distribute
horizontal/vertical, on the selection context menu and keyboard.

### LT-039 — Keyboard pass and a "?" shortcut overlay
**Source:** asked 2026-08-30 (Item D3).
**Acceptance:** Delete removes; Ctrl+D duplicates offset by one grid step;
arrows nudge 1px, Shift+arrows one grid step; Ctrl+A selects all in view; Esc
clears selection. All documented in a "?" overlay.

### LT-040 — The filter box finds on the canvas
**Source:** asked 2026-08-30 (Item D4).
**Acceptance:** typing in the existing monitored-objects filter box highlights
matches on the canvas, and Enter jumps/zooms to the first match.

### LT-041 — Export renders exactly the page rect
**Source:** asked 2026-08-30 (Item D5).
**Acceptance:** PNG and SVG export render exactly the LT-036 page rect, in
whichever theme is active, minimap and selection chrome excluded.

### LT-042 — Autosave and restore
**Source:** asked 2026-08-30 (Item D6).
**Acceptance:** snapshot the open document to the local store every 60s and on
window close; on next launch offer restore if newer than the last manual save.
No cloud, no new deps.

### LT-043 — Hover card during validation
**Source:** asked 2026-08-30 (Item D7).
**Acceptance:** hovering a device while validation runs shows last result, RTT
and checked time — the data already in the monitored-objects table, surfaced
at the cursor.

### LT-004 — **bug** A selected shape is outlined by its own outline
**Source:** asked 2026-08-30, with a screenshot of a router showing a square
selection box round a circular glyph.
**Acceptance:** selecting a shape highlights the shape itself, not a
rectangular bounding box round it. Resize handles may still sit on the box.

### LT-005 — **bug** Clearing the icon library
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

### LT-002 — Cisco PPTX stencil pipeline
**Source:** asked 2026-08-30. Supersedes LT-020.
**Blocked on:** LibreOffice. `soffice` is not installed and installing it needs
root, which is the operator's call — the spec itself says "fail loudly if
soffice is missing, do not silently skip", and this is that failure said
loudly.
**Checkpointed 2026-08-30, not abandoned:** `scripts/import-pptx-stencils.mjs`
is written and everything that does not need LibreOffice is tested against the
real deck — caption naming by geometry, slide-title categories, group
expansion, the manifest, and the viewBox crop (tested against a synthetic
LibreOffice-shaped SVG). The moment `soffice` exists, run:
`node scripts/import-pptx-stencils.mjs <deck.pptx> stencils/cisco` and check
the contact sheet it writes.
**Would unblock it:** `sudo apt-get install libreoffice-draw`.
**Acceptance (unchanged):**
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
  (`[{ id, name, category, file, slide }]`), **committed to the repository** —
  see D-019, which overrules the earlier policy.
- Render a contact sheet of every produced SVG and confirm each icon is
  centred, fills its tile and is recognisable, before wiring the palette to it.
  Report converted / skipped / unnamed counts.

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

### LT-001 — Neutral desk, white page, one colour token file — 2026-08-30
Shipped: the viewport is `--desk #EDEDED` and the drawing surface is a real
white page floating on it with a `--page-border` edge and the specified shadow.
The whole palette is hue-neutral. Chrome is `--chrome #FAFAFA` with
`--chrome-edge` dividers and no shadows, measured darker than the page.
Inspector fields sit on `--page`. The dark toggle moves the same tokens.
`rg '#[0-9a-fA-F]{6}' src/` now finds nothing outside `src/theme.ts` and the
three token blocks in `src/styles.css`.
**Differs from the ask in one place:** the page is drawn through React Flow's
viewport portal rather than as a node type — see D-021. Everything the ask
wanted from `zIndex -1` and the exclusions it listed comes for free that way.
**Found while doing it:** the page painted over the links until it was given
`z-index: -1`; the devices still drew, which made it look as though the links
had gone. And `--cv-text-dim`, `--cv-warn` and `--cv-accent` were being read in
three rules and have never been defined anywhere — every one of them was
silently falling back to a hardcoded hex.

### LT-007 — Grid clipped to the page — 2026-08-30
Shipped with LT-001: an SVG pattern inside the page, minor every 12px in
`--grid-minor`, major every 60px in `--grid-major`. React Flow's `<Background>`
is gone.

### LT-008 — The page is not an object — 2026-08-30
Shipped with LT-001, by construction rather than by filtering: the page is not
in `doc.nodes` at all, so there is nothing to keep out of the monitored-objects
table, the exports, the save payload, select-all, the crawl merge or any count.
Fit view fits the sheet rather than only what is on it, because fitting to the
devices puts the page edge off-screen and the edge is the thing that says where
the drawing surface is.

### LT-034 — Light chrome must not be white — 2026-08-30
Shipped: `--desk #E4E4E4`, `--chrome #F1F1F1`, `--chrome-edge #D6D6D6`, page
stays the only pure white. Measured, not eyeballed: page–chrome 14 RGB points
apart, chrome–desk 13, page–desk 27 — all above the "few points" failure bar.
Table rows sit on the page inside a chrome frame; the header stays chrome.
Minimap: desk-coloured map, chrome edge, ink-dark node marks — the old
blue-grey marks were within a few points of the mask, which is what made it a
blob. Dark theme untouched. Both-theme screenshots attached to the checkpoint.

### LT-035 — Minimap show/hide in the top bar — 2026-08-30
Shipped: an "Overview" checkbox beside Reduce motion, default on, persisted as
a view preference for this machine (like which panels are open — not part of
any project). Verified that toggling moves nothing: the viewport transform is
read before and after and must be identical.

### LT-036 — Page auto-grows with content — 2026-08-30
Shipped: one function (`src/lib/pageRect.ts`) computes the sheet — content
bounds of the current view + 120px margin, snapped outward in 60px steps,
never below the default sheet, never shrinking on its own. The renderer, Fit
view, the top-bar fit and the grid all read it. Growth is live during a drag
and remembered a moment later, without dirtying the document when nothing
grew. "Fit page to content" on the canvas menu is the one deliberate shrink.
**One reading settled while testing:** the 120px margin is the rule even
inside the default sheet — a device 100px from an edge grows that edge a step,
because the margin is what was asked for, not "grow only past the border".

### LT-032 — A handover document — 2026-08-30
**Source:** asked 2026-08-30 — a doc covering "this app and its code and
everything we need to know about" to hand the work to a different model and
have it continue.
**Shipped:** `docs/HANDOVER.md`. The map (what the app is, the shape of the
code, how to run and verify it, what "done" means here) and the minefield —
six categories of trap that have actually cost time on this project, each with
the specific failure and how it was found. Plus the lab hardware and what each
device proved, and the things that are true but written nowhere else.
**Deliberately not in it:** credentials. They belong in the vault, and any
that appeared in conversation should be rotated.

### LT-030 — **bug** A click in the middle of a device did nothing — 2026-08-30
**Source:** flagged 2026-08-30 — "clicking a node's centre selected nothing — a
neighbouring node's connection handle covers the middle after a tidy, and
swallows the click... if a click on a device does nothing, aim at the icon."
**Shipped, in `d81b91b`, before this was raised:** connection handles are
hidden until a device is pointed at, but hidden was not the same as
untouchable — an invisible handle kept its hit area, and that area is larger
than the dot it draws, so the handles of one device sat over its neighbours.
They now take the pointer only while they are visible.
**Verified by:** the check "a click in the middle of a device selects it" in
`e2e/interact.mjs`, which clicks the geometric centre of a device on a tidied
diagram where the neighbours are close. It fails without the fix.
**Not done the way it was offered:** the suggestion was to make handles ignore
clicks that are not drags. Making them untouchable until shown is simpler,
needs no drag-versus-click guess, and matches what the handles already did
visually.

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

### LT-033 — Stale debug scripts in `e2e/`
`e2e/dbg.mjs` and `e2e/dbg2.mjs` are one-off debugging leftovers that were
committed and never removed. Harmless, but they are the first thing a newcomer
opens. Delete them when next in that directory.

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
