# Coreview

A local-first desktop app for drawing a network topology and watching it stay
up while you work — during maintenance windows, cutovers, upgrades and
troubleshooting.

You draw the diagram. You enter the addresses. You choose what each line means.
Coreview checks the targets you configured and shows the result on the canvas:
moving packet dots on healthy links, stopped red lines on failing ones.

Runs on **Windows, macOS and Linux**. One machine, one SQLite file, no account.

---

## Privacy, and what "local-first" actually means here

This is the section to read if you are deciding whether to point this at a
customer's network. Every claim below was checked against the source, and the
places where the app *does* talk to the network are stated as plainly as the
places where it does not.

### There is no AI in this product

No model, no API key, no prompt, no "assistant", no cloud inference, nothing
sent anywhere to be analysed. There is no code path that could do it: the app
ships no HTTP client for general use, and the webview is forbidden from making
outbound requests at all (see below).

Check it yourself. `git grep -i openai` returns exactly one hit outside this
README, and it is worth knowing what it is: a company name inside
`crates/coreview-discover/src/oui_data.rs`, the offline IEEE OUI table that
turns a MAC address prefix into a manufacturer name. It sits alongside 19,858
others — Cisco, Netgear, Hewlett Packard. It is a static string in a lookup
table, compiled into the binary, and nothing dials it.

The same goes for `git grep -iE "telemetry|analytics|sentry"`: every hit is
either a vendor name in that same OUI table ("Adcon Telemetry", "Honeywell
Analytics") or a line of the app's own text promising there is none.

### There is no telemetry, and nothing to opt out of

- No analytics, crash reporting, usage metrics or "improve the product" upload.
  No Sentry, PostHog, Segment, Datadog, Google Analytics — none of them are
  dependencies, and there is no home-grown equivalent.
- **No auto-update.** The app never checks a server for a new version. You
  install a build, and that is the build you have until you replace it.
- No account, no licence check, no activation, no sign-in.
- No cloud sync, no vendor backend. There is no Coreview server. It does not
  exist, so it cannot be breached, subpoenaed, or quietly switched on.

The frontend ships **eight** runtime dependencies — the Tauri API, its dialog
plugin, React, React DOM, React Flow and Zustand. None of them phone home.

### The interface physically cannot reach the network

This is enforced structurally, not by convention. The webview runs under this
Content-Security-Policy (`src-tauri/tauri.conf.json`):

```
default-src 'self';
img-src 'self' asset: http://asset.localhost data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self';
connect-src 'self' ipc: http://ipc.localhost
```

`connect-src` allows only the app's own bundle and the Tauri IPC channel. A
`fetch()` to anywhere else is blocked by the engine before a packet is sent —
so even a supply-chain compromise in a frontend dependency has no route out
through the UI.

There are also no remote assets to leak a request through: no CDN, no Google
Fonts, no remote images, no web analytics pixel. Fonts are the ones already on
your machine. Device icons are drawn in-repo as SVG. Vendor stencils are
compiled in at build time and read from disk.

### The Rust side is a fixed list of 53 commands, not a general escape hatch

The webview cannot run a program, read an arbitrary file, or open a socket. It
can call 53 named Rust commands and nothing else — there is no generic
`execute`, no `eval`, no path passthrough.

The Tauri capability allowlist (`src-tauri/capabilities/default.json`) grants
only: core defaults, set-window-title, the event channel, and the native
save/open dialogs. In its own words:

> No shell, no HTTP, and no filesystem plugin: the webview cannot name a path
> of its own. Exports and backups are written by Rust commands, and only to a
> path or folder the user picked in a native dialog.

Exactly one Tauri plugin is initialised in `src-tauri/src/main.rs`: the dialog
plugin. (`@tauri-apps/plugin-fs` and `-opener` appear in `package.json` but are
imported nowhere and never registered on the Rust side, so they are inert.)

### What Coreview *does* send, and where

It is a network tool. It sends packets on purpose. Being straight about this is
more useful than a blanket "nothing leaves the machine", which would be false:

| Traffic | When | Where to |
| --- | --- | --- |
| ICMP echo (`ping`) | While a validation session is running | Only the addresses you typed into a probe |
| TCP connect | Same | Only your target and port |
| DNS resolution | Same | Your OS resolver, for names you entered |
| HTTP / HTTPS probe | Same | Only the URL you configured |
| Any of the above, once | When you press **Test now** | That one probe's target, one check, starting nothing |
| Ping sweep | Only when you run one, over a range you type | The range you typed |
| Reverse DNS (PTR) | During a sweep, for addresses that answered | Your OS resolver — this is what `ping -a` does, so a swept host arrives named rather than numbered |
| `traceroute` | Only when you click Traceroute | The target you chose |
| SSH | Only when you start a device crawl or a config backup | Only the devices you listed |
| SNMP (read-only) | Only during a crawl, and only if you supply SNMP credentials | Only the devices you listed |
| Telnet | Only when you explicitly choose it for a run | Only the devices you listed |
| Opening a link | Only when you click a hyperlink you added | Your OS browser, `http(s)` only — the Rust command rejects `file://`, `javascript:` and anything else, with tests covering it |

**On Telnet:** every credential and every byte of output crosses the network in
clear text. That is what the protocol is, not a flaw in this implementation,
which is why it is never selected automatically — a run has to ask for it, and
the interface says plainly what it costs. Prefer SSH wherever the equipment
allows it.

**On SNMP:** read-only, and deliberately narrow — the system group (which names
and describes the device) and the interface table. It earns its place because a
read-only community is far easier to get approved than shell access, and plenty
of equipment answers SNMP while refusing a login. Everything else you might
want from SNMP belongs in a monitoring system, not a diagram tool.

Everything in that table is **operator-initiated and operator-addressed**.
Nothing runs on a timer you did not start, nothing scans a range you did not
type, and nothing contacts an address that is not in your own project. Probes
run only between **Start validation** and **Stop validation**, and only for the
project that is open.

There is no general-purpose HTTP client in the app. HTTP/HTTPS probes open a
plain `TcpStream` and speak the request themselves (`crates/coreview-probe`),
with `rustls` for TLS. There is no library sitting there that could be pointed
at an arbitrary URL.

### Where your data lives

| | |
| --- | --- |
| Database | `%LOCALAPPDATA%\Coreview\coreview.db` on Windows; the XDG data directory elsewhere |
| Config backups | A folder **you** choose, or nowhere until you choose one |
| Exports | A folder you choose, or a save dialog each time |

One SQLite file holds projects, diagrams, validation sessions and events. The
About dialog prints the exact path on the running machine. Back it up, copy it
to another machine, or delete it — it is an ordinary file and it is yours.

### Credentials

Two modes, and the safe one is the default:

- **Session credentials** — typed for one run, held in memory, gone when the app
  closes. Nothing is written to disk.
- **The encrypted vault** — for when you are backing up ninety devices and do
  not want to retype a password ninety times. Argon2id derives a key from your
  passphrase; secrets are sealed with XChaCha20-Poly1305.

Three properties the vault is built to hold:

1. **A stored secret never leaves Rust** — not in an IPC response, not in a log
   line, not in an error. The UI saves a credential and thereafter refers to it
   by id. A hidden field is a rendering choice, and rendering choices are one
   devtools window away from not applying.
2. **The passphrase is never stored.** It derives a key and is discarded.
   Forgetting it means re-entering the credentials; there is no recovery path,
   because a recovery path is a second way in.
3. **A wrong passphrase fails rather than producing rubbish** — authenticated
   encryption refuses, it does not decrypt to nonsense.

### What is in a file you share, and what is not

A `.coreview` project export contains the **diagram and its metadata** — the
package is `meta` plus the document JSON, and nothing else.

It does **not** contain credentials, and it does **not** contain device
configuration backups. Backups are written to a separate folder you nominate,
one folder per device, and the export path never reads it — so a running-config
with SNMP communities and password hashes in it cannot ride along inside a
diagram you email to someone. There is a test asserting a capture path cannot
escape the backup folder.

Be clear-eyed about what a diagram *does* hold, though: **the things you typed
into it.** Hostnames, IP addresses, site names, port numbers, your notes. That
is customer information, and sharing the file shares it. Coreview keeps secrets
and configs out; it cannot keep out the topology, because the topology is the
document.

### What this does not protect you from

Stated so the list above is not mistaken for more than it is:

- The database is **not** encrypted at rest. Disk encryption is the operating
  system's job. Anyone with your user account has your projects.
- The app has no permissions model. If you can open it, you can use all of it.
- CSV and Markdown exports are plain text by design.
- Coreview is unsigned on macOS and Linux (Windows builds are signed when a
  certificate is configured). See the macOS note below.

---

## Install

Builds for all three platforms are produced by CI on every push. Download from
the **Actions** tab → a green run → **Artifacts**.

| Platform | Artifact | Contents |
| --- | --- | --- |
| Windows | `coreview-windows` | NSIS `.exe` and `.msi` |
| Windows, no internet at install time | `coreview-windows-offline` | Same, with the WebView2 runtime embedded (~500 MB) |
| macOS | `coreview-macos` | Universal `.dmg` — Apple Silicon and Intel |
| Linux | `coreview-linux` | `.deb` and AppImage |

### macOS: the "damaged" warning

The `.dmg` is unsigned and un-notarised, so macOS quarantines it and reports:

> "Coreview" is damaged and can't be opened. You should move it to the Bin.

**It is not damaged.** That is Gatekeeper refusing an app whose developer it
cannot verify. After dragging it to Applications:

```sh
xattr -dr com.apple.quarantine /Applications/Coreview.app
```

Right-click → Open works on some macOS versions and not others; the `xattr`
line works on all of them. See `docs/HANDOVER.md` §6.8.

### Linux

The `.deb` declares `iputils-ping` and `traceroute` as dependencies. The
AppImage carries its own WebKit — there is a CI job that boots it in a
container with no `libwebkit2gtk` installed specifically to prove it.

---

## What it does

**Diagram.** Infinite canvas, pan and zoom, grid and snap, minimap, marquee
selection, undo/redo, autosave, alignment and distribution, grouping, layers.

**Pages.** Several independent drawings in one project, as tabs along the
bottom — a rack elevation and a logical topology are two diagrams, not two
views of one. Monitoring is project-wide regardless of which page draws a
device.

**Views.** Saved visibility filters over one page — physical, logical, "the
change on Saturday" — so three documents that disagree within a fortnight do
not happen.

**Shapes.** A built-in library of 217 shapes including the bundled Cisco
stencil pack, plus your own folder of SVGs, plus shapes captured from the
canvas back into the project's own library. The core device icons are drawn
in-repo as SVG. A bundled stencil pack can be removed from the installed copy
to reclaim its disk space.

**Links.** Connect anywhere around a shape — the line meets a device on the
bearing to the device at the other end, not one of four fixed handles, and
follows as either end moves. Three independently editable labels per link
(source port, centre, target port), each draggable along the line; path type,
arrow caps, width, colour, line style, waypoints and line jumps.

```
[FGT-HQ-01] -- port3 / Po10 ==== 10 Gb LACP — VLANs 10,20,30 ==== Te1/0/48 / Po10 -- [CORE-SW-01]
```

**Probes.** ICMP, TCP connect, DNS, HTTP, HTTPS, or manual. Per probe: target,
interval, timeout, failure and recovery thresholds, warning latency, enable
toggle. Nodes hold multiple labelled addresses (`Management`, `Loopback0`,
`WAN1`). `Test now` runs one check and starts nothing.

**Link health rules.** Manual, follow source, follow target, both endpoints
healthy, dedicated probe, or a named probe on a chosen node. The inspector and
the tooltip both say which rule is driving the line.

**Live view.** Healthy links carry dots along the real SVG path; warning is
amber and slower; down is red, dashed and still. Every status is paired with a
glyph (`✓ ! ✕ ? – ⚙`) so colour is never the only signal. A global Reduce
motion switch stops all animation. A per-device status history strip you can
scrub for the exact time and state, and click to enlarge.

**Discovery, when you ask for it.** Ping sweep over a range you type, which
resolves each answering address back to its name the way `ping -a` does, so
the hosts you add to the diagram arrive named rather than as a page of
numbers; a crawl
over SSH (or Telnet, if you choose it, or SNMP for read-only identification)
that reads LLDP/CDP neighbours, MAC tables and etherchannel membership to
propose a topology; config backups on demand, with diffs between captures.
Observation, not inference — a bundle is read from the device, not guessed.
A crawl merges into the diagram you already have rather than drawing a second
copy beside it; a re-crawl then reports what it found that your diagram does
not say — a switch that has gone, a link that now lands on a different port —
because folding those in silently would turn change detection back into
drawing.

**Import.** A Coreview project package, a CSV of devices, or a Visio `.vsdx`
drawing. The `.vsdx` reader turns a drawing into devices and links rather than
into a picture — see below for exactly what it reads. All three are parsed on
this machine; nothing is uploaded to convert anything.

**Evidence.** Event timeline with filters, CSV of every state transition,
Markdown validation report, and diagram export to SVG, PNG, native PDF and
Visio `.vsdx`.

---

## What the Visio importer reads

A `.vsdx` is a ZIP of XML, so it is read directly — no Visio, no converter, no
service. The structure gives the shapes and which-connects-to-what. It does
*not* say which piece of text is a device name, which is an address and which
is an interface, because that is a house style rather than a standard. So the
reader works down a list, most reliable first, and shows you everything before
anything is drawn.

**Nothing is added until you press "Add to diagram",** and the preview is
fully editable: rename a device, correct an address, change its type, fix
which devices a link joins, correct a port, remove what does not belong, add
what the drawing left out. What is on screen is what lands on the canvas.

### Device name

1. **The shape's own text**, unless it reads as an interface (`Gi0/0/1`) or as
   a pair of them (`Gi0/0/1 <> Gi2/0/24`). Neither is ever taken as a name — a
   device must not end up named after the cable plugged into it.
2. **The nearest text block that could be a name**, within 1.5 inches of the
   shape's *edge* rather than its centre. One caption belongs to one device:
   every candidate pairing is ordered by distance and taken shortest-first, so
   two devices drawn close together do not both claim the same label.
3. **The Visio master name** (`ASA 5500`, `Workgroup switch`) — the fallback
   you see when a drawing never captions a shape.

### Address

Any IPv4 address in that same caption, so a caption of the form
`EDGE-FW-01 192.0.2.10` yields both the name and the address. Where a caption
holds several, the first becomes the device's address and the rest are kept in
its notes.

It has to be separated from the name. A run-together caption is left unread on
purpose: `vpn01192.0.2.50` could be `vpn01` + `192.0.2.50` or `vpn011` +
`92.0.2.50`, and nothing decides between them. An imported address becomes a
monitoring target, so a wrong one is worse than a missing one — it would check
the wrong host and report green for a device that is down.

### Ports

1. **Shape Data on the connector** — `Port_A_Port_Name` / `Port_B_Port_Name`,
   or `Port_A` / `Port_B`. This is stated rather than inferred and beats every
   heuristic below. If you can add it in Visio, it is the single change that
   makes port import exact.
2. **The connector's own label**, when it names both ends at once — split on
   `<>`, `<->`, `--` or `->`.
3. **A floating pair label** within 0.75 inches of the connector's *line*.
   Distance is measured to the whole run rather than its midpoint, because a
   long connector often carries its label near one end.
4. **A single interface label** within 0.9 inches of each end.

Both ends are written onto the link, and the pair is written along the middle
of the line as a centre label as well.

### Links

**Glue is authoritative.** A connector glued to a shape in Visio produces a
`<Connect>` entry and the link is certain. Each end is resolved on its own, so
a line glued at one end and merely touching at the other is still imported —
the unglued end resolves to the nearest device within 1.2 inches, and the
preview says how many links were worked out that way, so those can be checked
rather than trusted. An end far from anything stays unresolved: inventing a
device for it would be worse than dropping the line.

**Line colour** is carried across where the drawing states one, so a diagram
that colours carrier circuits differently from fibre runs still does after
importing.

### Device type, model and inventory

The Visio master name gives the type — router, firewall, core or access
switch, wireless controller, access point, server, storage — and is kept
verbatim as the model, including part numbers such as `N9K-C93180YC-EX Front`.
Rack-mounted equipment is recognised as equipment: the rack-unit stencils are
one-dimensional shapes carrying begin/end geometry exactly as a connector
does, and the two are told apart by whether that geometry *is* the shape's own
box.

Any Shape Data the drawing carried is kept: `Manufacturer` becomes the
device's vendor, `Room` becomes its rack, and the rest goes to its notes.

### Layout

Positions come from the drawing. Visio measures in inches from the bottom-left
and places a shape by its centre; the canvas measures in pixels from the
top-left. Each shape's own width and height are used where the drawing states
them, and the scale is taken from the drawing rather than fixed, so a rack of
switches stacked a fifth of an inch apart arrives stacked rather than piled.
One Coreview page is created per Visio page.

### What it will not do

Invent. A device the drawing never named arrives under its master name; a link
whose ports were never labelled arrives without ports; and a drawing that
glues nothing produces its devices plus a plain statement that its connections
cannot be read, rather than a guessed topology.

### Limits

`.vsdx` only. `.vsd` is the pre-2013 binary format and carries none of this
structure — re-save it as `.vsdx` first. Exports from some tools, Lucidchart
among them, contain no glue at all, so their links cannot be read; their
devices still import.

---

## Build from source

### Prerequisites

- [Node.js](https://nodejs.org) 20
- [Rust](https://rustup.rs) stable
- **Windows:** Visual Studio C++ Build Tools + Windows SDK; WebView2 runtime
  (already on Windows 11 and current Windows 10)
- **Linux:** `libwebkit2gtk-4.1-dev libsoup-3.0-dev libssl-dev libxdo-dev
  libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file
  pkg-config`
- **macOS:** Xcode command line tools

### Develop

```sh
npm install
npm run tauri dev
```

`npm run dev` runs the frontend alone in a browser, which is useful for UI
work. There is no backend in that mode: projects go to browser storage and
probing is unavailable. The app says so in a banner rather than pretending.

### Test

```sh
npm test            # frontend — 520 tests
npm run typecheck   # TypeScript, strict
npm run lint        # ESLint
npm run rust:test   # probe engine + app backend
cargo test --workspace   # all three crates — 447 tests
```

967 automated tests in total. Note that `npm run rust:test` covers the probe
engine and the app backend but not `coreview-discover`; `cargo test
--workspace` is the one that runs everything.

CI runs the suites on Ubuntu and Windows, then bundles for all three
platforms — plus a job that boots the AppImage in a container with no WebKit
installed, to check it really carries its own.

### Build installers

```sh
npm run tauri build
```

Tauri filters bundle targets by host platform, so each machine produces its
own: `.deb` + AppImage on Linux, NSIS + MSI on Windows, `.app` + `.dmg` on
macOS. Cross-compiling between platforms is not supported — that is why CI has
a job per platform.

---

## Security model, in detail

- **Probe targets are validated before they can reach a process argument, a
  socket or the resolver** (`crates/coreview-probe/src/validate.rs`). Shell
  metacharacters, whitespace, quotes, control characters and leading dashes are
  rejected. Unit tests cover the injection cases directly.
- **`ping` is invoked with an argument vector.** No `cmd.exe`, no PowerShell, no
  string interpolation, and no shell plugin in the capability set.
- **The IPC surface is 53 named commands.** No generic execute.
- **File access is mediated by Rust**, and writes go only to a path or folder
  chosen in a native dialog. A capture path cannot escape the backup folder,
  and a stencil pack name cannot escape the stencils folder — both asserted by
  tests.
- **Secrets never cross the IPC boundary.** The vault returns ids, not
  plaintext.
- **CSV export prefixes cells starting with `=`, `+`, `-` or `@`** with an
  apostrophe, so an imported device name cannot execute as a spreadsheet
  formula.
- **`open_external_url` accepts only `http://` and `https://`** and is tested
  against `file://` and `javascript:`.

---

## What a green link actually proves

A passing check proves that *this machine* reached *that target* with *that
method* at *that moment*. It does not prove every drawn hop in the path is
healthy, and it does not prove end-to-end application traffic. Link colour
follows the rule you selected for that link.

The app states this in the About dialog, the link inspector and every exported
report. It is the difference between a monitoring tool and a reassurance
machine.

---

## Known limitations

- No NetFlow, sFlow, IPFIX or vendor-API polling. Deliberate non-goals — see
  `docs/ROADMAP.md`. SNMP exists, but only to identify a device during a crawl,
  not as a monitoring transport: probes are ICMP/TCP/DNS/HTTP(S).
- Drawing exports (SVG/PNG/PDF/Visio) cover the **active page**. CSV and the
  Markdown report are project-wide, because an inventory silently missing
  devices would be a nastier surprise than a diagram of one page.
- The Visio export writes a single-page `.vsdx`, and glues connectors to one of
  four sides rather than carrying the on-canvas bearing.
- macOS and Linux builds are unsigned.
- The database is not encrypted at rest.

---

## Documentation

- `ARCHITECTURE.md` — structure, data model, probe lifecycle, security boundaries
- `docs/ROADMAP.md` — every request, what shipped, and where what shipped
  differed from what was asked
- `docs/DECISIONS.md` — the decisions and why, including the ones reversed
- `docs/HANDOVER.md` — traps that have actually bitten, and how to verify by hand
- `docs/USER_GUIDE.md` — how to use it
- `docs/PROBE_BEHAVIOR.md` — exact threshold and state-machine behaviour
- `docs/TEST_PLAN.md` — the required cases, mapped to automated or manual tests
