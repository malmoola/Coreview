# Roadmap

The single source of truth for what has been asked for. IDs are stable and are
never reused; items move between sections but are never deleted.

Acceptance criteria are written in the words they were asked in. Where what
shipped differs from what was asked, the Done entry says so.

---

## Now

*In progress or picked up next. Never more than three — LT-029 is a standing
bar rather than a piece of work, and does not count against that.*

*(This section has drifted well past three — a lot of what's below reads as
already finished, some literally titled "resolved". Flagged to the operator
2026-09-06; not reorganised without being asked.)*

### LT-120 — **bug, open** A selected device blocks the links around it
**Source:** reported three times on 2026-09-09, most clearly with a screenshot
of a device ringed by its selection circle and links running under it — "I
still can't move all the lines / do you see this big circular its blocking me."
**Diagnosed, not fixed.** The circle is the glyph selection ring, and it is not
what intercepts: it takes no pointer events. What intercepts is the device's
own square node box. LT-112's clickable band sits at z-index 2, chosen from a
two-node fixture where React Flow gave each node z-index 1. Measured on a real
diagram it gives a resting node **4** and a selected node **1004**, so the band
loses in both cases and a link crossing the device you are working on cannot be
clicked at all.
**What was tried and backed out.** Raising the band above the nodes (1100) does
make those links clickable — measured, every sampled point, including while a
neighbour is selected. But above the nodes it also covers their *connection
handles*, and the harness caught the consequence immediately: a new link could
no longer be drawn from a callout, because neither the handle it starts at nor
the device it is dropped on could receive the pointer. Trimming the band's ends
so the last pixels belong to the device fixes that for links of ordinary
length, and cannot for short ones — there is nothing left to trim. Stepping the
band aside while a connection is in progress does not help either, because the
drag never starts.
**Where the fix actually is:** the node's hit area, not this z-index. A device
glyph is a symbol drawn inside a square box, and the box captures the pointer
across its whole area including the parts that are empty. A hit area that
follows what is drawn would let a link pass behind a device and stay clickable
without taking anything from the device's own handles. That is a change to how
every device is hit-tested and wants its own careful pass rather than being
squeezed in behind a link fix.
**Not shipped rather than shipped broken.** The escalation is reverted; the
comment on `.cv-edge-hit` records the limit so the next attempt does not start
by rediscovering it.

### LT-119 — Port labels take the full ink of the ground
**Source:** asked 2026-09-09 — "need the ports to be bright light please when
the background is dark, and black text when the backgroud is white."
**Built.** `.cv-edge-port` used `--ink-muted`, which is a mid grey on both
grounds — legible enough on neither, and these are the smallest and most-read
text on a diagram. It now uses `--ink`, which the white-background ground
remaps, so the label follows whichever is in use without knowing which it is,
and carries a little more weight at 10px. Measured: luminance 0.90 on the dark
canvas, 0.10 on the white one. Both are checked in `e2e/interact.mjs`, which
switches the ground through the store rather than hunting for the toolbar
button.

### LT-118 — **bug** Imported devices arrived as unusable shapes
**Source:** two reports on 2026-09-09 — "some of the imported diagrams they get
locked shaped I can't adjust their boarders", with a screenshot of a device
drawn as a vast flat ellipse, and "for me to move the link I have to extend and
make it long to make room to move the link".
**One cause, three symptoms.** LT-110 gave an imported device the *drawing's*
box. A Cisco rack unit is 2.06in by 0.185in, which at the import scale is a
node 357px by 32px — eleven to one. From that:

- A device glyph's selection ring is a circle (`border-radius: 50%`), and on an
  eleven-to-one box that draws an enormous flat ellipse around a small icon.
  That is the screenshot.
- Two rack units stacked as the drawing stacks them leave a link with no
  grabbable length between them — hence having to stretch one out first.
- **And it did not survive being reopened.** `migrateDocument` squares any
  device glyph whose sides differ by more than 12px, on every load (LT-053: a
  glyph's bounds are square so its ring and resize corners sit on the drawn
  symbol). An imported diagram therefore changed shape and moved between
  sessions. LT-110 was fighting a rule the app already had, and losing.

**Fixed.** An imported device is square, sized by the geometric mean of the
drawing's box — which keeps what was worth keeping, a cloud still arriving
larger than an access switch — clamped to a usable range. Positions still come
from the drawing, which is the part that makes it look like the original.
**Squares that would collide are pushed apart**, because they must be: a rack
unit is drawn thinner than the gap between two of them, so as squares they
overlap at *every* scale. Scaling cannot fix that — it moves the gap and the
size together — which took one wrong attempt to see. Each device is settled
against those already placed, in the drawing's own order, so a rack comes back
stacked and in order rather than shuffled.

### LT-117 — **bug** "Save this style as the default" only saved it for one page
**Source:** reported 2026-09-09 — "save link stile as the default doesn't
really save it."
**Reproduced, and it does save — for the page you are looking at.** The action
called `setCanvas`, and the canvas has been per page since LT-094. Save the
style, add a page, and links drawn there come out in the built-in grey. Not an
edge case: importing a multi-page Visio drawing creates a page per Visio page,
so the style is set on the first and missing from every other.
**Fixed.** The default look of a link is a property of the diagram, not of one
of its canvases. `setDefaultLinkStyle` writes it to every page, and a page
added later inherits it from the one in front of you.
**Worth recording:** the first version of this check "failed" because my own
harness re-seeded its fixture on every navigation, including the reload it was
using to prove persistence — it overwrote the value it then reported missing.
The app was briefly accused of a bug it did not have.

### LT-116 — **bug** Removing a stencil pack did nothing, and said nothing
**Source:** reported 2026-09-09 with a screenshot of the confirm dialog —
"remove doesn't do anything, you delete this tripp-lite stencil pack and I
don't want it."
**Diagnosed.** The button deleted the pack's folder from the app's own
resources. An app installed where the person running it cannot write —
`/Applications`, `Program Files` — cannot do that, and on macOS editing a
signed bundle would break its signature. The delete failed, and the dialog
swallowed the error with `.catch(() => undefined)`, closed itself, and left the
pack where it was. Reproduced by making a directory read-only and watching
`remove_dir_all` refuse.
**Fixed.** Removal is a decision rather than a fact about the disk: the pack is
recorded in settings, and both the pack list and the icon scan skip it, so its
shapes leave the palette whether or not the files can be deleted. The files are
still deleted where that is possible, and the outcome says which happened —
"freed the space it used", or "its files could not be deleted, so the space is
still used". The dialog no longer swallows anything.
**Note on the pack itself:** `stencils/` in this repository ships `cisco` only.
The Tripp Lite pack was removed from the repo under LT-100, so an install that
still shows it predates that; removing it now takes it out of the palette for
good.

### LT-115 — A stack is one device with several serials
**Source:** asked 2026-09-09 — "Address the crawl's serial when we have cluster
of switches. There should be a comma separator."
**Correct, and it was a real hole.** LT-114 shipped `serial` as a single value
and took the first one it found. A StackWise stack, a VSS pair or a chassis
with two supervisors is one hostname, one management address and one node on a
diagram — and four boxes that can each be RMA'd separately. Naming one of them
and dropping the rest is worse than useless on the one field a support case is
raised against, because it looks complete while being wrong.
**Built.**

- **`serials_in_version`** reads every chassis serial out of `show version`,
  which the crawl already runs — so no extra round trip per device, which
  matters on a large crawl. IOS prints a `System Serial Number` per stack
  member; a lone unit that prints no serial line at all is caught by
  `Processor board ID`. The motherboard serial is skipped deliberately: it is a
  different part and not what a support contract is keyed on. Deduplicated,
  because the first member appears both in the summary and in its own block.
  `show inventory` is the fuller answer — it reaches line cards and optics —
  but that is another round trip, and optics serials are not what was asked
  for.
- **Merging is a union, not first-wins.** This is the subtle half. The same
  stack can reach the crawl twice from two different neighbours, each
  advertising a *different* member's serial in its CDP device id, and both are
  true. `src/lib/serials.ts` merges them, keeping discovery order so the member
  reported first — the master — stays first. A re-crawl adds a member rather
  than replacing the one already recorded.
- **The field is edited by hand**, so it reads commas, semicolons, slashes and
  runs of spaces, normalises case, and drops repeats. It says how many chassis
  it names: an operator expecting four members and seeing three has found
  something.
- **The comma survives the CSV**, which is the one thing that format is worst
  at. The writer already quoted a cell containing one; a test now pins the
  round trip rather than trusting it.

**Verified:** eight parser tests against the real `show version` shapes, eleven
on merging, three on the CSV round trip, and live in the harness — a three-
serial stack is kept whole on one device and described as a stack, and a single
switch is not.
**Still honest about the limit:** no device here to crawl, so the parsing is
tested against captured output shapes rather than live hardware, and VSS pairs
and Nexus chassis that report their members through `show module` rather than
`show version` will still give one serial until that is read too.

### LT-114 — The serial on the device, and a diagram that runs top to bottom
**Source:** asked 2026-09-08 — "some engineer asked on reddit if anyone knows a
tool to fully digram a network and map it with real links and real data flow
plus note the devices serial numbers on the devices options. We have most of it
but when i click the device to show its options i don't see the the SN its
useful plus real flow digram and top to bottom is something helpful."
**Built.**

**The serial, everywhere it should be.** `serial` and `assetTag` on a device —
two fields, not one, because the serial is the vendor's number and the asset
tag is the organisation's, and reconciling them is the job. The serial is what
an RMA, a support contract and a licence are all keyed on, and the one piece of
inventory that cannot be worked out from anything else on the diagram. It is
typed in the inspector, exported to and imported from the device CSV (added at
the end of the columns, and the importer is header-driven, so an older sheet
still lines up), read from a Visio drawing's Shape Data under any of the names
a drawing uses for it, and **filled in by a crawl**: CDP advertises it in
brackets after the device id — `N9K-2(FDO12345678)` — where the name parser had
always had to strip it to avoid duplicate devices and simply threw it away.
Only a plausible serial is taken, since a wrong one is worse than none: it is
the field a support case is raised against.

**A top-to-bottom flow layout** (`src/lib/hierarchyLayout.ts`), offered on the
canvas menu beside Tidy. The two are opposites and both are wanted: Tidy fixes
the spacing of an arrangement somebody made by hand and must not move anything
else; this replaces the arrangement, which is what a crawled or imported
topology needs and a hand-drawn one does not. Tiers come from **what the device
is** first — a firewall sits above a core switch and below the internet
whatever the cabling says, and that is the part a generic graph layout cannot
know and most of why those produce diagrams nobody recognises. A device whose
type says nothing takes a tier below the highest thing it is plugged into,
repeatedly, so a chain of unknowns resolves; an isolated unknown goes to the
bottom rather than somewhere arbitrary in the middle. Empty bands are closed
up, so a topology with no firewalls has no gap where the firewalls would have
been. Within a tier, order is the median of each node's neighbours in the tier
above — the standard cure for crossings — over two sweeps, because a layout
that keeps shuffling is one an operator cannot predict. Locked devices are left
where they are and reported.

**Also found and fixed while doing this: deleting a project left its history.**
A project's event timeline carries each device's *name* and the address it was
checked at. `ON DELETE CASCADE` and the `foreign_keys` pragma already handled
new deletions correctly — but nothing pinned that, and a database written
before those constraints existed still held the rows. This machine's had six.
`purge_orphans` now sweeps them at startup, and two tests hold the behaviour:
one that a delete really does take the history, so a dropped pragma cannot
break it silently, and one that a pre-constraint database is swept clean.

**And the e2e suite can now be run as a suite.** Three of the seven harnesses
took a project package as `argv[2]` and threw an unhandled `TypeError` with no
explanation when run without one, so "run the e2e tests" required knowing each
script's arguments. They fall back to `e2e/fixture.mjs` — a small invented
topology on documentation addresses — and `npm run e2e` runs the lot. All seven
pass.

**Verified live** in the browser harness: the serial appears on a device's
options and shows what the device carries, the canvas offers the arrangement,
and it puts the core above the access layer. Both are permanent checks in
`e2e/interact.mjs` now.

### LT-113 — Import: the enhancements that were being carried as "still open"
**Source:** asked 2026-09-08 — "all the enhancement you're talking about and
thinking of make them any other enhancements that you can think of make it",
alongside a repeat of the bezier request.
**Built, each with the check that would have caught it going wrong:**

1. **The bezier default is now a test, not a claim.** It shipped under LT-112
   but nothing asserted it, which is why it was reasonable to ask twice. Link
   and address construction moved out of the panel into
   `src/lib/visioImportModel.ts`, where `importedLinkData` states both of its
   departures from the diagram's own style — a curve rather than a smooth
   step, and a colour the drawing stated winning over the default — and ten
   tests hold them.
2. **A drawing that glues nothing now yields its links.** The Lucidchart
   family, and the failure was worse than "no links": a `com.lucidchart.Line`
   was not recognised as a connector at all, so every cable was imported as a
   *device*. A master is now read as a cable when its **last word** is
   connector/line/link — the last word, because `Catalyst 6500 Line Card` and
   `Inline power injector` are equipment that merely mention one, and
   matching any word turned the line card into a cable. The ends resolve by
   geometry and the links are marked not-glued, so they are flagged for
   review rather than asserted.
3. **Every address a caption carried is kept as an address.** The second and
   later ones used to be flattened into the notes as text, which is where an
   address goes to be forgotten. They are real addresses, the model already
   holds as many as you like, and a check can be aimed at one later.
4. **A `.vsd` is named rather than merely refused.** The pre-2013 binary
   format is an OLE compound file with a fixed signature, so it is recognised
   and the error says what to do about it, instead of "this does not look
   like a .vsdx file" when the fix is one Save As away.
5. **LT-108 fixed** — see that entry. One list, used by both canvas and
   export.
6. **The zoom limit under LT-112 removed** — see that entry.

**Not done, and why:** the Lucidchart drawings are no longer on this machine,
so item 2 is covered by a synthetic fixture and by reasoning about the
format, not by a measurement against a real file. Said plainly rather than
implied. The drawing that *is* available still reads 37 devices, 70 links and
62 with a port — unchanged, which is the point of re-measuring it.

### LT-112 — **bug** A link close to its devices cannot be clicked
**Source:** reported 2026-09-08 with a screenshot of a router and the links
meeting it — "I can't select the link to move it, if i select it will select
the router not the link to move it."
**Reproduced and measured before changing anything.** The wide transparent
path that makes a thin line practical to click lives in React Flow's edge
layer, which is drawn *below* the node layer. A device's box is square and
76px across whatever shape is drawn inside it, so near a device the box
covers the line. Sampling 21 points along a link between two devices and
asking what the pointer would actually land on:

| Distance between centres | Points that reached the link |
| --- | --- |
| 260px | 20 of 21 |
| 130px | 13 of 21 |
| 110px | 10 of 21 |
| 95px | 2 of 21 |
| 85px | **0 of 21** |

At 85px — nine pixels of clear gap between two 76px boxes — there was no
point on the line that could be clicked at all, which is exactly what the
operator hit: an imported drawing places devices where the drawing put them,
not on a comfortable grid.
**Built.** A second, narrow hit band (12px, six either side of the line) is
rendered in the edge-label layer, which the endpoint handles already use to
get above the nodes, and selects the link on pointer-down. The visible line
stays in the layer below the nodes, because a cable passing behind a device
is what a diagram should look like. z-index 2: above a resting node, still
below the one being dragged or selected, and below everything on a link that
can be grabbed — labels, waypoints, endpoint handles — or the band would
swallow those drags. Afterwards: 21 of 21 at every spacing down to 80px,
with node clicks and node drags unaffected.
**One thing it cost, and what replaced it.** Tracing — pointing at a link to
fade the rest — was pure CSS (`.react-flow__edges:has(.react-flow__edge:hover)`)
and could not survive this: the band is in a different part of the tree from
the line it belongs to, so the line is never `:hover` and no selector joins
them back up. `src/components/edges/traced.ts` holds the id instead and each
link fades itself. Deliberately outside the app store, so a hover does not
enter the undo history or every save. A side benefit: a *selected* link now
stays bright while the pointer wanders, which the CSS version could not do.
**A limit that was there and is now not (LT-113).** The band's width is a
stroke, so it first shrank with the zoom like everything else on the canvas —
under two pixels wide at 0.14 zoom, measured, so a link stopped being
clickable well before it stopped being visible. `vector-effect:
non-scaling-stroke` makes those twelve pixels *screen* pixels, and hit
testing follows the rendered stroke, so it holds all the way down: every
sampled point on a link still reaches it at 0.06 zoom. The harness checks the
zoomed-out case alongside the ordinary one.
**Also in this change, asked for at the same time:** an imported link now
arrives as a **bezier** rather than a smooth step. An imported drawing puts
devices where the drawing put them rather than on a grid, and an orthogonal
route between two of them takes a long way round and reads as routing that
was meant, when it is only routing that was computed.
**Verified** in the Chromium interaction harness (`e2e/interact.mjs`), which
is this repo's stated method for canvas interaction — synthetic X11 input
does not produce the pointer sequence React Flow needs, so those cases were
already run against the browser build. Three checks added there: a link
between two touching devices is clickable along its length, clicking it
selects it and offers its endpoint handles, and clicking or dragging a device
still does what it did. Not additionally hand-verified in WebKitGTK: the
Xvfb session would not hold a zoom level long enough to aim at a line. The
two CSS properties involved are long-standing and the rest is engine-neutral
DOM logic, but that is reasoning rather than a measurement, and is recorded
as such.
**Found while doing it, and fixed:** `e2e/interact.mjs` had been dying a
third of the way through since LT-094 landed — a right-click aimed at the
canvas hit the new page-tab strip, and 35 places still read `doc.nodes` on a
document that now holds pages. Roughly half the harness had not run since.
It runs end to end again.

### LT-107 — **bug** Links still leave a shape from only 4 points
**Source:** re-reported 2026-09-08, in the same words as LT-098 and with a
screenshot of HOME-MAIN-SW — "I need the connector to connect to the shapes
at 360 so anywhere I move the link it moves not just 4 directions we should
have more that the 4 points off connections **this is still not done**."
**Reproduced 2026-09-08** in the Branch office sample, before changing
anything: the Core switch's link to Access switch 1 — which sits down and
to the *left* — does not run diagonally. It leaves the fixed left handle
sideways, turns a right angle, and drops down. Same on the right for the
Wireless controller. Every link is funnelled through one of four points.
**What LT-098 got wrong:** it read "anywhere I move the link it moves" as
*I drag the endpoint and it stays put*, and shipped a hand-dragged fixed
anchor. Re-read against the screenshot, it means the link should attach at
the **true bearing** to the device at the other end, anywhere around the
full 360°, and keep doing so as things move — without anyone dragging
anything. The LT-098 anchor is still useful as a manual override; it was
just never the thing that was asked for.
**Acceptance:** a link leaves each shape pointing at the device it actually
goes to, at any angle, and follows as either end is moved — with no
per-link dragging.
**Fixed 2026-09-08 — deliberately still open, pending the operator's own
confirmation.** LT-098 was moved to Done on my verification alone and was
wrong; the same claim is not worth making twice. What was built: one new
pure function, `bearingAnchor` in `src/lib/floatingAnchor.ts`, giving the
point where a ray from a shape's centre towards the device at the other end
crosses its outline. Each end now resolves in three steps — a hand-placed
LT-098 anchor if there is one, then the fixed handle if the link is
`pinnedSides` (that flag has always meant "stop moving"), and otherwise the
bearing. Wired into both places an endpoint is computed, so the export
still matches the screen (D-001): `LiveEdge.tsx` and `diagram.ts`'s
`anchor()`.
**The detail that decides whether it looks right:** a glyph device is drawn
as a *round* icon — its selection ring is a literal `border-radius: 50%` —
so measured against the bounding box a diagonal link would attach at the
box's corner, visibly off the artwork and floating in the gap. `round`
shapes are met on the inscribed ellipse; cards, notes and drawn rectangles
on the box. This is also why the node's own box is the right thing to
measure at all: `.cv-glyph-art` is `width/height: 100%` — "the artwork owns
every pixel of the node" since LT-053 — so the label underneath overflows
rather than inflating the box.
**Verified, live, before and after:** reproduced first in the Branch office
sample (the Core switch leaving sideways out of its left handle and turning
a corner to reach a device that is down and to the left), then confirmed
the links now leave the lower-left and lower-right at the true angle. Then
dragged Access switch 1 up above the switch and watched that link's
attachment travel round the icon from lower-left to upper-left — the
"anywhere I move the link it moves" half, which no static screenshot of the
end state would have shown. 520 tests pass, 10 of them new: 7 on the
geometry (including that it lands *on* the outline, that a non-square box
does not distort the bearing, and that concentric shapes do not divide by
zero) and 3 on the export.

### LT-109 — The ping sweep should resolve names, like `ping -a`
**Source:** reported 2026-09-08 — "ping sweep is not setup correctly, it needs
ping -a to try to resolve the names as well!", with a transcript showing
`ping -a 10.10.10.24` returning `Pinging csdc.comsol.root [10.10.10.24]`.
**Confirmed by reading the code:** `SweepHit` is `{ ip, rtt_ms }` — the sweep
does no name resolution at all. Worse than it first looks:
`DiscoverPanel.tsx:95` sets `data.label = h.ip`, so adding swept hosts to the
diagram produces a page of devices named `10.10.10.24`, which is exactly the
labelling work the sweep was supposed to save.
**How, and why not literally `-a`:** `-a` is a Windows `ping` flag. On Linux
and macOS `-a` means *audible* ping, so passing it there would be wrong, and
on Windows the name would have to be scraped out of `Pinging <name> [ip]` —
a localized string that says something else on a non-English Windows. What
`-a` actually does is a reverse (PTR) lookup, so the portable equivalent is
to do that lookup directly and get a structured answer on all three
platforms.
**Acceptance:** a sweep shows the hostname beside each address that has one,
and adding hosts to the diagram labels them with the name, falling back to
the IP where there is no PTR record. A slow or missing reverse lookup must
not stall or fail the sweep.
**Built:** `SweepHit` gained `hostname: Option<String>`, filled by a reverse
lookup that runs only for addresses that *answered* — a /24 is 254 PTR
queries if you ask for everything, almost all of them for hosts that are not
there. It runs inside the existing per-host task, under the same concurrency
permit as the ping, so it adds no second pass. One new dependency,
`dns-lookup` (which added no transitive crates of its own), for the
`getnameinfo` call Rust's std does not expose. The results table gained a
**Name** column, and `DiscoverPanel` now labels an added device
`hostname ?? ip`, keeping the address as the probe target either way.
**The trap, and the test for it — corrected 2026-09-08 after being asked how
the name is resolved without `-a`:** the claim first written here was that
`getnameinfo` returns the numeric form instead of failing when there is no
PTR record, and that `usable_name()` was what stopped every device being
labelled with its own address. Reading the crate rather than assuming:
`dns_lookup::lookup_addr` passes `NI_NAMEREQD`, which makes `getnameinfo`
error instead of falling back, so that case was already handled a layer
down. The guard is real but defensive — it earns its place on the
trailing-root-dot form (`host.example.com.`), on empty answers, and against
that flag changing — not as the thing holding the line. The
decision is split into a pure `usable_name()` so it could be tested without
depending on what a given machine's resolver answers — including that a name
which merely *contains* the address (`10-0-0-5.static.example.net`, common on
ISP reverse zones) is kept, and only an exact match is discarded.
**Verified live, end to end:** swept `127.0.0.1/32` in the running app, which
has a PTR record on this machine. The Name column showed `localhost`, and
"Add 1 to diagram" produced a device labelled **localhost** with `127.0.0.1`
kept as its address — not a device called `127.0.0.1`. 974 tests pass, 7 of
them new. The test device was removed from the sample afterwards.

### LT-110 — Import a Visio drawing as a topology, not as pictures
**Source:** asked 2026-09-08 — "do I have the option to import .vsdx
diagrams? would it be possible to import and fully utilize the already on
the diagrams line ip address, ports devices names and fill that on coreview
fileds? how do we make that working at 100% I have enought digrams to import
and test."
**Where it stands today:** no. Import accepts `.coreview`/`.json` and `.csv`
only. A Visio file *can* be read, but only through `shapeconv`'s libvisio
path, which renders it to SVG — the drawing arrives as **artwork for the
shape library**, with every device, address and port flattened into a
picture. Nothing reads a `.vsdx` into devices and links.
**Why it is tractable:** `.vsdx` is OPC — plain XML in a ZIP, and `zip` is
already a dependency. Confirmed by unpacking `fixtures/blue-box.vsdx`:
`visio/pages/page1.xml` holds `<Shape ID=…>` with `<Cell N='PinX'…>`
geometry in readable XML. More to the point, this app's own Visio *exporter*
already writes the exact structure an importer has to read — `<Text>` on
shapes for the device name, `<Text>` on connectors for the port label, and a
`<Connects>` section gluing `FromSheet`/`ToSheet` — with tests asserting all
three. The importer is close to the inverse of code that already exists.
**Where the real work is — mapping text to fields.** The structure gives
devices and which-connects-to-what; it does not say which string is an
address and which is an interface. Planned in order of reliability:
1. **Shape Data** (`<Section N='Property'>`) — if the diagrams carry
   properties, this is exact rather than guessed, and is the first thing to
   look for in the operator's real files.
2. **IPv4 regex** — reliable.
3. **Interface names** (`Gi1/0/1`, `Te1/0/48`, `Po10`, `xe-0/0/0`) — the app
   already recognises these in `coreview-discover` for LLDP/CDP, so the
   knowledge exists and should be reused rather than rewritten.
4. **Whatever is left** → device name.
**Why "100%" is not a promise anyone can make**, and what it depends on:
- **Glued vs drawn-near connectors.** A glued connector produces a
  `<Connect>` entry and the link is certain. A line merely lying near two
  shapes produces nothing, and the link has to be inferred from geometry —
  a guess, and one that should be shown as a guess rather than asserted.
- **`.vsdx` vs `.vsd`.** `.vsdx` is XML and fully parseable. `.vsd` is the
  pre-2013 binary format; libvisio can only render it to SVG, which loses
  exactly the structure this needs. Old drawings may have to be re-saved.
- **House style.** How a team writes an address next to a port is a
  convention, not a standard.
So the honest target is not "100% of any Visio file" but "100% of the
operator's own diagrams, whose conventions can be read off real examples and
fitted" — with anything uncertain surfaced for review rather than quietly
drawn, the same rule `ChangeReport` already applies to a re-crawl.
**Real drawings were made available to develop against 2026-09-08**, and a
throwaway prototype run over them. They are not kept in this repository and
nothing identifying is recorded here — not a filename, not a device name, not
an address. What they taught us about the *format* is what matters, and that
is all that follows.

Four families showed up, spanning roughly 60 to 1400 shapes each: a
Lucidchart export with **zero** `<Connect>` entries, a Visio-native drawing
with custom connector Shape Data across eighteen pages, a Visio-native
drawing built from Cisco stencils, and one whose page XML is UTF-16.

Five findings that change the design:

1. **Not all page XML is UTF-8.** One producer writes UTF-16, with no BOM
   assumptions worth making. A reader that assumes UTF-8 sees an empty
   document and reports "0 shapes" — which is exactly what the first pass of
   this analysis did, silently. Encoding must be detected, not assumed.
2. **Lucidchart exports do not glue anything.** They use `com.lucidchart.*`
   masters with `com.lucidchart.Line`, and zero `<Connect>` entries — so
   there is no authoritative link data at all and endpoints have to be
   inferred from line geometry. This is the hard family.
3. **Where Shape Data exists it is better than any heuristic.** One drawing
   carries `Port_A_Port_Name`, `Port_B_Port_Name`, `Port_A_IP_Address` and
   `Port_B_CableID` on the connector — that is Coreview's link model already
   filled in. Another carries device inventory: Manufacturer, Part Number,
   Product Description, Room.
4. **The master name is the device type, and often the model.** `ASA 5500`,
   `Workgroup switch`, `N9K-C93180YC-EX Front`, `WS-C4500X-16SFP+ Front`,
   `C9500-48Y4C Front`, `L3 Switch` — Visio stencil names, not anybody's
   equipment. That maps onto `deviceType` and fills `model` for free.
5. **The caption is usually a separate shape, not the icon's own text.** An
   icon with no `<Text>` sits next to a text block holding something of the
   form `_ACCESS_SW01 192.0.2.20`. So association is geometric — and the
   first naive attempt grabbed the *port* label instead, because a port label
   is often nearer. Classifying text (an interface name is not a device name)
   before choosing fixed it.

**Prototype result, one rough pass, no tuning:** between 0 and 77 links per
drawing, 46–100% of them with both ends named, 37–85% of devices with an
address, and **0–16% with a port**. Ports read near zero only because port
labels are separate shapes near the connector's ends and the prototype only
looked at connector text — the same proximity trick that fixed captions
applies, it just was not written yet. The drawing with zero links is the
Lucidchart one, which carries no link data to find.
**Acceptance, restated honestly:** near-complete for glued Visio-native
drawings; best-effort with everything uncertain flagged for review for
Lucidchart exports, which carry no link data to be complete *from*.
**Built 2026-09-08 — glued Visio-native path, end to end.**
`src-tauri/src/visio_import.rs` reads the ZIP directly with `roxmltree`
(already in the tree, so no new download), an `import_visio` command wraps
it, and a **From Visio** tab beside From CSV previews the result before
anything is drawn — the same rule the crawl follows, since an import that
quietly gets an address wrong is worse than one that says what it is unsure
about. Adding puts one Coreview page per Visio page, converts Visio's
bottom-left inches to top-left pixels, and optionally creates a check per
addressed device. Shape Data is carried across: Manufacturer to vendor,
Room to rack, the rest to notes.
**Measured against a real drawing, in the running app:** 34 devices and 54
links, 28 named, 18 with an address, **51 of 54 links with a port** (from 7
before the pair-label matching was written), and device types and models read
straight off the Visio masters.
**Two decisions worth keeping:**
- *Port pairs are matched by distance to the connector's line, not to its
  midpoint.* The label belongs to the run, and a long connector can carry
  its label near one end. This one change took ports from 40/54 to 51/54.
- *An address jammed against a name is not read.* A caption of the form
  `vpn01192.0.2.50` is ambiguous — `vpn01`+`192.0.2.50` and
  `vpn011`+`92.0.2.50` are both readings, and nothing decides between them.
  An imported address becomes a monitoring target, so a wrong one is far
  worse than a missing one: it would check the wrong host and report green
  for a device that is down. A test asserts nothing is taken.
**Rebuilt 2026-09-08 after the operator tested it on a real drawing.** The
verdict was blunt and correct: "the names are incorrect! and missing info /
the diagram doesn't look the same as the visio / it needs a lot more work to
make it useful." Five defects, each found by measuring against a real file
rather than by reading the code:

1. **A port-pair caption was being used as a device name.** `could_be_a_name`
   now rejects anything reading as a port or a port pair, so a router keeps
   its own name instead of arriving called `Gi0/0/2 <> Gi1/0/13`.
2. **Connectors glued at only one end were dropped.** In the drawing tested,
   two thirds are glued at one end and four at neither. Each end now resolves
   independently — glue where it exists, nearest device where it does not —
   which recovered the carrier uplinks that had gone missing, with the
   router's interface on the router and the switch's on the switch.
3. **Rack-mounted equipment was being read as lines.** This was the big one.
   Cisco's rack-unit stencils are *1-D shapes* — a `N9K-C93180YC-EX Front`
   carries `BeginX`/`EndX` so it snaps into a rack frame, exactly as a
   connector does. Asking only "does it have begin/end?" threw away fourteen
   devices: all four Nexus 9000s, both Catalyst 4500Xs, both N2K fabric
   extenders, the UCS chassis, the HyperFlex node, both fabric interconnects
   and two storage arrays. What actually separates them is what the box
   *means*: on a connector Visio writes `Width` as the formula
   `GUARD(EndX-BeginX)`, so the box **is** the run. That plus a master named
   "connector" identifies all seventy connectors and misses none of the
   thirty-seven devices. Glue is a third signal but needs care — a `6324 FI`
   is glued into its own chassis at both ends, so only glue joining two
   *different* shapes counts.
4. **Devices that were never a connector endpoint were not imported at all.**
   Any shape from a named master that is not a connector and not a text block
   is now a device, joined or not.
5. **One caption could name two devices.** Assigning per device in id order
   let a device take a caption that belonged to its neighbour. Every
   candidate pairing is now ordered by distance and taken shortest-first, and
   distance is measured to the shape's *box* rather than its centre — a rack
   unit is two inches wide, so its own caption is nowhere near its middle.

**Measured on the same drawing, before → after:** 34 devices → **37**, which
is exactly how many device shapes the file contains; 54 links → **70**,
exactly how many `Dynamic connector` shapes it contains; 51 → **62** with a
port. The core switches, the distribution pair and the storage and compute
nodes all arrive now and did not before.

**Layout fidelity**, the other half of "doesn't look the same"
(`src/lib/visioLayout.ts`): Visio's pin is the shape's *centre*, not its
top-left, and shapes are not all one size. Placement now uses the centre and
the drawing's own width and height, and the scale is taken from the drawing
rather than fixed at 96 px to the inch — enough that its flattest shape stays
legible, so four switches stacked 0.185in apart in a rack come out stacked
rather than piled.

**Three things the operator asked for while this was being built,** all
built: the preview is now **editable** — rename a device, correct an address,
change its type, fix which devices a link joins, correct a port, remove what
does not belong, add what the drawing left out — because a preview you can
only accept or reject is not much of a decision, and some of what is read out
of a picture will be wrong however carefully it is read. **Line colours are
imported**: the drawing tested uses six, and an operator who drew the carrier
circuits orange meant something by it. And the port pair is written on the
line as a **centre label** (`Gi0/1 <> Eth1/4`) as well as being split across
the two ends.

**Verified live, end to end:** imported into a clean project in the running
app — 37 devices, 70 links, 107 monitored objects, coloured lines, port
labels at each end and the pair on the line, and the rack at the foot of the
drawing sitting where the drawing puts it.

**Still open:** the Lucidchart/geometric path (no `<Connect>` data at all);
a device the drawing never captions still falls back to its master name (in
the drawing tested, eight of thirty-seven); and a run-together address is
still left unread, for the reason above. Both are correctable in the preview.
**On test data:** no real drawing is kept in this repository and nothing
identifying one is written down — not a filename, not a device name, not an
address. The test that reads a real file takes a folder from
`COREVIEW_VISIO_DIR`, asserts only what must hold for *any* drawing, prints
counts rather than names, and skips everywhere that variable is unset,
including CI. Everything else is synthetic XML using documentation addresses
(RFC 5737).

### LT-108 — **bug** The canvas and the export disagree about `callout`
**Source:** found while doing LT-107, not reported. `DeviceNode.tsx` and
`diagram.ts` each keep their own copy of the "drawn as a plain shape rather
than a device glyph" list, and the copies differ: the canvas includes
`callout`, the export does not. So a callout is drawn as a shape on screen
and as a device glyph in an exported SVG or PDF — the export does not show
what the canvas shows, which is the one thing an export has to do (D-001).
**Not fixed here.** LT-107 needed the same list and added one shared
definition — `SHAPE_DEVICE_TYPES` in `src/types/domain.ts`, matching the
canvas — but both old copies were deliberately left where they are:
changing the export's list changes exported output for callout nodes, and
that wants its own before-and-after check rather than being smuggled in
under a link-routing fix.
**Acceptance:** one list, used by both, and a callout exports as the shape
it is drawn as.
**Done 2026-09-08 (under LT-113).** Both copies deleted; `diagram.ts` and
`DeviceNode.tsx` now read `SHAPE_DEVICE_TYPES`. A test renders a callout and
an access switch in glyph mode and asserts the callout keeps its node-sized
box while the switch does not — not just "contains a rect", since the switch
symbol is itself drawn out of them.

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

**Known bugs, open:** LT-107 (fixed 2026-09-08, held open until the
operator confirms it on his own diagram), LT-108.
**Known bugs, closed:** LT-030, LT-031, LT-003, LT-044, LT-004, LT-005,
LT-082, LT-083, LT-084, LT-085, LT-091, LT-101.

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

### LT-058 — The Cisco shapes ship in the installer — 2026-08-31
**Source:** "Change this statement you can bake into the installer please" —
overruling the D-019 rider, logged as D-022.
`stencils/` is bundled as a Tauri resource (~2 MB) and a `list_bundled_icons`
command scans it with the same scanner as a user folder; the palette grows a
built-in "Shape library" section — grouped, searchable, draggable — that
loading or clearing the operator's own folder never touches. Verified: the
repo's real stencils folder scans into 217 named, categorised icons (Rust
test); the palette section, search and clear-independence run in the
harness; the resource config passed context generation. **The last inch —
the resource actually landing inside the NSIS/MSI/AppImage — is proven by
the CI bundle jobs and then by the operator's next install: the palette
should open with the Cisco set in it, no folder to point at.**

### LT-051 — Drag a link label along its link — 2026-08-31
The centre label takes the pointer and slides: while dragging, the cursor
roams and the label takes the nearest spot on the drawn path — it cannot
leave the link — and on release the fraction is stored on the link
(`labelAt`), undoable, saved with the document. An untouched link keeps
React Flow's own midpoint, so nothing already drawn moves. One cost taken
knowingly: the label used to be transparent to the pointer so hovering the
line through it worked; a thing you drag has to take the pointer.
**Differs from the ask in one place:** the SVG/PNG export still draws the
centre label at the midpoint — the export knows the chord, not the drawn
path. Say the word and it learns.

### LT-052 — Double-click a link to write flat text on it — 2026-08-31
Double-click a spot on a link and a caret opens right there; the committed
text renders flat — no box, no border, mono ink with the canvas halo —
attached to the link at that spot, draggable along it like the centre label,
edited by double-click, removed by committing nothing (so a stray
double-click leaves no debris). Stored per-link (`texts`), undoable, saved.
Same export caveat as LT-051.

### LT-059 — **bug** The bundled Cisco shapes did not appear in the installed app — 2026-08-31
As suspected: Tauri places resources whose source lies outside `src-tauri/`
under a `_up_/` prefix in the resource directory, so
`resolve("stencils", Resource)` looked where nothing was. The map form of
`bundle.resources` pins the target path, and the proof is a locally built
.deb: 217 stencil SVGs at `usr/lib/Coreview/stencils/`, zero `_up_` paths.
Confirmed on the operator's machine once the next installer is on it.

### LT-061 — A device's check targets its address by itself — 2026-08-31
The primary check follows the primary address: a device that gains an
address gets a check aimed at it, changing the address moves the check, and
a target the operator aimed by hand is never overwritten from the address
side. Crawl-placed devices arrive monitored whether or not they were logged
into — ticking the row was the decision, and the old reached-only rule was
what left "Seen by a neighbour" devices with a target of "—". Ping-sweep and
CSV already did this. Harness-verified end to end.

### LT-062 — A new device joins a running validation — 2026-08-31
No more stop/start: the engine holds one cancellation token per probe and
can bring a running session's targets in line with the document — a check
added mid-session starts producing samples within one interval (staggered
like the rest, behind the same concurrency cap), a removed one stops, a
changed one restarts with its new settings. The store watches its own probe
list and pushes the change debounced, which covers every path — inspector
edits, discovery adds, undo, restore — without wiring each one. Proven live:
a real engine, real pings, a probe added mid-session sampled and a removed
one went silent.

### LT-009 — Draw a port-channel as one link — 2026-08-31
The operator bonded Gi1/0/11 + Gi1/0/12 between the 9300 and the 3850 as
Po1, and the whole path was built against that live LAG the same hour:
`show etherchannel summary` captured verbatim from both switches through the
crawler's own login, a parser for it (continuation lines, static bundles,
the empty table), the crawl asking every IOS device and carrying bundles to
the front, and the topology fold — a cable folds into its bundle when either
end's table says its port is aggregated, either because a crawl often
reaches only one of the two switches. Unbundled parallel cables still draw
as two links: D-014's line holds — the switch's own table, never inference.
**Found live on the way:** MACs learned across a LAG report on Po1, not on
the member port, so the uplink filter missed them and the entire far side of
the network appeared "attached" to the 9300; a bundle whose member is an
uplink is now an uplink itself.

### LT-060 — **bug** The 9300 still refused login after the kex fix — 2026-08-31
Reproduced from this machine with the crawler's own code: transport now
negotiates fine (the LT-054 fix holds — kex ecdh-sha2-nistp384, hostkey
rsa-sha2-512), and then the refused password attempt kills the session.
`ip ssh server algorithm authentication keyboard` means IOS-XE does not
merely decline a password try — it tears the connection down, and the
keyboard-interactive fallback that would have worked never got to run
("Channel send error"). The crawler now asks first: a `none` query learns
the advertised methods, password is attempted only where the server takes
passwords, and a server advertising nothing goes straight to
keyboard-interactive — whose prompt on this box is literally "Password: ",
which the existing prompt-matching answers. Proven live: the crawler's own
Device path logged into 192.168.14.20 and ran commands. The `raw_login`
diagnostic also now uses the crawler's algorithm offer instead of russh
defaults, so it diagnoses the client that actually failed.

### LT-053 — The edit corners hug the shape — 2026-08-31
**Source:** asked 2026-08-30 with a screenshot ("many times i told you the
shape should have no boarders and the edit corners should be close to the
shape not far away") — and filed only now, which broke the file-first rule;
the work itself went test-first as required.
The glyph node was an invisible 168x92 box with a 46px icon floating in it:
resize corners, connection dots and the ends of links all sat on the box,
nowhere near the drawn shape, and resizing changed nothing visible. The
node's bounds are now the art itself — the icon fills the node (resizing
finally scales it, aspect kept), the label hangs below without counting
toward the bounds, new devices drop at 76x76 square, and links terminate on
the shape's edge instead of in the air beside it. Three consequences, each
caught by the harness: the artwork owns no pointer events or it eats every
click meant for the node; the resize controls stack above the full-bleed
art; and the connection dots' positions were hardcoded to the old 46px art,
clustering all four at the node's top where a drag-grab landed in a
handle's hit area and became a connection attempt.

### LT-057 — **bug** The spacing snap could never fire on its own — 2026-08-31
Found while testing LT-053, not reported. The even-spacing rhythm competed
against the edge snap by comparing corrections — but with no edge in reach,
"stay where you are" costs zero and always won, so the rhythm only applied
when an accidental edge alignment coexisted (the old 176x96 fixture provided
one, hiding the bug). It now competes only when an alignment actually
snapped; the guide-and-land harness check fails without it.

### LT-046 — Chrome stays dark; only the diagram area follows the ground — 2026-08-31
Supersedes LT-034's light chrome, at the operator's word. The `.is-light`
block now carries nothing but the drawing surface — white page, warm
light-brown desk (#E9E2D3), its grid, inks and a `--canvas-accent` — and the
chrome tokens are simply never remapped, so the panels stay the approved
dark in both grounds. Canvas elements were moved off the chrome tokens onto
the ground set (`--ink`, `--page`, `--desk`, `--canvas-accent`): node cards,
labels, edge chips, connection dots, selection rings, the text halo. Print
forces the canvas set to paper values, which the harness caught. The desk
harness block asserts the new contract, both-ground screenshots are in
docs/checkpoints/2026-08-31-canvas-{light,dark}.png, and the dark ground is
bit-for-bit untouched.

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

### LT-056 — **bug** The installer's app is blocked on the second machine — resolved 2026-08-30
Reported with a screenshot ("Windows cannot access the specified device,
path, or file"), and withdrawn by the operator the same hour: the block was
that machine's own policy, and the same installer runs fine on another
Windows machine. Nothing to change in Coreview; kept because the symptom and
its reading (Windows application control refusing a binary whose internal CA
the machine does not trust) will recur on any locked-down host — that is
LT-011's public-CA half.

### LT-010 — Verify against Catalyst 9000 / IOS-XE 17
**Source:** asked 2026-08-29.
**Blocked on:** access to a Catalyst 9000. The CDP and LLDP parsers are written
against a C2960CX, a FortiSwitch and a FortiGate only. Operator has a 9300 he
will power on to test against (2026-08-30).

### LT-012 — Legacy binary `.vss` stencils
**Source:** raised 2026-08-30; deferred by the operator, then unblocked by him
the same day: `libvisio-tools` is installed (vss2xhtml and friends on PATH),
and LibreOffice itself reads Visio through the same libvisio. Folded into
LT-045's converter work — the .vss route lands there.


## Done

### LT-106 — A macOS build, as a .dmg — 2026-09-08
**Source:** asked 2026-09-08 — "but can we make a macOS version? i think dmg
file" / "so i can run the app on my mac book pro." The goal was the app
running on the operator's own MacBook Pro, not merely a file that exists.
**The constraint that shaped it:** Tauri cannot cross-compile a macOS
bundle from Linux — the same reason `build.yml`'s own header already gave
for Windows — and `.dmg` creation needs `hdiutil`, which exists nowhere
else. So none of this was buildable or testable on the machine this repo
is developed on. It had to be a `macos-latest` CI job, and verification
from here could only ever reach "CI produced the artifact."
**Built:** a `bundle (macOS, universal .dmg)` job, its own job rather than
a third leg of the `bundle` matrix — the same reasoning the offline
installer already uses, so a platform that cannot be tested from here can
never fail the bundles that can. Universal (`--target
universal-apple-darwin`, both Apple targets added to the toolchain) rather
than the runner's own Apple Silicon, because an Intel Mac cannot run an
arm64 build at all and a download does not get to ask which Mac it is
landing on. `bundle.targets` gained `app` and `dmg`, and `bundle.icon`
gained the `.icns` the macOS bundler needs — generated from the existing
`icon.png` by the Tauri CLI, which does that without a Mac; the other
icons were left alone, since they are deliberate placeholders (see
`src-tauri/icons/README.md`) and re-cutting them was not what was asked.
**The risk worth checking, checked:** adding macOS targets to a shared
`targets` list could have broken the two platforms that already worked.
Ran the full Linux release bundle locally afterwards — still exactly the
`.deb` and the AppImage, exit 0. Tauri filters targets by host platform,
which is also why `nsis`/`msi` had always been silently skipped on Linux.
CI then confirmed it: every pre-existing job (both test jobs, the Linux
bundle, both Windows bundles, the AppImage smoke test) stayed green on the
same commit.
**Unsigned, and that shows:** there is no Apple Developer certificate the
way there is for Windows, so macOS quarantines the download and reports it
as "damaged", which it is not. The `xattr -dr com.apple.quarantine` line
that clears it is written into `docs/HANDOVER.md` §6.8 — along with why
right-click → Open is not the instruction to give, since it works on some
macOS versions and not others — rather than left to be discovered. Proper
signing plus notarisation is the real fix and is noted there as the thing
to do before anyone who did not build it gets a copy.
**Verified:** the job went green first time (16 min), and the artifact
upload carries `if-no-files-found: error`, so a green upload is real
evidence a `.dmg` exists at the expected path rather than a compile that
merely finished. **The half this machine cannot do — that it installs and
opens — was confirmed by the operator on his own MacBook Pro** ("mac
worked"), which is the only place that check exists.

### LT-105 — Cisco shapes as real (vector) shapes, not embedded pictures — 2026-09-07
**Source:** asked 2026-09-07 — "can we turn all the cisco shapes to real
shapes not just pictures?" `src-tauri/src/icons.rs`'s own test
`keeps_embedded_bitmaps_but_not_fetching_ones` confirmed the icon pipeline
does deliberately preserve an embedded raster image where a source stencil
has one rather than converting it to vector paths — a real, specific gap,
not a misunderstanding. Left unscoped rather than promising a fix sight
unseen, since redrawing artwork by hand for an unknown number of shapes
could have been a small correction or a large undertaking.
**Scoped 2026-09-07:** counted it. Of 217 SVGs under `stencils/cisco/`,
only 12 contain an embedded `<image>` at all — the other 205 already draw
with real vector paths (`stroke="currentColor"`) and are already fully
recolourable today, which is most of what "all the cisco shapes" was
worried about. Of those 12, 10 live under a `3-rd-party` folder with
generic names (`image196.svg` etc.) — rendered, one turned out to be the
VMware vCenter logo: bundled third-party vendor logos, not Cisco shapes,
and not reasonable to recolour even if they were vector (that would
misrepresent someone else's brand mark). The remaining 2 —
`lan-switching/6500-vss.svg` (a VSS switch icon) and
`wifi-indicator/3g-4g-indicator.svg` — are genuinely Cisco shapes that are
entirely one embedded picture apiece (each file has exactly one `<image>`
and exactly one `<path>`, and that path is only the outer border). The
real scope was 2 icons out of 217, not "all" of them.
**Resolved 2026-09-07, given that count:** left as-is. 2 icons out of 217
was judged not worth hand-redrawing for how little it would change; the
icon pipeline's existing bitmap-preserving behaviour is intentional
elsewhere and stays exactly as it is.

### LT-099 — The status history strip: scrub it, and see more of it — 2026-09-07
**Source:** asked 2026-09-07, alongside LT-097/098 — "for the status line I
need a position line to drag and also I need to klick it and it enlarges
so I can see more details about the status." The "Recent status" strip in
the inspector (`StatusStrip` in `src/components/inspector/Inspector.tsx`)
— the coloured history bar with 15m/1h/6h window buttons.
**Built:** the strip tracks the pointer — no click-and-hold needed, since
a horizontal timeline reads its position from where the cursor already is
— with a thin line at that exact spot and a line underneath reading out
the real time and status there, formatted the same way the transition log
below it already is, a finer answer than the coarse,
per-segment native tooltip the bars already had. Clicking the strip
toggles it to a taller, easier-to-read version of itself (12px to 40px)
and, together with it, the transition log already underneath (LT-074)
both shows more entries (12 to 40) and grows the scrollable area they sit
in (148px to 360px) — answering "see more detail" with more of the actual
data the strip already has behind it, not just a bigger picture of the
same dozen pixels.
**Verified live, through the actual running app:** moved the pointer
across the strip and watched the scrub line and its time/status readout
track it continuously; clicked the strip and watched it grow taller in
place, with the readout still tracking; clicked again and watched it
collapse back. Transient UI state only — nothing here is saved with the
project, so there was nothing to clean up afterward. `npx tsc --noEmit`,
`npm run lint`, and `npx vitest run` (510 tests, unchanged — this is
inspector-only presentation, nothing new to unit-test beyond what the
existing timeline/formatting libraries already cover) all clean.

### LT-098 — More than 4 link connection points per shape — 2026-09-07
> **Reopened 2026-09-08 as LT-107 — this did not do what was asked.** The
> operator re-reported it in the same words, with a screenshot: "this is
> still not done". What shipped below is a hand-dragged fixed anchor; what
> was wanted is the link *automatically* meeting the shape at the true
> bearing to the other device. Kept here as the record of what was built
> and misread; the correction is LT-107.

**Source:** asked 2026-09-07 — "I need the connector to connect to the
shapes at 360 so anywhere I move the link it moves not just 4 directions
we should have more that the 4 points off connections." A device had
exactly four fixed handles — top/right/bottom/left, `DeviceNode.tsx`'s four
`<Handle>` elements.
**Resolved 2026-09-07:** the bigger option over more fixed handles at finer
angles — a link's end lands anywhere on its device's perimeter, dragged
there directly, and stays exactly there (not a point that keeps re-homing
itself to wherever is nearest as the *other* end moves — dragging sets a
fixed spot on this one device, the same idea as diagrams.net's fixed
connection points, not a "floating edge" that recomputes on every move of
the far end).
**Built:** `LinkData` gained `sourceAnchor`/`targetAnchor` — a point
normalized to the device's own bounding box (`x`/`y` each 0..1, one of
them always pinned to 0 or 1 so it sits on the perimeter) rather than a
fixed pixel offset, so a resize just recomputes the same relative point
for free instead of stranding it. The geometry is one new pure module,
`src/lib/floatingAnchor.ts` (`anchorPoint`, `nearestAnchorOnBox`,
`nearestSide`), shared by both places a link's endpoint gets computed: the
live canvas (`LiveEdge.tsx`, which now shadows the plain `sourceX`/
`sourceY`/etc. names it already threaded through path, port-label and
corner-drag logic, so nothing downstream needed to change) and the SVG/PDF
export (`diagram.ts`'s `anchor()`). Each end gets a new drag handle — a
small ring right at the connection point, visible whenever the link is
selected — that follows the cursor while held and snaps to the nearest
point on that device's box on release; double-click puts that one end
back on automatic without touching the other. Reuses the already-existing
`pinnedSides` flag (it stops a link swinging to a different side as
devices move) rather than inventing a second one, since a link with an
explicit anchor obviously should not auto-reswing either. The one explicit
"Route links" action, which forces every link back to its computed
default regardless of `pinnedSides`, now also clears any anchor it
overrides — otherwise a re-routed link would keep quietly ignoring its own
new side.
**Scoped out, deliberately:** the Visio export (`visio.rs`) still glues to
one of the 4 sides — carrying a normalized bounding-box point into Visio's
own connection model is real, separate work, and every other export path
(SVG, PNG, PDF, all of which share `diagram.ts`) already reflects the
true point.
**Verified live, through the actual running app:** selected a link,
dragged its source end from the bottom of a device to its left side and
watched the line visually reroute there immediately; saved, fully reloaded
the app, reopened the project, and confirmed the same custom attachment
point survived (not just an in-memory drag); double-clicked the handle
and watched it snap back to the original fixed-side position. `npx tsc
--noEmit`, `npm run lint`, and `npx vitest run` (510 tests, 13 new — 12 for
the geometry module, 1 for the export path) all clean.

### LT-104 — Save a canvas shape back into the shape library — 2026-09-07
**Source:** asked 2026-09-07 — "can we give admin the ablility to past
shape into the diagram page then drag it to the shape library?" Read as:
place/customise a shape on the canvas, then get it back into the palette
as a new reusable stencil — turning a one-off customisation into something
reachable again without repeating it.
**Resolved 2026-09-07,** two scoping questions asked directly rather than
guessed, since both were real forks with a meaningfully larger option on
one side: **where the shape lives** — this project's own document (chosen)
versus a shared library available everywhere, which would have needed a
whole new persistent store, not just this project's own already-opaque
JSON (D-002); and **how it gets there** — a "Save to shape library" item on
the existing right-click menu (chosen) versus true drag-and-drop off the
canvas, which would fight React Flow's own pointer-based node dragging for
the same gesture and — per this project's own established knowledge,
`paletteDrop.ts`'s header comment — can only ever be verified by hand,
never by an automated test.
**Built:** `ProjectDocument.customShapes?: IconLibEntry[]` — reusing the
icon library's own entry shape rather than inventing a new one, so a
captured shape drops into the palette's existing `icon:<id>` drag payload
alongside bundled and library shapes with no change to how a drop is
resolved (`nodeForDrop`, already generic over "some list of entries").
Capturing one (`src/lib/customShapes.ts`, `svgForDevice`) takes either
path a device's appearance can come from: a built-in glyph (re-rendered as
raw SVG via a new shared `glyphMarkup`, factored out of `diagram.ts`'s own
icon export so both use the same tinting logic instead of two copies of
it) tinted with its actual override or automatic colour, or an already-
inlined library/import icon (its `imageDataUrl`, decoded straight back to
the raw markup it was built from — a new `base64ToUtf8`, the other
direction of the base64 helper `svgToDataUrl` already used). A new palette
section, "Your shapes," lists what this project has captured, draggable
onto the canvas the same as any other shape, each with a small "×" — a
normal undoable edit here, not the permanent, confirm-modal-guarded
deletion LT-103's stencil-pack removal is, since nothing left disk.
**A real bug found live, not caught by `tsc`/`eslint`/`vitest`, all clean
beforehand:** the whole shape palette crashed — "Maximum update depth
exceeded" — the moment "Your shapes" existed as a section, with an actual
device on the canvas or not. Cause: its store selector read
`s.doc.customShapes ?? []`, and that fallback built a *new* empty array
every time Zustand's snapshot check called the selector — which happens
more than once per render — so the selected value never compared equal to
itself, and React's external-store consistency check spun forever. Fixed
by selecting the field itself (stable — the same reference every call
unless the state actually changes) and applying `?? []` outside the
selector, in the render body, where a fresh array each render is normal
and harmless.
**Verified live, through the actual running app:** right-clicked a device,
chose "Save to shape library," watched it appear in a new "Your shapes"
section with its actual on-canvas icon and colour; removed it with its
"×" and confirmed the section disappeared with it (empty); Undo brought
it straight back, proving the capture and the removal both went through
this project's normal history rather than sitting outside it. **Not
verified, and cannot be with the tools available here:** actually dragging
the resulting tile onto the canvas — confirmed by hand that this
limitation is not specific to the new code (the same true of every
existing built-in palette shape in this exact environment) — so this
rests on `nodeForDrop`'s own existing, already-passing test coverage,
which does not care which list an `icon:<id>` entry came from. `npx tsc
--noEmit`, `npm run lint`, and `npx vitest run` (497 tests, 3 new) all
clean.

### LT-102 — Recolour a whole selection of shapes at once — 2026-09-07
**Source:** asked 2026-09-07 — "is it possibel to give admin the ablitity
to change all the shapes colors?" Read as a bulk colour edit, the same
shape the multi-select bulk editor already uses for tags/lock/maintenance
(`MultiInspector` in `src/components/inspector/Inspector.tsx`) — there is
no "admin" account in this app, one operator, no login, so this is simply
"the person using it," same as everywhere else here.
**Found while scoping:** `DeviceNodeData.style` (`iconColor`/`background`/
`border`) already existed and was already read everywhere a device is
drawn or exported (`DeviceNode.tsx`, `diagram.ts`) — but nothing anywhere
could set it. There was no single-device colour editor to extend, bulk or
otherwise; this shipped both, since a bulk control with no single-device
counterpart to check one result against would have been an odd, unverifiable
half-feature.
**Built:** a shared `ColorField` (label, swatch, and a "Reset" back to
automatic that only appears once a field is actually overridden — the
swatch alone cannot tell a real override from the automatic colour it
happens to match). `NodeInspector` gets one row of these for a single
device, defaulting each swatch to `deviceColor(deviceType, status, ground)`
— the same automatic colour the canvas already draws — until overridden.
`MultiInspector` gets the same row over the whole selection: extended
`Selection` (`src/lib/bulkEdit.ts`) with `iconColor`/`background`/`border`
as `Shared<string | undefined>`, the same `shared()` machinery already
used for device type, so a selection that agrees on "no override" reads
`same, undefined` and one that disagrees reads `mixed` — shown with the
same "choosing one sets them all" hint already used for a mixed device
type. Setting or resetting a field goes through `mapManyNodeData`, not
`updateManyNodeData`, merging into each device's own existing `style`
object individually rather than overwriting it wholesale — the flat
patch the latter applies would have deleted an unrelated style key a
different device in the same selection already had set.
**Verified live, through the actual running app:** selected one device,
opened the native colour picker on "Icon," picked a colour — the swatch,
a "Reset" link, and the device's actual glyph on the canvas all updated
together; Reset put it back to the automatic colour on all three at once.
Selected two devices of different types (a firewall and a core switch,
different automatic colours), confirmed all three fields showed the
neutral "not set" swatch with no mixed hint (both genuinely agreed on "no
override"); set "Icon" to green and watched both glyphs turn green
together on the canvas; Reset restored each to its own distinct automatic
colour, not a shared one — proving the merge went through each device's
own data rather than a flat overwrite. `npx tsc --noEmit`, `npm run lint`,
and `npx vitest run` (494 tests, one new) all clean.

### LT-103 — Remove an added-on stencil pack to free space — 2026-09-07
**Source:** asked 2026-09-07 — "can we give the admin the ablity to
delete shapes and add shapes." **Resolved 2026-09-07** — not the core
built-in palette (Router, Firewall, the generic network shapes): "just the
ones we added like the cisco shapes," deleted permanently to free disk
space, restored only by reinstalling the app. The same shape of change as
LT-100 (removing the Tripp Lite pack), but as a button in the app rather
than something only done by hand in the repo.
**Built:** `src-tauri/src/icons.rs` gained `StencilPack`, `list_packs`
(lists the immediate subdirectories of the stencils resource directory —
a missing directory is no packs, not an error) and `remove_pack` (checks
the name has no path separators and isn't `.`/`..`, canonicalizes both the
stencils root and the target and confirms the target is really inside the
root before `remove_dir_all` — the same boundary a path coming from the
frontend always needs). Two new commands, `list_stencil_packs`/
`remove_stencil_pack`, read the resource directory the same way
`list_bundled_icons` already does. The palette gained a "Built-in stencil
packs" section (`StencilPacksSection` in `Palette.tsx`) listing each pack
with a "×", behind the same delete-confirmation modal pattern already used
for deleting a project — removing re-loads both `bundledIcons` and
`stencilPacks` so the palette updates without a restart.
**A real bug found live, not caught by any of `tsc`/`eslint`/`vitest`/
`cargo test`/`cargo clippy`, all of which were clean before this was
found:** the remove "×" was unclickable — not flaky, reliably so, at
every coordinate on the button. Reading the code found nothing wrong; the
component was rendering exactly as written. Diagnosing it live (a
temporary on-page overlay logging `document.elementFromPoint` at each
button's own centre — see the method below, since this was not visible
from a screenshot at all) showed the click was landing on
`ASIDE.cv-palette`, the scrollable palette panel itself, not the button
under it. WebKitGTK's scrollbar here is an overlay one — it does not
reserve layout space (`offsetWidth` and `clientWidth` on the palette came
back equal), so nothing about the layout suggested a problem — but it
still paints on top of the rightmost ~15px of content when shown, and a
click there hits the scrollbar, which resolves to the scrolling element,
not whatever is under it. Every remove button in this panel sits flush
against that exact edge, including the pre-existing Views panel's own
eye/lock/remove row (`Layers.tsx`) — the same bug, just never noticed
there before this.
**Fixed:** `.cv-layers-list` (shared by both Views and stencil packs) gets
`padding-right: 14px`, moving every button in it clear of the overlay
strip; `.cv-palette` also gets `scrollbar-gutter: stable` for engines that
do reserve gutter space (confirmed a no-op in this app's own WebKitGTK, so
the padding is the fix that actually matters here, not a belt-and-braces
extra).
**Verified live, through the actual running app:** with the fix in place,
the same `elementFromPoint` check against every remove button in both
panels (Views' and stencil packs') resolved to the button itself, not the
palette; clicking a real one (the stale `tripp-lite` pack left over from
LT-100's by-hand deletion) opened the confirm modal, and "Remove
permanently" deleted it — the palette's pack list and shape-library count
both dropped immediately, no restart needed. `npx tsc --noEmit`, `npm run
lint`, `npx vitest run` (493 tests), `cargo test` (97, including 5 new
`pack_tests`) and `cargo clippy --all-targets -- -D warnings` all clean.

### LT-097 — Drag a link's port labels along the link — 2026-09-07
**Source:** asked 2026-09-07 — "I need to be able to drag the port lable."
Screenshot showed the small tags near each end of a link (`Gi0/1`, `eth1`,
`port24`...) — the port-end labels, not the link's own centre label, which
LT-051 already made draggable this same way.
**Built:** two new fields on `LinkData`, `sourcePortAt`/`targetPortAt` (0..1
along the drawn path), the exact same mechanism `labelAt` already gave the
centre label — unset keeps `portAnchors`' fixed-distance-from-each-end
placement (the parallel-cable stacking fix, LT-050/055), only a link
someone has actually dragged switches to a stored fraction.
**A real bug caught by testing the drag, not by reading the code:**
`.cv-edge-label`'s base CSS is deliberately `pointer-events: none` — "a
label sits on top of the line it describes... nothing on a label is
clickable, so it loses nothing by standing aside," from before LT-051 made
the *centre* label draggable, at which point `.cv-edge-center` alone
opted back in with its own `pointer-events: auto`. Port labels never got
that override, so the first working version of this had a correctly-wired
drag handler sitting on an element the pointer could not reach at all —
every drag attempt silently did nothing. Confirmed by testing the
*pre-existing* centre-label drag first as a control (it worked), which is
what pointed at the CSS rather than the new drag code. Fixed by adding
`.cv-edge-port` to the same `pointer-events: auto; cursor: grab` rule.
**Verified live, through the actual running app:** dragged a target port
label along a real link in the sample project, watched it slide and land
near the far end; reloaded the app and confirmed the new position
persisted; undid it back to the original placement.

### LT-101 — **bug** "Send backward" does not move a node behind others — 2026-09-07
**Source:** asked 2026-09-07 — "send backward isn't working," alongside a
screenshot of the node context menu (Edit properties / Duplicate / Set
maintenance / Lock / Bring forward / Send backward / Delete).
**Reproduced:** duplicated a device so two identical glyphs overlapped,
right-clicked the front one, chose "Send backward" — nothing moved.
**Was:** `reorder()` in `src/components/Canvas.tsx` swapped a node with its
immediate neighbour in the document's own node array, and paint order used
to follow that array via a flat `zIndex` (0 for a section, 1 for
everything else — the same value for every non-section node). React
Flow's own node store is a `Map` keyed by id, and it updates an existing
entry in place rather than removing and re-adding it — so reordering the
array we hand it changes nothing about that `Map`'s iteration order.
Between two nodes sharing the same explicit `zIndex`, paint order follows
that Map order, which "Bring forward"/"Send backward" were reordering an
array that had no bearing on.
**Fixed:** `zIndex` is now derived from each node's actual position in
that array (a section still always at 0; everything else at its index +
1), so reordering the array — which is exactly what `reorder()` already
did — now changes something paint order actually reads.
**Verified live, through the actual running app, not just by reading the
code:** duplicated a device so it overlapped the original, confirmed the
newer one (later in the array) painted on top; sent it backward
repeatedly and watched it cross behind the original partway through —
proving the fix responds to reordering, not just asserting it compiles.
One call of "Send backward" moves one step in a document that can have
many nodes between two visually-overlapping ones, which is why the very
first click in this same session looked like nothing happened — that part
was never the bug.

### LT-100 — Remove the Tripp Lite / rack stencils — 2026-09-07
**Source:** asked 2026-09-07 — "remove all Tripp Lite / Racks 18 they are
not useful at all." Reverses LT-086 (and its two follow-on bug fixes,
LT-084/LT-085) — the 18 Tripp Lite SmartRack SVGs shipped as built-in
stencils.
**Built:** checked how a bundled stencil actually reaches the palette
before touching anything — `tauri.conf.json` bundles the whole `stencils/`
directory as one resource (`"../stencils/": "stencils/"`), and
`list_bundled_icons` (`src-tauri/src/commands.rs`) scans that resource
directory generically with the same code that scans a user's own icon
folder. Nothing names "Tripp Lite" anywhere in that path — it is purely
whatever happens to be under `stencils/`. So removal was exactly
`stencils/tripp-lite/` deleted, no code changes anywhere.
**Left alone, deliberately:** `src-tauri/fixtures/tripp-lite-racks.vss` and
the tests that use it (`icons.rs`'s `a_real_operator_stencil_becomes_
drawable_icons`, asserting 18 icons) — that is a captured real `.vss` file
testing the general *"import your own Visio stencil folder"* pipeline, a
different feature from the built-in bundled set, and removing it would
have weakened test coverage for something not asked to change.
**Verified:** `cargo test -p coreview` (92 tests, including the untouched
fixture-based ones above) and the full frontend suite both still pass;
confirmed by grep that nothing else in the codebase — frontend or
Rust — names the Tripp Lite stencils, so nothing else needed touching.

### LT-094 — Pages, like Lucidchart — 2026-09-07
**Source:** asked 2026-09-07 — "Lets also add pages just like how lucidchart
does."
**Resolved 2026-09-07:** asked directly whether this meant the existing
"Views" panel (`src/components/Layers.tsx` — one shared canvas, one shared
object set, a view is a saved visibility filter over it) or true Lucidchart
pages (each an independent canvas with its own object positions). Answer:
independent canvases. Confirmed again after reading the actual store code:
offered a smaller, lower-risk alternative (tag each object with a page,
reusing the Views filtering pattern) versus the larger, fully-nested
structure this called for — the operator chose the larger one.
**Built:** `ProjectDocument` changed from one flat `{nodes, edges, canvas,
probes}` to `{pages: ProjectPage[], activePageId, probes}`, each
`ProjectPage` holding its own nodes, edges, and canvas settings (grid,
snap, colour-by, node style, link style, Views). `probes` stays flat and
project-wide — a device's monitoring was never a question of which page
draws it. A new pure module, `src/lib/pages.ts`, holds the page
list-manipulation (add/remove/rename/duplicate/reorder/switch), mirroring
`src/lib/layers.ts`'s own pure-function style, and a new `PageTabs.tsx`
component gives it a tab strip along the bottom of the canvas — modelled on
the Views panel's own interaction vocabulary (inline-editable name, a
remove affordance, an add control), laid out sideways. Renamed the
existing `canvas.page`/`canvas.pageRect` fields (the print-sheet boundary
of one drawing — an unrelated, pre-existing feature) to `canvas.sheet`/
`canvas.sheetRect` so the two concepts sharing the word "page" could not be
confused with each other in the same file.
**Migration:** `migrateDocument` (`src/lib/migrate.ts`) gained a first step
that wraps a document saved before this into a single page named "Page 1"
— idempotent, and everything that was on it stays exactly where it was.
**~30 store actions in `src/state/store.ts`** that used to reach into
`doc.nodes`/`doc.edges`/`doc.canvas` directly now go through
`activePage(doc)`/`withPage(doc, patch)`; the handful that are genuinely
project-wide (`nodeStatus`, `linkStatus`, the Monitored Objects table,
`ensureNodeCheck`, backup/CSV export) go through `allNodes`/`allEdges`
instead, which flatten every page.
**Export scope for v1:** SVG/PNG/PDF/Visio (drawing exports) draw the
active page only; CSV/Markdown (data exports, not drawings) and the
Monitored Objects table stay project-wide. True multi-page Visio export
(one `.vsdx` page per Coreview page) is real, separate work, concentrated
in `src-tauri/src/visio.rs`'s currently-hardcoded single-page XML — not
attempted here.
**A real bug found and fixed during verification, not left in:** the first
working version of `PageTabs.tsx` had a tab's inline-rename `<input>`
calling `e.stopPropagation()` on click, which silently swallowed every
click meant to switch to that tab — clicking a tab did nothing, and it was
easy to misread as "pages aren't really independent" rather than "the
click never arrived." Fixed by switching to the tab's `onFocus` instead
(which a plain click into the input also triggers, without needing the
click to bubble at all) — caught by testing the actual click, not by
reading the code, exactly the kind of thing this project's own standard
("distinguish 'I compiled it' from 'I ran it and watched it work'") exists
to catch.
**Verified live, through the actual running app, not just unit tests:**
opened a project saved before this feature existed and confirmed it came
up as one page named "Page 1" with everything intact; added a second page
and confirmed it was genuinely blank; placed a device on it and watched
the Monitored Objects count go up regardless of which page was on screen;
switched back to the first page and confirmed it was untouched; renamed a
page inline; duplicated a page and confirmed the copy got fresh ids, no
carried-over probes, and a unique name; deleted a page and confirmed its
device dropped out of Monitored Objects (the probe cascade) and the tab
strip fell back to another page; confirmed the last remaining page refuses
to be deleted. `src/lib/pages.ts` also carries 22 direct unit tests
(add/remove/rename/duplicate/reorder/switch, unique-name collision,
probe-cascade-on-delete, last-page-refusal), and `migrate.ts` carries 4
covering the new wrap step specifically (isolated from the pre-existing
LT-065 glyph-squaring tests, which were adjusted to test squaring alone
rather than picking up an extra "changed" count from the wrap).

### LT-095 — A hyperlink on an object — 2026-09-07
**Source:** asked 2026-09-07 alongside pages and note hyperlinks —
"hyprlinks."
**Built:** an optional `link` field on a device and on a note, opened from a
small badge on the canvas (bottom-left corner, next to where the lock badge
already sits). This app deliberately ships with no shell/HTTP/filesystem
plugin (`capabilities/default.json`: "the webview cannot name a path of its
own") — adding `tauri-plugin-shell` would have contradicted that, so this is
one small hand-written command, `open_external_url`, that checks the scheme
is `http`/`https` before shelling out via the `open` crate. A link on a
device or note can arrive inside an imported or shared project file, so the
scheme check is enforced in Rust, not trusted from the frontend.
**Verified:** three Rust tests confirm `file://`, `javascript:`, and a
bare string with no scheme are all refused. Live under Xvfb: this
environment turned out to have no emoji font installed at all (`fc-list`
confirms — not something to fix here, a pre-existing gap in the test VM
that equally affects the already-shipped 🔒 lock badge, not something this
work introduced), so the 🔗 glyph itself couldn't be *seen* to render.
Swapped it for a plain letter with a bright background as a temporary,
reverted-before-commit diagnostic: confirmed the badge sits in exactly the
right spot, only renders when a link is set, and a click is caught by the
badge (`stopPropagation`) rather than falling through to node
selection/drag. Reverted back to 🔗 immediately after.

### LT-096 — Notes support hyperlinks in their text — 2026-09-07
**Source:** same message — "notes with hyperlinks."
**Built:** `NoteNode.tsx`'s existing small inline-markdown parser (bold,
code, headings, checkboxes) gains `[text](url)` link syntax, opened through
the same `open_external_url` command as LT-095 — a plain `<a href>` is never
allowed to navigate the webview itself, since there is nothing for it to
navigate to.
**Verified:** three unit tests on the exported `inline()` parser (a link
renders with the right href and text; unmatched brackets with no following
`(url)` stay plain text, not a broken link; bold/code/link all still work
together on one line). Live under Xvfb: typed `[the runbook](https://…)`
into a real note's body in the sample project and watched it render as an
underlined link (plain text, no emoji-font dependency, so this one *was*
directly visible) — clicking it did not navigate the app away. Sample
project's note content restored to its original text afterward.

### LT-092 — HTTP/HTTPS probing: match text in the response body — 2026-09-07
**Source:** asked 2026-09-07, offered as an idea and accepted ("Do it") —
right now any 2xx/3xx counts as healthy, but a maintenance page or a generic
web-server default page also returns 200. For a failover drill that isn't
enough: a backup site can be "up" at the HTTP layer while serving the wrong
thing entirely.
**Built:** an optional "Expected text in response" field on an HTTP/HTTPS
probe. Empty keeps prior behaviour (status code only). Filled in, a healthy
status whose body does not contain that text comes back as a new
`BodyMismatch` outcome rather than `Success`, with the status code still
reported so a mismatch is never confused with the site being down. The body
is read with the same hard cap (`MAX_BODY_BYTES`, 64 KiB) the rest of this
probe already uses, relying on `Connection: close` rather than buffering
without limit.
**Verified live, through the actual running app:** a real local HTTP server
(not a mock) serving a known body, probed via the Inspector's HTTP GET kind
with "Application OK" as the expected text — "Test now" returned "OK — HTTP
200, ... expected text found." Changed the expected text to a string not in
the body and re-ran — "Failed — HTTP 200, but the expected text was not in
the response." Both outcomes watched end to end: Inspector field → IPC →
`probe_http` → rendered result, under Xvfb.
**A verification trap found along the way:** the first attempt at this
showed only four probe kinds in the dropdown (no HTTP/HTTPS) despite the
source being correct — the running app was loading the stale, pre-LT-087
`dist/` bundle because it had been launched as the raw debug binary rather
than through `tauri dev`. Not a code bug; written up in
`docs/HANDOVER.md` §6.7 so it doesn't cost time twice.

### LT-093 — Traceroute: show what changed since the last run — 2026-09-07
**Source:** same message — comparing two hop lists by eye to prove a path
actually moved after a failover was the friction point.
**Built:** a session-only `Map` of the last hop list seen per target: running
traceroute again against a target it already has a result for compares the
new hop list against the old one (`tracerouteDiff.ts`'s `changedHops`, pure
and unit-tested) and highlights the changed rows. A hop counts as changed if
its set of routers differs at all — new, lost, or newly/no-longer
answering, not just a router-for-router swap. Not persisted across app
restarts and not a metrics/trend feature, per the acceptance as asked: one
before/after comparison, not a history.
**Verified live, through the actual running app:** ran Traceroute against a
node in the sample project — first run: "First trace to this target this
session." Ran it again against the same target — "Same path as the last
trace to this target," the unchanged-path branch of the same message, under
Xvfb. The changed-path branch (highlighted rows, "Path changed at N
hop(s)...") is covered by seven unit tests on `changedHops` itself (router
changed, started/stopped answering, brand-new hop, order-independence) —
forcing a real path change on real hardware mid-verification wasn't
practical, and the rendering ternary next to the already-confirmed
unchanged branch is a two-line read, not a leap of faith.

### LT-091 — **bug** Two probe tests failed only on real Windows CI — 2026-09-07
**Source:** found, not reported — CI's `windows-latest` run on the LT-090 commit
failed `test (windows-latest)` while `test (ubuntu-latest)` was green. No
Windows machine was available in this environment; the operator relayed the
CI log by hand (three rounds of screenshots) since the log-download API
returned 403 here.
**Two independent bugs, one CI run:**
1. `http::tests::nothing_listening_is_refused_not_down_with_no_reason`
   expected `Refused`, got `Timeout`. The test's own 500 ms budget, chosen
   without real justification, was too tight for how Windows tears down a
   just-freed loopback port — Linux delivers the refusal essentially
   instantly, Windows measurably slower. Not an app bug: the test itself was
   flaky. Raised to 3000 ms, matching the budget the other tests already use.
2. `traceroute::tests::a_real_loopback_run_succeeds` — a real loopback trace
   came back with hops but not one probe carrying an RTT. `tracert.exe`
   writes a sub-millisecond round trip as `<1`, which is not a bare number,
   so `parse_hop_body` fell through to reading it as a hostname — the same
   `<1ms` quirk `icmp.rs` already handles for `ping.exe`, missed when this
   was written new. Fixed in `rtt_value`, same `0.5` convention `icmp.rs`
   uses. While in there: `tracert.exe`'s classic layout prints a hop's RTTs
   *before* its router name, the reverse of `traceroute`'s, which the
   original parser had no way to attach a host to — fixed with a same-line
   back-fill that is a no-op for `traceroute`'s own host-first lines.
**Acceptance:** a bug is reproduced before it is fixed (D-020) — for #1, the
reproduction *is* the CI failure itself, a real flake on real Windows, not
worth re-inventing locally. For #2, a new test
(`windows_sub_millisecond_loopback_hop_is_parsed`) reconstructs the failing
line from `tracert.exe`'s documented classic format plus what the CI panic
revealed was wrong — labelled in its own doc comment as reconstructed, not
captured, since no real Windows machine was reachable here. Both fixes
verified passing locally on Linux (68 probe-crate tests) and pushed for CI
to confirm on the platform that actually found them.

### LT-090 — Traceroute, on demand — 2026-09-07
**Source:** same 2026-09-06 message as LT-087/088/089.
**Why not a recurring probe:** traceroute has no pass/fail signal — it's a
diagnostic snapshot of the current path, useful mid-drill when something
isn't reaching the backup DC and you want to see where it's actually going.
Building it as a scored, threshold-based probe would smuggle back the
RTT-trend/metrics-history idea already declined in D-023.
**Built:** a "Traceroute" item on a node's context menu, aimed at the same
address the node's own primary check is aimed at (LT-061), opening a panel
that shells out to the platform's own `traceroute`/`tracert.exe` and parses
its text output — the same privilege-free pattern `ping` already uses here,
no raw sockets. Shows the hop list once; nothing is logged or scored.
**Parser written against real captured output, not documentation** — the
operator installed `traceroute` on request specifically so this could be
verified against a real machine rather than assumed, per this project's own
rule for parsers (`icmp.rs`'s own header comment). The captures found a real
quirk no documentation mentions: on an ECMP path, a single hop's three
probes can come back from two or three *different* routers, and
`traceroute` only reprints the router's name when it changes between
probes — handled and covered by two tests built from real captures of it
(`preserves_a_mid_hop_router_change[_numeric]`).
**Verified live, twice:** once at the Rust level (real loopback run, real
run against the unreachable RFC 5737 range), and once through the actual
running app under Xvfb — right-clicked a real node in the sample project,
opened the real "Traceroute" panel, and watched it return and render a real
result (`localhost (127.0.0.1)`, three real RTTs) end to end: menu → IPC →
Rust command → process spawn → parse → React render. Also exercised the new
HTTP/HTTPS/DNS probe-kind UI the same way — the type dropdown, the
port/path/ignore-cert-errors fields, and a real "Test now" against HTTPS
that surfaced a genuine TLS failure reason in the inspector.

### LT-087 — HTTP probing — 2026-09-06
**Source:** asked 2026-09-06, alongside HTTPS/DNS/traceroute — a two-data-centre
failover drill: "we test failover emulating full data center failure and we
want to confirm the applications are all good on the backup Data Center...
some customers have F5's and traffic from the internet is going to both data
centers."
**Built:** a probe kind that opens a `TcpStream`, hand-writes a minimal
HTTP/1.1 GET (no HTTP client dependency), and reads the status line. 2xx/3xx
is healthy; anything else (4xx/5xx, refused, timeout) is down, with the
actual status code in the summary rather than a generic "down" — confirmed
with the operator rather than assumed.
**Verified:** a real TCP listener written for the test (not a mock),
covering a healthy 204, an unhealthy 503, and nothing listening on the port
at all, each asserting the specific `Outcome` the operator asked to have
distinguished.

### LT-088 — HTTPS probing — 2026-09-06
**Source:** same message as LT-087.
**Built:** the same GET-and-status-code check as LT-087, over TLS via
`rustls`/`tokio-rustls` (no OpenSSL, so the Windows build stays painless).
Crypto provider is `aws-lc-rs`, not rustls's own default of `ring` — this
workspace already pulls in `aws-lc-rs` through `russh`'s SSH crypto, so this
reuses that build instead of compiling a second native-crypto backend
alongside it (found and fixed after the first attempt genuinely ran the
machine out of memory rebuilding both). Certificate validation is on by
default (bundled Mozilla root list via `webpki-roots`, not the OS trust
store, so behaviour doesn't vary between Windows and Linux); a per-probe
`ignoreCertErrors` toggle skips it, for a backup DC on an internal CA or a
self-signed endpoint — confirmed with the operator.
**Verified live, against real servers, not just loopback:** a trusted
public cert (validated normally, succeeded), a known self-signed cert at
`self-signed.badssl.com` (correctly rejected as `CertificateError:
UnknownIssuer` with validation on, correctly accepted with
`ignoreCertErrors` on). All three outcomes confirmed by hand before this
shipped; not committed as an automated test, since it depends on live
internet hosts and this project's other network tests deliberately stay
hermetic (loopback and the RFC 5737 documentation range only).

### LT-089 — DNS probing: confirm the resolved address, not just that one came back — 2026-09-06
**Source:** same message. DNS probing already exists (LT-002-era) and only
checks that something resolved. For this operator's scenario — many F5
deployments steer failover through DNS (GTM/GSLB) — that isn't enough to
prove a failover actually happened.
**Built:** an optional `expectedAddress` field on a DNS probe. Empty keeps
the original behaviour. Filled in, a resolution that does not include that
address comes back as `AddressMismatch` — a failure, not a warning — rather
than `Success`, so pointing this at a failover record proves DNS actually
flipped to the backup DC rather than merely still answering.
**Acceptance:** shipped as written above (mismatch treated as a hard
failure was a judgement call, not asked for in those exact words — flagged
here per the standing rule that shipped acceptance differing from what was
asked gets said explicitly).

### LT-086 — Ship the operator's Tripp Lite SmartRack racks as built-in stencils — 2026-09-04
**Source:** asked 2026-09-04, re-uploading the same file — "can you add these
to the app please just like how you did with the PPTX files this is even
better its VSS".
**Built:** the same 18 masters LT-083/LT-084/LT-085 made drawable are
committed as `stencils/tripp-lite/racks/*.svg`, bundled into the installer
the way the Cisco PPTX set already is (D-022) — no folder to point at,
built in on first run. `stencils/tripp-lite/manifest.json` and
`contact-sheet.html` document the import the way the Cisco set's own do.
Generated by the app's own real scan (`icons::scan` against the fixture),
not a separate script, so what shipped is provably byte-identical to what
converting this file live in the app would produce.
**Along the way:** shipping a second `contact-sheet.html` doubled an
existing rough edge — `.html` wasn't in `is_paperwork`'s allowlist, so the
app's own bundled documentation files were reported as "cannot read
directly" on every single run. Fixed alongside this, since it's this
change that made it visible.
**Not carried over:** master names. `vss2xhtml` exposes none (LT-045's
still-open note), so these are "Tripp Lite SmartRack Rack 1..18" by
declaration order, not by what each rack actually is.
**Acceptance:** `the_shipped_stencils_scan_into_a_full_palette` now also
asserts `lib.skipped` is empty, so a shipped file being unreadable — the
`.html` regression above, or any Visio master reverting to LT-084/LT-085's
malformed XML — fails CI instead of shipping quietly. Verified past that:
a real bundle built and packaged (`.deb`), all 18 files present at
`usr/lib/Coreview/stencils/tripp-lite/racks/`, and the packaged binary
launched and stayed up under Xvfb.

### LT-085 — **bug** A self-closing clip group was reopened with nothing to close it — 2026-09-04
**Source:** found re-verifying LT-083's fix against the operator's second
upload of the same stencil — one of the 18 masters (the one at index 14)
still failed to parse as XML after LT-084's fix, so the investigation wasn't
over.
**Was:** `strip_cruft`'s "a `<g>` that only carried the page clip contributes
nothing without it" step replaced `<g clip-path="...">...</g>` with a plain
`<g>...</g>` — correct for a real, non-empty tag. For an already
self-closing `<g clip-path="..."/>` (soffice writes one when the clip
applies to an empty group), the same wholesale replacement produced a bare
`<g>` that nothing ever closes, since a self-closing tag never had a
`</g>` to begin with.
**Fixed:** a self-closing match collapses to nothing; only a real,
non-empty tag loses just its `clip-path`.
**Acceptance:** a test against a minimal reproduction (a self-closing
`<g clip-path="..."/>` alongside a real one) that fails while the count of
`<g>` opens and `</g>` closes disagree, then the fix. Verified against the
real master that exposed it, and against all 18, by parsing each with
`roxmltree` rather than checking substrings — added as a permanent
assertion in LT-083's own test, since a substring check is exactly what let
both LT-084 and LT-085 through unnoticed the first time.

### LT-084 — **bug** A self-closing `<defs>` swallowed the next unrelated block — 2026-09-04
**Source:** found while committing the operator's Tripp Lite stencil to
`stencils/` after LT-083 shipped — Inkscape reported "Opening and ending tag
mismatch: g ... and svg" on one of the 18 converted masters, which LT-083's
own test had not caught because it checked for a `viewBox` and the absence
of `data:image/emf`, never whether the SVG was well-formed XML at all.
**Was:** `strip_cruft`'s boilerplate-`<defs>` removal always searched for a
literal `</defs>` to know where a boilerplate block ended. soffice writes
some of these self-closing (`<defs class="TextShapeIndex"/>`, empty) with no
`</defs>` of their own; searching for one anyway found the *next*, unrelated
block's close and deleted everything in between — real content included,
along with any `<g>` that opened inside the wrongly-swallowed range but
closed outside it.
**Fixed:** a self-closing boilerplate `<defs>` is deleted on its own; only a
real, non-empty one still searches for its matching `</defs>`.
**Acceptance:** a test against a minimal reproduction (a self-closing
boilerplate `<defs/>` sitting between two real, unrelated `<g>` blocks) that
fails while the count of `<g>` opens and `</g>` closes disagree, then the
fix. Led straight to LT-085, a second, unrelated bug in the same function
found while re-verifying this one against the real file.

### LT-083 — **bug** A stencil's masters are blank tiles — 2026-09-04
**Source:** found while reproducing LT-080/LT-045 against the operator's real
`.vss` — not separately reported by him.
**Was:** libvisio hands a stencil master back as `<image>` pointing at an
inline `data:image/emf` (or `.wmf`) payload — that is the *entire* content of
a master in this stencil, no vector fallback underneath. No webview paints an
`<image>` whose href is `data:image/emf`, so every master converted through
`vss2xhtml` was a blank palette tile. `blue-box.vsdx` (libvisio's own test
fixture, used by the existing LT-045 test) happens to carry vector content
instead, which is why this went unseen until a real vendor stencil was on
hand.
**Fixed:** every embedded EMF/WMF across a stencil's masters is decoded and
run through `soffice` in one batched call, then spliced back in as vector
content scaled onto the picture's own box — coordinates baked into the
geometry itself, not left as a wrapping `<g transform>`, because
`crop_to_content` reads raw path/rect/image attributes and does not follow a
transform (the first version of the fix passed its own test but produced a
10504×28808 viewBox; caught by rendering the result to PNG with Inkscape and
actually looking, not just checking the SVG parsed). Verified against all 18
masters of the operator's real Tripp Lite stencil, each rendered to PNG and
inspected by eye — genuine rack elevation drawings, not blank tiles.
**Acceptance:** a test against the operator's own `tripp-lite-racks.vss`
fixture that fails while any master's SVG still carries a `data:image/emf` or
`data:image/wmf` href, then the fix. Shipped as written; also asserts the
resulting viewBox stays within the master's own scale, which is what caught
the untransformed-geometry regression above.

### LT-081 — Stencil archives, and a skip message that names the wrong formats — 2026-09-04
**Source:** the same 2026-09-04 message, from the pasted output — "46 file(s)
are in formats Coreview cannot read directly (.pptx, .vssx, .zip) — run
scripts/import-shapes.mjs on them first".
**Two things wrong:** `.vssx` *is* read — it has gone through the Visio route
since LT-045, so the message names a format it handles and sends the operator
off to a script he does not need. And a My Shapes folder is full of `.zip`
archives of stencils, which are not opened at all.
**Fixed:** a zip is opened and walked the same way a real subfolder is —
extracted to a scratch directory and fed back through the same `collect`, so
an SVG, EMF or `.vss` inside it becomes an icon exactly as a loose file
would, categorised under the zip's own name the way a real subfolder would
be (`folder_category` now tries more than one root for this reason). A zip
that will not open, or an entry a path-traversal check refuses
(`enclosed_name`), is named in `skipped` rather than silently dropped. The
refusal message for what is genuinely unreadable now lists the actual
extensions seen instead of a hardcoded, and partly wrong, example list.
**Acceptance:** the message names only what was actually skipped, by the
extensions actually seen; a `.zip` holding stencils or SVGs is read through
like a folder. Both shipped as written, plus a broken-zip case mirroring the
existing broken-Visio-file test.

### LT-082 — **bug** A real icon file refused for being over 512 KB — 2026-09-04
**Source:** the same 2026-09-04 message —
"Unmaintained-Design-Icons_v2.0(2).svg: larger than 512 KB".
**Was:** `MAX_SVG_BYTES` is a flat 512 KB guard meant to keep a runaway file
out of the palette. A legitimate multi-shape icon sheet is bigger than that,
so a file the operator wanted was dropped with a size complaint.
**Fixed:** raised to 8 MB — still a guard against a runaway or corrupt file,
no longer a cap on how much legitimate artwork one icon sheet may hold.
**Acceptance:** that file loads. A test that fails without the fix — built
first, confirmed it failed with the message the operator actually saw
("larger than 512 KB"), then fixed.

### LT-079 — A link's default style, and a way back to it — 2026-09-02
A link's menu gains two entries: **Save this style as the default** takes the
link's look — colour, path type, flow direction, width, line style — and makes
it what the document draws links with; **Reset to default style** puts a link
back to exactly that. New links are born with it too, so a diagram drawn after
the choice needs no tidying afterwards, while anything the caller sets
explicitly (a crawl marking a link red, a discovered port label) still wins.
Only the *look* travels: ports, label, health rule, maintenance and enabled
are facts about the network, not style, and a reset leaves them untouched — a
test pins that. A hand-drawn route does go, because that is part of the look.
The choice lives on the document, so it travels with the diagram.

### LT-078 — Export to Visio — 2026-09-01
"Diagram for Visio" writes a real `.vsdx` — an OPC package of seven XML parts
— with each device a named rectangle at its place on the page and each link a
connector glued to both ends carrying its port label. Shapes and connectors,
not a picture: a colleague without Coreview can open it and move things
about. Pixels become inches and the origin flips to the bottom left, in one
place, so nothing downstream has to remember which way up a Visio page is.
draw.io was offered and declined — "export to visio only".
**Verified with an independent reader, not just by assertion:** libvisio (the
engine LibreOffice uses to open Visio files) parses the package and recovers
both device names and the port label. That check earned its keep straight
away — the first version drew the boxes and *no link at all*, because a 1-D
shape's geometry is measured from its own origin and mine was written in page
coordinates. The connector is now a proper 1-D shape: pinned at the midpoint,
rotated onto the bearing, running (0,0)→(Width,0).
**Not claimed:** Visio itself has not opened it — there is no Visio on this
machine. The package is structurally valid, well-formed throughout, and reads
correctly in the one independent Visio reader available here.

### LT-077 — Export the diagram as a PDF — 2026-09-01
"Diagram as PDF" writes a real vector PDF at the chosen paper size, from the
same SVG the screen and the SVG export are drawn from — one renderer, three
outputs. Converted in Rust (`svg2pdf`), so there is no headless browser in
the loop and no bitmap on a page: 0 image objects, text as glyph outlines,
lines a plotter can take.
**Caught before it shipped, by a test written to doubt it:** the first
version produced a 1.5 KB PDF of boxes and lines with *no device names on it
at all*. usvg's default family is "Times New Roman"; where that is not
installed — any stock Linux, plenty of locked-down Windows — every label was
silently dropped, and the file still looked like a valid PDF. The generic
families are now bound to a font the machine actually has, preferring the
app's own stack, and the same diagram comes out at 23 KB with 186 glyph
paths. A test requires that a page of pure text is never empty.

### LT-076 — Choose how times are written, and use the machine's zone — 2026-09-01
DTG is what an operator reads at a glance; it is not what everyone reads. A
"Times" picker in the top bar now writes every timestamp one of four ways —
DTG in Zulu, DTG in the machine's own zone (marked `L`, never pretending to
be Zulu), a plain 24-hour clock, or a 12-hour clock with AM/PM — applied to
the event timeline and the transition log alike, remembered for the machine
rather than stored in the document, because two people reading the same
diagram may want different clocks. The zone is named out loud: the picker's
tooltip and a line under the transition log say "CDT (UTC−05:00)" or "Zulu
(UTC)", so nobody has to guess which one they are reading.
**Found while testing:** the harness grabbed devices at a fixed `+30px` from
their corner, which was inside a node until LT-053 made devices 76 units
square — at a zoomed-out fit that is under 30px on screen, so the grab landed
on the pane and rubber-banded instead of dragging. It had been passing by a
hair; a fraction of a percent of zoom change exposed it. Every drag now takes
its target by the centre.

### LT-075 — **bug** The space-bar hand let go of the diagram mid-drag — 2026-09-01
**Source:** reported 2026-09-01 — "holding the space bar and drag, the hand
doesn't really hold the screen where I try to move from-to, it just takes the
direction that I move the mouse to."
Measured rather than guessed: a plain press-drag-release tracked the cursor
exactly 1:1, at any zoom, starting on a device, and out-and-back returned to
zero — so the arithmetic was never wrong. What broke was releasing the space
bar *during* the drag, which everyone does once the hand has hold: the key-up
tore the pan sheet away mid-gesture and the diagram stopped following the
cursor after only part of the movement. A drag now runs until the button
comes up and the key is irrelevant once it has started; the deferred release
is honoured on pointer-up and on pointer-cancel, and a window blur still
clears everything.

### LT-074 — Transition times as a DTG — 2026-08-31
**Source:** asked 2026-08-31 — "I need time stamp of when the device
disconnects and when its live back again in DTG… I need logs showing in DTG."
"Down 7s" says how long, not which 7 seconds. Every status change now carries
a date-time group — `311430:07Z AUG 26` — in three places: the event timeline
(which showed a bare clock time, no date, no zone), a newest-first transition
log under Recent status on the device itself, and a `dtg` column in the
exported events CSV beside the ISO stamp. Zulu by default, because the zone
letter is part of what makes a DTG worth keeping; seconds included, because a
ping goes down and comes back inside a minute. Double-clicking a timeline row
copies the line with its DTG.

### LT-073 — **bug** Backing up three devices blanked the whole window — 2026-08-31
**Source:** reported 2026-08-31 with a screenshot — three devices selected,
backup pressed, and the app became an empty dark window.
Two faults, both fixed. **The throw:** the Rust backup enum is tagged
adjacently — `{kind, value:{…}}` — and every reader here expected the fields
flat, so a successful save arrived with `bytes` undefined,
`bytes.toLocaleString()` threw, and React unmounted the tree. Nothing caught
it earlier because no test had ever seen a *successful* backup payload.
Events are normalised at the IPC edge now (`normaliseBackupEvent`, tested
against both shapes) and the panel reads a missing size as "size unknown".
**The blank window:** a throw anywhere took the whole application down, with
nothing said and no way back. Each region — toolbar, palette, diagram,
inspector, monitoring panel — now sits in an error boundary that names what
broke, shows the message, keeps the rest alive and offers "Try again".
Verified by forcing a render fault in the harness: the window survives, the
boundary reports it, untouched regions keep working, reopening is clean.

### LT-025 — Two roadmap files — 2026-08-31
The MVP-era root `ROADMAP.md` is now a one-paragraph pointer to
`docs/ROADMAP.md`, which is authoritative.

### LT-033 — Stale debug scripts in `e2e/` — 2026-08-31
`e2e/dbg.mjs` and `e2e/dbg2.mjs` deleted.

### LT-063 — Bump the CI artifact actions off Node 20 — 2026-08-31
`actions/upload-artifact` to v7 and `download-artifact` to v8, clearing the
Node-20-deprecation warning on every run.

### LT-071 — **bug** Elbow grips multiplied into dozens along a link — 2026-08-31
`pathVertices` counted every number pair in the path, so a smoothstep's
rounded corners — each a `Q` whose control point *is* the corner and whose
endpoint lies on the next run — read as three vertices apiece, and every one
sprouted a grip. The parser is command-aware now (M/L give a vertex, Q gives
its control point, the endpoint is dropped) and collapses points that sit on
the run they join; runs too short to aim at get no grip at all. The real
browser path that produced the mess is the test: it now yields three grips,
one per straight run, which is what Lucidchart shows.

### LT-072 — A bezier link's curve can be adjusted — 2026-08-31
A selected curved link offers one ring handle at the middle of the curve;
dragging it away from the straight line between the ends bows the curve,
double-click hands it back to automatic. Stored on the link, undoable, saved.
A bezier shows only this handle — no elbow grips, no waypoint dots — so the
three routing modes never crowd each other.
**Reported not working, and it was:** the first cut passed a `curvature`
option to React Flow's `getBezierPath`, which in the pinned version *ignores
it* — every value returned a byte-identical path, so the handle moved and
nothing happened. Proven by isolating the call, then replaced with our own
cubic (`src/lib/bezierPath.ts`, tested): each end leaves along the side its
handle is on, and curvature is how far the control point reaches along that
end's own axis. Curvature 0.5 reproduces React Flow's old curve exactly, so
no diagram drawn before this moves.

### LT-027 — Colour by VLAN — 2026-08-31
Colour-devices-by joins health, role, subnet and tag with VLAN. The MAC-table
parser already read the VLAN column; that now threads onto each attached
device (`AttachedDevice.vlan`), into the node the topology builds
(`data.vlan`), and into the tinting key. A device the switch learned on an
access port colours by that VLAN; a switch that trunks many, or a device found
over a discovery protocol, has no single VLAN and is left uncoloured rather
than lumped into one shade. Confirmed against the lab 9300's live MAC table
(a flat VLAN-1 network, so everything colours as one group — correctly).

### LT-028 — Multi-sheet export — 2026-08-31
The SVG export can now write one file per sheet at full size, not just the
whole diagram shrunk onto one. `tileRects` splits the content by the chosen
paper's printable area (tested); the renderer clips each sheet to its tile so
a device straddling a seam is not drawn whole on both; the export menu's
"SVG sheets (N)" writes `<name>-sheet-r{row}c{col}.svg` into the export
folder. Needs an export folder set; without one it falls back to the single
SVG and says why.

### LT-069 — Elbow links: drag a segment, press-and-hold to reset — 2026-08-31
A step or smoothstep link now edits the Lucidchart elbow way: a selected one
shows a pill grip on each straight run, dragging a grip slides that run
orthogonally with every corner kept at 90° (`dragSegment`, tested), and a
press-and-hold on a grip that never moves resets the whole line to
automatic. Straight and curved links keep the free vertex/midpoint handles
from LT-068 — one interaction or the other, chosen by the link's path type.

### LT-070 — **bug** Shape conversion failed when LibreOffice was already busy — 2026-08-31
The overnight smoke caught it: `a_real_emf_becomes_a_palette_icon` failed
intermittently because `cargo test` runs the soffice-backed tests in
parallel, and two `soffice --convert-to` invocations sharing the default
user profile collide — one silently produces no output. A user with
LibreOffice already open would hit the identical failure on every import.
Each soffice call now gets its own `-env:UserInstallation` profile directory
(created and cleaned per call), so nothing shares a lock. Reproduced with two
concurrent conversions, fixed, and confirmed stable across repeated full
backend runs that were flaky before.

### LT-068 — Full manual control of link routing — 2026-08-31
Reshape a link by hand, Lucidchart-style: a selected link shows a filled
square at each waypoint (drag to move, double-click to remove) and a hollow
circle at each segment midpoint (drag to bend a new waypoint in). The route
is stored on the link (`waypoints`), undoable, saved, and drawn as a
rounded polyline that keeps its shape — no auto-hop, no lane. "Reset routing"
on the link's context menu hands it back to automatic. Double-click still
adds flat text on the bare line (LT-052); the handles sit only on the
vertices and midpoints, so the two do not fight. **Follow-up filed as LT-069:**
the elbow/step line mode Lucid shows — pill grips that slide a whole segment
orthogonally, and press-and-hold to reset — is a distinct interaction on top
of this.

### LT-064 — **bug** Links lost their little jumps at crossings — 2026-08-31
React Flow's smoothstep splits one straight segment at its border offsets
into collinear runs, and a crossing near one of those joints was dropped for
sitting at a run's end. The runs of a straight line are coalesced now, in
both the crossing finder and the arc renderer, so a crossing anywhere along a
straight link hops again. Not a regression from the recent edge work — a
longstanding weakness the crawled diagram exposed; the browser-captured paths
are the test.

### LT-065 — **bug** The edit corners are far from the shape on older nodes — 2026-08-31
`migrateDocument` squares a pre-LT-053 168x92 device box on open — centre
kept, shapes and already-square glyphs left alone, idempotent, dirtying the
document only when it changed something. Runs on open and recovery-restore.

### LT-066 — The bundled shapes fold into one palette section — 2026-08-31
The built-in library sits behind a single collapsed "Shape library" header
with its count; the nine categories nest inside it, and search opens through.

### LT-067 — Hovering a link shows its physical ports — 2026-08-31
The link hover leads with the ports: `Ports: A Gi1/0/1 ↔ B Gi0/1` for a
plain link, and `Port-channel: … (Gi1/0/11, Gi1/0/12)` listing the members
for a LAG, from the discovery note.

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

## Declined

*Explicitly ruled out by the operator. Kept with their IDs (never deleted),
never to be built.*

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
**Declined 2026-08-31:** the operator will not do this now or in future.

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
**Declined 2026-08-31:** the operator will not do this now or in future. The internal-CA signing that already works is enough.

---

## Icebox

*Raised but deliberately deferred. Not dropped.*

### LT-080 — `.vss` stencils do not import on Windows
**Source:** asked 2026-09-04 — "can we find a way to import vss", with the
app's own report pasted from a Windows machine pointed at My Shapes:
"83 Visio file(s) need libvisio-tools to convert — install it and reload".
**Why it fails:** the `.vss`/`.vssx` route runs libvisio's `vss2xhtml`, which
is packaged on Linux and has no Windows package. LibreOffice is not a way out:
its Visio filter is the same libvisio but calls `parse()`, and a stencil has
no drawing page — converting this operator's real Tripp Lite `.vss` through
`soffice` gives one empty page, while `vss2xhtml` on the same file gives 18
masters. Checked 2026-09-04, both ways, on the operator's own file.
**Tried and reverted, 2026-09-04 (D-024):** bundled the MSYS2 `mingw64` build
of `vss2xhtml`/`vsd2xhtml` and its DLLs (~40 MB) into the Windows installer
as a resource, resolved at startup with a `PATH` fallback. It built and
passed CI on a real `windows-latest` runner. The operator rejected it on
size: "made the installer up to 38MB I don't like that lets revert it and
remove whatever app or tool to covert the files i'm happy with what we have."
His stated workflow going forward: hand a stencil file over directly and
have it converted and committed the way `tripp-lite-racks.vss` was, rather
than have his own Windows install read a My Shapes folder natively.
**Deferred, not declined:** if a materially smaller way to read `.vss` on
Windows turns up — a native Rust reader for the legacy compound-binary
format, say, rather than shipping libvisio's own binary — this is still
wanted. Don't re-propose the ~40 MB DLL bundle; that trade is already made.

### LT-024 — Connection points on imported shapes
A Visio master carries named ports; an imported EMF is a picture. Reading ports
would let a link land on "Gi0/1" rather than on the right-hand side. Deferred:
the conversion path produces pictures, so there is nothing to read yet.

### LT-026 — Canvas performance above ~400 devices
Measured 2026-08-30: 400 devices open in ~2s, drag at ~15fps, pan at ~8fps;
120 devices at 33 and 18. The cost is ~60 DOM elements per device.
`onlyRenderVisibleElements` was tried and rejected (D-010). Not worth doing
until someone actually has a diagram that large.


