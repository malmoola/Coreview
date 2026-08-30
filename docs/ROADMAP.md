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
- [ ] **Telnet transport**: `russh` is SSH-only, so this is a new transport,
      not a flag. Wanted for old gear that has nothing else. Must be opt-in
      per run and say plainly that credentials cross the network in clear text
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
- [ ] Draw those attached devices on the diagram. The data is collected; what
      is missing is deciding how much of a flat network belongs on a picture
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
- [ ] Let the interval and failure threshold be set for the whole project
      rather than per probe, so "tell me within 5 seconds" is one setting

## Then — the diagram itself

- [x] **A re-crawl updates the diagram rather than drawing another copy of the
      network beside it.** A device found again keeps its node and the position
      someone put it in; a cable found again is not drawn twice; only what a
      crawl can newly establish is written, so a name corrected by hand
      survives. Verified by crawling the real network twice: the second run
      reported "Added 0 devices and 0 links. Updated 5 already on the diagram,
      keeping their positions" 
- [ ] Group by site or subnet, using the grouping that already exists
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
| FortiSwitch 224E (192.168.14.203) | SSH via the FortiOS command set — classified Switch, platform FortiSwitch-224E, and its LLDP neighbour HOME-MAIN-SW on port24. SNMP v3 identity too. Reached only because its address is resolved from its chassis id, and only with the second credential set — three features composing on one device |

## Not doing, and why

- **Agent on the device.** The whole point is that it reads what is already
  there over protocols a network engineer already allows.
- **Cloud sync.** No account, no telemetry, everything on the machine.
- **Writing configuration.** It reads and diagrams. A tool that can also
  change things is a different tool with a different risk profile.
