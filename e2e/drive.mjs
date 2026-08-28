// Drives the Coreview frontend in a real browser engine and captures evidence.
//
// This runs the app in *browser mode* (no Tauri backend), which the README
// documents: projects go to browser storage and probing is unavailable. That
// is enough to exercise the canvas, the palette, link rendering and the
// animation gating, which are the parts of TEST_PLAN that are visual.
//
// It is NOT a substitute for running the packaged app: the shipping webview is
// WebView2 on Windows and WebKitGTK on Linux, not Chromium. Performance numbers
// from here are indicative of the React/SVG cost, not of the real webview.
//
//   node e2e/drive.mjs <outdir>

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] || "/tmp/coreview-shots";
mkdirSync(OUT, { recursive: true });

const URL = "http://localhost:5173/";
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  shot: ${name}.png`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

console.log("== loading app ==");
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot(page, "01-home");

console.log("visible text (first 400 chars):");
console.log(
  "  " + (await page.locator("body").innerText()).slice(0, 400).replace(/\n/g, "\n  "),
);

// Open a sample if the button is there.
const sample = page.getByText("Branch office validation", { exact: false }).first();
if (await sample.count()) {
  console.log("== opening sample ==");
  await sample.click();
  await page.waitForTimeout(2000);
  await shot(page, "02-after-sample-click");

  // The sample may create a project row rather than navigating; click it.
  const row = page.getByText(/Sample .* Branch office/i).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(2500);
    await shot(page, "03-project-open");
  }
}

// Report what actually rendered on the canvas.
const counts = await page.evaluate(() => ({
  reactFlow: document.querySelectorAll(".react-flow").length,
  nodes: document.querySelectorAll(".react-flow__node").length,
  edges: document.querySelectorAll(".react-flow__edge").length,
  svgPaths: document.querySelectorAll("svg path").length,
  animateMotion: document.querySelectorAll("animateMotion").length,
  circles: document.querySelectorAll("svg circle").length,
}));
console.log("== DOM census ==");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);

if (errors.length) {
  console.log("== page errors ==");
  for (const e of errors.slice(0, 10)) console.log("  " + e);
} else {
  console.log("== no page errors ==");
}

await browser.close();
console.log(`\nscreenshots in ${OUT}`);
