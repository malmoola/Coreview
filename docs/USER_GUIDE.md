# User guide

## Create a project

Open Coreview and choose **Create project**. Fill in the name, and — because
these end up in the exported report — the customer, site, change ticket and
engineer. You can edit all of it later: click empty canvas and the inspector
shows project fields.

To see the app working immediately, pick one of the three samples instead. They
use documentation address ranges plus loopback, so one node comes up healthy and
the rest go down. That is the point: you get both states without touching a live
network.

## Draw

Drag anything from the left palette on to the canvas. Drop it, then click it and
rename it in the inspector.

- **Resize** — select an object and drag a corner handle.
- **Connect** — hover a node, drag from one of the four dots to another node.
- **Multi-select** — drag on empty canvas, or Shift-click.
- **Pan** — middle-drag or right-drag. **Zoom** — scroll.
- **Right-click** anything for its menu.

Shortcuts: `Ctrl+S` save, `Ctrl+Z` undo, `Ctrl+Y` redo, `Ctrl+D` duplicate,
`Delete` remove, `F` fit view.

Autosave writes about two and a half seconds after you stop editing. The top bar
says either *Unsaved changes* or *Saved* with a time.

## Label a link

Select a link. The inspector gives you three separate fields:

- **Source port label** — the interface at the near end, e.g. `port3 / Po10`
- **Centre label** — what the link is, e.g. `10 Gb LACP — VLANs 10,20,30`
- **Target port label** — the interface at the far end, e.g. `Te1/0/48 / Po10`

Below that: path type, flow direction, width, notes and the health rule.

## Add addresses and probes

Select a node. Under **Addresses**, add one row per address with a friendly
label — `Management`, `Loopback0`, `WAN1`. Mark one primary.

Under **Probes**, click **Add probe** and set:

| Field | What it does |
| --- | --- |
| Type | ICMP ping, TCP port connect, DNS resolution, or manual |
| Target | IPv4, IPv6 or a hostname. Internal single-label names are fine. |
| Port | TCP only |
| Interval | Seconds between checks. Default 5. |
| Timeout | Milliseconds to wait. Default 1000. |
| Warn above | RTT in milliseconds that turns a passing check amber. Default 100. |
| Fail after | Consecutive failures before the object goes red. Default 3. |
| Recover after | Consecutive successes needed to leave red. Default 1. |

Press **Test now** to run that check once. It runs once and stops. It does not
start monitoring.

## Choose what each link means

This is the part worth being deliberate about. Select a link and pick a health
rule:

| Rule | Use it when |
| --- | --- |
| Manual — no monitoring | The line is documentation, not a check |
| Follow source node status | The near device is what you actually care about |
| Follow target node status | The far device is |
| Both endpoints must be healthy | You want the line red if either end drops |
| Dedicated probe target | The link has its own address to test — a transit IP, a far-side loopback |
| Follow a named probe on a node | A specific probe elsewhere is the real signal |

The inspector shows the rule in plain language, and so does the tooltip when you
hover a link.

## Start and stop validation

**Start validation** in the top bar begins checking every enabled probe in the
open project. The state pill shows *Running* and the counts fill in.

**Stop validation** ends it. So does closing the project, and so does closing
the window. Nothing survives in the background.

While a session runs, statuses are live. When it stops, everything returns to
unknown — a status from a stopped session is not evidence.

## Read the canvas

| State | Node | Link | Motion |
| --- | --- | --- | --- |
| Healthy `✓` | Green badge | Green line | Green dots moving |
| Warning `!` | Amber badge | Amber line | Slower amber dots |
| Down `✕` | Red badge | Red dashed line | Stopped, one static dot |
| Unknown `?` | Grey | Grey line | None |
| Disabled `–` | Muted | Dotted | None |
| Maintenance `⚙` | Purple | Purple dashed | None |

Every state has a glyph as well as a colour, so nothing depends on colour alone.
Turn on **Reduce motion** in the top bar to stop all animation.

Hover a link for the detail:

```
Health: Healthy
Rule: Dedicated ICMP probe
Target: 10.50.10.1
Last result: Reply, 2 ms
Last updated: 19:11:22
```

## What this proves, and what it does not

Every check runs from the Windows machine Coreview is on. A green node means
that machine reached that address with that method just now. It does not mean
every hop drawn between them is healthy, and it does not mean application
traffic works. Link colour follows the rule you chose. Keep that in mind before
pasting a screenshot into a change record.

## Export evidence

The **Export** menu gives you:

- **Diagram as PNG / SVG** — includes a title block with project, customer,
  site, ticket, engineer, timestamp, and a status legend
- **Print / save as PDF** — opens the print dialog with the canvas only
- **Events as CSV** — every state transition with timestamp, object, target,
  probe type, RTT and the failure text
- **Validation report (Markdown)** — project metadata, object counts, status
  summary and the full transition table
- **Project package (.coreview)** — the whole project, importable elsewhere

## Move a project to another machine

Export the `.coreview` package, copy it over, and use **Import project** on the
welcome screen. Diagram, metadata, probes and health rules come across. Event
history does not — it stays with the machine that recorded it.
