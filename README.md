# LiveTopo

A local-first Windows desktop app for drawing a network topology and validating
reachable targets on it while you work — during maintenance windows, cutovers,
upgrades and troubleshooting.

You draw the diagram. You enter the addresses. You choose what each line means.
LiveTopo checks the targets you configured and shows the result on the canvas:
moving packet dots on healthy links, stopped red lines on failing ones.

**Nothing leaves the machine.** No account, no cloud, no telemetry, no
auto-discovery, no scanning. Probes run only between Start validation and Stop
validation, and only for the project that is open.

---

## Build status — read this first

| Part | Status |
| --- | --- |
| Frontend (React/TypeScript) | Builds clean. `tsc --noEmit` and `vite build` both pass. |
| Frontend test suite | 23 tests pass (`npm test`). |
| Rust crates | **Written but not compiled.** They were authored in an environment with no Rust toolchain, so `cargo build` has not been run against them. |
| Windows installer | Configured in `src-tauri/tauri.conf.json`, not yet produced. |

Run `npm run rust:test` on a machine with Rust installed before trusting the
backend. Expect to fix small compile errors on the first pass; the logic and
the security boundaries are the parts worth reviewing, and both are covered by
unit tests that will run as soon as the crate compiles.

Milestones 0–5 are implemented. Milestone 6 is partial: exports, event log,
report and samples exist; CSV import is written as a library (`src/lib/csv.ts`,
tested) but is not yet wired to a UI button.

---

## Prerequisites

- Windows 10 or 11
- [Node.js](https://nodejs.org) 18 or newer
- [Rust](https://rustup.rs) stable (MSVC toolchain)
- Microsoft Visual Studio C++ Build Tools with the Windows 10/11 SDK
- WebView2 runtime (already present on Windows 11 and current Windows 10)

## Run in development

```powershell
npm install
npm run tauri dev
```

The frontend alone can be run in a browser with `npm run dev`, which is useful
for UI work. In that mode there is no backend: projects go to browser storage
and probing is unavailable. The app says so in a banner rather than pretending.

## Tests

```powershell
npm test                 # frontend: health rules, link rules, CSV
npm run typecheck        # TypeScript strict mode
npm run rust:test        # probe engine + persistence (needs Rust)
```

## Build the Windows installer

```powershell
npm install
npm run tauri build
```

Output lands in `src-tauri\target\release\bundle\` — `nsis\LiveTopo_0.1.0_x64-setup.exe`
and `msi\LiveTopo_0.1.0_x64_en-US.msi`.

---

## What it does

**Diagram.** Infinite canvas, pan and zoom, grid and snap, minimap, marquee
selection, undo/redo, autosave. A palette of 26 objects — firewall, router,
core/distribution/access switch, wireless controller and AP, server, VM,
storage, endpoint, printer, camera, ISP cloud, private cloud, site container,
VPN, application, database, plus basic shapes and text. Everything resizes.
Icons are drawn in-repo (`src/components/icons.tsx`); no vendor artwork ships
with the app.

**Links.** Four handles per node, multiple connections per side. Each link has
three independently editable labels — source port, centre, target port —
plus path type, arrow direction, width and notes:

```
[FGT-HQ-01] -- port3 / Po10 ==== 10 Gb LACP — VLANs 10,20,30 ==== Te1/0/48 / Po10 -- [CORE-SW-01]
```

**Probes.** ICMP, TCP connect, DNS resolution, or manual. Per probe: target,
interval, timeout, failure threshold, recovery threshold, warning latency, and
an enable toggle. Nodes hold multiple labelled addresses (`Management`,
`Loopback0`, `WAN1`). `Test now` runs a single check and starts nothing.

**Link health rules.** Six of them: manual, follow source, follow target, both
endpoints healthy, dedicated probe, or a named probe on a chosen node. The
inspector and the link tooltip both state which rule is driving the line.

**Live view.** Healthy links carry green dots along the real SVG path. Warning
is amber and slower. Down is red, dashed, and still. Every status is paired
with a glyph (`✓ ! ✕ ? – ⚙`) so colour is never the only signal. A global
Reduce motion switch stops all animation.

**Evidence.** Event timeline with filters, CSV export of every state
transition, Markdown validation report, PNG and SVG diagram export with a title
block and legend, and a print path for PDF.

## Known limitations

- The Rust side has not been compiled (see build status above).
- CSV import is implemented and tested as a library but has no UI entry point.
- PDF export goes through the browser print dialog. Native PDF is not built.
- `.livetopo` export is a JSON package, not the ZIP-with-assets format the spec
  describes. Custom images are embedded as data URLs inside the JSON, so
  round-tripping works, but the file is larger than a ZIP would be.
- Dedicated link probes are configured through the link inspector only when the
  rule is set to "Dedicated probe target".
- Performance was reasoned about (SMIL animation, memoised edges) but has not
  been measured against the 50-node/75-link target on real hardware.
- No SNMP, no NetFlow, no discovery, no API polling. These are deliberate
  non-goals for the MVP — see `ROADMAP.md`.

## Security model

- Every probe target is parsed by `crates/livetopo-probe/src/validate.rs` before
  it can reach a process argument, a socket or the resolver. Shell
  metacharacters, whitespace, quotes, control characters and leading dashes are
  rejected. Unit tests cover the injection cases directly.
- `ping` is invoked with an argument vector. There is no `cmd.exe`, no
  PowerShell, no string interpolation, and no shell plugin in the Tauri
  capability set.
- The frontend can call fourteen named Rust commands and nothing else. There is
  no generic execute.
- File access is scoped in `src-tauri/capabilities/default.json` to the app data
  directory plus files the user picks in a dialog.
- No credentials are stored. The data model leaves room for Windows Credential
  Manager references when SNMP and API checks arrive; nothing writes secrets
  today.
- CSV export prefixes cells starting with `=`, `+`, `-` or `@` with an
  apostrophe so an imported device name cannot execute as a spreadsheet formula.

## Where your data lives

`%LOCALAPPDATA%\LiveTopo\livetopo.db`

One SQLite database holding projects, diagrams, validation sessions, events and
samples. The About dialog shows the exact path on the running machine.

## What a green link actually proves

A passing check proves that *this Windows machine* reached *that target* with
*that method* at *that moment*. It does not prove every drawn hop in the path is
healthy, and it does not prove end-to-end application traffic. Link colour
follows the rule you selected for that link. The app states this in the About
dialog, the link inspector and every exported report.

## Documentation

- `ARCHITECTURE.md` — structure, data model, probe lifecycle, security boundaries
- `ROADMAP.md` — what is done and what comes next
- `docs/USER_GUIDE.md` — how to use it
- `docs/PROBE_BEHAVIOR.md` — exact threshold and state-machine behaviour
- `docs/TEST_PLAN.md` — the 20 required cases, mapped to automated or manual tests
