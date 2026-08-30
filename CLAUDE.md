# Coreview

A local-first desktop app for network engineers: draw a topology, point it at
real addresses, and watch the links while you work. Tauri 2 + React + TypeScript
+ Vite on the front, Rust behind. Everything stays on the machine — no account,
no telemetry, no cloud.

## Standing rules

**Read these first, every session, before doing anything else:**
`docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/OPEN-QUESTIONS.md`. Then summarise
the **Now** and **Blocked** sections back in three lines or fewer.

- **A new task goes into `docs/ROADMAP.md` before the work starts.** Several
  things in one message become several items. Never merge them.
- **Never renumber an ID. Never delete an item.** It moves to Done or Icebox
  with a reason.
- **If a task conflicts with a logged decision, say so and cite the D-ID**
  rather than silently doing the new thing.
- **When a task is finished, move it to Done with the date**, and say what
  actually shipped if it differs from the acceptance criteria.
- **Something mentioned in passing goes in Icebox**, not in the bin.
- **Never mark something Done without having run it.** "It compiles" is not
  "it works"; say which one you mean.
- **Commit roadmap and decision changes in the same commit as the code they
  describe.**
- At the end of a session, or whenever asked to **checkpoint**, update all three
  docs and show the diff.
- "Where are we" and "what's left" are answered from `docs/ROADMAP.md`, not
  from whatever is still in context.

## How the work is done here

- No stubs, no mocks, no "TODO: implement". If something cannot work, say so
  plainly and stop.
- A failing test is not fixed by weakening the test.
- Prefer editing an existing file to rewriting it.
- `crates/coreview-probe` is Tauri-free on purpose.
- Parsers are written against captured output from real hardware, not against
  documentation. `crates/coreview-discover/examples/try_commands.rs` and
  `raw_login.rs` are for capturing it.

## Layout

```
src/                 React front end
  components/        Canvas, palette, inspector, panels
  lib/               Pure logic, all unit-tested — routing, layout, diffing,
                     tinting, clipboard, paper, stencil-adjacent helpers
  state/store.ts     Zustand store; the document lives here
  theme.ts           Every colour the canvas paints with, per ground
  styles.css         Every colour the chrome paints with, as CSS variables
crates/
  coreview-discover  Crawling: SSH, telnet, CDP, LLDP, FortiOS, SNMP, ARP
  coreview-probe     ICMP/TCP/DNS probing; no Tauri
src-tauri/           Commands, SQLite, credential vault, icon library scan
scripts/             Stencil and shape import, run by hand
e2e/                 Playwright harnesses driving the real app
docs/                ROADMAP, DECISIONS, OPEN-QUESTIONS, and the rest
```

## Checks

```
npx tsc --noEmit
npx eslint src --ext .ts,.tsx
npx vitest run
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm run dev            # then, in another terminal:
node e2e/interact.mjs  # 164 interaction checks
node e2e/change.mjs    # the change report, against a stubbed backend
node e2e/library.mjs   # the icon library, against a stubbed backend
```

The e2e harnesses drive a real browser because WebKitGTK plus xdotool cannot
deliver modifier-clicks, HTML5 drags or the pointer sequences React Flow needs.
They are the only thing that catches a feature that compiles and does nothing.

## Colour

Two grounds, dark and light, each with its own palette — not one derived from
the other (D-007). Canvas colours are in `src/theme.ts`; chrome colours are CSS
variables in `src/styles.css`. A neutral desk and a white page are accepted and
not yet built (D-016, LT-001); until then the light ground's `--bg` is the
blue-tinted `#f4f7fa` that is being complained about.
