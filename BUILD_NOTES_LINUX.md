# Linux build notes

First attempt to compile and run Coreview on Linux. Machine: **Ubuntu 26.04
(resolute)** — newer than the 22.04/24.04 the instructions assumed, which
matters for package names.

## Status

| Part | Result |
| --- | --- |
| `crates/coreview-probe` build | **Compiles clean.** No source changes needed. |
| `crates/coreview-probe` tests | **29/29 pass.** |
| `crates/coreview-probe` clippy `-D warnings` | Clean after one fix. |
| Dependency resolution for `src-tauri` | **444 packages resolve, no conflicts.** |
| `src-tauri` build | **Blocked** — needs pkg-config + GTK/WebKit (root). |
| Frontend `tsc --noEmit` | Clean. |
| Frontend `npm test` | **23/23 pass.** |
| App run / 20 test cases | **Blocked** — no display, no `ping` binary. |

## Fixed

1. **`icmp.rs` manual `div_ceil`** — clippy `-D warnings` rejected
   `((timeout_ms + 999) / 1000)`. Replaced with `timeout_ms.div_ceil(1000)`.
   Behaviour is identical; the tests still pass.

That is the only source change required to get the probe crate compiling,
testing and linting clean.

## Checked and found already correct

Three things flagged as likely problems turned out not to be:

- **`creation_flags` in `icmp.rs`** is already behind `#[cfg(windows)]`
  (line 171). No guard needed.
- **Linux `ping` argv** already branches correctly and emits
  `-c 1 -W <secs> <target>`.
- **serde ↔ TypeScript naming.** `Outcome` uses `rename_all = "snake_case"`
  and all eight variants appear in `src/lib/ipc.ts` as `success`, `timeout`,
  `unreachable`, `refused`, `dns_failure`, `no_answer`, `os_error`,
  `invalid_target`. `HealthStatus`, `ProbeKind` and `ObjectKind` use
  `rename_all = "lowercase"` and match their TS unions. No drift.

## Documentation drift found

- **No workspace root `Cargo.toml`.** `cargo build --workspace` cannot work as
  the instructions and README assume. Each crate builds individually
  (`cd crates/coreview-probe && cargo build`, `cd src-tauri && cargo build`).
  Worth adding a root manifest.
- `docs/TEST_PLAN.md` says `state.rs` has 10 tests; it has 11. Probe crate
  total is 29, not 28. With `src-tauri/db.rs`'s 4 the project total is 33.

## What is blocked and why

Everything remaining needs packages that require root. The apt lists are also
stale — only `deb.nodesource.com` is present, no Ubuntu archive — so
`apt update` is needed before anything installs.

```bash
sudo apt update
sudo apt install -y \
  pkg-config build-essential curl wget file \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libssl-dev \
  libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
  iputils-ping \
  xvfb x11-utils imagemagick \
  inkscape
```

What each unblocks:

| Package | Unblocks |
| --- | --- |
| `pkg-config`, `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev` | `cargo build` for `src-tauri`; the 4 db tests; `npm run tauri dev` and `build` — Phases 2 (rest), 3, 6 |
| `iputils-ping` | ICMP probes. **There is no `ping` binary on this box at all.** Test cases 6/7/9 and everything in Phase 3 depend on it. |
| `xvfb`, `x11-utils`, `imagemagick` | Running the app headless and taking the screenshots you asked for — Phases 3 and 5 |
| `inkscape` (or `libreoffice`) | EMF → SVG conversion for the icon library — Phase 4 |

Note: `libwebkit2gtk-4.1-dev` / `libsoup-3.0-dev` are the 24.04+ names and
should be right for 26.04, but I could not confirm against the archive because
the package lists are not downloaded.

## Good news on ICMP

`net.ipv4.ping_group_range = 0 2147483647`, so unprivileged ICMP is permitted
for every group on this machine. Once `iputils-ping` is installed, probes will
work as the normal user with no setuid or capability changes. The "does the app
fail loudly when ping needs root" question cannot be exercised here without
deliberately narrowing that sysctl — worth doing as a separate test.

## Icon extraction (Phase 4, partial)

The pptx was unpacked and fully catalogued, but **not converted** — no EMF
converter is installed.

- 216 media files: **215 `.emf` (vector)** + 1 `.png`
- 10 slides, all 216 files mapped to a category
- **188 recovered real names** from the slide labels; the remaining 28 are on
  the 3rd-Party slide, which carries no per-icon label in the deck
- Names are good quality: `ASR 9000`, `CSR 1000v`, `ASA 5500`,
  `Fibre Channel Director MDS 9000`, `L2 Switch with Dual Supervisor`

Categories: Collaboration 43, Data Center 31, 3rd-Party 28, SAFE 24, Security/
Clouds/Connectors 20, Routing WAN 19, WiFi Indicator 18, LAN Switching 15,
Endpoint Client & Device 11, DNA/SD-Access 7.

Staged with a manifest at `~/.local/share/coreview/icons-staging/`.
**Not committed to this repo and not bundled** — it is Cisco artwork.

## Bundles (Phase 6)

Both Linux bundles build and both were run, not just produced.

| Artifact | Size | Declares / carries |
| --- | --- | --- |
| `Coreview_0.1.0_amd64.deb` | 2.6 MB | depends on `iputils-ping`, `libwebkit2gtk-4.1-0`, `libgtk-3-0` |
| `Coreview_0.1.0_amd64.AppImage` | 78 MB | 161 bundled libraries, including WebKit |

`iputils-ping` had to be added by hand. The generated deb declared only the
GTK and WebKit libraries, but the probe engine shells out to `ping`
(`crates/coreview-probe/src/icmp.rs:164`), so without it the app would install
cleanly and then fail every check — the worst way for a dependency to go
missing.

### What the AppImage actually carries

Worth knowing before promising anyone it is self-contained. It bundles WebKit
in full — `libwebkit2gtk-4.1.so.0`, `libjavascriptcoregtk-4.1.so.0`,
`WebKitWebProcess` and `WebKitNetworkProcess` — which is the part that would
otherwise be painful, since distributions ship incompatible webkit2gtk
versions.

It does **not** carry the graphics or font stack, and is not supposed to:

    libGL.so.1  libEGL.so.1  libGLX.so.0  libgbm.so.1  libdrm.so.2
    libX11.so.6  libxcb.so.1  libfontconfig.so.1  libfreetype.so.6
    libharfbuzz.so.0

The AppImage format excludes these deliberately — `libGL` is coupled to the
host's driver, and bundling it breaks hardware acceleration on the machine that
runs it. So the AppImage runs on any ordinary desktop and on nothing less. It
will not start in a bare container, and no desktop application would.

CI proves the useful half of that claim: the `AppImage on a machine without
WebKit` job installs a minimal desktop runtime, asserts via `ldconfig` that the
host has no WebKit at all, and then starts the app. Passing means it ran on the
WebKit it carries.

### Running headless

WebKitGTK will not realise its window on a machine with no GPU. The app starts,
prints nothing, and leaves an unmapped 10x10 placeholder window — there is no
error to search for. Every headless run needs:

    WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    LIBGL_ALWAYS_SOFTWARE=1 ./target/release/coreview

This is what made Cases 14, 15, 17 and 2 testable at all.
