// Frame-rate benchmark for the live canvas.
//
// Injects a 50-node / 75-link project into browser storage with MANUAL health
// rules, so links are healthy/warning — and therefore animating — without a
// backend. Then counts real frames via requestAnimationFrame.
//
// This is Chromium, not the WebView2/WebKitGTK the app actually ships on, so
// treat the absolute number as indicative. What it measures reliably is the
// *relative* cost of an animation change, which is what a before/after needs.
//
//   node e2e/perf.mjs [label] [animatedEdges]

import { chromium } from "playwright";

const LABEL = process.argv[2] || "run";
const ANIMATED = Number(process.argv[3] || 30);
const URL = "http://localhost:5173/";
const NODES = 50, EDGES = 75;

const uid = (p, i) => `${p}-${i}`;

function buildProject() {
  const nodes = [], edges = [];
  for (let i = 0; i < NODES; i++) {
    nodes.push({
      id: uid("n", i), type: "device",
      position: { x: (i % 10) * 260, y: Math.floor(i / 10) * 190 },
      width: 176, height: 96, measured: { width: 176, height: 96 },
      data: {
        label: `DEV-${String(i).padStart(2, "0")}`,
        deviceType: ["router", "firewall", "core-switch", "server", "access-point"][i % 5],
        addresses: [], tags: [], locked: false, maintenance: false, showDetails: true,
      },
    });
  }
  for (let i = 0; i < EDGES; i++) {
    const a = uid("n", i % NODES);
    const b = uid("n", (i * 7 + 11) % NODES);
    // First ANIMATED edges healthy (animating); a few warning; rest down (still).
    const manualStatus = i < ANIMATED ? (i % 6 === 0 ? "warning" : "healthy") : "down";
    edges.push({
      id: uid("e", i), type: "live", source: a, target: b,
      sourceHandle: "r", targetHandle: "l",
      data: {
        label: `link-${i}`, sourcePortLabel: `Gi1/0/${i % 48}`, targetPortLabel: `Te1/${i % 4}`,
        pathType: "smoothstep", direction: i % 5 === 0 ? "both" : "forward",
        color: "#5b6b7c", width: 2, enabled: true, maintenance: false,
        healthRule: { type: "manual", manualStatus },
      },
    });
  }
  return {
    meta: {
      id: "perf", name: "PERFBENCH", customer: "bench", site: "bench",
      ticket: "", engineer: "", description: "",
      createdAt: Date.now(), updatedAt: Date.now(), archived: false,
    },
    // ProjectPackage is { meta, documentVersion, document } — not `doc`.
    documentVersion: 1,
    document: { canvas: { grid: true, snap: true, zoom: 1, x: 0, y: 0 }, nodes, edges, probes: [] },
  };
}

const browser = await chromium.launch({ args: ["--enable-gpu-rasterization"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const pkg = buildProject();
await page.addInitScript((p) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ perf: p }));
}, pkg);

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// Open it from the recent list.
const row = page.getByText("PERFBENCH", { exact: false }).first();
if (!(await row.count())) {
  console.error("PERFBENCH row not found; body was:\n" + (await page.locator("body").innerText()).slice(0, 400));
  await browser.close();
  process.exit(1);
}
await row.click();
await page.waitForSelector(".react-flow__edge", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2500);

if (process.env.PERF_DEBUG) {
  console.error("--- after click ---");
  console.error((await page.locator("body").innerText()).slice(0, 600));
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.waitForTimeout(500);
  console.error("errors:", errs);
}

const census = await page.evaluate(() => ({
  edges: document.querySelectorAll(".react-flow__edge").length,
  nodes: document.querySelectorAll(".react-flow__node").length,
  motion: document.querySelectorAll("animateMotion").length,
  circles: document.querySelectorAll(".react-flow svg circle").length,
}));

// Count frames over 6 seconds.
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
        else resolve(+(frames / ((performance.now() - t0) / 1000)).toFixed(1));
      };
      requestAnimationFrame(tick);
    }),
);

console.log(JSON.stringify({ label: LABEL, ...census, fps }));
await browser.close();
