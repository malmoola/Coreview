# Test plan

## Automated coverage

**Runs today** (`npm test`, 23 passing):

| File | Covers |
| --- | --- |
| `src/health/evaluate.test.ts` | Node status aggregation, all six link health rules, both-endpoints truth table, animation gating, severity ordering — 17 tests |
| `src/lib/csv.test.ts` | CSV quoting, formula-injection neutralisation, event export columns, node/link import with error reporting — 6 tests |

**Written, needs a Rust toolchain** (`npm run rust:test`):

| File | Covers |
| --- | --- |
| `crates/coreview-probe/src/validate.rs` | 4 tests. IPv4/IPv6/hostname acceptance, normalisation, 16 hostile inputs rejected, numeric bounds |
| `crates/coreview-probe/src/icmp.rs` | 8 tests. Windows and Linux reply parsing, sub-millisecond replies, timeout vs unreachable vs DNS failure, unparseable output, single-probe argv |
| `crates/coreview-probe/src/state.rs` | 10 tests. Initial unknown, first success, no duplicate events, warning on high RTT, hold-below-threshold, failure counter text, never-claims-unobserved-health, recovery threshold, threshold of 1, maintenance masking, disabled |
| `crates/coreview-probe/src/engine.rs` | 6 tests. Idempotent stop, start/stop clears session, project scoping, disabled probes not scheduled, project switch stops the prior session, invalid target fails without spawning a process |
| `src-tauri/src/db.rs` | 4 tests. Document round-trip, independent duplication, event scoping, cascade delete |

## The 20 required cases

**Run on Linux (Ubuntu 26.04) on 2026-08-27.** Status column records what was
actually observed, not what is expected to work. "Backend" means verified in
`crates/coreview-probe/tests/live_linux.rs` against the real network stack;
"UI" means observed in the running app via a screenshot.

| # | Case | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Draw firewall, router, switch, AP, server | **PASS (UI)** | Branch office sample renders 9 devices of distinct types; palette shows all 26 |
| 2 | Resize all object categories | **PARTIAL (UI)** | window resized 1600x1000 -> 1150x740 on the packaged binary: toolbar wraps to a second row, panels reflow, table stays readable, no overflow. Per-node drag-resize still not exercised — synthetic drags do not reach `NodeResizer` |
| 3 | Label all nodes | **PASS (UI)** | every node shows its display name and address |
| 4 | Source, target and centre labels on one link | **PASS (UI)** | `Primary ISP / port1`, `10 Gb LACP — VLANs 10,20,30 / Te1/0/48 / Po10` |
| 5 | Free-form note, resize and lock | **PARTIAL (UI)** | change note renders with checklist; resize/lock not exercised |
| 6 | Reachable ICMP target reaches healthy | **PASS (UI + backend)** | 127.0.0.1 → green, `Healthy · <1 ms`; backend measured rtt 0.019 ms |
| 7 | Unreachable range goes down after threshold | **PASS (UI + backend)** | 192.0.2.x → red `Down`, `Request timed out`; backend `Unknown→Down` |
| 8 | Healthy link animates green dots | **PARTIAL (UI)** | healthy links render green and solid, down links red and dashed; motion itself is not observable in a still capture |
| 9 | Failing link turns red, dots stop | **PASS (UI)** | red dashed links with ✕ glyph |
| 10 | Warning when RTT exceeds threshold | **PASS (unit)** | `state.rs::high_rtt_becomes_warning` |
| 11 | Both-endpoints rule down when either endpoint down | **PASS (unit)** | `evaluate.test.ts` truth table |
| 12 | Test Now starts no background monitoring | **PASS (backend)** | `live_linux::test_now_starts_no_background_work` — engine stays Stopped, snapshot empty |
| 13 | Stop validation stops future probes | **PASS (UI + backend)** | UI returns to `Validation stopped`, all 9 → Unknown, RTT cleared; backend confirms session cleared and no live `ping`. See note on defunct children below |
| 14 | Closing a project stops active probes | **PASS (UI)** | packaged binary under Xvfb: `ping` present in 4/14 and 6/20 one-second samples while running; after Close project, 0/25 samples and no zombies |
| 15 | Closing the app stops active probes | **PASS (UI)** | `ping` in 4/10 samples, then WM_DELETE_WINDOW: no `coreview` and no `ping` process anywhere on the system |
| 16 | Duplicate creates independent data | **PASS (unit)** | `db.rs::duplicate_is_independent` |
| 17 | Export/import preserves objects and metadata | **PASS (UI)** | exported `.coreview`, deleted the project (DB row gone, events cascaded), re-imported, re-exported: 10 nodes / 8 edges / 8 probes and the canvas identical after dropping generated ids. Only `id`, `name`, `createdAt`, `updatedAt` differ, by design |
| 18 | CSV contains transitions, timestamps, target, type, RTT, messages | **PASS (unit)** | `csv.test.ts` |
| 19 | Malicious hostname cannot cause shell injection | **PASS (backend)** | 6 payloads incl. `10.0.0.1 && touch /tmp/...` all → `InvalidTarget`; marker file asserted absent. Not re-driven through the UI, which passes the same string to the same validator |
| 20 | 50 nodes / 75 links stays responsive | **PASS (measured)** | see below |

### Case 20 — measured, 2026-08-27

Generated by `e2e/make_case20.py`: 50 nodes, 75 links, 50 ICMP probes
(25 × 127.0.0.1, 25 × RFC 5737). Ran validation for **5 minutes** in the
packaged debug build under Xvfb on a **2-core** box.

| | Idle | Under load |
| --- | --- | --- |
| CPU (whole process, % of 2 cores) | 0.4 % | **6.6 – 6.9 %** |
| RSS | 165.8 MB | **166.5 – 166.8 MB** |

- Steady across all 15 samples; no drift.
- RSS grew **0.9 MB over 5 minutes** — no leak at this duration.
- 6.7 % of two cores ≈ 13 % of one core. **Inside the 15 % budget.**
- Reached `Healthy 25 / Down 25 / Unknown 0`, 50 events, 125 monitored objects.
- **Frame rate not measured.** The headless WebKitGTK webview gives no usable
  frame counter, and a number from a different engine would not be the number
  that matters. Outstanding.

### Note on defunct child processes

After Stop validation, one `[ping] <defunct>` zombie was observed persisting.
It is **not** a running probe — the child had exited and merely was not reaped,
so it consumes no CPU and sends no packets, and Case 13's substantive
requirement holds. It comes from the cancellation path: `kill_on_drop` signals
the child but the future is dropped before tokio reaps it. Over a long session
this could accumulate PIDs. After the 5-minute Case 20 run the count was back
to **0**, so it is transient rather than cumulative, but worth fixing.

## Manual test script

Run this once on a clean Windows machine after the Rust side compiles.

1. Install from the NSIS output. Launch. Confirm no console window appears.
2. Open the Branch office sample. Confirm nine devices, eight links, one change
   note, all links grey and still.
3. Select the edge firewall. Confirm the probe targets `127.0.0.1`.
4. Press **Test now**. Expect `OK — Reply, <1 ms`. Confirm the session pill still
   reads *Validation stopped*. (Case 12)
5. Press **Start validation**. Within ~15 s the firewall should be green with
   moving dots; the documentation-range nodes should go red after three failures
   — about 15 s. (Cases 6, 7, 8, 9)
6. Hover a red link. Confirm the tooltip names the rule and shows the failure
   text. (Truthful-status requirement)
7. Set a link to *Both endpoints must be healthy* between one green and one red
   node. Confirm red. (Case 11)
8. Turn on **Reduce motion**. Confirm all dots stop and colours remain.
9. Press **Stop validation**. Confirm everything returns to grey and still, and
   that a packet capture shows no further ICMP. (Case 13)
10. Start again, then close the project. Confirm probes stop. (Case 14)
11. Start again, then close the window. Confirm no `Coreview.exe` or `ping.exe`
    remains in Task Manager. (Case 15)
12. Name a node `10.0.0.1 && calc.exe` and give a probe that target. Confirm the
    probe fails with an invalid-target message and that no calculator opens.
    (Case 19)
13. Export the diagram as PNG and SVG. Confirm the title block carries project,
    customer, site, ticket, engineer and timestamp, and that the legend is
    present.
14. Export events as CSV and open in Excel. Confirm the node named above appears
    as text, not as a formula. (Case 18)
15. Export the `.coreview` package, delete the project, import the file, confirm
    the diagram, labels, probes and health rules all return. (Case 17)
16. Duplicate a project, edit the copy, confirm the original is untouched.
    (Case 16)
17. Build a 50-node/75-link project, start validation, and watch CPU in Task
    Manager for five minutes. Record the number. (Case 20)

## Open defect: diagram export renders no diagram

Found while driving Case 17 on the packaged binary. "Diagram as PNG" and
"Diagram as SVG" produce a file with the correct title block and legend and an
**empty canvas area**. Confirmed a 2084x1508 PNG with nothing but the header.

`canvasToSvg` serialises `.react-flow__viewport` and injects the result into an
`<svg>` document. In @xyflow/react 12 that element and its children are HTML
`<div>`s, not SVG — `react-flow__viewport` at `dist/esm/index.js:3090`,
`react-flow__nodes` at 2380, `react-flow__edges` at 3057. HTML in the SVG
namespace outside a `<foreignObject>` renders nothing, so the whole diagram
drops out. This is not a regression; the code was written against an assumed
DOM shape and, like the rest of the app, had never been run.

The fix is to draw the export from the document model instead of from the DOM:
`getNodesBounds` for the extent, `getSmoothStepPath` / `getBezierPath` /
`getStraightPath` (all exported by the library) for the link geometry, and
`renderToStaticMarkup` on the existing glyph components in
`src/components/icons.tsx` so the exported artwork stays the same one the
canvas draws rather than a second copy that can drift. Not attempted here —
it is a rewrite of the exporter, not a patch.

Case 13 of the manual script ("Export the diagram as PNG and SVG. Confirm the
title block ... and that the legend is present") passes as literally written:
both are present. The diagram between them is not.

## Known gaps

- Case 20 has never been run. Everything about the animation design was chosen
  with it in mind — SMIL in the compositor, memoised edge components, dots
  unmounted when not healthy — but that is reasoning, not a measurement.
- No end-to-end UI test harness. Playwright against the Tauri build would cover
  cases 1–5 and 8–9 properly and is the obvious next investment.
- CSV import has unit tests but no UI, so it has no manual case yet.
