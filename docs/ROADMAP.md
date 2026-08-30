# Roadmap

What is done, what is next, and what is deliberately not being done. Kept in
the repository rather than in a chat so neither of us has to remember it.

Ordered by what makes the app more useful, not by what is easiest.

## Now — discovery and diagramming

- [x] Build a linked diagram from a crawl: nodes joined by discovered
      adjacencies, interface at each end, laid out by distance from the seed
- [x] Draw everything found, not just infrastructure — phones, printers,
      cameras, endpoints
- [x] Choose which classes to log in to **before** the run, so a connection
      attempt to a camera never happens by surprise
- [x] Short-form interface names, full names kept on the link
- [x] Cisco Nexus (NX-OS): CDP, LLDP and interface parsing all covered by
      tests against real NX-OS output, including its different labels
      ("Local Port id", one-line "Management Address", serial in the device id)
- [ ] **Verify against Catalyst 9000 / IOS-XE 17** CDP and LLDP output
- [x] FortiSwitch and FortiGate over SSH. They answer SSH and reject every
      IOS command, so the crawl used to log in and learn nothing but the
      hostname. Verified against a real FortiSwitch 224E: identity, model,
      interfaces and its LLDP neighbour table
- [x] A device reported under two names is one device. A switch reached over
      SNMP gives its sysName, which is not always what it advertises over
      LLDP — "Laundry-SW" against "USW-Lite-8-PoE" — so entries are folded by
      address as well as by name, and links follow the fold rather than
      dangling

## Next — reaching more devices

- [x] **Backup credentials**: a second login, tried only where the first is
      rejected. Not on a timeout or a refused connection — a second password
      cannot help there, and on a locking account policy it would do harm.
      Proved against the real Cisco with a deliberately wrong first password

- [x] **Resolve a neighbour that advertises no address**, from the chassis id
      and the ARP table of the device that saw it. This unblocked the test
      network: the FortiSwitch advertises no address, its chassis id
      e81c.bac4.964b appears in the Cisco's ARP table as 192.168.14.203, and
      it is now reached, identified as a FortiSwitch-224E and linked both ways
- [x] **Telnet transport**, for equipment that offers nothing else. Opt-in per
      run — "SSH only", "SSH then telnet if nothing answers", or "Telnet only"
      — with the cost stated next to the choice rather than in a manual.
      Never falls back to telnet after a password is *rejected*: the account
      exists and the credentials are wrong, and sending them again in clear
      text would be worse than failing.

      **Never tested against a real telnet device** — everything on the test
      network runs SSH. Covered by unit tests for the option negotiation and
      by an end-to-end test against a server that answers the way a Cisco
      does. The same standing as Duo
- [x] A device that announces a name and no address is found by the port it is
      on: the switch learned exactly one address there, so the far end is what
      holds it. WORKSTATION1 on the test network is found this way and no
      other. A port carrying more than one address is left alone — the far end
      is another switch and choosing between them would be a guess
- [x] MAC-address-table and ARP are read on every device reached, and what
      they learn is on `CrawledDevice.attached`: every address seen on a port
      that has no discovery neighbour, with its maker. Nothing on the test
      network exercises it — every port there carries a device that announces
      itself — so the parser is verified against that switch's real output and
      the selection is covered by tests, but the end-to-end path is not
- [x] **Draw the silent devices you ask for.** Filtered by maker, subnet, port,
      or "only ports carrying one device" — a question about what someone is
      looking for rather than a count. Each hangs off the port it was learned
      on, labelled with the maker and never a guessed role, and drawn once
      however many switches saw its MAC through an uplink.

      Verified against the real network by temporarily relaxing the uplink
      rule to produce data: 38 devices from the switch's MAC table, filtering
      to 0 for Nokia, 2 for Ubiquiti and 6 for Fortinet. Nothing on that
      network qualifies under the real rule — every port there carries a
      device that announces itself — so the panel correctly does not appear
- [x] **MAC OUI lookup**, from the bundled IEEE registry — a device whose only
      identity is `7456.3c75.fcae` is drawn as "Ubiquiti device". The maker
      only: a vendor does not say what a device *is*, and guessing would put
      wrong glyphs on a diagram with no way to tell they were guessed. Costs
      1.4 MB of binary, halved by deduplicating the names

## Status honesty

- [x] **A device that stops answering looks different straight away.** With the
      default thresholds — a check every 5 seconds, 3 failures before a device
      is called down — something unplugged stayed solid green for fifteen
      seconds with nothing to say otherwise. The engine and both probe kinds
      were verified correct; the fault was that `consecutiveFailures` was
      tracked and only shown in the inspector. A missed check now shows on the
      node and in the table immediately, without claiming the device is down
      before the rule says so
- [x] **How long ago each result was confirmed**, in a Checked column. A green
      row looked identical whether it was confirmed a second ago or had not
      been re-checked since the session was paused. The clock only runs while
      a session does — with nothing being checked there is nothing to age
- [x] **One timing policy for the whole project.** "Tell me within fifteen
      seconds" is one decision, and setting it per probe across ninety devices
      is data entry, not a decision. Both numbers sit together in the project
      panel with their product spelled out — an interval and a threshold
      multiply, and people read them separately

## Then — the diagram itself

- [x] **A re-crawl updates the diagram rather than drawing another copy of the
      network beside it.** A device found again keeps its node and the position
      someone put it in; a cable found again is not drawn twice; only what a
      crawl can newly establish is written, so a name corrected by hand
      survives. Verified by crawling the real network twice: the second run
      reported "Added 0 devices and 0 links. Updated 5 already on the diagram,
      keeping their positions" 
- [x] **Group each subnet together**, from the canvas menu. A discovered
      diagram of a real estate is a lot of boxes, and the first thing anyone
      wants is to push each site into its own corner — this makes that one
      drag per site. /24, because that is what a site or a VLAN almost always
      is and a boundary you have to configure before you can tidy a diagram is
      one nobody uses. A subnet holding one device is left alone
- [x] **Tidy the layout**, from the canvas menu. Evens the spacing of a
      crawled diagram without rearranging it: whatever was above stays above,
      whatever was left stays left. Predictable matters more than optimal —
      an operator has to be able to press it without bracing. Locked devices
      are left where they are, and it says how many it moved
- [x] **Find a device**, Ctrl+F. Ranks name, then address, then model, tag
      and note; moves the view to the match and selects it. Zoom is left
      alone deliberately: someone who has zoomed out to see the shape of a
      site does not want a search to throw them back in
- [x] **Say what changed since the diagram was drawn.** A re-crawl merges
      silently, which is right when nothing moved and wrong when something
      did. Discover now reports devices that have gone, devices that are new,
      addresses that moved, and links that are no longer where they were
      drawn — a link that is both gone and new is a cable that moved port. It
      reports; drawing stays the operator's decision. Driven end to end by
      `e2e/change.mjs`, which stubs the Tauri bridge and delivers a crawl
      result the way the backend does
- [x] **Links swing round as devices move.** Everything a crawl drew left the
      bottom and arrived at the top, and stayed there: move the lower device
      out to the side and its link still dived off the bottom and climbed
      back. Now the side is chosen on every render, so a link faces wherever
      its devices have been dragged to, and swings back when they are dragged
      back. A node emits from its right and bottom only, so there are two
      legal pairs and the router picks the better one rather than the ideal
      one. It is a view — nothing is written while a node is being dragged, so
      the undo history does not fill with one entry per frame. A single link
      can be held to the sides it is on when it has been drawn the long way
      round on purpose
- [x] **A link can leave any of the four sides**, so the swing is a full turn
      rather than a choice between two pairs. React Flow finds a source handle
      only among source handles even in loose mode, so every side is declared
      as one and loose connections let a source also be an end. Drawing a link
      by hand still works, and a device cannot be linked to itself
- [x] **Links leaving the same side take different lanes**, so six access
      switches under one core no longer run their cables along the same line
- [x] **Pointing at a link fades the others.** On a meshed diagram links
      necessarily cross and no routing removes that, but only one has to be
      readable at a time. Edge labels no longer swallow the pointer — the one
      place you would naturally aim was the one place hovering did nothing
- [x] **A link can carry its own colour** — a fibre run, a carrier circuit —
      while the travelling dots, the halo, the arrowheads and the dash pattern
      keep reporting health, so a purple link that is up still reads as up
- [x] **Edit a whole selection at once.** A crawl puts dozens of devices down
      in one go. A value the selection disagrees on reads "mixed" rather than
      showing the first one, tags are split into those everything carries and
      those only some do — only the first can be removed — and the whole
      change is one undo
- [x] **Fold a site down to one box.** A view, not a document change, so
      opening restores exactly what was there. Links crossing the boundary are
      redrawn to the box and collapsed to one line each; links inside go with
      it. Named after a tag every member shares, ignoring the ones the crawler
      writes about how it found something
- [x] **What a device's status has been**, not just what it is — rebuilt from
      recorded transitions rather than a stored sample per device per
      interval. A period nobody was watching is drawn as unknown rather than
      filled in with whatever the device is doing now
- [x] **Export the diagram as the CSV the importer reads back.** Import
      existed and export did not, which made it a one-way door. Two files,
      devices and links, in exactly the columns the importers read. Positions
      are left out on purpose: a CSV is an inventory, and the project package
      is the format that keeps a layout
- [ ] **Link aggregation: draw a port-channel as one link.** Attempted and
      reverted. Collapsing links whose ports are consecutive infers a bundle
      from port numbering, and two consecutive cables between a pair are just
      as likely as an aggregation — the app would be asserting something it
      cannot observe, which is the one thing it is not supposed to do.

      Doing it properly means asking the device: `show etherchannel summary`
      lists each port-channel and its members. The command exists on the test
      switch and reports "Number of channel-groups in use: 0", so there is no
      populated table to write a parser against. **Configure a port-channel on
      the lab switch — two ports is enough — and this becomes a morning's
      work with real output to verify against.**

## Drawing, and being a diagram tool

The bar here is Lucidchart and Visio, on the drawing side, without giving up
the half neither of them has: a diagram that is pointed at real addresses and
watches them.

- [x] **Sections** — a labelled area that holds whatever stands in it.
      Membership is geometric and recomputed, so nothing is re-assigned when a
      device is dragged in
- [x] **Line jumps** where one link crosses another, sized to the line, one per
      crossing pair
- [x] **Link properties**: solid, dashed, dotted or dash-dot; six thicknesses;
      arrow, open arrow, circle, square, diamond or nothing at each end; and a
      colour of its own while health keeps the dots and the arrowheads
- [x] **A white ground** for a document or a projector, with every colour
      chosen against it rather than inverted
- [x] **Shape import** from PowerPoint stencil decks, Visio 2013+ stencils,
      zips and folders, named from the source and grouped by family
- [x] **The icon library reads folders of folders**, and says how many files it
      could not read instead of reporting an almost empty library
- [ ] **Legacy binary `.vss`** — Visio 2003 to 2010 — is a compound file rather
      than a zip. `libvisio-tools` can read them; it is not installed here and
      installing it is the operator's call. Everything else in a shape folder
      already imports
- [ ] **Shapes with their own connection points.** An imported vendor shape is
      a picture; a Visio master carries named ports. Reading those would let a
      link land on "Gi0/1" rather than on the right-hand side
- [ ] **Text on the canvas that is not a node** — headings, legends, callouts
      with a leader line
- [ ] **Snapping and alignment guides.** Drag a device and have it line up with
      its neighbours, with the guide shown
- [ ] **Layers**, so a physical view and a logical view can share one document
- [ ] **A shape library that travels with the project**, so a diagram opened on
      another machine is not missing its artwork

## Packaging and trust

- [x] Windows installer down from 500 MB to 7 MB (WebView2 bootstrapper)
- [x] Offline installer as a separate artifact for air-gapped machines
- [x] **Authenticode signing wired up.** Both Windows artifacts are signed
      when `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` are set,
      and build unsigned when they are not. See `docs/SIGNING.md`
- [ ] Add those two secrets. The certificate is issued by COREVIEW-FGT-Root-CA,
      an internal CA, so this names the publisher and proves the installer is
      unaltered **on machines that trust that root** — it does not clear
      SmartScreen for anyone else, and cannot. That needs an OV/EV certificate
      from a public CA, which since 2023 must be signed from an HSM

## Verified against real hardware

Recorded because it is the only evidence that counts.

| Device | What was proved |
| --- | --- |
| Cisco C2960CX (192.168.14.7) | SSH login, CDP and LLDP, config backup, SNMP v2c and v3, six neighbours found and linked |
| Ubiquiti USL8L (192.168.14.112) | SNMP v2c identity; refuses SSH, which the crawl reports rather than hides |
| Palo Alto PA-220 (192.168.14.206) | SNMP v2c identity, classified as a firewall |
| FortiGate (192.168.14.195) | Not answering on 161 — the error now says what to check |
| FortiAP U431F ×2 | Classified as access points from LLDP platform |
| FortiGate-60F 7.6.7 (192.168.14.1) | SSH login on a read-only profile — which needed the prompt finder to accept FortiOS's `$`, without which the device was unreachable entirely. 44 named endpoints from `execute dhcp lease-list` across four networks, the FortiSwitch it manages, and three FortiAPs, two of them cabled to Laundry-SW on Port 3 and Port 2. `diagnose` is refused on this profile, so the device store is unavailable and the lease list is what runs |
| Ubiquiti Laundry-SW (UBNT-USL8L) | Found only through a FortiAP's LLDP block, by name, chassis MAC and socket. It speaks no CDP and the crawl cannot log into it |
| FortiSwitch 224E (192.168.14.203) | SSH via the FortiOS command set — classified Switch, platform FortiSwitch-224E, and its LLDP neighbour HOME-MAIN-SW on port24. SNMP v3 identity too. Reached only because its address is resolved from its chassis id, and only with the second credential set — three features composing on one device |

## Not doing, and why

- **Agent on the device.** The whole point is that it reads what is already
  there over protocols a network engineer already allows.
- **Cloud sync.** No account, no telemetry, everything on the machine.
- **Writing configuration.** It reads and diagrams. A tool that can also
  change things is a different tool with a different risk profile.
