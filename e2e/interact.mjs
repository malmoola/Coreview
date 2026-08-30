// Drives the canvas interactions that the hand-run smoke test could not reach.
//
// The Tauri build renders in WebKitGTK, and synthetic input through xdotool
// does not produce the pointer sequence React Flow's NodeResizer needs, nor a
// real HTML5 drag from the palette. Those cases sat as PARTIAL in the test
// plan for that reason. They are pure frontend, so Chromium driving the
// browser build exercises the same components with real events.
//
//     npm run dev            # in another terminal
//     node e2e/interact.mjs [outdir]
import { chromium } from "playwright";

const out = process.argv[2] ?? null;
const URL = process.env.CV_URL ?? "http://localhost:5173/";

const NOW = 1756000000000;
const project = {
  meta: {
    id: "e2e-project", name: "Interaction fixture", customer: "", site: "",
    ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW,
    archived: false,
  },
  documentVersion: 1,
  document: {
    nodes: [
      {
        id: "n1", type: "device", position: { x: 0, y: 0 }, width: 176, height: 96,
        data: {
          label: "Core switch", deviceType: "core-switch", tags: [],
          addresses: [{ id: "a1", label: "Management", address: "192.0.2.10", isPrimary: true }],
          locked: false, maintenance: false, showDetails: true,
        },
      },
      {
        id: "note1", type: "note", position: { x: 300, y: 0 }, width: 200, height: 120,
        data: {
          title: "Rollback", body: "- [ ] Restore config", variant: "change",
          fontSize: 12, textColor: "#f0e6d2", background: "#2a1f10",
          borderColor: "#8a6a2a", locked: false,
        },
      },
      {
        id: "n2", type: "device", position: { x: 0, y: 260 }, width: 176, height: 96,
        data: {
          label: "Access switch", deviceType: "access-switch", tags: [],
          addresses: [], locked: false, maintenance: false, showDetails: true,
        },
      },
    ],
    edges: [
      {
        id: "e-healthy", source: "n1", target: "n2", sourceHandle: "b", targetHandle: "t",
        type: "live",
        data: {
          sourcePortLabel: "Gi1/0/1", targetPortLabel: "Gi0/1", label: "Uplink",
          pathType: "smoothstep", direction: "forward", width: 2, color: "#2fbf6b",
          enabled: true, maintenance: false,
          healthRule: { type: "manual", manualStatus: "healthy" },
        },
      },
      {
        id: "e-down", source: "n2", target: "n1", sourceHandle: "r", targetHandle: "l",
        type: "live",
        data: {
          sourcePortLabel: "", targetPortLabel: "", label: "Backup",
          pathType: "bezier", direction: "forward", width: 2, color: "#e4564a",
          enabled: true, maintenance: false,
          healthRule: { type: "manual", manualStatus: "down" },
        },
      },
    ],
    probes: [],
    canvas: {},
  },
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript((p) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
}, project);
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForSelector(".react-flow__node", { timeout: 15000 });
await page.waitForTimeout(400);

const nodeCount = () => page.locator(".react-flow__node").count();
const boxOf = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return b ? { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) } : null;
};

/** Where a node sits relative to another one.
 *
 *  Absolute screen position is the wrong measure for "did this move": now that
 *  left-drag pans, dragging a node the canvas refuses to move scrolls the view
 *  instead, and every node's screen box changes while the diagram is unchanged.
 *  The gap between two nodes only changes if one of them actually moved. */
const gapBetween = async (a, b) => {
  const [x, y] = await Promise.all([page.locator(a).first().boundingBox(), page.locator(b).first().boundingBox()]);
  return { dx: Math.round(x.x - y.x), dy: Math.round(x.y - y.y) };
};

/** A drag that is verified to have actually dragged something.
 *
 *  "The gap did not change" is true both when a node moved with its group and
 *  when nothing moved at all — a locked node, a missed grab, or a pan. Two of
 *  the grouping checks below passed for that second reason for as long as the
 *  lock tests left their nodes locked. Watching a third, uninvolved node
 *  separates the cases: it stays put during a node drag and moves during a
 *  pan. */
const dragNode = async (selector, dx, dy, witnessSelector) => {
  const witnessBefore = await page.locator(witnessSelector).first().boundingBox();
  const b = await page.locator(selector).first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 22);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + 22 + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const after = await page.locator(selector).first().boundingBox();
  const witnessAfter = await page.locator(witnessSelector).first().boundingBox();
  return {
    moved: Math.abs(after.x - b.x) > 40 || Math.abs(after.y - b.y) > 40,
    panned:
      Math.abs(witnessAfter.x - witnessBefore.x) > 12 ||
      Math.abs(witnessAfter.y - witnessBefore.y) > 12,
  };
};

// ---------------------------------------------------------------- case 1
// A real HTML5 drag out of the palette. `nodeForDrop` is unit-tested; what is
// not, is that the palette actually hands over the payload the canvas reads.
{
  const before = await nodeCount();
  const item = page.locator(".cv-palette-item", { hasText: "Firewall" }).first();
  await item.dragTo(page.locator(".react-flow__pane"), {
    targetPosition: { x: 520, y: 420 },
  });
  await page.waitForTimeout(400);
  const after = await nodeCount();
  check("palette drag creates a node", after === before + 1, `${before} -> ${after}`);

  const kind = await page.evaluate(() => {
    // Either presentation: the glyph style labels with .cv-glyph-label, the
    // card style with .cv-node-label.
    const labels = [...document.querySelectorAll(".cv-glyph-label, .cv-node-label")].map(
      (e) => e.textContent,
    );
    return labels.includes("Firewall");
  });
  check("the dropped node is the one that was dragged", kind);
}

// ------------------------------------------------------------- cases 8, 9
// A still capture cannot show whether anything is moving, which is why these
// sat as PARTIAL. The rule is that a healthy link carries travelling dots and
// a failed one does not; in the DOM that is an <animateMotion> per dot.
{
  const healthy = await page.evaluate(() =>
    document.querySelectorAll('g[data-id="e-healthy"] animateMotion').length,
  );
  const down = await page.evaluate(() =>
    document.querySelectorAll('g[data-id="e-down"] animateMotion').length,
  );
  check("a healthy link carries travelling dots", healthy > 0, `${healthy} animateMotion`);
  check("a failed link carries none", down === 0, `${down} animateMotion`);

  const stroke = await page.evaluate(() => {
    const at = (id) => {
      const p = document.querySelector(`g[data-id="${id}"] path.react-flow__edge-path`);
      const cs = p ? getComputedStyle(p) : null;
      return cs ? { stroke: cs.stroke, dash: cs.strokeDasharray } : null;
    };
    return { healthy: at("e-healthy"), down: at("e-down") };
  });
  // rgb(47, 191, 107) is #2fbf6b; rgb(228, 86, 74) is #e4564a.
  check(
    "a healthy link is drawn green and solid",
    stroke.healthy?.stroke === "rgb(47, 191, 107)" &&
      (stroke.healthy?.dash === "none" || !stroke.healthy?.dash),
    JSON.stringify(stroke.healthy),
  );
  check(
    "a failed link is drawn red and dashed",
    stroke.down?.stroke === "rgb(228, 86, 74)" && /\d/.test(stroke.down?.dash ?? ""),
    JSON.stringify(stroke.down),
  );

  // Status is never carried by colour alone.
  const glyphs = await page.evaluate(() =>
    [...document.querySelectorAll(".cv-edge-glyph")].map((e) => e.textContent),
  );
  check("each link label repeats its status as a glyph", glyphs.includes("\u2713") && glyphs.includes("\u2715"), JSON.stringify(glyphs));
}

// ---------------------------------------------------------------- case 2
// Selecting a node shows NodeResizer; dragging its corner must resize it.
{
  const node = page.locator(".react-flow__node").first();
  await node.click();
  await page.waitForTimeout(300);
  const before = await boxOf(".react-flow__node");
  const handle = page.locator(".cv-resize-handle.bottom.right, .cv-resize-handle").last();
  const hb = await handle.boundingBox();
  if (!hb) {
    check("a selected node offers resize handles", false, "no .cv-resize-handle in the DOM");
  } else {
    check("a selected node offers resize handles", true);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 120, hb.y + 80, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await boxOf(".react-flow__node");
    check(
      "dragging the corner resizes the node",
      after.w > before.w + 40 && after.h > before.h + 20,
      `${before.w}x${before.h} -> ${after.w}x${after.h}`,
    );
  }
}

// ---------------------------------------------------------------- case 5
// The same for a note, which uses its own minimums.
{
  const note = page.locator(".react-flow__node .cv-note").first();
  await note.click();
  await page.waitForTimeout(300);
  const before = await boxOf(".react-flow__node:has(.cv-note)");
  const handle = page.locator(".cv-resize-handle").last();
  const hb = await handle.boundingBox();
  if (!hb) {
    check("a selected note offers resize handles", false, "no handle");
  } else {
    check("a selected note offers resize handles", true);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 90, hb.y + 70, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await boxOf(".react-flow__node:has(.cv-note)");
    check(
      "dragging the corner resizes the note",
      after.w > before.w + 30 && after.h > before.h + 20,
      `${before.w}x${before.h} -> ${after.w}x${after.h}`,
    );
  }
}

// ---------------------------------------------------------------- moving
{
  const node = page.locator(".react-flow__node").first();
  const before = await boxOf(".react-flow__node");
  const b = await node.boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30 + 140, b.y + b.height / 2 + 90, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await boxOf(".react-flow__node");
  check(
    "a node can be dragged to a new position",
    Math.abs(after.x - before.x) > 80 && Math.abs(after.y - before.y) > 50,
    `(${before.x},${before.y}) -> (${after.x},${after.y})`,
  );
}

// ---------------------------------------------------------------- locking
// A locked node must not move. This is the half of case 5 that a screenshot
// cannot show: the lock has to actually refuse the drag.
{
  await page.locator(".react-flow__node").first().click();
  await page.waitForTimeout(250);
  const lockLabel = page.locator("label.cv-check", { hasText: "Lock position" }).first();
  const found = (await lockLabel.count()) > 0;
  check("the inspector offers a lock", found);
  if (found) {
    await lockLabel.locator("input[type=checkbox]").check();
    await page.waitForTimeout(300);
    const ref = ".react-flow__node:has(.cv-note)";
    const before = await gapBetween(".react-flow__node", ref);
    const b = await page.locator(".react-flow__node").first().boundingBox();
    await page.mouse.move(b.x + 30, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 200, b.y + 150, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await gapBetween(".react-flow__node", ref);
    check(
      "a locked node refuses to move",
      Math.abs(after.dx - before.dx) < 6 && Math.abs(after.dy - before.dy) < 6,
      `gap (${before.dx},${before.dy}) -> (${after.dx},${after.dy})`,
    );
    check(
      "a locked node offers no resize handles",
      (await page.locator(".cv-resize-handle").count()) === 0,
    );

    // Unlock again, and prove it. Leaving it locked made every later check
    // that measures a drag pass without anything moving.
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(200);
    await lockLabel.locator("input[type=checkbox]").uncheck();
    await page.waitForTimeout(250);
    const freed = await page.locator(".react-flow__node").first().boundingBox();
    await page.mouse.move(freed.x + 30, freed.y + freed.height / 2);
    await page.mouse.down();
    await page.mouse.move(freed.x + 160, freed.y + freed.height / 2 + 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const freedAfter = await gapBetween(".react-flow__node", ref);
    check(
      "unlocking lets it move again",
      Math.abs(freedAfter.dx - after.dx) > 40 || Math.abs(freedAfter.dy - after.dy) > 20,
      `gap (${after.dx},${after.dy}) -> (${freedAfter.dx},${freedAfter.dy})`,
    );
  }
}

// ---------------------------------------------------------------- note lock
// The note has its own wording for the same thing, and the fix is shared, so
// it is worth asserting rather than assumed.
{
  await page.locator(".react-flow__node .cv-note").first().click();
  await page.waitForTimeout(250);
  const label = page.locator("label.cv-check", { hasText: "Lock this note" }).first();
  const found = (await label.count()) > 0;
  check("the inspector offers a note lock", found);
  if (found) {
    await label.locator("input[type=checkbox]").check();
    await page.waitForTimeout(300);
    const note = ".react-flow__node:has(.cv-note)";
    const before = await gapBetween(note, ".react-flow__node");
    const b = await page.locator(note).first().boundingBox();
    await page.mouse.move(b.x + 30, b.y + 20);
    await page.mouse.down();
    await page.mouse.move(b.x + 200, b.y + 160, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await gapBetween(note, ".react-flow__node");
    check(
      "a locked note refuses to move",
      Math.abs(after.dx - before.dx) < 6 && Math.abs(after.dy - before.dy) < 6,
      `gap (${before.dx},${before.dy}) -> (${after.dx},${after.dy})`,
    );

    // Same reason as the device: a note left locked makes every grouping
    // check below pass with nothing moving.
    await page.locator(".react-flow__node .cv-note").first().click();
    await page.waitForTimeout(200);
    await label.locator("input[type=checkbox]").uncheck();
    await page.waitForTimeout(250);
    const freed = await page.locator(note).first().boundingBox();
    await page.mouse.move(freed.x + 30, freed.y + 20);
    await page.mouse.down();
    await page.mouse.move(freed.x + 170, freed.y + 120, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const freedAfter = await gapBetween(note, ".react-flow__node");
    check(
      "unlocking the note lets it move again",
      Math.abs(freedAfter.dx - after.dx) > 40 || Math.abs(freedAfter.dy - after.dy) > 40,
      `gap (${after.dx},${after.dy}) -> (${freedAfter.dx},${freedAfter.dy})`,
    );
  }
}

// ---------------------------------------------------------------- grouping
// A group is drawn as nothing at all, so the only way to see whether it worked
// is whether the other members move.
{
  // Start clean: the earlier checks left things locked.
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForSelector(".react-flow__node", { timeout: 15000 });
  await page.waitForTimeout(500);

  const dev = ".react-flow__node:not(:has(.cv-note))";
  // A node that takes no part in the grouping, so it can testify that the
  // canvas did not simply pan under the drag.
  const witness = ".react-flow__node:not(:has(.cv-note))>>nth=1";
  const note = ".react-flow__node:has(.cv-note)";

  await page.locator(dev).first().click();
  await page.locator(note).first().click({ modifiers: ["Control"] });
  await page.waitForTimeout(300);
  await page.locator(dev).first().click({ button: "right" });
  await page.waitForTimeout(300);
  const groupItem = page.locator(".cv-menu button", { hasText: /^Group / }).first();
  const offered = (await groupItem.count()) > 0;
  check("grouping is offered for a multiple selection", offered);
  if (offered) {
    await groupItem.click();
    await page.waitForTimeout(300);

    // Deselect first. Both were selected in order to group them, and React
    // Flow moves a selection together on its own — leaving them selected made
    // this check pass with the grouping logic removed entirely.
    await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
    await page.waitForTimeout(250);

    const before = await gapBetween(note, dev);
    const dragged = await dragNode(dev, 130, 90, witness);
    const after = await gapBetween(note, dev);
    check("the grouped node actually moved", dragged.moved && !dragged.panned, JSON.stringify(dragged));
    check(
      "a grouped companion moves with the node that was dragged",
      dragged.moved && Math.abs(after.dx - before.dx) < 8 && Math.abs(after.dy - before.dy) < 8,
      `gap (${before.dx},${before.dy}) -> (${after.dx},${after.dy})`,
    );

    // Now with both selected: React Flow moves both itself, and moving the
    // companion again on top of that would send it twice as far.
    await page.locator(dev).first().click();
    await page.locator(note).first().click({ modifiers: ["Control"] });
    await page.waitForTimeout(250);
    const before2 = await gapBetween(note, dev);
    const b2 = await page.locator(dev).first().boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 - 120, b2.y + b2.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after2 = await gapBetween(note, dev);
    check(
      "a member that moved itself is not moved twice",
      Math.abs(after2.dx - before2.dx) < 8 && Math.abs(after2.dy - before2.dy) < 8,
      `gap (${before2.dx},${before2.dy}) -> (${after2.dx},${after2.dy})`,
    );

    await page.locator(dev).first().click({ button: "right" });
    await page.waitForTimeout(300);
    const ungroup = page.locator(".cv-menu button", { hasText: /^Ungroup/ }).first();
    check("ungroup is offered on a grouped node", (await ungroup.count()) > 0);
    await ungroup.click();
    await page.waitForTimeout(300);
    await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
    await page.waitForTimeout(200);

    const before3 = await gapBetween(note, dev);
    const dragged3 = await dragNode(dev, 140, 0, witness);
    const after3 = await gapBetween(note, dev);
    check("the ungrouped node actually moved", dragged3.moved && !dragged3.panned, JSON.stringify(dragged3));
    check(
      "an ungrouped companion stays where it was",
      dragged3.moved && Math.abs(after3.dx - before3.dx) > 60,
      `gap (${before3.dx},${before3.dy}) -> (${after3.dx},${after3.dy})`,
    );
  }
}

// ---------------------------------------------------------------- find
// The search library is unit-tested. What is not, is that Ctrl+F actually
// opens it, that a match moves the view, and that it changes nothing.
{
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 600 } });
  const before = await nodeCount();
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
  const box = page.locator(".cv-find-input");
  check("Ctrl+F opens the find box", await box.count() === 1);

  if (await box.count()) {
    await box.fill("Access");
    await page.waitForTimeout(250);
    const results = await page.locator(".cv-find-results button").count();
    check("typing a name lists matches", results > 0, `${results} results`);

    const label = await page.locator(".cv-find-results button .cv-find-label").first().textContent();
    check("the match is the device asked for", label === "Access switch", String(label));

    // Where the node sits on screen before and after jumping to it. The
    // view moves, so the node's screen box must change.
    const at = async () => {
      const b = await page.locator(".react-flow__node").nth(2).boundingBox();
      return b ? { x: Math.round(b.x), y: Math.round(b.y) } : null;
    };
    const was = await at();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    const now = await at();
    check(
      "choosing a match moves the view to it",
      was && now && (Math.abs(now.x - was.x) > 20 || Math.abs(now.y - was.y) > 20),
      `${JSON.stringify(was)} -> ${JSON.stringify(now)}`,
    );
    check("the find box closes once a device is chosen", await page.locator(".cv-find-input").count() === 0);
    check("searching adds and removes nothing", await nodeCount() === before, `${before} -> ${await nodeCount()}`);
  }
}

// ---------------------------------------------------------------- tidy
// Tidy must even out spacing without rearranging: whatever was above stays
// above. An operator has to be able to press it without bracing.
{
  const order = async () => {
    const boxes = [];
    const n = await page.locator(".react-flow__node").count();
    for (let i = 0; i < n; i++) {
      const b = await page.locator(".react-flow__node").nth(i).boundingBox();
      boxes.push(b ? { x: b.x, y: b.y } : null);
    }
    return boxes;
  };
  const before = await order();
  const count = await nodeCount();

  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  const item = page.locator(".cv-menu button", { hasText: "Tidy the layout" });
  check("the canvas menu offers a tidy", await item.count() === 1);
  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(400);
    const after = await order();
    check("tidying draws and deletes nothing", await nodeCount() === count, `${count} -> ${await nodeCount()}`);

    // Every pair that was left-to-right must still be left-to-right, and
    // every pair that was above must still be above.
    let flipped = 0;
    for (let i = 0; i < before.length; i++) {
      for (let j = i + 1; j < before.length; j++) {
        if (!before[i] || !before[j] || !after[i] || !after[j]) continue;
        const wasLeft = before[i].x < before[j].x - 8;
        const wasAbove = before[i].y < before[j].y - 8;
        if (wasLeft && after[i].x > after[j].x + 8) flipped++;
        if (wasAbove && after[i].y > after[j].y + 8) flipped++;
      }
    }
    check("tidying keeps the arrangement it was given", flipped === 0, `${flipped} pairs reordered`);

    const status = await page.locator(".cv-panel-message").first().textContent().catch(() => "");
    check("tidying says what it did", /tidy|even|row/i.test(status ?? ""), String(status).slice(0, 90));
  }
}

if (out) await page.screenshot({ path: `${out}/interact-final.png` });
await browser.close();
console.log(failures === 0 ? "\nall interaction checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
