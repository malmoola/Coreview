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
        id: "n1", type: "device", position: { x: 0, y: 0 }, width: 76, height: 76,
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
        id: "n2", type: "device", position: { x: 0, y: 260 }, width: 76, height: 76,
        data: {
          label: "Access switch", deviceType: "access-switch", tags: [],
          addresses: [], locked: false, maintenance: false, showDetails: true,
        },
      },
      // A third device that takes part in nothing. It is the control: bulk
      // edits must not reach it, and it can testify that a drag moved a node
      // rather than panning the canvas.
      {
        id: "n3", type: "device", position: { x: 640, y: 300 }, width: 76, height: 76,
        data: {
          label: "Bystander", deviceType: "router", tags: [],
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


/** The recovery banner is the app being right about an unexpected reload —
 *  which long harness runs occasionally suffer. It shifts the canvas down,
 *  so any block about to measure dismisses it first. */
const dismissRecovery = async () => {
  if (await page.locator(".cv-recovery").count()) {
    await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
    await page.waitForTimeout(300);
  }
};
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

const pointOnEdge = async () => {
  const d = await page.locator(".react-flow__edge-path").first().getAttribute("d");
  const nums = (d ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
  if (nums.length < 4) return null;
  const t = await page.locator(".react-flow__viewport").evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { a: m.a, e: m.e, f: m.f };
  });
  const box = await page.locator(".react-flow__pane").boundingBox();
  // Several points along the line, taking the first that is really the
  // line and not something drawn over it.
  for (let i = 2; i + 1 < nums.length; i += 2) {
    const at = {
      x: box.x + nums[i] * t.a + t.e,
      y: box.y + nums[i + 1] * t.a + t.f,
    };
    const tag = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? "",
      at,
    );
    if (tag === "path") return at;
  }
  return null;
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
    // Since LT-053 a resize genuinely scales the glyph, and every block after
    // this one is laid out against the original size — put it back.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
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

// ---------------------------------------------------------------- folding
// Folding a site is a view. It must not change the document, and expanding
// has to give back exactly what was there.
{
  const dev = ".react-flow__node:not(:has(.cv-note))";
  const note = ".react-flow__node:has(.cv-note)";
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);

  const before = await nodeCount();
  await page.locator(dev).first().click();
  await page.locator(note).first().click({ modifiers: ["Control"] });
  await page.waitForTimeout(250);
  await page.locator(dev).first().click({ button: "right" });
  await page.waitForTimeout(300);
  const groupItem = page.locator(".cv-menu button", { hasText: /^Group \d+ objects/ }).first();
  if (await groupItem.count()) {
    await groupItem.click();
    await page.waitForTimeout(300);
  }

  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  await page.locator(dev).first().click({ button: "right" });
  await page.waitForTimeout(300);
  const foldItem = page.locator(".cv-menu button", { hasText: "Fold this group into one box" });
  check("a grouped node offers folding", (await foldItem.count()) === 1);

  if (await foldItem.count()) {
    await foldItem.click();
    await page.waitForTimeout(450);
    const folded = await nodeCount();
    check("folding replaces the members with one box", folded === before - 1, `${before} -> ${folded}`);

    const boxes = await page.locator(".cv-glyph-label, .cv-node-title").allTextContents();
    check("the box says how much is inside it",
      boxes.some((b) => /objects/.test(b)), JSON.stringify(boxes).slice(0, 140));

    // Unfolding must give back exactly what was there.
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
    await page.waitForTimeout(250);
    const openAll = page.locator(".cv-menu button", { hasText: /^Open all folded groups/ });
    check("there is a way to open everything again", (await openAll.count()) === 1);
    await openAll.click();
    await page.waitForTimeout(450);
    const restored = await nodeCount();
    check("opening restores every object", restored === before, `${before} -> ${folded} -> ${restored}`);
  }
}

// ---------------------------------------------------------------- history
// A dot says what a device is doing now. The strip has to say what it has
// been doing, and must not fill in periods nobody was watching.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  await page.locator(".react-flow__node:not(:has(.cv-note))").first().click();
  await page.waitForTimeout(300);

  const strip = page.locator(".cv-history-strip");
  check("a selected device shows a status strip", (await strip.count()) === 1);

  if (await strip.count()) {
    const bands = await strip.locator("span").count();
    check("the strip is drawn as bands of status", bands > 0, `${bands} bands`);

    // Validation has never been started in this fixture, so nothing is known
    // about any of it. Claiming otherwise is the failure this guards.
    const label = (await strip.getAttribute("aria-label")) ?? "";
    check("an unwatched period reads as unknown, not healthy",
      /Unknown/.test(label) && !/Healthy/.test(label), label.slice(0, 80));

    const windows = await page.locator(".cv-history-windows button").allTextContents();
    check("the window can be changed", windows.join(",") === "15m,1h,6h", windows.join(","));
    await page.locator(".cv-history-windows button", { hasText: "15m" }).click();
    await page.waitForTimeout(250);
    check("choosing a window keeps the strip",
      (await strip.locator("span").count()) > 0);
  }
}

// ---------------------------------------------------------------- csv out
// CSV import existed and export did not, which made it a one-way door. The
// check that matters is not that a file appears but that what comes out is
// what the importer reads back in.
{
  const downloads = [];
  page.on("download", (d) => downloads.push(d));

  await page.locator(".cv-dropdown summary", { hasText: "Export" }).first().click();
  await page.waitForTimeout(250);
  const item = page.locator(".cv-dropdown-menu button", { hasText: "Devices and links as CSV" });
  check("the export menu offers the diagram as CSV", (await item.count()) === 1);

  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(1200);
    check("it writes two files, devices and links", downloads.length === 2, `${downloads.length} downloads`);

    const fs = await import("node:fs/promises");
    const read = async (which) => {
      const d = downloads.find((x) => x.suggestedFilename().includes(which));
      const path = d ? await d.path() : null;
      return path ? fs.readFile(path, "utf8") : "";
    };
    const devicesCsv = await read("devices");
    const linksCsv = await read("links");

    check("the devices file names every device on the diagram",
      /Core switch/.test(devicesCsv) && /Access switch/.test(devicesCsv) && /Bystander/.test(devicesCsv),
      devicesCsv.split("\n").slice(0, 2).join(" / "));
    check("the devices file carries the header the importer reads",
      /^Name,Type,IP,Probe type,Port,Notes,Tags/.test(devicesCsv), devicesCsv.slice(0, 60));
    check("the links file references devices by name, with ports",
      /Core switch/.test(linksCsv) && /Gi1\/0\/1/.test(linksCsv), linksCsv.split("\n").slice(0, 3).join(" / "));
  }
}

// ---------------------------------------------------------------- swinging
// A link must face wherever its devices have been moved to, not stay attached
// to the side it happened to be drawn on.
{
  const dev = ".react-flow__node:not(:has(.cv-note))";
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);

  /** Which way the link sets off from its source.
   *
   *  Checking that the path's start point moved would prove nothing — moving
   *  a node moves the end of its link whatever side it is attached to. The
   *  direction of the first segment is the side: a link on the bottom handle
   *  sets off downwards, one on the right handle sets off to the right. */
  const leavesTowards = async () => {
    const d = await page.locator(".react-flow__edge-path").first().getAttribute("d");
    const nums = (d ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
    if (nums.length < 4) return null;
    const [x0, y0] = [nums[0], nums[1]];
    // The first point that is actually somewhere else.
    for (let i = 2; i + 1 < nums.length; i += 2) {
      const dx = nums[i] - x0;
      const dy = nums[i + 1] - y0;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
      return dy > 0 ? "down" : "up";
    }
    return null;
  };

  const before = await leavesTowards();
  check("a link stacked above its neighbour sets off downwards", before === "down", String(before));

  // Addressed by name. React Flow moves a dragged node to the end of the DOM
  // for z-order, so an index stops pointing at the same device after a drag.
  const lower = page.locator(".react-flow__node", { hasText: "Access switch" }).first();
  // Grabbed near its left edge and not shoved so far right that it ends up
  // underneath the inspector panel, where the next grab would hit the panel.
  const shove = async (dx, dy) => {
    const b = await lower.boundingBox();
    await page.mouse.move(b.x + 40, b.y + 22);
    await page.mouse.down();
    await page.mouse.move(b.x + 40 + dx, b.y + 22 + dy, { steps: 16 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  };

  await shove(430, -260);
  check("moved beside it, the link sets off sideways instead",
    (await leavesTowards()) === "right", String(await leavesTowards()));

  // And back: this is not a one-way change.
  await shove(-430, 260);
  check("moved back below, it sets off downwards again",
    (await leavesTowards()) === "down", String(await leavesTowards()));
}

// ---------------------------------------------------------------- ends
// Line style and what sits at each end, which is what a diagram uses to mean
// things the app cannot infer: a dashed line is a tunnel, a hollow circle is
// a demarcation point.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  const onLine = await pointOnEdge();
  if (onLine) await page.mouse.click(onLine.x, onLine.y);
  await page.waitForTimeout(350);

  const selectLabelled = (label) =>
    page.locator(".cv-inspector .cv-field", { hasText: label }).locator("select").first();

  const style = selectLabelled("Line style");
  check("the link inspector offers a line style", (await style.count()) === 1);
  if (await style.count()) {
    const solid = await page
      .locator(".react-flow__edge.selected .react-flow__edge-path")
      .first()
      .evaluate((el) => el.style.strokeDasharray);
    await style.selectOption("dotted");
    await page.waitForTimeout(300);
    const dotted = await page
      .locator(".react-flow__edge.selected .react-flow__edge-path")
      .first()
      .evaluate((el) => el.style.strokeDasharray);
    check("choosing a style changes the dash pattern", dotted !== solid && dotted !== "",
      `"${solid}" -> "${dotted}"`);
  }

  const finish = selectLabelled("Finish end");
  check("the link inspector offers an end shape", (await finish.count()) === 1);
  if (await finish.count()) {
    await finish.selectOption("circle");
    await page.waitForTimeout(300);
    const marked = await page
      .locator(".react-flow__edge.selected .react-flow__edge-path")
      .first()
      .evaluate((el) => ({
        end: el.getAttribute("marker-end"),
        // The marker has to exist, not just be referenced.
        defined: el.getAttribute("marker-end")
          ? !!document.querySelector(
              `#${(el.getAttribute("marker-end") ?? "").replace(/^url\(#|\)$/g, "")}`,
            )
          : false,
      }));
    check("the end shape is referenced and defined", marked.defined, JSON.stringify(marked));

    await finish.selectOption("none");
    await page.waitForTimeout(300);
    const bare = await page
      .locator(".react-flow__edge.selected .react-flow__edge-path")
      .first()
      .evaluate((el) => el.getAttribute("marker-end"));
    // Choosing nothing has to beat the flow direction, or there is no way to
    // take the arrow off a link that still animates one way.
    check("choosing nothing removes the arrow the direction would have drawn",
      bare === null, String(bare));
  }
}

// ---------------------------------------------------------------- ground
// A white ground for a document or a projector. The test that matters is not
// that the background changed but that everything drawn on it changed with
// it — a colour picked to glow on near-black is invisible on white.
{
  const luminance = (css) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css ?? "");
    if (!m) return null;
    return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
  };
  const sample = () =>
    page.evaluate(() => {
      const label = document.querySelector(".cv-glyph-label, .cv-node-label");
      const app = document.querySelector(".cv-app");
      const edge = document.querySelector(".react-flow__edge-path");
      return {
        text: label ? getComputedStyle(label).color : null,
        ground: app ? getComputedStyle(app).backgroundColor : null,
        edge: edge ? edge.style.stroke : null,
      };
    });

  const dark = await sample();
  const toggle = page.locator("button", { hasText: /background$/ }).first();
  check("the top bar offers the other ground", (await toggle.count()) === 1);

  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(600);
    const light = await sample();

    check("the ground turns white",
      (luminance(light.ground) ?? 0) > 0.85, String(light.ground));
    check("the text turns dark with it",
      (luminance(light.text) ?? 1) < 0.3 && (luminance(dark.text) ?? 0) > 0.6,
      `${dark.text} -> ${light.text}`);
    // The link colour has to change too. Leaving it is what makes a diagram
    // unreadable in a document, which is the whole reason for the option.
    check("a healthy link darkens rather than staying as it was",
      light.edge !== dark.edge && (luminance(light.edge) ?? 1) < (luminance(dark.edge) ?? 0),
      `${dark.edge} -> ${light.edge}`);

    await toggle.click();
    await page.waitForTimeout(600);
    const back = await sample();
    check("switching back restores the dark ground",
      back.text === dark.text && back.edge === dark.edge,
      `${JSON.stringify(back)}`);
  }
}

// ---------------------------------------------------------------- colour
// A link can be given a colour of its own — a fibre run, a carrier circuit —
// without ceasing to be a live link. The line changes; everything that
// reports health does not.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);

  const strokeOfFirstEdge = () =>
    page.locator(".react-flow__edge-path").first().evaluate((el) => el.style.stroke);
  // The edge that was actually clicked, which is not necessarily the first in
  // the document — selecting one moves it in the DOM.
  const strokeOfSelected = () =>
    page
      .locator(".react-flow__edge.selected .react-flow__edge-path")
      .first()
      .evaluate((el) => el.style.stroke);
  const dotFills = () =>
    page.locator(".react-flow__edges circle").evaluateAll((els) =>
      els.map((e) => e.getAttribute("fill")),
    );

  const healthyStroke = await strokeOfFirstEdge();
  const dotsBefore = await dotFills();
  check("a healthy link is drawn in its health colour",
    /rgb\(47, 191, 107\)|#2fbf6b/i.test(healthyStroke), healthyStroke);

  // Clicked on the line itself. The centre of an edge's bounding box is
  // usually empty space, and another edge's invisible hit area often sits
  // there instead.
  const onLine = await pointOnEdge();
  check("a point on a link can be clicked", onLine !== null, JSON.stringify(onLine));
  if (onLine) await page.mouse.click(onLine.x, onLine.y);
  await page.waitForTimeout(350);
  const mode = page.locator(".cv-inspector select").filter({ hasText: "Follow health" }).first();
  check("the link inspector offers a colour of its own", (await mode.count()) === 1);

  if (await mode.count()) {
    await mode.selectOption("fixed");
    await page.waitForTimeout(250);
    const swatch = page.locator('.cv-inspector input[type="color"]').first();
    check("choosing that reveals a colour picker", (await swatch.count()) === 1);
    await swatch.fill("#b76eff");
    await page.waitForTimeout(400);

    const painted = await strokeOfSelected();
    check("the line takes the colour it was given",
      /rgb\(183, 110, 255\)|#b76eff/i.test(painted), painted);

    // The whole point: it is still a live link.
    const dotsAfter = await dotFills();
    check("the travelling dots still report health, not the new colour",
      dotsAfter.length === dotsBefore.length &&
        dotsAfter.every((f) => !/b76eff/i.test(String(f))),
      JSON.stringify(dotsAfter.slice(0, 3)));
    check("and there are still dots travelling", dotsAfter.length > 0, `${dotsAfter.length}`);

    // And back.
    await mode.selectOption("status");
    await page.waitForTimeout(350);
    const restored = await strokeOfSelected();
    check("switching back restores the health colour",
      /rgb\(47, 191, 107\)|rgb\(228, 86, 74\)/i.test(restored), restored);
  }
}

// ---------------------------------------------------------------- drawing
// Every side of a device became a source so links can face any direction.
// That changes how connections are made, so drawing one by hand has to be
// checked rather than assumed still to work.
{
  await dismissRecovery();
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  const before = await page.locator(".react-flow__edge").count();

  const dev = ".react-flow__node:not(:has(.cv-note))";
  const from = await page.locator(dev).first().boundingBox();
  const to = await page.locator(dev).nth(2).boundingBox();

  // Handles are hidden until the node is hovered, so the pointer goes to the
  // glyph first — which is what a person does too.
  await page.mouse.move(from.x + from.width / 2, from.y + 22);
  await page.waitForTimeout(250);
  const handle = await page
    .locator(`${dev} >> nth=0 >> .react-flow__handle-right`)
    .boundingBox();
  check("a device offers a handle to drag from", handle !== null);

  if (handle) {
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 22, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await page.locator(".react-flow__edge").count();
    check("dragging from a handle to another device draws a link",
      after === before + 1, `${before} -> ${after}`);
  }

  // A link from a device to itself is never what anyone meant to draw, and
  // loose connections make it possible where it was not before.
  const selfBefore = await page.locator(".react-flow__edge").count();
  await page.mouse.move(from.x + from.width / 2, from.y + 22);
  await page.waitForTimeout(250);
  const h2 = await page.locator(`${dev} >> nth=0 >> .react-flow__handle-right`).boundingBox();
  if (h2) {
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + from.height - 10, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    check("a device cannot be linked to itself",
      (await page.locator(".react-flow__edge").count()) === selfBefore,
      `${selfBefore} -> ${await page.locator(".react-flow__edge").count()}`);
  }
}

// ---------------------------------------------------------------- hops
// Two lines meeting at a point look exactly like two lines joined at a point.
// A hop is the convention that says they pass.
{
  const arcs = () =>
    page.locator(".react-flow__edge-path").evaluateAll((els) =>
      els.reduce((n, e) => n + ((e.getAttribute("d") ?? "").match(/A\d/g) ?? []).length, 0),
    );
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(400);

  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  const off = page.locator(".cv-menu button", { hasText: "Stop hopping crossed links" });
  check("the canvas menu offers hops", (await off.count()) === 1);

  if (await off.count()) {
    await off.click();
    await page.waitForTimeout(500);
    check("turning them off leaves no arcs", (await arcs()) === 0, `${await arcs()}`);

    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
    await page.waitForTimeout(250);
    await page.locator(".cv-menu button", { hasText: "Hop crossed links" }).click();
    await page.waitForTimeout(600);
    check("turning them back on is offered and works",
      (await page.locator(".cv-menu").count()) === 0);
  }
}

// ---------------------------------------------------------------- tracing
// On a meshed diagram links necessarily cross, and no routing removes that.
// Pointing at one has to fade the others so that one can be followed.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);

  // A point actually on the line. The centre of an edge's bounding box is
  // usually empty space — an L-shaped path passes nowhere near it — so the
  // path data is read and a real point on it mapped into screen coordinates.
  const opacities = async () =>
    page.locator(".react-flow__edge").evaluateAll((els) =>
      els.map((e) => Number(getComputedStyle(e).opacity)),
    );

  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  const before = await opacities();
  check("with nothing pointed at, every link is fully drawn",
    before.every((o) => o > 0.9), JSON.stringify(before));

  const at = await pointOnEdge();
  check("a point on a link can be found", at !== null, JSON.stringify(at));
  if (at) {
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(400);
    const after = await opacities();
    check("pointing at a link fades the others",
      after.filter((o) => o < 0.5).length >= 1, JSON.stringify(after));
    check("the link pointed at stays fully drawn",
      after.some((o) => o > 0.9), JSON.stringify(after));

    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    const back = await opacities();
    check("moving away brings them all back", back.every((o) => o > 0.9), JSON.stringify(back));
  }
}

// ---------------------------------------------------------------- holding
// A link can be held in place deliberately, and there has to be a way back.
{
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  const item = page.locator(".cv-menu button", { hasText: "Let every link follow its devices" });
  check("the canvas menu offers releasing held links", (await item.count()) === 1);
  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(350);
    const said = (await page.locator(".cv-panel-message").first().textContent()) ?? "";
    check("with none held it says so rather than pretending to work",
      /already follows/.test(said), said.slice(0, 90));
  }
}

// ---------------------------------------------------------------- bulk
// Editing a whole selection. The rule that matters is that it changes only
// what it was asked to: a bulk editor which quietly overwrites the rest is
// worse than none at all.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);

  const devs = page.locator(".react-flow__node:not(:has(.cv-note))");
  const total = await devs.count();
  await devs.nth(0).click();
  await devs.nth(1).click({ modifiers: ["Control"] });
  await page.waitForTimeout(300);

  const title = await page.locator(".cv-inspector-title").first().innerText().catch(() => "");
  check("selecting two devices opens a bulk editor", /2 selected/.test(title), title.replace(/\n/g, " "));

  const typeSelect = page.locator(".cv-inspector select").first();
  const hasType = (await typeSelect.count()) > 0;
  check("the bulk editor offers a device type", hasType);

  if (hasType) {
    // The two devices start as different types, so it must say mixed rather
    // than showing one of them.
    const shown = await typeSelect.inputValue();
    check("a mixed selection says mixed instead of picking one", shown === "", `value="${shown}"`);

    await typeSelect.selectOption("router");
    await page.waitForTimeout(350);

    // Both are now routers; a third device must be untouched.
    await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
    await page.waitForTimeout(200);
    await devs.nth(0).click();
    await devs.nth(1).click({ modifiers: ["Control"] });
    await page.waitForTimeout(300);
    const after = await page.locator(".cv-inspector select").first().inputValue();
    check("setting a type applies it to the whole selection", after === "router", `value="${after}"`);
  }

  // Tagging.
  // Scoped to the inspector: the views panel in the palette uses the same row
  // class, and an unscoped match found that one first.
  const tagField = page.locator(".cv-inspector .cv-row-tight input").first();
  if (await tagField.count()) {
    await tagField.fill("site-hq");
    await page.locator(".cv-inspector .cv-row-tight button", { hasText: "Add" }).first().click();
    await page.waitForTimeout(350);
    const tags = await page.locator(".cv-tag-row .cv-tag").allTextContents();
    check("a tag lands on every selected device", tags.some((t) => t.includes("site-hq")), JSON.stringify(tags));

    // A third device must not have picked it up. Asserted rather than
    // guarded on: a check that quietly skips itself is not a check.
    check("there is a third device to check against", total > 2, `${total} devices`);
    await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
    await page.waitForTimeout(200);
    await devs.nth(2).click();
    await page.waitForTimeout(300);
    const lone = await page.locator(".cv-inspector").innerText();
    check("a device outside the selection is untouched", !/site-hq/.test(lone), lone.slice(0, 120).replace(/\n/g, " "));
  }

  // One undo, not one per device.
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  await devs.nth(0).click();
  await devs.nth(1).click({ modifiers: ["Control"] });
  await page.waitForTimeout(250);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  await devs.nth(0).click();
  await page.waitForTimeout(300);
  const undone = await page.locator(".cv-inspector").innerText();
  check("one undo reverses the whole bulk change", !/site-hq/.test(undone), undone.slice(0, 120).replace(/\n/g, " "));
}

await dismissRecovery();
// ---------------------------------------------------------------- sections
// A labelled area that holds whatever is standing in it. Membership is
// geometric, so nothing has to be re-assigned when a device is dragged in.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  const before = await nodeCount();

  const item = page.locator(".cv-palette-item", { hasText: "Section" }).first();
  check("the palette offers a section", (await item.count()) === 1);

  if (await item.count()) {
    // Dropped over the two devices that are stacked in the fixture, so it
    // lands holding them.
    await item.dragTo(page.locator(".react-flow__pane"), {
      targetPosition: { x: 300, y: 300 },
    });
    await page.waitForTimeout(500);
    check("dropping a section adds one node", (await nodeCount()) === before + 1,
      `${before} -> ${await nodeCount()}`);

    const zone = page.locator(".cv-zone").first();
    check("it is drawn as a section", (await zone.count()) === 1);

    // The point of the layering: a device standing in a section must still be
    // reachable. A section drawn over its contents turns the diagram into a
    // set of empty boxes.
    const box = await zone.boundingBox();
    const held = await page
      .locator(`.react-flow__node:not(:has(.cv-zone)):not(:has(.cv-note))`)
      .filter({ hasText: "Bystander" })
      .first();
    const heldBox = await held.boundingBox();
    const overlapping =
      heldBox &&
      heldBox.x < box.x + box.width &&
      heldBox.x + heldBox.width > box.x &&
      heldBox.y < box.y + box.height &&
      heldBox.y + heldBox.height > box.y;
    check("the section was dropped over a device", Boolean(overlapping),
      `${JSON.stringify(box)} vs ${JSON.stringify(heldBox)}`);

    if (overlapping) {
      await page.mouse.click(heldBox.x + heldBox.width / 2, heldBox.y + 22);
      await page.waitForTimeout(350);
      const title = await page.locator(".cv-inspector-title").first().innerText();
      check("a device standing in a section is still selectable",
        /Node/i.test(title), title.replace(/\n/g, " ").slice(0, 60));
    }

    // Dragging the section carries what is standing in it.
    const wasAt = await held.boundingBox();
    // By its own title text — the one pixel that is unambiguously the
    // section's: the body is a backdrop under the devices, and the bottom
    // edge can run behind the bottom panel.
    const titleBox = await zone.locator(".cv-node-label").first().boundingBox();
    await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(titleBox.x + titleBox.width / 2 + 90, titleBox.y + titleBox.height / 2 + 60, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    const nowAt = await held.boundingBox();
    check("dragging a section carries what is standing in it",
      nowAt && wasAt && Math.abs(nowAt.x - wasAt.x) > 40,
      `${Math.round(wasAt?.x ?? 0)} -> ${Math.round(nowAt?.x ?? 0)}`);

    // Removed, so later checks meet the diagram they expect.
    await zone.click({ position: { x: 6, y: 6 } });
    await page.waitForTimeout(200);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    check("the section can be deleted again", (await page.locator(".cv-zone").count()) === 0);
  }
}

await dismissRecovery();
// ---------------------------------------------------------------- guides
// Grid snapping is not the same as being in line: two devices can both sit on
// the grid and still be a few pixels out from each other, and a few pixels out
// is what a diagram looks untidy for.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const named = (label) => page.locator(".react-flow__node", { hasText: label }).first();
  const leftOf = async (label) => (await named(label).boundingBox()).x;

  const anchor = await named("Core switch").boundingBox();
  const mover = await named("Bystander").boundingBox();

  // Where a dragged node ends up relative to the pointer depends on the zoom,
  // so rather than predicting it, the pointer is moved, the result measured,
  // and the difference corrected. That leaves the check about whether the
  // device lines up, not about React Flow's drag arithmetic.
  let pointer = { x: mover.x + 30, y: mover.y + 22 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(anchor.x + 3, pointer.y, { steps: 20 });
  pointer = { x: anchor.x + 3, y: pointer.y };
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(120);
    const now = await named("Bystander").boundingBox();
    const off = anchor.x + 3 - now.x;
    if (Math.abs(off) < 1) break;
    pointer = { x: pointer.x + off, y: pointer.y };
    await page.mouse.move(pointer.x, pointer.y, { steps: 3 });
  }
  await page.waitForTimeout(250);

  const shown = await page.locator(".cv-guide").count();
  check("a guide appears while dragging into line", shown >= 1, `${shown} guides`);

  await page.mouse.up();
  await page.waitForTimeout(400);
  check("the guide goes when the drag ends", (await page.locator(".cv-guide").count()) === 0);

  const gap = Math.abs((await leftOf("Bystander")) - (await leftOf("Core switch")));
  check("the device lands exactly in line", gap < 2, `${gap.toFixed(1)}px out`);

  // Alt refuses the snap: sometimes a device has to sit deliberately a few
  // pixels off, and a snap that cannot be refused is one that gets fought.
  {
    const m2 = await named("Bystander").boundingBox();
    await page.keyboard.down("Alt");
    await page.mouse.move(m2.x + 30, m2.y + 22);
    await page.mouse.down();
    await page.mouse.move(m2.x + 30 + 57, m2.y + 22 + 3, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await page.waitForTimeout(350);
    const offBy = Math.abs((await leftOf("Bystander")) - (await leftOf("Core switch")));
    check("holding Alt lets it sit off-line on purpose", offBy > 10, `${offBy.toFixed(1)}px off`);
    check("and no guide is shown for a refused snap",
      (await page.locator(".cv-guide").count()) === 0);
  }
}

// ---------------------------------------------------------------- spacing
// Lining up is half of tidy; the other half is the gaps being equal. Three
// devices dropped in a row should end up evenly spaced without measuring.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const drop = async (at) => {
    const before = await nodeCount();
    await page.locator(".cv-palette-item", { hasText: "Router" }).first()
      .dragTo(page.locator(".react-flow__pane"), { targetPosition: at });
    await page.waitForTimeout(350);
    return (await nodeCount()) === before + 1;
  };

  // Kept well clear of the bottom panel, which overlaps the canvas and will
  // swallow a pointer-down aimed at a device placed under it.
  check("three devices can be placed", (await drop({ x: 200, y: 470 }))
    && (await drop({ x: 460, y: 470 })) && (await drop({ x: 760, y: 470 })));

  // A freshly dropped device is selected, and a selected device is not a
  // target to line up against — it may be moving too.
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const routers = page.locator(".react-flow__node", { hasText: "Router" });
  const boxOf = async (i) => routers.nth(i).boundingBox();
  /** The node's own position, in diagram units, straight off its transform.
   *  Screen pixels carry the zoom and a rounding at every step; this is the
   *  number the app is actually reasoning about. */
  const posOf = async (i) =>
    routers.nth(i).evaluate((el) => {
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform ?? "");
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });

  const [p0, p1] = [await posOf(0), await posOf(1)];
  const wantsDiagram = p1.x + (p1.x - p0.x);
  const r1 = await boxOf(1);
  const r2 = await boxOf(2);
  const wants = r1.x + (r1.x - (await boxOf(0)).x);

  // Nudged to just inside the tolerance of where the rhythm says it belongs.
  let pointer = { x: r2.x + 30, y: r2.y + 22 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(wants + 2, r1.y + 22, { steps: 18 });
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(110);
    const now = await boxOf(2);
    const dx = wants + 2 - now.x;
    const dy = r1.y - now.y;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) break;
    pointer = { x: pointer.x + dx, y: pointer.y + dy };
    await page.mouse.move(pointer.x, pointer.y, { steps: 3 });
  }
  await page.waitForTimeout(200);
  check("a guide shows the rhythm it has found",
    (await page.locator(".cv-guide").count()) >= 1);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const landedAt = await posOf(2);
  check("the third device lands at the same gap as the first two",
    Math.abs(landedAt.x - wantsDiagram) < 1,
    `${Math.abs(landedAt.x - wantsDiagram).toFixed(1)} units out (at ${landedAt.x.toFixed(0)}, wanted ${wantsDiagram.toFixed(0)})`);
}

// ---------------------------------------------------------------- views
// A network is documented more than once. Views share every device and almost
// no links, and three separate files disagree within a fortnight.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const panel = page.locator(".cv-layers");
  check("the palette offers views", (await panel.count()) === 1);
  // Opened directly rather than by clicking the summary, which toggles — and
  // scrolled to, because the palette is a long column.
  await panel.evaluate((el) => {
    el.open = true;
    el.scrollIntoView();
  });
  await page.waitForTimeout(300);

  const before = await nodeCount();
  await page.locator(".cv-layers-add input").fill("Logical");
  await page.locator(".cv-layers-add button", { hasText: "Add" }).click();
  await page.waitForTimeout(400);
  const names = await page.locator(".cv-layer-name").evaluateAll((els) => els.map((e) => e.value));
  check("a view can be added", names.includes("Logical"), JSON.stringify(names));
  check("adding a view hides nothing", (await nodeCount()) === before, `${before} -> ${await nodeCount()}`);

  // Put one device on the new view, then hide it. The view is fitted first:
  // by this point earlier checks have dragged devices around and panned the
  // canvas, and a device off-screen cannot be clicked.
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".react-flow__node:not(:has(.cv-note))").first().click();
  await page.waitForTimeout(350);
  const picker = page.locator(".cv-inspector .cv-field", { hasText: "Appears on" });
  check("a device can be put on a view", (await picker.count()) === 1);
  // The inspector is a long scrollable column; the picker has to be brought
  // into the window before it can be clicked.
  await picker.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await picker.locator(".cv-tag", { hasText: "Logical" }).click();
  await page.waitForTimeout(300);

  // Addressed by label: the view's name lives in an input's value, which a
  // text match cannot see.
  await page.getByLabel("Hide Logical").click();
  await page.waitForTimeout(450);
  check("hiding a view takes its objects off the diagram",
    (await nodeCount()) === before - 1, `${before} -> ${await nodeCount()}`);

  await page.getByLabel("Show Logical").click();
  await page.waitForTimeout(450);
  check("showing it again brings them back", (await nodeCount()) === before);

  // Putting a whole selection on a view at once — the reason to have views is
  // to say "these forty are the physical layer", and one at a time is the work
  // the bulk editor exists to remove.
  {
    // The drag checks above leave devices stacked on one another, so a click
    // lands on whichever is on top. Tidying spreads them out again — which is
    // what it is for.
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
    await page.waitForTimeout(250);
    await page.locator(".cv-menu button", { hasText: "Tidy the layout" }).click();
    await page.waitForTimeout(450);
    await page.locator("button", { hasText: "Fit view" }).first().click();
    await page.waitForTimeout(500);
    // Clicked on each device own glyph: after the drag checks above, node
    // boxes overlap and a centre click lands on whichever is on top.
    const devs = page.locator(".react-flow__node:not(:has(.cv-note))");
    await devs.nth(0).locator(".cv-glyph-node").click();
    await devs.nth(1).locator(".cv-glyph-node").click({ modifiers: ["Control"] });
    await page.waitForTimeout(350);
    const bulk = page.locator(".cv-inspector .cv-field", { hasText: "Appears on" });
    check("the bulk editor offers views", (await bulk.count()) === 1);
    if (await bulk.count()) {
      await bulk.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(200);
      await bulk.locator(".cv-tag", { hasText: "Logical" }).click();
      await page.waitForTimeout(400);
      await page.getByLabel("Hide Logical").click();
      await page.waitForTimeout(450);
      check("a selection can be put on a view in one go",
        (await nodeCount()) === before - 2, `${before} -> ${await nodeCount()}`);
      await page.getByLabel("Show Logical").click();
      await page.waitForTimeout(400);
      check("and taken back off", (await nodeCount()) === before);
    }
  }

  // A view hidden to prepare a document must not reappear in the document.
  await page.getByLabel("Hide Logical").click();
  await page.waitForTimeout(400);
  {
    const downloads = [];
    page.on("download", (d) => downloads.push(d));
    await page.locator(".cv-dropdown summary", { hasText: "Export" }).first().click();
    await page.waitForTimeout(250);
    await page.locator(".cv-dropdown-menu button", { hasText: "Diagram as SVG" }).click();
    await page.waitForTimeout(1200);
    const fs = await import("node:fs/promises");
    const path = downloads[0] ? await downloads[0].path() : null;
    const svg = path ? await fs.readFile(path, "utf8") : "";
    check("the export leaves out a hidden view",
      svg.length > 0 && !svg.includes("Core switch"),
      `${svg.length} bytes${svg.includes("Core switch") ? ", still has the hidden device" : ""}`);
    check("but keeps everything else", svg.includes("Bystander"));
  }
  await page.getByLabel("Show Logical").click();
  await page.waitForTimeout(400);

  // Removing a view must not remove the network.
  await page.getByLabel("Remove Logical").click();
  await page.waitForTimeout(450);
  check("removing a view keeps what was on it",
    (await nodeCount()) === before, `${before} -> ${await nodeCount()}`);
}

// ---------------------------------------------------------------- callouts
// A line out of a piece of text is a remark about the diagram, not a cable.
{
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const item = page.locator(".cv-palette-item", { hasText: "Callout" }).first();
  check("the palette offers a callout", (await item.count()) === 1);

  const edgeIds = () =>
    page.locator(".react-flow__edge").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-id") ?? ""),
    );
  const idsBefore = await edgeIds();
  const edgesBefore = idsBefore.length;
  await item.dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 200, y: 130 } });
  await page.waitForTimeout(450);

  const callout = page.locator(".cv-node[data-shape='callout']").first();
  check("it lands as a callout", (await callout.count()) === 1);

  if (await callout.count()) {
    // Draw a line from it to a device.
    const from = await callout.boundingBox();
    // Whatever device is actually on screen — by this point the earlier checks
    // have moved things about, and a named one may be outside the view.
    const target = await page
      .locator(".react-flow__node:not(:has(.cv-note)):not(:has(.cv-node[data-shape='callout']))")
      .first()
      .boundingBox();
    check("there is a device to point at", target !== null);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.waitForTimeout(250);
    const wrapper = page.locator(".react-flow__node:has(.cv-node[data-shape='callout'])").first();
    const handle = await wrapper.locator(".react-flow__handle-right").boundingBox().catch(() => null);
    // Asserted rather than guarded on: a check that quietly skips itself is
    // not a check.
    check("the callout offers a handle to draw from", handle !== null);
    if (handle) {
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      // The left-edge midpoint is the left handle since LT-053 put handles on
      // the node's real edges; a fixed +22 from the top misses at some zooms.
      await page.mouse.move(target.x + 3, target.y + target.height / 2, { steps: 18 });
      // React Flow needs a moment with the pointer over the target before it
      // treats the drop as landing on it.
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(500);
      check("a line can be drawn from a callout",
        (await page.locator(".react-flow__edge").count()) === edgesBefore + 1,
        `${edgesBefore} -> ${await page.locator(".react-flow__edge").count()}`);

      // Found by id rather than by position: React Flow reorders edges for
      // z-order, so "the last one" is not reliably the one just drawn — which
      // made this check read a different link and fail about one run in three.
      const added = (await edgeIds()).filter((id) => id && !idsBefore.includes(id));
      check("the new line can be identified", added.length === 1, JSON.stringify(added));
      const last = page.locator(`.react-flow__edge[data-id="${added[0]}"]`);
      const marker = await last.locator("path.react-flow__edge-path")
        .getAttribute("marker-end").catch(() => null);
      check("a leader carries no arrowhead", marker === null, String(marker));
      const dots = await last.locator("circle").count();
      check("nothing travels along a leader", dots === 0, `${dots} dots`);
    }
  }
}

// ---------------------------------------------------------------- printing
// Paper is white. A diagram printed straight from the dark ground comes out as
// pale grey lines on a white page.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  // Make sure we are on the dark ground, which is the case that used to fail.
  const toggle = page.locator("button", { hasText: /background$/ }).first();
  if ((await toggle.innerText()) === "Dark background") {
    await toggle.click();
    await page.waitForTimeout(500);
  }

  const inkNow = () =>
    page.evaluate(() => {
      const el = document.querySelector(".cv-glyph-label, .cv-node-label");
      return el ? getComputedStyle(el).color : null;
    });
  const luminance = (css) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css ?? "");
    return m ? (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 : null;
  };

  check("the diagram is on the dark ground to begin with",
    (luminance(await inkNow()) ?? 0) > 0.6, String(await inkNow()));

  // Print styling is applied without actually printing.
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(300);
  const printed = await inkNow();
  check("printing puts the text in ink that reads on paper",
    (luminance(printed) ?? 1) < 0.3, String(printed));

  const chrome = await page.locator(".cv-topbar").evaluate((el) => getComputedStyle(el).display);
  check("the tools are not printed", chrome === "none", chrome);

  await page.emulateMedia({ media: "screen" });
  await page.waitForTimeout(300);
  check("and the screen is unchanged afterwards",
    (luminance(await inkNow()) ?? 0) > 0.6, String(await inkNow()));
}

// ---------------------------------------------------------------- colour by
// "Which of these are on the management VLAN" is a question a network diagram
// answers with colour and a general drawing tool cannot answer at all.
{
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const glyphInk = () =>
    page.locator(".cv-glyph-art svg, .cv-node-icon svg").first()
      .evaluate((el) => getComputedStyle(el).color);
  const byHealth = await glyphInk();

  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 200 } });
  await page.waitForTimeout(250);
  const item = page.locator(".cv-menu button", { hasText: "Colour devices by subnet" });
  check("the canvas menu offers colouring by subnet", (await item.count()) === 1);

  // The menu has to fit on the screen. Opened near the bottom it used to run
  // off the edge, and the items past the edge were unreachable — worst for
  // the longest menus, which are the ones worth opening.
  const menuBox = await page.locator(".cv-menu").boundingBox();
  const viewport = page.viewportSize();
  check("the menu stays inside the window",
    menuBox.y >= 0 && menuBox.y + menuBox.height <= viewport.height + 1,
    `${Math.round(menuBox.y)}..${Math.round(menuBox.y + menuBox.height)} of ${viewport.height}`);

  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(500);

    check("a legend says what the colours mean",
      (await page.locator(".cv-legend").count()) === 1);
    const legend = await page.locator(".cv-legend").innerText();
    check("it names the subnets it found", /\d+\.\d+\.\d+\.0\/24/.test(legend),
      legend.replace(/\n/g, " ").slice(0, 90));

    check("the devices are repainted", (await glyphInk()) !== byHealth,
      `${byHealth} -> ${await glyphInk()}`);

    // And back, from the legend itself.
    await page.locator(".cv-legend-off").click();
    await page.waitForTimeout(400);
    check("the legend can turn itself off", (await page.locator(".cv-legend").count()) === 0);
    check("and health colouring comes back", (await glyphInk()) === byHealth,
      `${byHealth} -> ${await glyphInk()}`);
  }
}

// ---------------------------------------------------------------- page
// A file sized to its own contents is right for the screen and wrong for a
// document: whoever pastes it scales it, badly, once per document.
{
  const downloads = [];
  page.on("download", (d) => downloads.push(d));

  await page.locator(".cv-dropdown summary", { hasText: "Export" }).first().click();
  await page.waitForTimeout(250);

  const paperSelect = page.locator(".cv-dropdown-field select").first();
  check("the export menu offers a page size", (await paperSelect.count()) === 1);

  const before = await page.locator(".cv-dropdown-field .cv-help").innerText();
  check("it starts sized to the diagram", /sized to the diagram/i.test(before), before);

  await paperSelect.selectOption("a4");
  await page.waitForTimeout(300);
  const after = await page.locator(".cv-dropdown-field .cv-help").innerText();
  check("it says what will happen on that page", /A4 landscape/.test(after), after);

  await page.locator(".cv-dropdown-menu button", { hasText: "Diagram as SVG" }).click();
  await page.waitForTimeout(1400);

  const fs = await import("node:fs/promises");
  const path = downloads.length ? await downloads[downloads.length - 1].path() : null;
  const svg = path ? await fs.readFile(path, "utf8") : "";
  // A4 landscape at 96 dpi.
  check("the file comes out at the page size",
    /width="1123"/.test(svg) && /height="794"/.test(svg),
    svg.slice(svg.indexOf("<svg"), svg.indexOf("<svg") + 90));
  check("the whole sheet is painted, not just the drawing",
    /<rect width="100%" height="100%"/.test(svg));
  check("the drawing is scaled and centred as one piece",
    /<g transform="translate\([\d.]+, [\d.]+\) scale\([\d.]+\)">/.test(svg));

  // Put it back so nothing after this inherits a page size.
  await page.locator(".cv-dropdown summary", { hasText: "Export" }).first().click();
  await page.waitForTimeout(200);
  await paperSelect.selectOption("fit");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
}

await dismissRecovery();
// ---------------------------------------------------------------- arrange
// The guides handle the device being dragged. This is the other half: several
// already placed and none of them quite in line, which is one command rather
// than five careful drags.
{
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  await page.locator(".cv-menu button", { hasText: "Tidy the layout" }).click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(500);

  const devs = page.locator(".react-flow__node:not(:has(.cv-note))");
  const posOf = async (i) =>
    devs.nth(i).evaluate((el) => {
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform ?? "");
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });

  await devs.nth(0).locator(".cv-glyph-node").click();
  await devs.nth(1).locator(".cv-glyph-node").click({ modifiers: ["Control"] });
  await page.waitForTimeout(300);

  await devs.nth(0).click({ button: "right", position: { x: 10, y: 10 } });
  await page.waitForTimeout(300);
  const item = page.locator(".cv-menu button", { hasText: "Line up their left edges" });
  check("a multiple selection can be lined up", (await item.count()) === 1);

  if (await item.count()) {
    // The keyboard half first: Ctrl+Alt+T lines up their tops.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    if (await page.locator(".cv-menu").count()) {
      // Belt and braces: the menu also closes on an outside press.
      await page.mouse.click(60, 640);
      await page.waitForTimeout(250);
    }
    check("the context menu is closed before the keyboard half",
      (await page.locator(".cv-menu").count()) === 0);
    // By name, not by index: clicking a node reorders the DOM, so nth(1)
    // after a click can be the node just clicked — the handover's 6.2 trap.
    const two = ["Core switch", "Bystander"];
    const byName = (n) => page.locator(".react-flow__node", { hasText: n }).first();
    const yOf = (n) => byName(n).evaluate((el) => {
      const m = /,\s*(-?[\d.]+)px\)/.exec(el.style.transform ?? "");
      return m ? Number(m[1]) : 0;
    });
    const yBefore = [await yOf(two[0]), await yOf(two[1])];
    await byName(two[0]).locator(".cv-glyph-node").click();
    await byName(two[1]).locator(".cv-glyph-node").click({ modifiers: ["Control"] });
    await page.waitForTimeout(250);
    // At least the two named ones; a leftover from the menu step may ride
    // along, which the align handles fine.
    check("a multiple selection is in place for the keyboard align",
      (await page.locator(".react-flow__node.selected").count()) >= 2);
    await page.keyboard.press("Control+Alt+t");
    await page.waitForTimeout(400);
    const yAfter = [await yOf(two[0]), await yOf(two[1])];
    check("Ctrl+Alt+T lines up their tops from the keyboard",
      Math.abs(yAfter[0] - yAfter[1]) < 0.5 &&
        Math.abs(Math.min(...yAfter) - Math.min(...yBefore)) < 0.5,
      `${yBefore.map((v)=>v.toFixed(0))} -> ${yAfter.map((v)=>v.toFixed(0))}`);

    // The menu was closed for the keyboard half; open it again on one of the
    // still-selected devices for the mouse half.
    // The glyph's own pixels, not a corner offset: below the old 0.5x fit
    // floor (LT-047) the corner of one node can sit under a neighbour.
    await byName(two[0]).locator(".cv-glyph-node").click({ button: "right" });
    await page.waitForTimeout(300);
    const xOf = (n) => byName(n).evaluate((el) => {
      const m = /translate\((-?[\d.]+)px/.exec(el.style.transform ?? "");
      return m ? Number(m[1]) : 0;
    });
    const before = [{ x: await xOf(two[0]) }, { x: await xOf(two[1]) }];
    await item.click();
    await page.waitForTimeout(450);
    const after = [{ x: await xOf(two[0]) }, { x: await xOf(two[1]) }];
    check("their left edges end up the same",
      Math.abs(after[0].x - after[1].x) < 0.5,
      `${after[0].x.toFixed(1)} vs ${after[1].x.toFixed(1)}`);
    check("at the leftmost of them, not the average",
      Math.abs(after[0].x - Math.min(before[0].x, before[1].x)) < 0.5,
      `${after[0].x.toFixed(1)} from ${before.map((b) => b.x.toFixed(1)).join(", ")}`);
    check("and nothing is added or removed", (await devs.count()) >= 2);
  }
}

// ---------------------------------------------------------------- copying
// Two switches and the link between them, repeated for eleven wiring closets,
// is most of what drawing a real network consists of.
{
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  await page.locator(".cv-menu button", { hasText: "Tidy the layout" }).click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(500);

  const devs = page.locator(".react-flow__node:not(:has(.cv-note))");
  const before = await nodeCount();
  const edgesBefore = await page.locator(".react-flow__edge").count();

  // Selection cleared first, then each device taken by its glyph — the middle
  // of a node is often under a neighbour's connection handle after a tidy,
  // and a click there is swallowed without selecting anything.
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);
  await devs.nth(0).locator(".cv-glyph-node").click();
  await page.waitForTimeout(200);
  await devs.nth(1).locator(".cv-glyph-node").click({ modifiers: ["Control"] });
  await page.waitForTimeout(350);
  const picked = await page.locator(".react-flow__node.selected").count();
  check("two devices are selected to copy", picked === 2, `${picked} selected`);

  await page.keyboard.press("Control+c");
  await page.waitForTimeout(300);
  check("copying says what it took",
    /Copied 2 objects/.test(await page.locator(".cv-panel-message").first().textContent() ?? ""),
    (await page.locator(".cv-panel-message").first().textContent()) ?? "");

  await page.keyboard.press("Control+v");
  await page.waitForTimeout(500);
  check("pasting adds the copies", (await nodeCount()) === before + 2,
    `${before} -> ${await nodeCount()}`);

  // A link whose two ends were both copied comes with them; one with an end
  // outside the selection does not, because it has nowhere to land.
  const edgesAfter = await page.locator(".react-flow__edge").count();
  check("links inside the selection come too, and no others",
    edgesAfter >= edgesBefore, `${edgesBefore} -> ${edgesAfter}`);

  // Pasting again must make a row, not a stack nobody can separate.
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(500);
  check("pasting twice adds two more", (await nodeCount()) === before + 4);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  check("both pastes undo", (await nodeCount()) === before, `${before} -> ${await nodeCount()}`);

  // Select all, which is the other half of working on more than one thing.
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(350);
  const selected = await page.locator(".react-flow__node.selected").count();
  check("select all takes everything", selected === before, `${selected} of ${before}`);
}

await dismissRecovery();
// ---------------------------------------------------------------- handling
// How it is driven, which is the way Lucidchart and Visio do it because that
// is what anyone opening this already knows.
{
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  await page.locator(".cv-menu button", { hasText: "Tidy the layout" }).click();
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(250);

  const devs = page.locator(".react-flow__node:not(:has(.cv-note))");
  const flowPos = (loc) =>
    loc.evaluate((el) => {
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform ?? "");
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });

  // A click in the middle of a device selects it. An invisible connection
  // handle belonging to a neighbour used to sit over that spot and swallow it.
  const first = await devs.nth(0).boundingBox();
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.waitForTimeout(300);
  check("a click in the middle of a device selects it",
    (await page.locator(".react-flow__node.selected").count()) === 1,
    `${await page.locator(".react-flow__node.selected").count()} selected`);

  // Left-drag across bare canvas draws a selection box.
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(200);
  const a = await devs.nth(0).boundingBox();
  const b = await devs.nth(1).boundingBox();
  const left = Math.min(a.x, b.x) - 25;
  const top = Math.min(a.y, b.y) - 25;
  const right = Math.max(a.x + a.width, b.x + b.width) + 25;
  const bottom = Math.max(a.y + a.height, b.y + b.height) + 25;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const caught = await page.locator(".react-flow__node.selected").count();
  check("dragging across bare canvas selects what it covers", caught >= 2, `${caught} caught`);

  // And they move together.
  if (caught >= 2) {
    const was = [await flowPos(devs.nth(0)), await flowPos(devs.nth(1))];
    const grab = await devs.nth(0).boundingBox();
    await page.mouse.move(grab.x + grab.width / 2, grab.y + 22);
    await page.mouse.down();
    await page.mouse.move(grab.x + grab.width / 2 + 130, grab.y + 22 + 70, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    const now = [await flowPos(devs.nth(0)), await flowPos(devs.nth(1))];
    const moved = now.map((p, i) => p.x - was[i].x);
    check("a selection moves together",
      Math.abs(moved[0]) > 40 && Math.abs(moved[0] - moved[1]) < 2,
      `${moved.map((m) => m.toFixed(0)).join(" vs ")}`);
  }

  // Space held drags the whole diagram: everything shifts on screen and
  // nothing moves on the diagram.
  //
  // Watched by name. React Flow reorders nodes in the document as they are
  // selected and dragged, so comparing "the first one" before and after is
  // comparing two different devices.
  const witness = page.locator(".react-flow__node", { hasText: "Bystander" }).first();
  const screenWas = await witness.boundingBox();
  const flowWas = await flowPos(witness);
  await page.keyboard.down("Space");
  await page.waitForTimeout(250);
  check("holding space puts the canvas in hand mode",
    (await page.locator(".cv-canvas.is-panning").count()) === 1,
    `class: ${await page.locator(".cv-canvas").first().getAttribute("class")}`);
  await page.mouse.move(700, 460);
  await page.mouse.down();
  await page.mouse.move(520, 360, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await page.waitForTimeout(400);
  const screenNow = await witness.boundingBox();
  const flowNow = await flowPos(witness);
  check("holding space and dragging moves the whole diagram",
    Math.abs(screenNow.x - screenWas.x) > 80,
    `${Math.round(screenNow.x - screenWas.x)}px on screen`);
  check("and moves nothing on it",
    Math.abs(flowNow.x - flowWas.x) < 0.5,
    `${(flowNow.x - flowWas.x).toFixed(1)} units`);

  // Double-click on bare canvas writes text where you clicked.
  const before = await nodeCount();
  const pane = await page.locator(".react-flow__pane").boundingBox();
  await page.mouse.dblclick(pane.x + pane.width - 140, pane.y + 90);
  await page.waitForTimeout(500);
  check("double-clicking bare canvas adds text", (await nodeCount()) === before + 1,
    `${before} -> ${await nodeCount()}`);
  check("and puts the cursor in it straight away",
    (await page.locator(".cv-inline-edit").count()) === 1);

  await page.keyboard.type("Rack 4 spare");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  const labels = await page.locator(".cv-node-label, .cv-glyph-label").allTextContents();
  check("what was typed is what it says", labels.some((t) => t === "Rack 4 spare"),
    JSON.stringify(labels.slice(-3)));

  const border = await page.locator(".cv-node[data-shape='text']").first()
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  check("text on the canvas has no box round it",
    /rgba\(0, 0, 0, 0\)|transparent/.test(border), border);
}

await dismissRecovery();
// ---------------------------------------------------------------- desk
// LT-046, superseding LT-034's light chrome: the white ground touches the
// canvas only. Panels, top bar and bottom panel keep the dark chrome in both
// grounds; the diagram becomes a white page on a warm light-brown desk.
{
  const toggle = page.locator("button", { hasText: /background$/ }).first();
  if ((await toggle.innerText()) === "White background") {
    await toggle.click();
    await page.waitForTimeout(600);
  }
  const read = (sel, prop) =>
    page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);

  check("the desk is the warm light brown that was asked for",
    (await read(".react-flow__pane", "backgroundColor")) === "rgb(233, 226, 211)",
    await read(".react-flow__pane", "backgroundColor"));
  check("the page is white and has an edge",
    (await read(".cv-page", "backgroundColor")) === "rgb(255, 255, 255)" &&
      (await read(".cv-page", "borderTopColor")) === "rgb(208, 199, 179)",
    `${await read(".cv-page", "backgroundColor")} / ${await read(".cv-page", "borderTopColor")}`);
  check("the grid is inside the page, not on the desk",
    (await page.locator(".cv-page .cv-page-grid").count()) === 1 &&
      (await page.locator(".react-flow__background").count()) === 0);

  // The chrome does not follow the ground: dark panels around a light canvas.
  const darkChrome = "rgb(18, 26, 36)";
  check("the top bar stays dark chrome on the white ground",
    (await read(".cv-topbar", "backgroundColor")) === darkChrome,
    await read(".cv-topbar", "backgroundColor"));
  check("the palette and the inspector stay dark chrome too",
    (await read(".cv-palette", "backgroundColor")) === darkChrome &&
      (await read(".cv-inspector", "backgroundColor")) === darkChrome);
  check("node labels on the light canvas are dark ink",
    (await read(".cv-glyph-label", "color")) === "rgb(26, 26, 26)",
    await read(".cv-glyph-label", "color"));

  // The dark toggle overrides the same tokens rather than adding a second set.
  await toggle.click();
  await page.waitForTimeout(600);
  check("the dark ground moves the same tokens",
    (await read(".react-flow__pane", "backgroundColor")) === "rgb(10, 14, 19)" &&
      (await page.locator(".cv-page").count()) === 1,
    await read(".react-flow__pane", "backgroundColor"));
  check("and the chrome never moved at all",
    (await read(".cv-topbar", "backgroundColor")) === darkChrome);
}

await dismissRecovery();
// ---------------------------------------------------------------- sheet
// The page grows to hold what is drawn on it, never shrinks on its own, and
// the minimap toggle moves nothing else.
{
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(500);

  const pageRect = () => page.locator(".cv-page").first()
    .evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight, x: el.offsetLeft, y: el.offsetTop }));
  const before = await pageRect();

  // Drag a device past the sheet's current right edge — wherever earlier
  // checks have left it — not a fixed distance that may land inside it.
  const dev = page.locator(".react-flow__node", { hasText: "Bystander" }).first();
  const b = await dev.boundingBox();
  const sheetBox = await page.locator(".cv-page").first().boundingBox();
  const target = Math.min(sheetBox.x + sheetBox.width + 80, 1560);
  await page.mouse.move(b.x + 30, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(target, b.y + 20, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const draggedTo = target - (b.x + 30);
  const grown = await pageRect();
  check("the page grows when a device is dragged past its edge",
    grown.w > before.w, `${before.w} -> ${grown.w}`);
  check("and grows in whole grid steps", grown.w % 60 === 0, `${grown.w}`);

  // Drag it back to where it was — in flow units, closed-loop, because after
  // the growth the device may sit under the inspector where a screen-relative
  // drag cannot grab it. Fit view first so it is reachable at all.
  void draggedTo;
  const flowX = () => dev.evaluate((el) => {
    const m = /translate\((-?[\d.]+)px/.exec(el.style.transform ?? "");
    return m ? Number(m[1]) : 0;
  });
  const wantX = await flowX() - 900;
  for (let i = 0; i < 8; i++) {
    const now = await flowX();
    if (now <= wantX + 10) break;
    // The device may sit under the inspector where no pointer reaches it, and
    // the sheet fit will not bring it in. Do what a person does: hold space,
    // drag the diagram until the device is in the middle of the canvas.
    let art = await dev.locator(".cv-glyph-art").boundingBox();
    if (!art || art.x > 1100 || art.x < 260) {
      await page.keyboard.down("Space");
      await page.waitForTimeout(150);
      await page.mouse.move(700, 400);
      await page.mouse.down();
      await page.mouse.move(700 - ((art?.x ?? 1400) - 700), 400, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      await page.waitForTimeout(300);
      art = await dev.locator(".cv-glyph-art").boundingBox();
    }
    if (!art) continue;
    const zoom = art.width / 46; // the glyph is 46 flow units wide
    await page.mouse.move(art.x + art.width / 2, art.y + art.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      art.x + art.width / 2 - Math.min(480, (now - wantX) * zoom),
      art.y + art.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  check("moving it back does not shrink the sheet",
    (await pageRect()).w === grown.w, `${(await pageRect()).w}`);
  check("the device really did come back", (await flowX()) < wantX + 200,
    `${await flowX()} vs ${wantX}`);

  // The explicit shrink.
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 760, y: 640 } });
  await page.waitForTimeout(250);
  await page.locator(".cv-menu button", { hasText: "Fit page to content" }).click();
  await page.waitForTimeout(500);
  const refit = await pageRect();
  check("fit page to content shrinks it on demand",
    refit.w < grown.w, `${grown.w} -> ${refit.w} (was ${before.w})`);

  // Minimap: on by default, off and on without touching the viewport.
  const vp = () => page.locator(".react-flow__viewport").evaluate((el) => el.style.transform);
  check("the overview box is on by default", (await page.locator(".cv-minimap").count()) === 1);
  const vpBefore = await vp();
  await page.locator("label", { hasText: "Overview" }).locator("input").uncheck();
  await page.waitForTimeout(300);
  check("the toggle hides it", (await page.locator(".cv-minimap").count()) === 0);
  check("without moving the canvas", (await vp()) === vpBefore);
  await page.locator("label", { hasText: "Overview" }).locator("input").check();
  await page.waitForTimeout(300);
  check("and brings it back", (await page.locator(".cv-minimap").count()) === 1);
}

// ---------------------------------------------------------------- keys
// The keyboard is how the last two pixels of a layout actually get done.
{
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
  await page.waitForTimeout(250);

  const dev = page.locator(".react-flow__node", { hasText: "Bystander" }).first();
  const flowPos = () => dev.evaluate((el) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform ?? "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
  });
  await dev.locator(".cv-glyph-node").click();
  await page.waitForTimeout(250);

  const start = await flowPos();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  check("an arrow nudges by one pixel", (await flowPos()).x === start.x + 1,
    `${start.x} -> ${(await flowPos()).x}`);
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(200);
  check("shift-arrow nudges a grid step", (await flowPos()).x === start.x + 61,
    `${(await flowPos()).x}`);
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  check("and back", (await flowPos()).x === start.x);

  // Ctrl+D: one grid step over, selected, ready to nudge.
  const before = await nodeCount();
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(350);
  check("Ctrl+D duplicates", (await nodeCount()) === before + 1);
  const copies = await page.locator(".react-flow__node", { hasText: "Bystander" }).count();
  check("the copy is a grid step over and selected", copies === 2 &&
    (await page.locator(".react-flow__node.selected").count()) >= 1, `${copies} copies`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  check("Delete removes it again", (await nodeCount()) === before);

  // Esc selects nothing.
  await dev.locator(".cv-glyph-node").click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Esc clears the selection",
    (await page.locator(".react-flow__node.selected").count()) === 0);

  // ? shows the overlay; Esc puts it away.
  await page.keyboard.press("?");
  await page.waitForTimeout(250);
  check("? opens the shortcut list", (await page.locator(".cv-help-card").count()) === 1);
  const listed = await page.locator(".cv-help-card").innerText();
  check("and it names the arrange keys", /Ctrl\+Alt\+L/.test(listed));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("Esc puts it away", (await page.locator(".cv-help-card").count()) === 0);
}

// ---------------------------------------------------------------- filter
// The words that filter the table light up the canvas.
{
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const box = page.locator('input[placeholder*="Filter by name"]');
  check("the panel has its filter box", (await box.count()) === 1);

  await box.fill("Bystander");
  await page.waitForTimeout(400);
  const lit = await page.locator(".is-hit").count();
  const dimmed = await page.locator(".is-dimmed").count();
  check("typing lights the matches on the canvas", lit >= 1, `${lit} lit`);
  check("and steps the rest back without hiding them", dimmed >= 1, `${dimmed} dimmed`);

  await box.press("Enter");
  await page.waitForTimeout(600);
  const title = await page.locator(".cv-inspector-title").first().innerText();
  check("Enter jumps to and selects the first match", /Node/i.test(title),
    title.replace(/\n/g, " ").slice(0, 30));

  await box.fill("");
  await page.waitForTimeout(300);
  check("clearing the filter puts the canvas back",
    (await page.locator(".is-hit").count()) === 0 &&
      (await page.locator(".is-dimmed").count()) === 0);
}

// ---------------------------------------------------------------- recovery
// A session that ends badly leaves its unsaved work behind, and the next
// launch offers it back — only when it is newer than what was really saved.
{
  // The debounced real save has to land first: reloading while dirty makes
  // the beforeunload writer overwrite the planted slot with a genuine one.
  await page.waitForTimeout(3200);
  // Plant a recovery slot newer than the project's last save, then reload.
  const projectId = await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem("coreview.projects.v1") ?? "{}");
    const id = Object.keys(all)[0];
    const doc = all[id].document;
    const marked = {
      ...doc,
      nodes: [...doc.nodes, {
        id: "recovered-node", type: "device", position: { x: 900, y: 900 },
        width: 168, height: 92,
        data: { label: "RECOVERED-SW", deviceType: "access-switch", tags: [],
          addresses: [], locked: false, maintenance: false, showDetails: true },
      }],
    };
    localStorage.setItem(`coreview.recovery.${id}`,
      JSON.stringify({ savedAt: Date.now() + 60_000, document: marked }));
    return id;
  });
  void projectId;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForSelector(".react-flow__node");
  await page.waitForTimeout(600);

  check("unsaved work from a dead session is offered back",
    (await page.locator(".cv-recovery").count()) === 1);

  const before = await nodeCount();
  await page.locator(".cv-recovery button", { hasText: "Restore it" }).click();
  await page.waitForTimeout(600);
  check("restoring brings the lost work back",
    (await page.locator(".react-flow__node", { hasText: "RECOVERED-SW" }).count()) === 1,
    `${before} -> ${await nodeCount()}`);
  check("and the offer is answered once", (await page.locator(".cv-recovery").count()) === 0);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  check("a restore is an edit, so undo can take it back",
    (await page.locator(".react-flow__node", { hasText: "RECOVERED-SW" }).count()) === 0);

  // A stale slot — older than the last save — is not offered. The debounced
  // real save must land first, or the beforeunload writer replaces the
  // planted stale slot with a genuine fresh one on the way out.
  await page.waitForTimeout(3200);
  await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem("coreview.projects.v1") ?? "{}");
    const id = Object.keys(all)[0];
    localStorage.setItem(`coreview.recovery.${id}`,
      JSON.stringify({ savedAt: 1, document: all[id].document }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForSelector(".react-flow__node");
  await page.waitForTimeout(600);
  check("a slot older than the last save is stale, not a recovery",
    (await page.locator(".cv-recovery").count()) === 0);
}

// ---- hover card during validation (LT-043) ----------------------------------
// A real session needs the Tauri backend, so the harness stages one through
// the dev-only store handle: session running, one probe on a node, one
// runtime row — then hovers, and the monitored-objects data must be at the
// cursor. Card only while running; native title suppressed while it shows.
{
  await dismissRecovery();
  const target = page.locator(".react-flow__node", { hasText: "Core switch" }).first();
  // The title attribute lives on the node's own div, not React Flow's wrapper.
  const inner = target.locator(".cv-glyph-node, .cv-node").first();
  check("no card before validation runs — staging precondition",
    (await page.locator(".cv-livecard").count()) === 0);
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    const node = st.doc.nodes.find((n) => n.data.label === "Core switch");
    const probe = { id: "e2e-probe", objectId: node.id, kind: "icmp",
      target: "192.0.2.10", isPrimary: true, enabled: true, intervalMs: 5000 };
    const runtime = new Map(st.runtime);
    runtime.set("e2e-probe", { probeId: "e2e-probe", status: "healthy",
      lastRttMs: 3.2, lastSuccessMs: Date.now() - 4000, lastFailureMs: null,
      lastSummary: "reply from 192.0.2.10", consecutiveFailures: 0, failureThreshold: 3 });
    window.__cvStore.setState({
      doc: { ...st.doc, probes: [...st.doc.probes, probe] },
      runtime,
      session: { id: "e2e", state: "running", startedAt: Date.now() },
    });
  });
  await target.hover();
  await page.waitForTimeout(500); // past the 250ms intent delay
  check("hovering a device while validation runs shows the card",
    (await page.locator(".cv-livecard").count()) === 1);
  const text = await page.locator(".cv-livecard").innerText();
  check("the card carries the last result", text.includes("reply from 192.0.2.10"), text);
  check("the card carries the RTT", text.includes("3 ms"), text);
  check("the card carries the checked time", /\d+s ago/.test(text), text);
  check("the native tooltip yields while the card can show",
    (await inner.getAttribute("title")) === null);
  await page.mouse.move(30, 400);
  await page.waitForTimeout(300);
  check("the card leaves with the cursor",
    (await page.locator(".cv-livecard").count()) === 0);
  // Stop the session: same hover, no card.
  await page.evaluate(() => {
    window.__cvStore.setState({ session: { id: null, state: "stopped", startedAt: null } });
  });
  await target.hover();
  await page.waitForTimeout(500);
  check("no card once validation stops",
    (await page.locator(".cv-livecard").count()) === 0);
  check("and the native tooltip is back",
    ((await inner.getAttribute("title")) ?? "").includes("Core switch"));
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({
      doc: { ...st.doc, probes: st.doc.probes.filter((pr) => pr.id !== "e2e-probe") },
    });
  });
  await page.mouse.move(30, 400);
}

// ---- text has no borders, no box, no connectors (LT-049) -------------------
{
  await dismissRecovery();
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({ doc: { ...st.doc, nodes: [...st.doc.nodes, {
      id: "txt1", type: "device", position: { x: 520, y: 40 }, width: 140, height: 40,
      data: { label: "Bare text", deviceType: "text", tags: [], addresses: [],
        locked: false, maintenance: false, showDetails: true },
    }] } });
  });
  await page.waitForTimeout(400);
  const txt = page.locator(".react-flow__node", { hasText: "Bare text" }).first();
  await txt.click();
  await page.waitForTimeout(300);
  const inner = txt.locator(".cv-node").first();
  const cs = await inner.evaluate((el) => {
    const c = getComputedStyle(el);
    return { shadow: c.boxShadow, border: c.borderColor };
  });
  check("selected text draws no selection rectangle", cs.shadow === "none", cs.shadow);
  check("text has no border", cs.border === "rgba(0, 0, 0, 0)" || cs.border === "transparent", cs.border);
  check("text has no connection handles", (await txt.locator(".cv-handle").count()) === 0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({ doc: { ...st.doc, nodes: st.doc.nodes.filter((n) => n.id !== "txt1") } });
  });
}

// ---- zoom without walls (LT-047) -------------------------------------------
// The old stops were React Flow's defaults: 0.5x out, 2x in. Passing either
// proves the walls moved.
{
  await dismissRecovery();
  const scale = () => page.locator(".react-flow__viewport").evaluate((el) =>
    new DOMMatrix(getComputedStyle(el).transform).a);
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 240);
  await page.waitForTimeout(400);
  const far = await scale();
  check("zooming out sails past the old 0.5x wall", far < 0.1, `scale ${far}`);
  for (let i = 0; i < 50; i++) await page.mouse.wheel(0, -240);
  await page.waitForTimeout(400);
  const near = await scale();
  check("zooming in sails past the old 2x wall", near > 5, `scale ${near}`);
  // Put the view back for whatever runs after: the canvas menu's own
  // "Fit view", because at 8x zoom every later click lands on one giant node.
  await pane.click({ button: "right", position: { x: 30, y: 30 } });
  await page.locator(".cv-menu button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(400);
}

// ---- the status chip is readable (LT-048) ----------------------------------
// "can't really see the word healthy because its not white enough in dark
// mode." Three components shared the class .cv-chip; the filter-chip rules
// later in the stylesheet clobbered the status pill's ink, painting dim grey
// on bright green. The check measures what is actually painted.
{
  await dismissRecovery();
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    const node = st.doc.nodes.find((n) => n.data.label === "Core switch");
    const probe = { id: "chip-probe", objectId: node.id, kind: "icmp",
      target: "192.0.2.10", isPrimary: true, enabled: true, intervalMs: 5000 };
    const runtime = new Map(st.runtime);
    runtime.set("chip-probe", { probeId: "chip-probe", status: "healthy",
      lastRttMs: 1.0, lastSuccessMs: Date.now() - 3000, lastFailureMs: null,
      lastSummary: "Reply, 1 ms", consecutiveFailures: 0, failureThreshold: 3 });
    window.__cvStore.setState({
      doc: { ...st.doc, probes: [...st.doc.probes, probe] },
      runtime,
    });
  });
  await page.waitForTimeout(400);
  const chip = page.locator(".cv-panel .cv-status-chip, .cv-panel .cv-chip[style]").first();
  check("a monitored row shows its status chip", (await chip.count()) > 0);
  if (await chip.count()) {
    const ratio = await chip.evaluate((el) => {
      const cs = getComputedStyle(el);
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number)
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const a = lum(cs.color), b = lum(cs.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    check("the chip's word clears the 4.5:1 contrast floor", ratio >= 4.5, `ratio ${ratio.toFixed(2)}`);
  } else {
    check("the chip's word clears the 4.5:1 contrast floor", false, "no chip found");
  }
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({
      doc: { ...st.doc, probes: st.doc.probes.filter((pr) => pr.id !== "chip-probe") },
    });
  });
}

// ---- a selected shape is outlined by its own outline (LT-004) --------------
// The screenshot behind the item: a circular router glyph wearing a square
// selection box. The square was the NodeResizer's line rectangle — every
// shape's own highlight (the ring on a glyph, the stroked cloud outline, the
// radius-following shadow on a circle) already traces the shape. The line
// must stay draggable for edge-resizing but stop drawing the box; the corner
// handles may stay visible — the item allows them.
{
  await dismissRecovery();
  const dev = page.locator(".react-flow__node", { hasText: "Core switch" }).first();
  await dev.click();
  await page.waitForTimeout(300);
  const lines = page.locator(".react-flow__resize-control.line");
  check("selecting shows the resizer's edge controls", (await lines.count()) > 0);
  const colors = await lines.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).borderColor));
  check("no rectangular box is drawn round the shape",
    colors.every((c) => c === "rgba(0, 0, 0, 0)" || c === "transparent"), colors.join(" | "));
  const handle = page.locator(".react-flow__resize-control.handle").first();
  check("resize handles still sit on the box",
    (await handle.count()) > 0 &&
      (await handle.evaluate((el) => getComputedStyle(el).visibility)) !== "hidden");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

// ---- clearing the icon library (LT-005) ------------------------------------
// "Icon library stuck and can't clear it": once a folder was loaded, the
// palette offered reload and nothing else — changing your mind meant editing
// the database by hand. A real library needs the desktop backend, so the
// harness stages a loaded one through the dev store handle and clears it.
{
  await dismissRecovery();
  await page.evaluate(() => {
    window.__cvStore.setState({
      iconLibraryDir: "/tmp/fake-icons",
      iconLibrary: [{ id: "x", name: "X", category: "C", svg: "<svg viewBox=\"0 0 1 1\"></svg>" }],
      iconLibraryError: null,
    });
  });
  await page.waitForTimeout(300);
  check("a loaded library names its folder",
    (await page.locator(".cv-palette", { hasText: "/tmp/fake-icons" }).count()) === 1);
  const clearBtn = page.locator(".cv-palette button", { hasText: "clear" });
  check("the loaded library offers clear next to reload", (await clearBtn.count()) === 1);
  if (await clearBtn.count()) {
    await clearBtn.click();
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => {
      const s = window.__cvStore.getState();
      return { dir: s.iconLibraryDir, n: s.iconLibrary.length, err: s.iconLibraryError };
    });
    check("clearing empties the library and forgets the folder",
      st.dir === null && st.n === 0 && st.err === null, JSON.stringify(st));
    check("the folder input returns so a different library can be chosen",
      (await page.locator('.cv-palette input[placeholder="/path/to/icons"]').count()) === 1);
  } else {
    check("clearing empties the library and forgets the folder", false, "no clear button");
    check("the folder input returns so a different library can be chosen", false, "no clear button");
  }
}

// ---- port labels at the ends, one per cable (LT-050 / LT-055) --------------
// Two parallel cables between one pair used to wear their chips at 0.32
// along the straight chord — the same chord for both, so the pairs stacked
// and the lab showed two links both reading "Gi1/0/11" with 1/0/12 hidden
// underneath. Chips now ride the drawn path, near their own ends.
{
  await dismissRecovery();
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    const mk = (id, sp, tp) => ({
      id, source: "n1", target: "n3", sourceHandle: "r", targetHandle: "l",
      type: "live",
      data: { sourcePortLabel: sp, targetPortLabel: tp, label: "",
        pathType: "smoothstep", direction: "none", width: 2, color: "#7c8fa3",
        enabled: true, maintenance: false,
        healthRule: { type: "manual", manualStatus: "healthy" } },
    });
    window.__cvStore.setState({ doc: { ...st.doc, edges: [...st.doc.edges,
      mk("lane-a", "Gi1/0/11", "Gi1/0/11"), mk("lane-b", "Gi1/0/12", "Gi1/0/12")] } });
  });
  await page.waitForTimeout(500);
  const chip = (t) => page.locator(".cv-edge-port", { hasText: t });
  check("both cables show their own port label",
    (await chip("Gi1/0/11").count()) >= 2 && (await chip("Gi1/0/12").count()) >= 2,
    `11s: ${await chip("Gi1/0/11").count()}, 12s: ${await chip("Gi1/0/12").count()}`);
  const a = await chip("Gi1/0/11").first().boundingBox();
  const b = await chip("Gi1/0/12").first().boundingBox();
  const overlap = a && b &&
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
  check("the two source chips do not stack on one spot", !overlap,
    a && b ? `a=(${a.x.toFixed(0)},${a.y.toFixed(0)}) b=(${b.x.toFixed(0)},${b.y.toFixed(0)})` : "missing chip");
  // Near its own device: the chip's centre must be much closer to the source
  // node than to the target node.
  const srcBox = await page.locator('[data-id="n1"]').boundingBox();
  const dstBox = await page.locator('[data-id="n3"]').boundingBox();
  const cx = a.x + a.width / 2, cy = a.y + a.height / 2;
  const d = (bb) => Math.hypot(cx - (bb.x + bb.width / 2), cy - (bb.y + bb.height / 2));
  check("a source chip sits near its own device, not mid-link",
    d(srcBox) < d(dstBox) / 2, `to-src ${d(srcBox).toFixed(0)} to-dst ${d(dstBox).toFixed(0)}`);
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({ doc: { ...st.doc,
      edges: st.doc.edges.filter((e) => !e.id.startsWith("lane-")) } });
  });
  await page.waitForTimeout(300);
}

// ---- the edit corners hug the shape (LT-053) -------------------------------
// "the shape should have no borders and the edit corners should be close to
// the shape not far away." The glyph node used to be an invisible 168x92 box
// with a 46px icon floating in it: resize corners, connection dots and link
// ends all sat on the box, nowhere near the drawn shape. The node's bounds
// are now the art itself — the label hangs below without counting.
{
  await dismissRecovery();
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({ doc: { ...st.doc, nodes: [...st.doc.nodes, {
      id: "hug1", type: "device", position: { x: 540, y: 420 }, width: 80, height: 80,
      data: { label: "Huggable", deviceType: "router", tags: [], addresses: [],
        locked: false, maintenance: false, showDetails: true },
    }] } });
  });
  await page.waitForTimeout(400);
  const node = page.locator(".react-flow__node", { hasText: "Huggable" }).first();
  await node.locator(".cv-glyph-node").click();
  await page.waitForTimeout(300);
  const art = await node.locator(".cv-glyph-art").boundingBox();
  const handle = await page.locator(".react-flow__resize-control.handle.top.left").first().boundingBox();
  check("a resize corner sits on the shape's own corner",
    handle && Math.hypot(handle.x + handle.width / 2 - art.x, handle.y + handle.height / 2 - art.y) < 12,
    handle ? `handle (${handle.x.toFixed(0)},${handle.y.toFixed(0)}) vs art (${art.x.toFixed(0)},${art.y.toFixed(0)})` : "no handle");
  const label = await node.locator(".cv-glyph-text").boundingBox();
  check("the label hangs below the shape without widening its bounds",
    label && label.y >= art.y + art.height - 2, label ? `label y ${label.y.toFixed(0)} art bottom ${(art.y + art.height).toFixed(0)}` : "no label");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    window.__cvStore.setState({ doc: { ...st.doc, nodes: st.doc.nodes.filter((n) => n.id !== "hug1") } });
  });
}

if (out) await page.screenshot({ path: `${out}/interact-final.png` });
await browser.close();
console.log(failures === 0 ? "\nall interaction checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
