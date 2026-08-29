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
- [ ] Merge SNMP-only devices into the topology by neighbour identity, so a
      switch that answers SNMP but refuses SSH still lands in the right place
      rather than as an island

## Next — reaching more devices

- [x] **Backup credentials**: a second login, tried only where the first is
      rejected. Not on a timeout or a refused connection — a second password
      cannot help there, and on a locking account policy it would do harm.
      Proved against the real Cisco with a deliberately wrong first password

- [ ] **Resolve a neighbour that advertises no address.** This is what now
      blocks the test network. The FortiSwitch is seen by the Cisco on Gi0/9
      and classified correctly, but advertises no management address, so the
      crawl has nowhere to connect and no credential can help. The switch that
      sees it does know: the LLDP chassis-id is a MAC, and `show ip arp` or
      `show mac address-table` maps that MAC to an address. This is what the
      FortiGate reference script does with `get system arp`. Doing it would
      turn "seen only" into "reached" for a whole class of devices
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
| FortiSwitch 224E (192.168.14.203) | SSH via the FortiOS command set — classified Switch, platform FortiSwitch-224E, and its LLDP neighbour HOME-MAIN-SW on port24. SNMP v3 identity too |

## Not doing, and why

- **Agent on the device.** The whole point is that it reads what is already
  there over protocols a network engineer already allows.
- **Cloud sync.** No account, no telemetry, everything on the machine.
- **Writing configuration.** It reads and diagrams. A tool that can also
  change things is a different tool with a different risk profile.
