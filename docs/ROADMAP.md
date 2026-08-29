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
- [ ] **Verify against Cisco Nexus (NX-OS)** — parsers were written and tested
      against IOS and IOS-XE only
- [ ] **Verify against Catalyst 9000 / IOS-XE 17** CDP and LLDP output
- [ ] FortiSwitch over SSH — reachable at 192.168.14.203 for testing
- [ ] Merge SNMP-only devices into the topology by neighbour identity, so a
      switch that answers SNMP but refuses SSH still lands in the right place
      rather than as an island

## Next — reaching more devices

- [ ] **Backup credentials**: a second username and password tried when the
      first is rejected, as the reference scripts do. Common where a site is
      mid-migration between TACACS realms
- [ ] **Telnet transport**: `russh` is SSH-only, so this is a new transport,
      not a flag. Wanted for old gear that has nothing else. Must be opt-in
      per run and say plainly that credentials cross the network in clear text
- [ ] LLDP-only devices: use chassis-id/port-id when a system name is absent
- [ ] ARP and MAC-address-table sweep for endpoints that advertise nothing,
      the way the FortiGate reference script does with `get system arp`
- [ ] MAC OUI lookup to name and classify unmanaged devices

## Then — the diagram itself

- [ ] Manual re-layout that survives a re-crawl: re-running discovery should
      update a diagram, not replace it
- [ ] Group by site or subnet, using the grouping that already exists
- [ ] Link aggregation: draw a port-channel as one link that says how many
      members it has

## Packaging and trust

- [x] Windows installer down from 500 MB to 7 MB (WebView2 bootstrapper)
- [x] Offline installer as a separate artifact for air-gapped machines
- [ ] **Authenticode signing.** A certificate exists. Needs: confirmation of
      whether it chains to a public CA or an internal one, the thumbprint, and
      the PFX plus its password as GitHub secrets. An internal CA removes the
      "unknown publisher" text only on machines that trust that CA — it does
      not clear SmartScreen for anyone else

## Verified against real hardware

Recorded because it is the only evidence that counts.

| Device | What was proved |
| --- | --- |
| Cisco C2960CX (192.168.14.7) | SSH login, CDP and LLDP, config backup, SNMP v2c and v3, six neighbours found and linked |
| Ubiquiti USL8L (192.168.14.112) | SNMP v2c identity; refuses SSH, which the crawl reports rather than hides |
| Palo Alto PA-220 (192.168.14.206) | SNMP v2c identity, classified as a firewall |
| FortiGate (192.168.14.195) | Not answering on 161 — the error now says what to check |
| FortiAP U431F ×2 | Classified as access points from LLDP platform |

## Not doing, and why

- **Agent on the device.** The whole point is that it reads what is already
  there over protocols a network engineer already allows.
- **Cloud sync.** No account, no telemetry, everything on the machine.
- **Writing configuration.** It reads and diagrams. A tool that can also
  change things is a different tool with a different risk profile.
