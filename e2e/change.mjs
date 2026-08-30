// Drives the change report against the real panel.
//
// The diff itself is unit-tested. What those tests cannot show is that a crawl
// result actually reaches the report and renders — that path runs through the
// Tauri event bridge, which does not exist in a browser. So the bridge is
// stubbed here and a crawl result is delivered exactly the way the backend
// delivers one. Everything above the stub is the real application.
//
//     npm run dev            # in another terminal
//     node e2e/change.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

// A diagram drawn from an earlier crawl: two switches, one link.
const project = {
  meta: {
    id: "change-fixture", name: "Change fixture", customer: "", site: "", ticket: "",
    engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false,
  },
  documentVersion: 1,
  document: {
    nodes: [
      { id: "n1", type: "device", position: { x: 0, y: 0 }, width: 176, height: 96,
        data: { label: "CORE-SW", deviceType: "core-switch", tags: ["discovered"],
          addresses: [{ id: "a1", label: "Management", address: "10.0.0.1", isPrimary: true }],
          locked: false, maintenance: false, showDetails: true } },
      { id: "n2", type: "device", position: { x: 0, y: 260 }, width: 176, height: 96,
        data: { label: "ACC-SW", deviceType: "access-switch", tags: ["discovered"],
          addresses: [{ id: "a2", label: "Management", address: "10.0.0.2", isPrimary: true }],
          locked: false, maintenance: false, showDetails: true } },
      { id: "n3", type: "device", position: { x: 300, y: 260 }, width: 176, height: 96,
        data: { label: "OLD-SW", deviceType: "access-switch", tags: ["discovered"],
          addresses: [{ id: "a3", label: "Management", address: "10.0.0.9", isPrimary: true }],
          locked: false, maintenance: false, showDetails: true } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", sourceHandle: "b", targetHandle: "t", type: "live",
        data: { sourcePortLabel: "Gi1/0/1", targetPortLabel: "Gi0/1", label: "",
          pathType: "smoothstep", direction: "forward", width: 2, color: "#2fbf6b",
          enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } },
    ],
    probes: [], canvas: {},
  },
};

const neighbor = (name, local, remote, ip) => ({
  deviceId: name, shortName: name,
  addresses: ip ? [{ ip, interface: null, isManagement: true }] : [],
  localInterface: local, remoteInterface: remote, platform: null, capabilities: [],
  version: null, class: "switch", discoveredBy: "cdp", chassisId: null, vendor: null,
});
const device = (hostname, address, neighbors = []) => ({
  hostname, address, addresses: [{ ip: address, interface: null, isManagement: true }],
  probeTarget: address, class: "switch", platform: null, version: null,
  neighbors, hops: 0, reachedBy: "ssh", attached: [],
});

// OLD-SW is gone. ACC-SW has moved to Gi1/0/9. NEW-SW has appeared.
const crawlResult = {
  devices: [
    device("CORE-SW", "10.0.0.1", [
      neighbor("ACC-SW", "Gi1/0/9", "Gi0/1", "10.0.0.2"),
      neighbor("NEW-SW", "Gi1/0/5", "Gi0/1", "10.0.0.5"),
    ]),
    device("ACC-SW", "10.0.0.2"),
  ],
  notVisited: [],
  failures: [],
  cancelled: false,
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));

  // The smallest thing that behaves like Tauri's bridge: callbacks can be
  // registered, listeners remembered, and every other command answers
  // harmlessly rather than throwing and taking the panel down with it.
  const listeners = {};
  const callbacks = {};
  let next = 1;
  window.__cvEmit = (event, payload) => {
    const id = listeners[event];
    if (id && callbacks[id]) callbacks[id]({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) {
      const id = next++;
      callbacks[id] = cb;
      return id;
    },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") {
        listeners[args.event] = args.handler;
        return Promise.resolve(next++);
      }
      // Once the bridge exists the app takes the desktop path, so the two
      // calls that gate the project screen have to answer for real.
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
            engineer: "", description: "", created_at: p.meta.createdAt,
            updated_at: p.meta.updatedAt, archived: false,
          },
        ]);
      }
      if (cmd === "load_project") {
        return Promise.resolve({
          meta: {
            id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
            engineer: "", description: "", created_at: p.meta.createdAt,
            updated_at: p.meta.updatedAt, archived: false,
          },
          document_version: p.documentVersion,
          document: p.document,
        });
      }
      if (cmd === "get_settings") return Promise.resolve({});
      // Anything else answers with an empty list. Components ask for
      // collections, and null makes them throw on `.length`.
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERROR:", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.locator(".cv-project-open").first().click();
await page.waitForSelector(".react-flow__node", { timeout: 15000 });

await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(500);

check("no report before a crawl has run", (await page.locator(".cv-change").count()) === 0);

await page.evaluate((r) => window.__cvEmit("coreview://crawl-result", r), crawlResult);
await page.waitForTimeout(700);

const report = page.locator(".cv-change");
check("a finished crawl produces a change report", (await report.count()) === 1);

if (await report.count()) {
  const text = await report.innerText();
  check("it says a device has gone", /Gone/.test(text) && /OLD-SW/.test(text), text.slice(0, 200));
  check("it says a device is new", /New/.test(text) && /NEW-SW/.test(text));
  check("it reports the link that moved port", /Gi1\/0\/1/.test(text) && /Gi1\/0\/9/.test(text), text.slice(0, 400));

  // hasText matches a substring and ignores case, so "Gone" also selects
  // "Links gone". The headings have to be anchored.
  const itemsUnder = (heading) =>
    page.locator(".cv-change-group").filter({ has: page.locator(`h4:text-is("${heading}")`) })
      .locator("li").allTextContents();

  const gone = await itemsUnder("Gone");
  check("only the missing device is listed as gone", gone.length === 1 && gone[0].includes("OLD-SW"), JSON.stringify(gone));

  const added = await itemsUnder("New");
  check(
    "a device that has not changed is not called new",
    added.length === 1 && added[0].includes("NEW-SW") && !added.some((a) => a.includes("CORE-SW")),
    JSON.stringify(added),
  );

  // The report is a report. Pressing nothing must change nothing.
  const nodes = await page.locator(".react-flow__node").count();
  check("reporting draws nothing on its own", nodes === 3, `${nodes} nodes`);

  // "OLD-SW is gone" is only useful if you can see which box that is.
  const goneLine = report.locator(".cv-change-group")
    .filter({ has: page.locator('h4:text-is("Gone")') })
    .locator(".cv-change-show").first();
  check("a change can be gone to from the report", (await goneLine.count()) === 1);
  if (await goneLine.count()) {
    await goneLine.click();
    await page.waitForTimeout(600);
    const title = await page.locator(".cv-inspector-title").first().innerText();
    check("clicking it selects the device the line is about",
      /Node/i.test(title), title.replace(/\n/g, " ").slice(0, 40));
    const label = await page.locator(".cv-inspector input").first().inputValue();
    check("and it is the right one", label === "OLD-SW", label);
    check("going to a change still changes nothing",
      (await page.locator(".react-flow__node").count()) === 3);
  }
}

if (process.argv[2]) {
  await page.locator(".cv-change").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  const box = await page.locator(".cv-change").first().boundingBox().catch(() => null);
  await page.screenshot({
    path: `${process.argv[2]}/change-report.png`,
    clip: box ? { x: box.x - 12, y: box.y - 12, width: Math.min(box.width + 24, 1580), height: box.height + 24 } : undefined,
  });
}
await browser.close();
console.log(failures === 0 ? "\nall change-report checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
