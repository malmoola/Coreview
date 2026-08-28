// Does dragging a palette item onto the canvas create a node?
//
// xdotool cannot drive HTML5 drag-and-drop, but Playwright can: it dispatches
// real input through CDP, so dragstart/dragover/drop fire exactly as they do
// for a user. This is the check that was missing when the drop handler shipped.
//
//   node e2e/dnd.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Browser-mode storage is keyed by meta.id; openProject looks it up by that,
// so the key and the id have to agree or the row renders and opens nothing.
await page.addInitScript((p) => {
  localStorage.setItem("livetopo.projects.v1", JSON.stringify({ [p.meta.id]: p }));
}, pkg);
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator(".lt-project-open").first().click();
await page.waitForSelector(".react-flow__node", { timeout: 15000 });
await page.waitForTimeout(1200);

const before = await page.locator(".react-flow__node").count();

// Drag the Firewall palette button onto an empty part of the canvas.
const source = page.locator(".lt-palette-item", { hasText: "Firewall" }).first();
const target = page.locator(".react-flow__pane");
const box = await target.boundingBox();

await source.hover();
await page.mouse.down();
await page.mouse.move(box.x + 700, box.y + 120, { steps: 20 });
await page.mouse.move(box.x + 720, box.y + 140, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(1500);

const after = await page.locator(".react-flow__node").count();
console.log(JSON.stringify({ before, after, created: after - before, errors }));
await page.screenshot({ path: process.argv[3] || "/tmp/dnd.png" });
await browser.close();
process.exit(after > before ? 0 : 1);
