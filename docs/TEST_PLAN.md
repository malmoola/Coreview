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
| `crates/livetopo-probe/src/validate.rs` | 4 tests. IPv4/IPv6/hostname acceptance, normalisation, 16 hostile inputs rejected, numeric bounds |
| `crates/livetopo-probe/src/icmp.rs` | 8 tests. Windows and Linux reply parsing, sub-millisecond replies, timeout vs unreachable vs DNS failure, unparseable output, single-probe argv |
| `crates/livetopo-probe/src/state.rs` | 10 tests. Initial unknown, first success, no duplicate events, warning on high RTT, hold-below-threshold, failure counter text, never-claims-unobserved-health, recovery threshold, threshold of 1, maintenance masking, disabled |
| `crates/livetopo-probe/src/engine.rs` | 6 tests. Idempotent stop, start/stop clears session, project scoping, disabled probes not scheduled, project switch stops the prior session, invalid target fails without spawning a process |
| `src-tauri/src/db.rs` | 4 tests. Document round-trip, independent duplication, event scoping, cascade delete |

## The 20 required cases

| # | Case | How it is covered | Status |
| --- | --- | --- | --- |
| 1 | Draw firewall, router, switch, AP, server | Manual: drag each from the palette. Also exercised by all three sample projects. | Manual |
| 2 | Resize all object categories | Manual: `NodeResizer` is attached to device, shape and note nodes alike. | Manual |
| 3 | Label all nodes | Manual: inspector *Display name*. | Manual |
| 4 | Source, target and centre labels on one link | Manual: three separate inspector fields. Sample 1 ships a link with all three populated. | Manual |
| 5 | Free-form note in empty space, resize and lock | Manual: right-click canvas → Add note; inspector has a Lock checkbox. | Manual |
| 6 | Reachable ICMP target reaches healthy | Manual: configure `127.0.0.1`, Start validation. Samples ship this node. | Manual |
| 7 | Unreachable documentation range goes down after threshold | Automated (`state.rs::holds_prior_state_below_failure_threshold`) plus manual with `192.0.2.1`. | Automated + manual |
| 8 | Healthy link animates green dots | Manual visual check. Gating is automated (`shouldAnimate`). | Manual |
| 9 | Failing link turns red, dots stop | Manual visual check. Gating automated. | Manual |
| 10 | Warning when RTT exceeds threshold | Automated (`state.rs::high_rtt_becomes_warning`) — injected, no live network needed. | Automated |
| 11 | Both-endpoints rule is down when either endpoint is down | Automated (`evaluate.test.ts`, full truth table). | Automated |
| 12 | Test Now starts no background monitoring | Automated by construction: `test_probe_now` calls `run_once`, which touches no scheduler. Verify manually that the session pill stays *Validation stopped*. | Automated + manual |
| 13 | Stop validation stops future probes | Automated (`engine.rs::start_then_stop_clears_the_session`). Manual confirmation with a packet capture is worth doing once. | Automated |
| 14 | Closing a project stops active probes | `store.closeProject` calls `stopValidation` first. Manual. | Manual |
| 15 | Closing the app stops active probes | Three layers: `WindowEvent::CloseRequested`, `RunEvent::Exit`, and a `beforeunload` handler. Manual. | Manual |
| 16 | Duplicate creates independent data | Automated (`db.rs::duplicate_is_independent`). | Automated |
| 17 | Export/import preserves objects and metadata | Automated at the storage layer (`db.rs::round_trips_a_project_document`); the file round-trip is manual. | Automated + manual |
| 18 | CSV contains transitions, timestamps, target, type, RTT, failure messages | Automated (`csv.test.ts`). | Automated |
| 19 | Malicious hostname cannot cause shell injection | Automated (`validate.rs::rejects_injection_shaped_input`, 16 payloads) and by construction — argv, no shell. | Automated |
| 20 | 50 nodes / 75 links stays responsive while monitoring | **Not yet measured.** Needs a real run on Windows hardware. | Outstanding |

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
11. Start again, then close the window. Confirm no `LiveTopo.exe` or `ping.exe`
    remains in Task Manager. (Case 15)
12. Name a node `10.0.0.1 && calc.exe` and give a probe that target. Confirm the
    probe fails with an invalid-target message and that no calculator opens.
    (Case 19)
13. Export the diagram as PNG and SVG. Confirm the title block carries project,
    customer, site, ticket, engineer and timestamp, and that the legend is
    present.
14. Export events as CSV and open in Excel. Confirm the node named above appears
    as text, not as a formula. (Case 18)
15. Export the `.livetopo` package, delete the project, import the file, confirm
    the diagram, labels, probes and health rules all return. (Case 17)
16. Duplicate a project, edit the copy, confirm the original is untouched.
    (Case 16)
17. Build a 50-node/75-link project, start validation, and watch CPU in Task
    Manager for five minutes. Record the number. (Case 20)

## Known gaps

- Case 20 has never been run. Everything about the animation design was chosen
  with it in mind — SMIL in the compositor, memoised edge components, dots
  unmounted when not healthy — but that is reasoning, not a measurement.
- No end-to-end UI test harness. Playwright against the Tauri build would cover
  cases 1–5 and 8–9 properly and is the obvious next investment.
- CSV import has unit tests but no UI, so it has no manual case yet.
