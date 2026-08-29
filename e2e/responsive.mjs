// Checks the workspace layout across the range of screens people actually use.
//
// A Tauri window cannot be resized reliably under Xvfb, and the thing being
// tested is CSS, so this drives a real browser at real viewport sizes and
// measures what the layout actually does rather than what the rules say.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = process.argv[3];

const SIZES = [
  { name: "3440x1440-ultrawide", width: 3440, height: 1440 },
  { name: "2560x1440-qhd", width: 2560, height: 1440 },
  { name: "1920x1080-desktop", width: 1920, height: 1080 },
  { name: "1600x1000-default", width: 1600, height: 1000 },
  { name: "1366x768-laptop", width: 1366, height: 768 },
  { name: "1280x720-scaled", width: 1280, height: 720 },
  { name: "1024x768-small", width: 1024, height: 768 },
  { name: "900x600-minimum", width: 900, height: 600 },
];

const browser = await chromium.launch();
let failures = 0;

for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.addInitScript((p) => {
    localStorage.setItem("livetopo.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  }, pkg);
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

  // The launcher is the first thing anyone sees and has its own layout, so it
  // is checked at every size too rather than assumed to be fine.
  const launcher = await page.evaluate(() => {
    let worst = 0;
    let culprit = null;
    for (const e of document.querySelectorAll(".cv-welcome *")) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > worst) {
        worst = r.right;
        culprit = String(e.className || e.tagName).slice(0, 50);
      }
    }
    return {
      right: Math.round(worst),
      culprit,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  if (launcher.right > size.width + 1 || launcher.overflowX > 0) {
    failures++;
    console.log(
      `FAIL ${size.name.padEnd(22)} launcher reaches ${launcher.right}px past ${size.width} — "${launcher.culprit}"`,
    );
    if (out) await page.screenshot({ path: `${out}/launcher-${size.name}.png` });
  }

  await page.locator(".cv-project-open").first().click();
  await page.waitForSelector(".react-flow__node", { timeout: 15000 });
  await page.waitForTimeout(600);

  const m = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
      return visible ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    return {
      palette: box(".cv-palette"),
      canvas: box(".cv-canvas"),
      inspector: box(".cv-inspector"),
      panel: box(".cv-panel"),
      topbar: box(".cv-topbar"),
      // Nothing may push the page sideways.
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // Nor may any chrome stick out past the right edge. React Flow's own
      // nodes are excluded: they live in a pan and zoom space and are supposed
      // to sit outside the viewport, so measuring them says nothing about the
      // layout.
      widest: (() => {
        let worst = 0;
        let culprit = null;
        for (const e of document.querySelectorAll(".cv-app *")) {
          if (e.closest(".react-flow__viewport, .react-flow__renderer, .react-flow__minimap")) continue;
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > worst) {
            worst = r.right;
            culprit = e.className?.baseVal ?? e.className ?? e.tagName;
          }
        }
        return { right: Math.round(worst), culprit: String(culprit).slice(0, 60) };
      })(),
    };
  });

  const problems = [];
  if (m.overflowX > 0) problems.push(`page scrolls sideways by ${m.overflowX}px`);
  if (m.widest.right > size.width + 1)
    problems.push(`chrome reaches ${m.widest.right}px past ${size.width} — "${m.widest.culprit}"`);
  if (!m.canvas) problems.push("no canvas");
  else if (m.canvas.w < 300) problems.push(`canvas only ${m.canvas.w}px wide`);
  else if (m.canvas.h < 180) problems.push(`canvas only ${m.canvas.h}px tall`);
  if (!m.topbar) problems.push("no toolbar");

  const cols = [m.palette && "palette", m.canvas && "canvas", m.inspector && "inspector"]
    .filter(Boolean)
    .join("+");
  const line = `${size.name.padEnd(22)} canvas ${String(m.canvas?.w ?? 0).padStart(4)}x${String(m.canvas?.h ?? 0).padStart(4)}  panel ${String(m.panel?.h ?? 0).padStart(3)}  [${cols}]`;
  if (problems.length) {
    failures++;
    console.log(`FAIL ${line}\n       ${problems.join("; ")}`);
  } else {
    console.log(`ok   ${line}`);
  }

  if (out) await page.screenshot({ path: `${out}/resp-${size.name}.png` });
  await page.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
