// Drives the icon library through the real path.
//
// The library only exists in the desktop build, so the Tauri bridge is stubbed
// and a small set of shapes handed back the way the backend hands one back.
// Everything above the stub is the real application.
//
//     npm run dev            # in another terminal
//     node e2e/library.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">${body}</svg>`;

// Two families and a loose one, which is the shape a real set arrives in.
const icons = [
  { id: "router", name: "Router", category: "Network", svg: svg('<rect x="3" y="9" width="18" height="8"/>') },
  { id: "switch", name: "Switch", category: "Network", svg: svg('<rect x="2" y="10" width="20" height="6"/>') },
  { id: "firewall", name: "Firewall", category: "Security", svg: svg('<path d="M12 3l8 4v6l-8 8-8-8V7z"/>') },
  { id: "shield-lock", name: "Shield Lock", category: "Security", svg: svg('<path d="M12 3l8 4v6"/>') },
  { id: "cisco", name: "Cisco", category: "Vendors", svg: svg('<circle cx="12" cy="12" r="8"/>') },
];

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "lib", name: "Library", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.addInitScript(({ p, lib }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt,
        archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "list_icon_library")
        return Promise.resolve({ dir: "/shapes", icons: lib, skipped: [] });
      if (cmd === "get_settings") return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
}, { p: project, lib: icons });

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);

check("the library is offered when the desktop backend is there",
  (await page.locator("button", { hasText: "Load folder" }).count()) === 1);

await page.getByPlaceholder("/path/to/icons").fill("/shapes");
await page.locator("button", { hasText: "Load folder" }).first().click();
await page.waitForTimeout(900);

const note = await page.locator(".cv-palette-note").first().innerText();
check("it says how many it loaded and from where", /5 icons from/.test(note), note.replace(/\n/g, " "));

// Grouped, because a real set is hundreds across a dozen families and one
// alphabetical list of them is not something anyone finds anything in.
const groups = await page.locator(".cv-palette-sub").allTextContents();
check("the shapes are grouped by family",
  groups.some((g) => /Network/.test(g)) && groups.some((g) => /Security/.test(g)),
  JSON.stringify(groups));

const counted = groups.find((g) => /Network/.test(g)) ?? "";
check("each group says how many it holds", /2/.test(counted), counted);

// Searching has to reach inside a collapsed group, or the search is useless
// on exactly the libraries it exists for.
await page.locator(".cv-palette input").first().fill("cisco");
await page.waitForTimeout(400);
const shown = await page.locator(".cv-palette-item").allTextContents();
check("searching finds a shape in a group that was closed",
  shown.some((t) => /Cisco/.test(t)), JSON.stringify(shown));

await page.locator(".cv-palette input").first().fill("");
await page.waitForTimeout(300);

// And a library shape has to reach the canvas.
const before = await page.locator(".react-flow__node").count();
await page.locator(".cv-palette-item", { hasText: "Router" }).first()
  .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 400, y: 300 } });
await page.waitForTimeout(600);
check("a library shape can be dropped on the canvas",
  (await page.locator(".react-flow__node").count()) === before + 1,
  `${before} -> ${await page.locator(".react-flow__node").count()}`);
check("it arrives carrying its artwork",
  (await page.locator(".react-flow__node img").count()) >= 1);

if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/library.png` });
await browser.close();
console.log(failures === 0 ? "\nall icon library checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
