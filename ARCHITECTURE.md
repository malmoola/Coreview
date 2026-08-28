# Architecture

## Shape

```
┌─────────────────────────────────────────── WebView2 ───────────────────────────────────────────┐
│  React + TypeScript + Vite                                                                     │
│                                                                                                │
│  ProjectScreen ── TopBar ── Palette ── Canvas (React Flow) ── Inspector ── StatusPanel          │
│                                  │                                                             │
│                          Zustand store (state/store.ts)                                        │
│                    durable document │ live runtime │ undo history                              │
│                                  │                                                             │
│                          lib/ipc.ts  ← the only IPC surface                                    │
└──────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                   │ 14 named Tauri commands + 1 event channel
┌──────────────────────────────────┴─────────────────────────────────────────────────────────────┐
│  Rust                                                                                          │
│                                                                                                │
│  src-tauri/          commands.rs  (glue: validation of shape, state handles, SQLite)            │
│                      db.rs        (rusqlite: projects, sessions, events, samples)               │
│                      main.rs      (window lifecycle; stop-on-close, stop-on-exit)               │
│                                                                                                │
│  crates/livetopo-probe/   validate.rs  target parsing — the security boundary                   │
│                           icmp.rs      ping argv construction + output parsing                  │
│                           net.rs       TCP connect, DNS resolution                              │
│                           state.rs     threshold state machine                                  │
│                           engine.rs    project-scoped scheduler, cancellation, concurrency      │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The probe crate has no Tauri dependency on purpose. Everything that could hurt
someone — argument construction, output parsing, threshold logic, cancellation —
lives there and is testable with plain `cargo test`. `src-tauri` is glue.

## Why Zustand

One store, no provider ceremony, and selectors that let a node re-render when
its own probe updates without re-rendering the other forty-nine. React Flow
already owns node position state; Redux Toolkit's ceremony buys nothing here,
and Context would re-render the whole canvas on every probe sample.

Three kinds of state are deliberately kept apart:

- **Durable** — `doc` (nodes, edges, probes, canvas settings) and `meta`. This
  is what is written to SQLite and what export produces.
- **Live** — `runtime` (per-probe status), `session`, `events`. Never persisted
  as truth; rebuilt from engine events each session.
- **UI** — selection, panel open, settings. Never persisted with the project.

## Data model

SQLite holds project metadata, validation sessions, events and probe samples in
normalised tables because those are queried, filtered and exported. The diagram
itself is one versioned JSON document per project, because it is always read and
written whole, and one document keeps undo/redo, export and migration simple.

```
projects(id, name, customer, site, ticket, engineer, description,
         created_at, updated_at, archived, document_version, document)
validation_sessions(id, project_id, started_at, stopped_at, operator, status)
events(id, project_id, session_id, timestamp_ms, object_type, object_id,
       object_name, event_type, previous_status, current_status,
       probe_type, target, rtt_ms, message)
probe_samples(id, session_id, probe_id, timestamp_ms, status, outcome, rtt_ms, summary)
```

`schema_info.version` gates SQL migrations; `document_version` gates diagram
shape migrations. Both are checked on open.

The document contains `nodes`, `edges`, `probes` and `canvas`. Node and edge
shapes match React Flow's, with LiveTopo fields under `data`.

## Probe lifecycle

```
Start validation
  └─ stop any prior session first (project switch can never orphan probes)
  └─ open a validation_sessions row
  └─ filter to: enabled, this project, not manual
  └─ spawn one task per probe under a CancellationToken
       each task: stagger (index * 137 ms, capped at 3 s)
                  loop { acquire semaphore permit (default 20)
                         run one check
                         apply threshold state machine
                         emit Sample, and Transition only if status changed
                         sleep interval }
       every await point is inside tokio::select! against the token

Stop validation / close project / close window / quit
  └─ token.cancel()
  └─ drain the JoinSet, bounded to 3 s, then abort_all()
  └─ every probe status resets to unknown — a stopped session is not evidence
  └─ close the session row
```

Cancellation is checked before acquiring a permit, while waiting for a permit,
during the check itself, and during the interval sleep. A child `ping` process
is killed on drop. `Test now` calls `run_once` directly and registers nothing,
so a one-off test can never leave a schedule behind.

## Link health evaluation

`src/health/evaluate.ts` is pure and unit-tested. It is the single place a link
colour is decided.

- Disabled link → `disabled`, regardless of endpoints.
- Maintenance link → `maintenance`.
- Manual rule → the operator's chosen status; never touches probe data.
- Every other rule requires a running session; otherwise `unknown`.
- Follow source / follow target → that node's effective status.
- Both endpoints → down if either is down; then maintenance, then unknown, then
  disabled, then warning; healthy only when both are healthy.
- Dedicated probe → the link's own probe.
- Named node probe → a probe selected by id anywhere in the project.

A node's status comes from its primary enabled probe, or the first enabled probe
if none is primary. A node with no probes is `unknown` — never `healthy`. The
app does not report health it has not observed.

Nothing here traces a physical path. A link's colour is a rule the operator
chose, and the UI says which rule in the inspector and the hover tooltip.

## Animation

`LiveEdge` renders SVG `<circle>` elements driven by `<animateMotion>` bound to
the same path string React Flow computed for the line, so dots follow the actual
geometry including bends. SMIL runs in the compositor rather than in React, so a
hundred animated edges cost no re-renders. Dots exist only while status is
healthy or warning; changing status unmounts them, which is also how Stop
validation halts everything. Speed is constant per status and is not derived
from RTT — a status indicator that looked like a throughput gauge would be
misleading.

## Security boundaries

1. **JS → Rust.** Fourteen named commands. No shell plugin, no HTTP plugin, no
   generic exec. Listed explicitly in `main.rs`.
2. **Rust → OS.** `parse_target` must succeed before any target reaches an argv,
   a socket or the resolver. `ping` gets an argument vector, never a string.
3. **Filesystem.** Tauri capability scopes limit reads and writes to
   `$APPLOCALDATA` and `$TEMP`, plus whatever the user picks in a dialog.
4. **Untrusted display data.** Device names, labels, notes and imported CSV
   values are rendered as React text nodes, never as HTML. CSV export escapes
   leading formula characters.
5. **Secrets.** None are stored. The probe config has no credential field. When
   SNMP or API checks arrive they should hold a Windows Credential Manager
   reference, not a value.
