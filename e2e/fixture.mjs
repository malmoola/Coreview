// A project for the harnesses that need one to look at.
//
// Three of these scripts took a package file as argv[2] and threw an unhandled
// TypeError with no explanation when run without one, so the suite could not
// be run as a smoke test — you had to already know each script's arguments.
// They now fall back to this. Pass a path to use a real project instead.
//
// Documentation addresses throughout (RFC 5737), no real equipment names: this
// file is in the repository and everything in it is invented.
import { readFileSync } from "node:fs";

const NOW = 1756000000000;

const device = (id, x, y, label, deviceType, address, over = {}) => ({
  id,
  type: "device",
  position: { x, y },
  width: 76,
  height: 76,
  data: {
    label,
    deviceType,
    tags: [],
    addresses: address
      ? [{ id: `${id}-a`, label: "Management", address, isPrimary: true }]
      : [],
    locked: false,
    maintenance: false,
    showDetails: true,
    ...over,
  },
});

const link = (id, source, target, sourcePort, targetPort, over = {}) => ({
  id,
  source,
  target,
  type: "live",
  data: {
    sourcePortLabel: sourcePort,
    targetPortLabel: targetPort,
    label: sourcePort && targetPort ? `${sourcePort} <> ${targetPort}` : "",
    pathType: "smoothstep",
    direction: "none",
    width: 2,
    color: "#7c8fa3",
    enabled: true,
    maintenance: false,
    healthRule: { type: "both-endpoints" },
    ...over,
  },
});

/** A small branch topology: internet, edge, firewall, core, two access. */
export const fixturePackage = {
  meta: {
    id: "e2e-fixture",
    name: "Harness fixture",
    customer: "Example Customer",
    site: "Example site",
    ticket: "CHG-0001",
    engineer: "Operator",
    description: "",
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
  },
  documentVersion: 1,
  document: {
    pages: [
      {
        id: "page-1",
        name: "Page 1",
        nodes: [
          device("net", 400, 0, "Internet", "internet", ""),
          device("rtr", 400, 160, "EDGE-RTR-01", "router", "203.0.113.1", {
            vendor: "Example",
            model: "Model 1000",
            serial: "EXA1000A001",
          }),
          device("fw", 400, 320, "EDGE-FW-01", "firewall", "192.0.2.10", {
            serial: "EXA2000B002",
          }),
          device("core", 400, 480, "CORE-SW-01", "core-switch", "192.0.2.20"),
          device("acc1", 240, 640, "ACC-SW-01", "access-switch", "192.0.2.31"),
          device("acc2", 560, 640, "ACC-SW-02", "access-switch", "192.0.2.32"),
        ],
        edges: [
          link("e-wan", "net", "rtr", "", "Gi0/0/0"),
          link("e-edge", "rtr", "fw", "Gi0/0/1", "port1"),
          link("e-core", "fw", "core", "port2", "Te1/0/1"),
          link("e-acc1", "core", "acc1", "Te1/0/2", "Gi0/1"),
          link("e-acc2", "core", "acc2", "Te1/0/3", "Gi0/1"),
        ],
        canvas: {},
      },
    ],
    activePageId: "page-1",
    probes: [],
  },
};

/** The package this run should use: the file named on the command line, or
 *  the fixture above. */
export function packageFromArgv(index = 2) {
  const path = process.argv[index];
  return path ? JSON.parse(readFileSync(path, "utf8")) : fixturePackage;
}
