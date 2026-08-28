// Screenshot the launcher and an open project after the rename, and check that
// no element still carries an old lt- class (which would be an unstyled leak).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = process.argv[3];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript((p) => {
  localStorage.setItem("livetopo.projects.v1", JSON.stringify({ [p.meta.id]: p }));
}, pkg);
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/brand-launcher.png` });
await page.locator(".cv-project-open").first().click();
await page.waitForSelector(".react-flow__node", { timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/brand-project.png` });
const stale = await page.evaluate(() =>
  [...document.querySelectorAll("*")]
    .flatMap((e) => [...e.classList])
    .filter((c) => c.startsWith("lt-")));
// Legacy localStorage adoption: the seed used the OLD key only.
const adopted = await page.evaluate(() => ({
  newKey: !!localStorage.getItem("coreview.projects.v1"),
  projects: Object.keys(JSON.parse(localStorage.getItem("coreview.projects.v1") || "{}")).length,
}));
console.log(JSON.stringify({ staleClasses: [...new Set(stale)], adopted, errors }));
await browser.close();
