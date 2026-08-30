# Decisions

Append-only. A past entry is never edited; it is superseded by a new one that
references its ID.

Each entry: date, ID, the decision, what was rejected, and why.

---

### D-001 — The export draws itself from the model — 2026-08-28
**Decision:** the SVG export is rendered from nodes, edges and statuses, not by
serialising the live canvas.
**Rejected:** serialising `.react-flow__viewport`.
**Why:** React Flow lays nodes out as absolutely positioned HTML `<div>`s. Wrap
that in an `<svg>` and you get a valid file that no renderer will draw — and it
fails silently: the edges and the title block appear and every device is
missing. It costs a second implementation of the node's appearance and buys an
export that works, does not depend on what is scrolled into view, and is a pure
function that can be tested without a browser.

### D-002 — Rust stores the diagram as opaque JSON — 2026-08-28
**Decision:** `ProjectPackage.document` is a `serde_json::Value`. The storage
layer never parses the diagram.
**Rejected:** a typed Rust struct mirroring the document.
**Why:** every field the interface adds after that struct is written would be
dropped on the next save, and the person would find out when their diagram
reopened without its views, its leaders or its colours. Proved by test on
2026-08-30: a document round-trips byte for byte including a field the storage
layer has never heard of.

### D-003 — No vendor artwork in the repository or the binary — 2026-08-28
**Decision:** Coreview draws its own glyphs. Third-party icon sets are fetched
or converted into a folder the operator points the app at.
**Rejected:** bundling a vendor icon set.
**Why:** licensing and trademark. It is also why the icon library is a folder
path rather than an asset directory, and why `scripts/fetch-modern-shapes.mjs`
writes licences next to what it downloads.

### D-004 — Telnet is never tried after a password is refused — 2026-08-29
**Decision:** fall back to telnet on a timeout or a refused connection, never
on a rejected password.
**Rejected:** falling back on any SSH failure.
**Why:** a rejected password means the account exists and the credentials are
wrong. Sending them again in clear text is worse than failing.

### D-005 — A port-channel is not inferred from port numbering — 2026-08-29
**Decision:** links are not collapsed because their ports are consecutive.
**Rejected:** treating consecutive ports between the same pair as a bundle.
**Why:** two consecutive cables between a pair are as likely as an
aggregation. The app would be asserting something it cannot observe, which is
the one thing it is not supposed to do. Doing it properly means asking the
device — see LT-009.

### D-006 — Credentials are never in an export unless asked for — 2026-08-29
**Decision:** a project package carries no credentials; there is a separate,
labelled export that includes the vault.
**Why:** a project package is the thing people send each other.

### D-007 — Two grounds, not an inversion — 2026-08-30
**Decision:** the light ground has its own palette, chosen against white.
**Rejected:** deriving light colours by inverting or lightening the dark ones.
**Why:** amber at `#e8a33d` is legible on `#0a0e13` and disappears on white. A
first attempt dimmed the dark palette and every diagram looked faded.
**Superseded in part by D-016** for the neutral-grey desk.

### D-008 — An unwatched device is drawn by what it is — 2026-08-30
**Decision:** colour by device type when the status is `unknown`; health takes
the colour back as soon as a probe is attached.
**Rejected:** always colouring by health.
**Why:** with no probes every device is "unknown", so a diagram nobody has
pointed at anything yet came out entirely grey. The status line never borrows
the device's colour, or a blue switch would read as though blue meant
something.

### D-009 — Only one of a crossing pair hops — 2026-08-30
**Decision:** the horizontal run hops the vertical; where both lie at the same
angle the edge id breaks the tie.
**Rejected:** both hopping; deciding by render order.
**Why:** two arcs through each other is worse than none, and a decision that
depends on which edge rendered first makes the hop flicker between them.

### D-010 — `onlyRenderVisibleElements` is not used — 2026-08-30
**Decision:** React Flow renders every node.
**Rejected:** rendering only what is on screen.
**Why:** measured — it halves the DOM and improves opening and panning, and
makes dragging three times worse, because React Flow recalculates what is
visible on every frame of a drag. Recorded so it is not tried again.

### D-011 — A view is a property of an object — 2026-08-30
**Decision:** an object carries a list of views; a view is not a container.
**Rejected:** views owning their contents.
**Why:** nothing has to move between views, an object can be on more than one,
and an object that has never been assigned is on all of them — which is what
keeps a diagram drawn before views existed opening with everything visible.
Deleting a view does not delete what was on it.

### D-012 — A section's contents are geometric — 2026-08-30
**Decision:** a section holds whatever stands inside it, recomputed, never
stored.
**Rejected:** a membership list.
**Why:** "everything in this half of the picture is the DMZ" is not a list
anybody maintains. Membership goes by a device's middle, so one half over the
border belongs to the side most of it is on.

### D-013 — Alignment guides replace grid snapping — 2026-08-30
**Decision:** no ten-pixel grid snap; devices line up with their neighbours.
**Rejected:** keeping both.
**Why:** two devices can both sit on the grid and still be four pixels out from
each other, which is what a diagram looks untidy for — and the grid fought the
guides for the last few pixels of every drag.

### D-014 — Space-panning is done with an overlay, not React Flow — 2026-08-30
**Decision:** while space is held, a transparent sheet covers the canvas, takes
the drag, and moves the viewport directly.
**Rejected:** `panOnDrag` including the left button; disabling nodes with CSS
`pointer-events`.
**Why:** a drag that begins over a device is captured by the device before the
pane sees it, and a device is exactly where the pointer usually is. React Flow
sets `pointer-events` on a node inline, where no stylesheet reaches.

### D-015 — A leader carries no health — 2026-08-30
**Decision:** a line whose `kind` is `leader` reports no status, is not
counted, has nothing travelling along it, and does not hop.
**Rejected:** an ordinary link with its health rule turned off.
**Why:** it is an annotation, not a cable. Reporting a health for it would put
a made-up green line in the counts and a made-up outage in the timeline.

### D-016 — The canvas gets a neutral desk and a white page — 2026-08-30
**Decision:** the viewport is a neutral grey desk; the drawing surface is a
white page floating on it. Tokens are hue-neutral.
**Rejected:** painting the viewport white (the current `#f4f7fa`).
**Why (the operator's):** "Visio and Lucidchart do NOT paint the viewport
white... that contrast is what makes white look white." Supersedes the light
ground's `--bg` from D-007; the rest of D-007 stands.
**Status:** accepted, not yet implemented — LT-001.

### D-017 — Stencil conversion moves from Inkscape to LibreOffice — 2026-08-30
**Decision:** EMF→SVG goes through `libreoffice --headless --convert-to svg`,
batched, with a bounding-box crop afterwards.
**Rejected:** Inkscape, which is what `scripts/import-shapes.mjs` uses today.
**Why (the operator's):** LibreOffice emits each icon on a full A4 page with
the artwork in the corner, so the viewBox has to be cropped to the real content
— "without this every icon renders as a tiny speck in a huge empty canvas".
Failing loudly when `soffice` is missing is part of the decision.
**Status:** accepted, not yet implemented — LT-002.

### D-018 — Remote Lucid assets are skipped, not faked — 2026-08-30
**Decision:** the 27 `.lcsl` shapes whose artwork lives on Lucid's servers are
written to `unresolved.json` with their names and urls and reported as a count.
**Rejected:** substituting a placeholder icon.
**Why (the operator's):** "Do not fabricate a placeholder that looks like a
real icon." A placeholder that looks real is worse than an absence.
**Status:** accepted, not yet implemented — LT-006.
