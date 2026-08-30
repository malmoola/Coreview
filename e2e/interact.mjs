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
      // A third device that takes part in nothing. It is the control: bulk
      // edits must not reach it, and it can testify that a drag moved a node
      // rather than panning the canvas.
      {
        id: "n3", type: "device", position: { x: 640, y: 300 }, width: 176, height: 96,
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
      (luminance(light.ground) ?? 0) > 0.9, String(light.ground));
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
  const tagField = page.locator(".cv-row-tight input").first();
  if (await tagField.count()) {
    await tagField.fill("site-hq");
    await page.locator(".cv-row-tight button", { hasText: "Add" }).first().click();
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
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height - 8 + 60, { steps: 14 });
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
}

if (out) await page.screenshot({ path: `${out}/interact-final.png` });
await browser.close();
console.log(failures === 0 ? "\nall interaction checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
