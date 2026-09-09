/**
 * Pages: more than one independent drawing in one project.
 *
 * Unlike a view (src/lib/layers.ts) — a filter over one shared canvas, where
 * an object can be on more than one and nothing has to move between them —
 * a page is a completely separate canvas: its own devices, links, layout,
 * grid, snap, colour choice and views. A rack elevation and a logical
 * topology are not the same drawing shown two ways; they are two drawings
 * that happen to describe the same site.
 *
 * Monitoring is deliberately not part of this: a project's probes stay one
 * flat list regardless of which page a device is drawn on (LT-094) — which
 * page something is drawn on is not the same question as whether it is
 * being checked.
 */
import type { ProjectDocument, ProjectPage, TopoEdge, TopoNode } from '../state/store';

export const DEFAULT_PAGE_CANVAS: ProjectPage['canvas'] = {
  gridEnabled: true,
  snapEnabled: true,
  minimap: true,
  nodeStyle: 'glyph',
};

export function newPage(name: string, id: string): ProjectPage {
  return { id, name, nodes: [], edges: [], canvas: { ...DEFAULT_PAGE_CANVAS } };
}

/** The page being viewed and edited, falling back to the first page — a
 *  document always has at least one, but a stale activePageId (its page
 *  since removed) must not leave nothing selected. */
export function activePage(doc: ProjectDocument): ProjectPage {
  return doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]!;
}

/** Patches the active page, and only the active page. */
export function withPage(doc: ProjectDocument, patch: Partial<ProjectPage>): ProjectDocument {
  const id = activePage(doc).id;
  return { ...doc, pages: doc.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

/** Every node across every page — for the things that do not care which
 *  page a device is drawn on: monitoring, status, event history. */
export function allNodes(doc: ProjectDocument): TopoNode[] {
  return doc.pages.flatMap((p) => p.nodes);
}

/** Every link across every page. See allNodes. */
export function allEdges(doc: ProjectDocument): TopoEdge[] {
  return doc.pages.flatMap((p) => p.edges);
}

function uniqueName(pages: ProjectPage[], name: string): string {
  const taken = new Set(pages.map((p) => p.name.toLowerCase()));
  const base = name.trim() || 'Page';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} ${n}`;
    n += 1;
  }
  return candidate;
}

/** Adds a page, with a name that is not already taken — the same rule
 *  src/lib/layers.ts uses for views. Becomes the active page: a page you
 *  just added is the one you meant to start drawing on. */
export function withNewPage(doc: ProjectDocument, name: string, id: string): ProjectDocument {
  const page = newPage(uniqueName(doc.pages, name), id);
  // A new page inherits how this diagram draws links. The style is per page
  // because the canvas is, but "the default look of a link" is a property of
  // the diagram: saving it and then adding a page — which is what an import of
  // a multi-page drawing does for you — left the new page drawing links in the
  // built-in grey, and the setting looked as though it had not saved.
  const style = activePage(doc).canvas.linkStyle;
  if (style) page.canvas = { ...page.canvas, linkStyle: { ...style } };
  return { ...doc, pages: [...doc.pages, page], activePageId: id };
}

/**
 * Removing a page removes what was drawn on it — unlike removing a view,
 * which only removes a filter and leaves the network alone (a view is not a
 * container; a page is). Its probes are cascaded away with it, the same as
 * deleting the devices directly would.
 *
 * Refuses to remove the last page: a project with no pages at all is not a
 * smaller project, it is a broken one.
 */
export function withoutPage(doc: ProjectDocument, id: string): ProjectDocument {
  if (doc.pages.length <= 1) return doc;
  const removed = doc.pages.find((p) => p.id === id);
  if (!removed) return doc;
  const pages = doc.pages.filter((p) => p.id !== id);
  const goneIds = new Set([
    ...removed.nodes.map((n) => n.id),
    ...removed.edges.map((e) => e.id),
  ]);
  return {
    ...doc,
    pages,
    activePageId: doc.activePageId === id ? pages[0]!.id : doc.activePageId,
    probes: doc.probes.filter((p) => !goneIds.has(p.objectId)),
  };
}

/** Renames a page, refusing a blank name — an unnamed page is confusing in
 *  a tab strip in a way an unnamed view never was in a list with an icon. */
export function renamePage(doc: ProjectDocument, id: string, name: string): ProjectDocument {
  const trimmed = name.trim();
  if (!trimmed) return doc;
  return { ...doc, pages: doc.pages.map((p) => (p.id === id ? { ...p, name: trimmed } : p)) };
}

/**
 * A copy of one page with fresh ids throughout, so it shares no group
 * membership or link endpoint with the original — the same reasoning
 * src/lib/clipboard.ts's paste uses for a copied selection. No probes are
 * carried over, matching how paste never carries over monitoring either: a
 * duplicate is a starting point, not a live copy. Placed right after the
 * original and made active.
 */
export function duplicatePage(
  doc: ProjectDocument,
  id: string,
  newId: () => string,
): ProjectDocument {
  const source = doc.pages.find((p) => p.id === id);
  if (!source) return doc;

  const remap = new Map<string, string>();
  for (const n of source.nodes) remap.set(n.id, newId());

  const nodes = source.nodes.map((n) => {
    const data = { ...(n.data as Record<string, unknown>) };
    delete data.groupId;
    return { ...n, id: remap.get(n.id)!, data } as TopoNode;
  });
  const edges = source.edges.map((e) => ({
    ...e,
    id: newId(),
    source: remap.get(e.source)!,
    target: remap.get(e.target)!,
  })) as TopoEdge[];

  const copy: ProjectPage = {
    id: newId(),
    name: uniqueName(doc.pages, `${source.name} copy`),
    nodes,
    edges,
    canvas: JSON.parse(JSON.stringify(source.canvas)) as ProjectPage['canvas'],
  };
  const at = doc.pages.findIndex((p) => p.id === id);
  const pages = [...doc.pages];
  pages.splice(at + 1, 0, copy);
  return { ...doc, pages, activePageId: copy.id };
}

/** Moves one page to a new position in the tab strip. */
export function reorderPages(doc: ProjectDocument, fromIndex: number, toIndex: number): ProjectDocument {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= doc.pages.length) return doc;
  const pages = [...doc.pages];
  const moved = pages.splice(fromIndex, 1)[0]!;
  pages.splice(Math.max(0, Math.min(toIndex, pages.length)), 0, moved);
  return { ...doc, pages };
}

/** Switches which page is being viewed and edited. A no-op for an id the
 *  document does not have, rather than leaving nothing active. */
export function setActivePage(doc: ProjectDocument, id: string): ProjectDocument {
  if (!doc.pages.some((p) => p.id === id)) return doc;
  return { ...doc, activePageId: id };
}
