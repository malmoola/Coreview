# Open questions

Things deferred, or needing a decision that is not mine to make. Each one moves
to ROADMAP.md or DECISIONS.md when it is answered.

*Closed: Q-002 (where converted stencils live) — answered 2026-08-30, see
D-019.*

---

### Q-001 — Install `libvisio-tools` for legacy `.vss`?
Raised 2026-08-30. `.vss` from Visio 2003–2010 is a compound binary file that
nothing here can open; `libvisio-tools` reads it. Installing a system package
is not a call I should make on your machine. Deferred by you the same day
("Skip the .vss for now"), so this is only live again if the `.zip` twins in
your shape folder turn out not to cover the same sets. See LT-012.

### Q-003 — What should the page default to?
Raised 2026-08-30 by LT-008. The spec says 1584x1224 (11x8.5in @ 144dpi),
which is Letter landscape. The export already has its own page-size menu with
A4 as an option. Should the canvas page follow the export page setting, or stay
a fixed size regardless?

### Q-004 — Does the page apply to every project or only new ones?
Raised 2026-08-30 by LT-008. Existing diagrams have devices at coordinates that
predate any page and may sit outside 1584x1224. Options: put the page under
them wherever they are, grow the page to contain them, or show the page only on
new projects.

### Q-005 — Re-sourcing the 27 remote Lucid shapes
Raised 2026-08-30 by LT-006 and D-018. They will be listed in
`stencils/lucid/unresolved.json` with their urls. Fetching them from
`images.lucid.app` is possible but they are somebody else's artwork under
somebody else's terms. Do you want them fetched, or replaced from the Tabler /
Simple Icons set, or left out?

### Q-006 — Catalyst 9000 and a lab LAG
Raised 2026-08-29, still open. LT-009 and LT-010 are both blocked on hardware
access rather than on work. Two bonded ports on the test switch and an hour
against a Catalyst would clear both.

### Q-007 — Is the root `ROADMAP.md` still wanted?
Raised 2026-08-30. There are two roadmap files and they had drifted apart.
`docs/ROADMAP.md` is now authoritative. Delete the root one, or leave it as a
one-line pointer? See LT-025.
