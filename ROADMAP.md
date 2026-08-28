# Roadmap

## Done (MVP)

**Milestone 0 — bootstrap.** Tauri 2 + React + TypeScript + Vite, dark
operations shell, strict TypeScript, test scripts.

**Milestone 1 — diagram editor.** React Flow canvas, 26-object palette with
drag and drop, resizable device/shape/note nodes, four-handle linking, three
independent link labels, selection, undo/redo, grid, snap, minimap, fit view,
keyboard shortcuts, context menus on nodes, links and canvas.

**Milestone 2 — persistence.** SQLite through rusqlite, create/open/save/
duplicate/archive/delete/import/export, autosave with a visible saved state,
safe project close, versioned schema and document.

**Milestone 3 — probes and Test now.** Node addresses, ICMP/TCP/DNS/manual
probe configuration with full threshold controls, one-shot `Test now` that
starts no schedule, target validation with unit tests.

**Milestone 4 — live monitoring.** Project-scoped Rust scheduler, cancellation
on stop/close/switch/quit, threshold state machine, transition-only event
logging, live binding to canvas badges and dashboard.

**Milestone 5 — animated links.** Custom SVG edge with path-following packet
dots, per-status colour and glyph, direction options including bidirectional,
six link health rules, global reduce-motion setting.

**Milestone 6 — operational quality (partial).** Event timeline with filters,
CSV export, Markdown report, PNG/SVG diagram export with title block and
legend, three sample projects, installer configuration.

## Immediate next steps

1. **Compile and fix the Rust.** It has never been through `cargo build`.
2. **Wire CSV import to the UI.** The parser and its tests exist; it needs a
   file picker, a preview of unresolvable link endpoints, and a skip/resolve
   step.
3. **Measure performance** at 50 nodes and 75 links with 30 animated edges.
   If SMIL is too expensive, drop dot count per edge before dropping frame rate.
4. **Real `.coreview` ZIP package** with a manifest, the SQLite slice, imported
   assets and optional logs, instead of a single JSON file.
5. **Native PDF export** rather than the print dialog.
6. **Persist probe samples**, not only transitions, so a report can show a
   latency series for the window.

## Later phases

**Phase 2 — richer checks.** HTTP/HTTPS status checks, TLS expiry, traceroute
capture attached to a link, SNMPv3 interface state and utilisation with
credentials held in Windows Credential Manager. Extension points are in place:
`ProbeKind` is a closed enum today but `run_once` is the only dispatch site.

**Phase 3 — evidence quality.** Before/after snapshot comparison for a change
window, automatic pre-check and post-check runs bound to a change note,
signed/timestamped report export.

**Phase 4 — scale.** Multi-project dashboards, scheduled unattended windows,
optional agent on a remote site so probes originate from the right vantage
point rather than the engineer's laptop.

**Explicitly not planned for the MVP line:** auto-discovery, NetFlow/sFlow/IPFIX,
SSH/REST execution, real-time collaboration, cloud sync, mobile, an in-product
AI assistant, Visio compatibility, enterprise RBAC.
