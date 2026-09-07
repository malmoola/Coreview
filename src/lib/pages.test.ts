import { describe, expect, it } from 'vitest';

import {
  activePage,
  allEdges,
  allNodes,
  duplicatePage,
  newPage,
  renamePage,
  reorderPages,
  setActivePage,
  withNewPage,
  withoutPage,
  withPage,
} from './pages';
import type { ProjectDocument, ProjectPage, TopoEdge, TopoNode } from '../state/store';

const node = (id: string, groupId?: string): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label: id, deviceType: 'router', tags: [], addresses: [], locked: false,
      maintenance: false, showDetails: true, ...(groupId ? { groupId } : {}),
    },
  }) as never;

const edge = (id: string, source: string, target: string): TopoEdge =>
  ({ id, source, target, data: {} }) as never;

const page = (id: string, name: string, over: Partial<ProjectPage> = {}): ProjectPage => ({
  ...newPage(name, id),
  ...over,
});

const doc = (pages: ProjectPage[], activePageId = pages[0]!.id): ProjectDocument => ({
  pages,
  activePageId,
  probes: [],
});

describe('activePage / withPage', () => {
  it('finds the page matching activePageId', () => {
    const d = doc([page('a', 'A'), page('b', 'B')], 'b');
    expect(activePage(d).name).toBe('B');
  });

  it('falls back to the first page for a stale activePageId', () => {
    const d = doc([page('a', 'A'), page('b', 'B')], 'gone');
    expect(activePage(d).name).toBe('A');
  });

  it('patches only the active page', () => {
    const d = doc([page('a', 'A'), page('b', 'B')], 'b');
    const patched = withPage(d, { nodes: [node('n1')] });
    expect(patched.pages[0]!.nodes).toEqual([]);
    expect(patched.pages[1]!.nodes).toHaveLength(1);
  });
});

describe('allNodes / allEdges', () => {
  it('flattens every page, regardless of which is active', () => {
    const d = doc([
      page('a', 'A', { nodes: [node('n1')], edges: [edge('e1', 'n1', 'n1')] }),
      page('b', 'B', { nodes: [node('n2')] }),
    ]);
    expect(allNodes(d).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(allEdges(d).map((e) => e.id)).toEqual(['e1']);
  });
});

describe('withNewPage', () => {
  it('adds a page and makes it active', () => {
    const d = withNewPage(doc([page('a', 'A')]), 'B', 'b');
    expect(d.pages.map((p) => p.name)).toEqual(['A', 'B']);
    expect(d.activePageId).toBe('b');
  });

  it('does not add a second page with the same name', () => {
    const d = withNewPage(doc([page('a', 'Site')]), 'Site', 'b');
    expect(d.pages[1]!.name).toBe('Site 2');
  });

  it('names an unnamed page rather than leaving it blank', () => {
    const d = withNewPage(doc([page('a', 'A')]), '   ', 'b');
    expect(d.pages[1]!.name).toBe('Page');
  });
});

describe('withoutPage', () => {
  it('removes the page asked for and keeps the rest', () => {
    const d = withoutPage(doc([page('a', 'A'), page('b', 'B')]), 'a');
    expect(d.pages.map((p) => p.id)).toEqual(['b']);
  });

  it('never removes the last page', () => {
    const d = withoutPage(doc([page('a', 'A')]), 'a');
    expect(d.pages).toHaveLength(1);
  });

  it('switches the active page when the removed one was active', () => {
    const d = withoutPage(doc([page('a', 'A'), page('b', 'B')], 'a'), 'a');
    expect(d.activePageId).toBe('b');
  });

  it('leaves the active page alone when a different page is removed', () => {
    const d = withoutPage(doc([page('a', 'A'), page('b', 'B')], 'b'), 'a');
    expect(d.activePageId).toBe('b');
  });

  it('cascades to the probes of everything that was on it', () => {
    const withProbes: ProjectDocument = {
      ...doc([
        page('a', 'A', { nodes: [node('n1')] }),
        page('b', 'B', { nodes: [node('n2')] }),
      ]),
      probes: [
        { id: 'p1', projectId: '', objectKind: 'node', objectId: 'n1', name: 'x', kind: 'icmp', target: '1.1.1.1', tcpPort: null, intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 3, recoveryThreshold: 1, warningLatencyMs: 100, enabled: true, maintenance: false, isPrimary: true } as never,
        { id: 'p2', projectId: '', objectKind: 'node', objectId: 'n2', name: 'y', kind: 'icmp', target: '1.1.1.2', tcpPort: null, intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 3, recoveryThreshold: 1, warningLatencyMs: 100, enabled: true, maintenance: false, isPrimary: true } as never,
      ],
    };
    const d = withoutPage(withProbes, 'a');
    expect(d.probes.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('renamePage', () => {
  it('renames the page asked for', () => {
    const d = renamePage(doc([page('a', 'A')]), 'a', 'Renamed');
    expect(d.pages[0]!.name).toBe('Renamed');
  });

  it('refuses a blank name', () => {
    const d = renamePage(doc([page('a', 'A')]), 'a', '   ');
    expect(d.pages[0]!.name).toBe('A');
  });
});

describe('duplicatePage', () => {
  it('copies nodes and edges with fresh ids', () => {
    const source = doc([
      page('a', 'A', { nodes: [node('n1'), node('n2')], edges: [edge('e1', 'n1', 'n2')] }),
    ]);
    const d = duplicatePage(source, 'a', (() => {
      let n = 0;
      return () => `fresh-${n++}`;
    })());
    expect(d.pages).toHaveLength(2);
    const copy = d.pages[1]!;
    expect(copy.nodes.map((n) => n.id)).not.toEqual(['n1', 'n2']);
    expect(copy.edges[0]!.source).toBe(copy.nodes[0]!.id);
    expect(copy.edges[0]!.target).toBe(copy.nodes[1]!.id);
  });

  it('strips group membership from the copy', () => {
    const source = doc([page('a', 'A', { nodes: [node('n1', 'g1')] })]);
    const d = duplicatePage(source, 'a', (() => {
      let n = 0;
      return () => `fresh-${n++}`;
    })());
    expect((d.pages[1]!.nodes[0]!.data as { groupId?: string }).groupId).toBeUndefined();
  });

  it('names the copy uniquely and makes it active', () => {
    const source = doc([page('a', 'Site')]);
    const d = duplicatePage(source, 'a', (() => {
      let n = 0;
      return () => `fresh-${n++}`;
    })());
    expect(d.pages[1]!.name).toBe('Site copy');
    expect(d.activePageId).toBe(d.pages[1]!.id);
  });

  it('carries no probes over — a duplicate is a starting point, not a live copy', () => {
    const source: ProjectDocument = {
      ...doc([page('a', 'A', { nodes: [node('n1')] })]),
      probes: [{ id: 'p1', projectId: '', objectKind: 'node', objectId: 'n1', name: 'x', kind: 'icmp', target: '1.1.1.1', tcpPort: null, intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 3, recoveryThreshold: 1, warningLatencyMs: 100, enabled: true, maintenance: false, isPrimary: true } as never],
    };
    const d = duplicatePage(source, 'a', (() => {
      let n = 0;
      return () => `fresh-${n++}`;
    })());
    expect(d.probes).toHaveLength(1);
  });
});

describe('reorderPages', () => {
  it('moves a page to a new position', () => {
    const d = reorderPages(doc([page('a', 'A'), page('b', 'B'), page('c', 'C')]), 0, 2);
    expect(d.pages.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('does nothing for an out-of-range index', () => {
    const original = doc([page('a', 'A'), page('b', 'B')]);
    expect(reorderPages(original, 5, 0)).toBe(original);
  });
});

describe('setActivePage', () => {
  it('switches the active page', () => {
    const d = setActivePage(doc([page('a', 'A'), page('b', 'B')]), 'b');
    expect(d.activePageId).toBe('b');
  });

  it('is a no-op for an id the document does not have', () => {
    const original = doc([page('a', 'A')]);
    expect(setActivePage(original, 'nope')).toBe(original);
  });
});
