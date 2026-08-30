# Handover

Everything a new pair of hands needs to pick this up and carry on. Read
`CLAUDE.md` for the standing rules and `docs/ROADMAP.md` for what is owed;
this file is the map and the minefield.

---

## 1. What this is

**Coreview** — a local-first desktop app for network engineers. You draw a
topology, point it at real addresses, and watch the links while you work. It
also crawls a network over SSH and draws itself.

Nothing leaves the machine. No account, no telemetry, no cloud, no agent on the
device. It reads what is already there over protocols a network engineer
already allows, and it does not write configuration — a tool that can also
change things is a different tool with a different risk profile.

The operator is a working network engineer with real hardware on his desk.
He tests against it. Things that "compile" get found out within the hour.

**The bar he set:** better than Lucidchart and Visio at drawing, without giving
up the half neither of them has — a diagram pointed at real addresses that
watches them.

---

## 2. Read these first, in this order

| File | What it is |
| --- | --- |
| `CLAUDE.md` | Standing rules. Non-negotiable. |
| `docs/ROADMAP.md` | Every request, with stable IDs. The answer to "what's left". |
| `docs/DECISIONS.md` | 21 decisions with what was rejected and why. Append-only. |
| `docs/OPEN-QUESTIONS.md` | What is not yours to decide. |
| This file | The shape of the code and the traps in it. |

If a task conflicts with a logged decision, **say so and cite the D-ID**. Do
not quietly do the new thing. Several requests in one message become several
roadmap items — never one merged item.

---

## 3. The shape of the code

~95,000 lines. TypeScript front, Rust back, Tauri 2 between.

```
src/
  lib/            28 modules of pure logic. This is where the thinking lives.
                  Every one is unit-tested and none of them touch React.
                  routeLinks, alignment, lineJumps, collapse, zones, layers,
                  tinting, clipboard, paper, topology, topologyDiff, diagram,
                  statusHistory, bulkEdit, csv, subnetGroups, tidyLayout,
                  findNodes, linkStyle, paletteDrop, probes, exports, samples…
  components/     React. Canvas, palette, inspector, panels, node and edge
                  renderers. Thin — they call into lib/.
  state/store.ts  Zustand. The document lives here: nodes, edges, probes,
                  canvas settings. Undo/redo is snapshot-based.
  theme.ts        Every colour the canvas paints with, for both grounds.
  styles.css      Every colour the chrome paints with. Three token blocks.
crates/
  coreview-discover  Crawling. SSH (russh), telnet, CDP, LLDP, FortiOS, SNMP,
                     ARP, MAC tables, OUI lookup. 300+ tests.
  coreview-probe     ICMP/TCP/DNS probing. Tauri-free on purpose.
src-tauri/        Commands, SQLite, the credential vault, icon library scan.
scripts/          Stencil/shape importers. Run by hand, not by the app.
e2e/              Playwright harnesses that drive the real app.
```

**The pattern that matters:** anything with logic in it goes in `src/lib/` as a
pure function with tests, and the component calls it. `routeLinks.ts` decides
which side a link leaves from; `LiveEdge.tsx` just draws what it is told. When
you are about to put a decision inside a component, don't.

---

## 4. Running and verifying

```bash
npx tsc --noEmit
npx eslint src --ext .ts,.tsx
npx vitest run                                    # 369 tests
cargo test --workspace                            # 377 tests
cargo clippy --workspace --all-targets -- -D warnings

npm run dev                                       # then, in another terminal:
node e2e/interact.mjs                             # 171 checks, the big one
node e2e/change.mjs                               # change report, stubbed backend
node e2e/library.mjs                              # icon library, stubbed backend
```

`cargo` may not be on `PATH`: `export PATH="$HOME/.cargo/bin:$PATH"`.

### Why the e2e harnesses exist

The Tauri build renders in WebKitGTK, and synthetic input through xdotool
cannot deliver modifier-clicks, Shift-drag, HTML5 drag-and-drop, or the pointer
sequences React Flow's resizer and connection handles need. Those cases sat
untested for that reason. The frontend is the same code in Chromium, so
Playwright drives it there.

They are the only thing that catches **a feature that compiles and does
nothing**, which on this project is the dominant failure mode. Several
features have shipped, passed type-checking and unit tests, and been silently
inert until an e2e check was written for them.

`change.mjs` and `library.mjs` stub `window.__TAURI_INTERNALS__` so the desktop
paths can be driven in a browser. Everything above the stub is the real app.

**Stale scripts:** `e2e/dbg.mjs` and `e2e/dbg2.mjs` are one-off debug leftovers
that got committed. Ignore them; they are in Icebox to be removed.

---

## 5. What "done" means here

- **No stubs, no mocks, no "TODO: implement".** If something cannot work, say
  so plainly and stop. Do not fake it.
- **Never fix a failing test by weakening the test.** If the test is wrong,
  say why it is wrong and fix the assertion to be *stronger*, not looser.
- **Reproduce a bug before fixing it** (D-020): a test that fails without the
  fix comes first.
- **Distinguish "I compiled it" from "I ran it and watched it work."** Say
  which one you mean, every time.
- **Verify by measuring, not by looking.** Screenshots are for judging design;
  assertions are for judging behaviour. Several bugs here looked fine in a
  screenshot.
- Commit after each piece of work with a real message. Roadmap and decision
  changes go in the same commit as the code they describe.

### The commit style

Prose, not bullet points. Say what was wrong, what it does now, and why the
obvious alternative was rejected. A reader six months out should learn
something from it. Look at `git log` — that is the register to match.

---

## 6. Traps that have actually bitten

This is the part worth reading twice. Every one of these cost real time.

### 6.1 Tests that pass for the wrong reason

The single most common failure here.

- **Two grouping checks passed because nothing could move at all.** A lock test
  earlier in the file locked a node and never unlocked it; "the gap did not
  change" is true both when a companion follows its group and when nothing
  moves. Fix: assert the thing *moved* first, using a third uninvolved node as
  a witness to distinguish a node drag from a canvas pan.
- **A check that skips itself is not a check.** `if (await x.count()) { …five
  assertions… }` reports success when the locator finds nothing. Assert the
  precondition, then act on it.
- **A test asserted the broken behaviour.** It encoded the bug as expected
  output. When a test fails, decide which one is wrong before changing either.
- **Verify a new test fails without the fix.** Temporarily break the code and
  watch it go red. Done here for link routing and it caught a no-op assertion.

### 6.2 React Flow

- **DOM order is not stable.** Selecting or dragging a node moves it in the
  document for z-order. `nth(0)` before and after an interaction are different
  elements. Address nodes by label, edges by `data-id`.
- **The centre of an edge's bounding box is usually empty space.** An L-shaped
  path passes nowhere near it. To click or hover "the edge", parse its `d`,
  take a real point on the line, and map it through the viewport transform.
- **It sets `pointer-events` on nodes inline.** No stylesheet can override it.
  If you need nodes inert, use the API or an overlay.
- **It does not forward a double-click on the pane.** A React handler above it
  never fires. Use a native listener in the capture phase.
- **A `sourceHandle` is looked up only among *source* handles**, even in loose
  connection mode. Only the target side searches both. That is why all four
  sides are declared as sources.
- **Correcting a node position from `onNodeDrag` does not hold** — the next
  drag event overwrites it. Rewrite the change as it passes through
  `onNodesChange`, and include the final change, which arrives with `dragging`
  already false.
- **`onlyRenderVisibleElements` makes dragging three times worse.** Measured.
  See D-010. Do not try it again.

### 6.3 Rust and serde

- **An internally-tagged enum cannot represent a newtype variant holding a
  String.** It compiles and fails at runtime. Use adjacent tagging
  (`content = "value"`).
- **The document is stored as `serde_json::Value` and must stay that way**
  (D-002). A typed struct would silently drop every field the frontend adds
  afterwards.
- **`-D warnings` in CI.** An import used only by a `cfg`-gated test is an
  unused import on other platforms. Windows CI went red for a day over this.

### 6.4 SVG

- **An eight-digit hex is not a colour in SVG 1.1.** Renderers fall back to
  black. Use `fill-opacity`. This drew sections as solid slabs over their
  contents.
- **A marker referenced but not defined draws nothing, silently.** Assert that
  an arrowhead is both referenced *and* present.
- **A marker in a shared `<defs>` cannot see the colour of the path using it.**
  Per-link markers are why a link can carry its own colour.

### 6.5 CSS

- **`var()` resolves where it is used.** Nodes inherited colour from `body`,
  which sits outside the element carrying the theme class, so every node stayed
  dark-theme coloured on a white ground. Colour and background belong on the
  themed root.
- **Invisible is not untouchable.** `opacity: 0` keeps the hit area. Hidden
  connection handles were swallowing clicks meant for neighbouring devices.
- **A variable that does not exist falls through to its fallback silently.**
  Three rules read `--cv-text-dim`, `--cv-warn` and `--cv-accent`, none of
  which have ever been defined here.

### 6.6 Playwright

- The bottom panel overlaps the canvas. A node placed low is under it and a
  pointer-down aimed at it hits the panel.
- A context menu that runs off the bottom of the window has unreachable items.
  Fixed in the app, but it is the kind of thing to watch for.
- Where a node lands relative to the pointer depends on the zoom. Do not
  predict it — move, measure, correct, then release.

---

## 7. The lab

Real hardware the operator tests against. **Credentials are his and are not in
this repository** — they live in the app's encrypted vault, and any that
appeared in conversation should be treated as compromised and rotated.

| Device | Address | What it proved |
| --- | --- | --- |
| Cisco C2960CX | 192.168.14.7 | CDP, LLDP, config backup, SNMP v2c and v3 |
| FortiSwitch 224E | 192.168.14.203 | FortiOS command set, chassis-id→ARP resolution |
| FortiGate 60F 7.6.7 | 192.168.14.1 | `$` prompt, DHCP lease list, FortiLink, FortiAP LLDP |
| Ubiquiti USL8L | 192.168.14.112 | SNMP only; found via a FortiAP's LLDP |
| Palo Alto PA-220 | 192.168.14.206 | SNMP v2c identity |

**Parsers are written against captured output, never against documentation.**
`crates/coreview-discover/examples/try_commands.rs` runs a list of commands
against a real device and reports which were understood;
`examples/raw_login.rs` dumps exactly what a device sends after login. Both
exist because guessing from docs produces a crawler that fails silently on
hardware nobody tested.

The biggest single win on this project came from `raw_login.rs`: a FortiGate
was completely unreachable because FortiOS ends its prompt in `$` for any
non-super_admin profile and the prompt finder only accepted `#` and `>`.

---

## 8. Where the work is

`docs/ROADMAP.md` is authoritative. At the time of writing:

- **Now:** LT-002 Cisco PPTX stencil pipeline · LT-003 custom shape import bugs
  · LT-029 the standing bug bar
- **Next:** LT-004 selection should outline the shape, not a box · LT-005 icon
  library cannot be cleared · LT-006 Lucidchart `.lcsl` import
- **Blocked:** port-channel (needs a LAG on the lab switch) · Catalyst 9000
  (needs access) · installer trust (needs two GitHub secrets, and a public CA
  for SmartScreen) · legacy `.vss` (needs `libvisio-tools`)

**Known bugs open: 3.** LT-003, LT-004, LT-005.

---

## 9. Things worth knowing that are not written anywhere else

- **The operator wants no pale colours.** He said so directly. There are tests
  holding a contrast floor for every device tint on the ground it is for. Do
  not lower them.
- **An unwatched device is drawn by what it is, not by its health** (D-008).
  With no probes attached everything is "unknown", so colouring purely by
  health made every new diagram grey. Health takes the colour back the moment
  something is watching.
- **Two grounds, not an inversion** (D-007, D-016). Light is built against
  white; dark against near-black. A colour chosen for one is wrong on the other.
- **The export draws itself from the model** (D-001), not by serialising the
  canvas. It has fallen behind the canvas once already and had to be caught up
  — sections, line styles, end caps, ground. If you add something visible to
  the canvas, ask whether `src/lib/diagram.ts` needs it too.
- **`src/lib/paper.ts`'s `sheetsFor` is written and tested but only reports.**
  Multi-sheet export is in Icebox.
- **Performance is measured, not guessed.** 400 devices: opens in ~2s, drags at
  ~15fps, pans at ~8. 120 devices: 33 and 18. The cost is the DOM, about sixty
  elements per device. Line jumps cost nothing measurable.
- **The user is direct and technically fluent.** He will tell you when
  something is wrong and he will be right. He does not want hedging, and he
  does want to be told plainly when something cannot be done or when you have
  broken something.
