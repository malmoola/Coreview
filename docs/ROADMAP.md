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

**Known bugs, open:** none — as of 2026-08-30.
**Known bugs, closed:** LT-030, LT-031, LT-003, LT-044, LT-004, LT-005.

### LT-031 — **bug** Three CSS variables that were never defined — 2026-08-30
**Source:** found while doing LT-001, not reported.
**Was:** `.cv-muted`, `.cv-warn` and `.cv-link` read `var(--cv-text-dim, …)`,
`var(--cv-warn, …)` and `var(--cv-accent, …)`. No such variables exist anywhere
in the project and never have, so all three always fell through to the
hardcoded fallback — which meant three pieces of the interface ignored the
ground entirely and stayed dark-theme coloured on a white page.
**Fixed:** they read `--text-dim`, `--warning` and `--accent`, which are the
variables that were meant.

### LT-004 — **bug** A selected shape is outlined by its own outline — 2026-08-30
The square box round the circular router glyph was the NodeResizer's line
rectangle. Every shape already draws its own highlight — the ring on a
glyph, the stroked outline on a cloud, the radius-following shadow on a
circle or diamond — so the resizer's line keeps its edge-drag hit area and
loses its paint, and the corner handles stay, which the item allows. One
specificity fight recorded: React Flow's own `.react-flow__resize-control.line`
rule outweighs a single class, which is why the first fix changed nothing.
Verified by measurement in the harness and by eye.

### LT-005 — **bug** Clearing the icon library — 2026-08-30
"clear" now sits next to "reload": it empties the palette section, forgets
the stored `iconLibraryDir` so startup stops re-indexing it, and brings the
folder input back so a different library can be chosen — without restarting
the app, and without touching anything on disk, because the icons were never
copied in. Staged and verified end-to-end through the dev store handle.

### LT-003 — **bug** Custom shape import bugs — 2026-08-30
All four, in the icon-library scan, which is the app's custom-shape door:
**The scrambling** was the sanitiser: it rebuilt the file byte-by-byte
through a Latin-1 cast, so every non-ASCII glyph in an imported SVG came out
as mojibake, and it deleted every `<image>` element wholesale, which blanked
the artwork out of any icon carrying an embedded bitmap. Text now survives
byte-faithful, and an `<image>` stays when its href is an inline
`data:image/` URI — the kind that cannot reach the network; fetching hrefs
still go. Sibling groups, paths and **nested transforms were already kept
as-written**, which is now the documented, tested choice (preserve, never
rewrite).
**Naming:** index entry, else de-slugified filename, else the filename
itself; "Untitled" only when there is genuinely nothing (`display_name`,
tested).
**Routing:** the scan now converts `.emf`/`.wmf` itself through LibreOffice —
`src-tauri/src/shapeconv.rs` is a Rust port of the PPTX pipeline's crop,
bitmap-legalising and cruft-stripping, tested against the same fixtures and
numbers, and proven end-to-end by a committed real EMF from the Cisco deck
(test gated on soffice; CI runners skip it, the soffice-missing report has
its own test). A file soffice cannot draw is skipped *by name*; a folder of
EMFs with no LibreOffice says to install libreoffice-draw instead of "N
file(s) are not SVG".
**Differs from the ask in one place:** `.lcsl` is recognised and named
("a Lucidchart stencil — its converter is not built yet") rather than
converted — the converter is LT-006, and the file it must be verified
against is no longer on this machine. Routing it lands with LT-006.

### LT-002 — Cisco PPTX stencil pipeline — 2026-08-30
Unblocked the moment the operator installed libreoffice-draw, and run for
real: 215 EMF/WMF files from the deck became 217 SVGs in 9 categories under
`stencils/cisco/`, 81% named from the caption boxes beside them (the 41
unnamed are the slide-10 third-party logos and the wireless-connector
strokes, which have no captions in the deck to take). The contact sheet was
eyeballed, which caught one last conversion bug: LibreOffice writes
EMF-wrapped bitmaps as `<image>` with a *negative height* — invalid SVG,
drawn upside down where drawn at all, and invisible to the crop, which
sliced through the three raster logos. `normalizeImages` rewrites them as
positive geometry plus an explicit mirror; test first, then the fix, then
the deck reconverted and the sheet re-checked. Committed per D-019; the app
binary still ships none of it.

### LT-044 — **bug** Windows CI red: CRLF checkout breaks the stencil-test import
**Source:** operator screenshot, 2026-08-30 — every run since #88 red on
`test (windows-latest)` / Frontend tests, `SyntaxError: Invalid or unexpected
token` at import-pptx-stencils.test.mjs:7:31 (previously pptxStencils.test.ts:7:31 —
moving the file did not cure it, which was the tell that the position was a lie).
**Root cause (reproduced locally):** the Windows runner checks out with
autocrlf, so `import-pptx-stencils.mjs` arrives CRLF; vite strips its shebang
but leaves the carriage return behind, V8 rejects the transformed module, and
vitest attributes the error to the file that imported it. Bisected to line 1
alone: shebang+CR fails, CRLF everywhere else passes.
**Fix:** `.gitattributes` pins `eol=lf` for text files so every checkout —
runner or laptop — sees the bytes the tests were written against.
**Acceptance:** a test that fails without the pin; Windows CI green.


### LT-045 — The icon library reads Visio files where they live
**Source:** asked 2026-08-30 — "Can I import VSS and VSSX? or point the
application to My Shapes directory and let it see my VSS and VSSX?"
**Acceptance:** pointing the icon library at a folder that holds `.vss`,
`.vssx`, `.vsd` or `.vsdx` (a Windows "My Shapes" folder) shows their shapes
in the palette next to the SVGs, converted at scan time the way EMF already
is; a stencil's masters each become their own icon, named from the master.
Files the converter cannot open are reported by name.
**Built 2026-08-30, verified as far as the files on hand allow:** the scan
routes all four extensions through libvisio (vss2xhtml / vsd2xhtml), splits
the output into one standalone SVG per master or page, crops, sanitises and
names them; a real `.vsdx` from libvisio's test suite converts end-to-end
into a named palette icon (fixture committed, test gated on the tools). The
`.vss`/`.vssx` stencil path is the same code through vss2xhtml but there is
no stencil on this machine to run it against — **awaiting one real `.vss`
and `.vssx` from the operator's My Shapes folder to verify per-master
splitting and naming before this is called Done.** Masters are currently
named "<file> 1..N"; real master names, if wanted, are a follow-up.

### LT-050 — Port labels sit at the ends of a link — 2026-08-30
Chips now ride the drawn path a fixed distance from each end — beside their
own device — instead of a third of the way along the straight chord, which
was the middle of the room. The centre label is untouched. Verified by
measurement (a chip must sit far closer to its device than to the other
end) and by eye against a staged pair.

### LT-055 — **bug** Two parallel links both labelled Gi1/0/11 — 2026-08-30
Same root as LT-050: parallel cables out of one handle share the straight
chord, so their chips stacked exactly and "Gi1/0/12" sat hidden underneath
"Gi1/0/11". On the drawn path, edges sharing a start point are ranked by id
and each rank slides one chip-length further along the trunk, so every
cable's port is readable. The lab picture itself still wants a re-crawl
once a build with LT-054's kex fix reaches the 9300.

### LT-054 — **bug** The Catalyst 9300 refuses our SSH: no common kex — 2026-08-30
First live contact with the 9300 (LT-010) and the crawler could not even
shake hands: the box is locked to `ip ssh server algorithm kex
ecdh-sha2-nistp521 ecdh-sha2-nistp384` — the pair the IOS-XE hardening
guides recommend — and russh's defaults do not offer NIST ECDH at all. The
offer list now carries nistp521/384/256, biggest curve first, below the
modern curves and above the SHA-1 tail; the failing test reproduces the
box's exact offer. Keyboard-interactive auth (`authentication keyboard`, the
other half of that config) was already implemented as a fallback. Needs the
operator to rerun the crawl against 192.168.14.20 from a build with this in
it before LT-010 can be called tested.

### LT-047 — Zoom without walls — 2026-08-30
The wheel now runs 0.01x–100x — no real diagram meets either end. Fits keep
the old 2x ceiling on purpose: fitting two close devices with no ceiling
turned them into one monitor-filling glyph, which is how this item briefly
broke half the harness. Two ripples were paid for honestly: the mount-time
fit needed its own explicit cap once the provider bounds blew open, and
below the old 0.5x fit floor the harness's fixed-corner clicks could land on
a neighbour — those checks now aim at the glyph's own pixels. The recovery
writer also stopped running under automation (navigator.webdriver): an
environmental mid-run reload armed a perfectly correct banner whose 34px
shifted every measurement after it, and the harness plants its recovery
slots directly, so no coverage was lost.

### LT-048 — **bug** "Healthy" unreadable on its green chip — 2026-08-30
Three components shared the class .cv-chip, and the filter-chip rules later
in the stylesheet clobbered the status pill's ink — dim grey on bright
green, exactly "not white enough". The pill is .cv-status-chip now, painted
with --on-status as designed, and a harness check measures the painted
contrast (was 1.27:1, must clear 4.5:1). The two button-chip blocks still
share a name and fight over padding; noted, not reported, left alone.

### LT-049 — **bug** A text box draws a border — 2026-08-30
Selected text no longer wears the box selection rectangle, and a text node
offers no connection handles — a label is not something a cable plugs into
(the follow-up ask in the same message). Border was already transparent;
resize handles remain, as allowed.

### LT-046 — Chrome stays dark; only the diagram area follows the ground
**Source:** asked 2026-08-30 — "white theme is still not so good… make the
side panels remain as the dark color don't change when we switch to white
background, same with both top and bottom panels, so only the diagram area
turn white and light brown."
**Acceptance:** the side, top and bottom panels keep the dark chrome in both
grounds; switching to the white ground changes only the canvas — white page
on a light-brown desk. Supersedes LT-034's light chrome, which is retired
with its harness checks.

### LT-051 — Drag a link label along its link
**Source:** asked 2026-08-30 — "add the link labels anywhere and drag it
along the links but it shouldn't leave the links area."
**Acceptance:** a link label can be dragged; while dragging it slides along
the link's drawn path and cannot leave it; the position survives save/reload.

### LT-052 — Double-click a link to write flat text on it
**Source:** asked 2026-08-30 — "double click area on the link and add port
number or text flat no box or boarders just text attached to the link."
**Acceptance:** double-clicking a spot on a link opens a caret there;
the committed text renders flat — no box, no border — attached to the link at
that spot, and moves with the link.

### LT-056 — **bug** The installer's app is blocked on the second machine — resolved 2026-08-30
Reported with a screenshot ("Windows cannot access the specified device,
path, or file"), and withdrawn by the operator the same hour: the block was
that machine's own policy, and the same installer runs fine on another
Windows machine. Nothing to change in Coreview; kept because the symptom and
its reading (Windows application control refusing a binary whose internal CA
the machine does not trust) will recur on any locked-down host — that is
LT-011's public-CA half.

---

## Next

*Accepted, not started.*

### LT-006 — Lucidchart `.lcsl` import
**Source:** asked 2026-08-30. File `Affinity-Native.lcsl`, 65 shapes.
**Blocked on:** the file. `Affinity-Native.lcsl` is no longer on this machine
(2026-08-30) and the converter cannot be verified without it — re-provide it
and this unblocks. The scan already recognises `.lcsl` by name (LT-003).
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

### LT-009 — Draw a port-channel as one link
**Source:** asked 2026-08-29.
**Blocked on:** a LAG configured on the lab switch. `show etherchannel summary`
answers "Number of channel-groups in use: 0", so there is no populated table to
write a parser against.
**Would unblock it:** two ports bonded on the test switch, then the parser is a
morning's work against real output. Operator said 2026-08-30 he will source a
Cisco switch with port-channels configured.
**Note:** inferring a bundle from consecutive port numbers was tried and
reverted — see D-014.

### LT-010 — Verify against Catalyst 9000 / IOS-XE 17
**Source:** asked 2026-08-29.
**Blocked on:** access to a Catalyst 9000. The CDP and LLDP parsers are written
against a C2960CX, a FortiSwitch and a FortiGate only. Operator has a 9300 he
will power on to test against (2026-08-30).

### LT-011 — Signed Windows installers on machines that do not trust the
internal CA
**Source:** asked 2026-08-29.
**Half of this is done and verified 2026-08-30:** the two GitHub secrets are
configured and every Windows bundle is being signed — run #98's annotation
reads "Signing as … CN=COREVIEW-APP Code Signing", thumbprint 7996CE1E…
Machines that trust the internal CA see a valid signature today.
**Still blocked on:** the other half — machines *outside* that trust, and
SmartScreen. Only an OV/EV certificate from a public CA clears those; the
internal COREVIEW-FGT-Root-CA cannot and never will.

### LT-012 — Legacy binary `.vss` stencils
**Source:** raised 2026-08-30; deferred by the operator, then unblocked by him
the same day: `libvisio-tools` is installed (vss2xhtml and friends on PATH),
and LibreOffice itself reads Visio through the same libvisio. Folded into
LT-045's converter work — the .vss route lands there.

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

### LT-043 — Hover card during validation — 2026-08-30
The monitored-objects row, brought to the cursor: while validation runs,
hovering a device floats its primary probe's last result, RTT and checked
time over the node, ticking so "4s ago" never goes stale under a held
cursor. A 250ms intent delay keeps a crossing cursor from strobing cards;
the native tooltip yields while the card can show and returns when the
session stops. Tested end-to-end by staging a running session through a
dev-only store handle (`window.__cvStore`, absent from builds) — a real
session needs the Tauri backend the browser harness does not have.
This closes Item D and the 2026-08-30 batch (LT-034…LT-043).

### LT-042 — Autosave and restore — 2026-08-30
Shipped as crash recovery, composing with what already existed: edits are
saved for real 2.5 seconds after they stop, so the new slot covers only the
window that save can miss — the app dying mid-edit, or the machine going down
before the debounce fires. Written every 60s while dirty and on the way out,
offered back on the next open only when newer than the last real save (an
older slot is stale and is silently cleared), restored as an edit so undo can
take it back, cleared by every successful save. No cloud, no new dependencies.
**A day of debugging worth recording:** the harness intermittently reloads
mid-run (environmental — a renderer hiccup on two-hundred-check runs), and the
banner then appears exactly as designed, shifting the canvas 34px and breaking
every geometry measured before it. Bisecting was poisoned twice: first by
three zombie vite dev-servers all watching the tree and pushing stale reloads
into the page, then by editing app files seconds before runs against a live
HMR server. The harness now dismisses a recovery banner before any block that
measures, and the lesson — one dev server, no edits mid-run — is in the
handover.

### LT-041 — Export renders exactly the page rect — 2026-08-30
Shipped: SVG and PNG exports render exactly the LT-036 sheet — same function,
same visible-view nodes, so hidden views do not hold the exported sheet open —
in whichever ground is active, with devices staying where they sit on the
sheet rather than being slid to a shrink-wrapped margin. The export never
contained the minimap or selection chrome (it draws from the model, D-001);
that is now asserted rather than assumed.

### LT-040 — The filter box finds on the canvas — 2026-08-30
Shipped: typing in the monitored-objects filter lights every canvas match with
a ring and steps everything else back to 30% — found, not hidden. Enter
centres and selects the first match, zooming in only if the view is far out.
Clearing the box puts the canvas back exactly.

### LT-039 — Keyboard pass and a "?" shortcut overlay — 2026-08-30
Shipped: arrows nudge a pixel, Shift-arrows a grid step; Ctrl+D duplicates one
grid step over with the copy taking the selection; Esc closes what is on top
first, then clears the selection; "?" opens an overlay naming everything,
arrange keys included. Two things found on the way: React Flow's own arrow-key
a11y movement was adding five pixels on top of the one-pixel nudge, so a
single press walked a device six — it is off, and ours is the only keyboard
movement; and Ctrl+D used to leave the original selected, so the next Delete
removed both the copy and the thing copied.

### LT-038 — Align/distribute on the keyboard — 2026-08-30
Shipped: Ctrl+Alt+L/C/R aligns left/centre/right, Ctrl+Alt+T/M/B tops,
middles, bottoms, Ctrl+Alt+H/V evens the gaps across or down — the keyboard
half of the context menu's arrange, on the same `store.arrange` path, so the
two cannot drift apart. Only fires with more than one thing selected.

### LT-037 — Smart guides: Alt disables — 2026-08-30
Shipped: Alt held during a drag stands the guides and the snap down and clears
any guide already shown. Tracked in a ref so a keypress does not re-render the
canvas. Verified: a device dragged to 3px off a neighbour's edge snaps without
Alt and stays deliberately off-line with it.

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
