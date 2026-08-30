import { create } from 'zustand';
import type { Edge, Node } from '@xyflow/react';
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react';

import { ipc, isDesktop, type ProbeResultDto, type IconLibEntry } from '../lib/ipc';
import { uid } from '../lib/id';
import { groupBySubnet as bucketBySubnet } from '../lib/subnetGroups';
import { tidyLayout as evenOutSpacing } from '../lib/tidyLayout';
import { routeLinks as chooseLinkSides } from '../lib/routeLinks';
import { zoneDeltas } from '../lib/zones';
import { alignTo, distribute } from '../lib/alignment';
import { copySelection, pasteClipping, type Clipping } from '../lib/clipboard';
import { layersOf, withNewLayer, withoutLayer, type Layer } from '../lib/layers';
import type { ColourBy } from '../lib/tinting';
import {
  linkStatus as computeLinkStatus,
  nodeStatus as computeNodeStatus,
} from '../health/evaluate';
import type {
  DeviceNodeData,
  EventRow,
  HealthStatus,
  LinkData,
  NoteNodeData,
  Probe,
  ProbeRuntime,
  ProjectMeta,
  SessionState,
} from '../types/domain';

export type TopoNode = Node<DeviceNodeData, 'device'> | Node<NoteNodeData, 'note'>;
export type TopoEdge = Edge<LinkData>;

/** The durable part of a project. Everything else is UI or live state. */
export interface ProjectDocument {
  nodes: TopoNode[];
  edges: TopoEdge[];
  probes: Probe[];
  canvas: {
    gridEnabled: boolean;
    snapEnabled: boolean;
    minimap: boolean;
    /** Little hops where one link crosses another. On by default: two lines
     *  meeting at a point look exactly like two lines joined at a point. */
    lineJumps?: boolean;
    /** The sheet the diagram is drawn on. On by default; turning it off gives
     *  back the endless desk for a diagram that is not going on paper. */
    page?: boolean;
    /** What the sheet has grown to. Grows automatically, shrinks only through
     *  "Fit page to content" — a sheet that snaps smaller mid-drag makes the
     *  whole layout jump. */
    pageRect?: { x: number; y: number; w: number; h: number };
    /** The views this document is drawn in. A network is documented more than
     *  once — physical, logical, the change on Saturday — and three files that
     *  disagree within a fortnight is what this exists to avoid. */
    layers?: Layer[];
    /** What device colour means. Health is the default and is what the app is
     *  for; the others answer questions a general drawing tool cannot, because
     *  it does not know what an address is. */
    colourBy?: ColourBy;
    /** How device nodes are drawn. 'glyph' is the icon with its name beneath
     *  and no box, the way a network diagram is normally drawn. 'card' is the
     *  bordered panel that holds the same text inside it. */
    nodeStyle?: 'glyph' | 'card';
  };
}

export interface AppSettings {
  reduceMotion: boolean;
  highContrast: boolean;
  /** The overview box, bottom-right. A view preference for this machine, like
   *  which panels are open — not part of any project. */
  minimap: boolean;
  /** Paper for exports and printing. 'fit' sizes the file to the diagram. */
  paper: string;
  orientation: 'portrait' | 'landscape';
  /** 'light' draws the diagram on white, for a document or a projector. */
  ground: 'dark' | 'light';
  /** Where configuration backups are written. Chosen by the user, and kept
   *  well away from exports: a running-config holds SNMP communities and
   *  hashed passwords, and must not travel inside a project someone shares. */
  backupFolder: string | null;
  /** Where exports land without prompting. Null falls back to a save dialog. */
  exportFolder: string | null;
}

interface HistoryEntry {
  nodes: TopoNode[];
  edges: TopoEdge[];
  probes: Probe[];
}

interface Store {
  // --- project
  projects: ProjectMeta[];
  meta: ProjectMeta | null;
  doc: ProjectDocument;
  dirty: boolean;
  lastSavedAt: number | null;

  // --- selection & ui
  selectedNodeId: string | null;
  /** A node that has just been made and should be typed into straight away. */
  editingNodeId: string | null;
  selectedEdgeId: string | null;
  settings: AppSettings;
  /** Runtime-indexed icon library. Never persisted with the project — the
   *  project stores an iconRef plus an inlined copy instead. */
  iconLibrary: IconLibEntry[];
  iconLibraryDir: string | null;
  iconLibraryError: string | null;
  panelOpen: boolean;
  paletteOpen: boolean;
  inspectorOpen: boolean;

  // --- live
  session: { id: string | null; state: SessionState; startedAt: number | null };
  runtime: Map<string, ProbeRuntime>;
  events: EventRow[];
  statusMessage: string | null;

  // --- history
  past: HistoryEntry[];
  future: HistoryEntry[];

  // actions
  refreshProjects: () => Promise<void>;
  createProject: (meta: Partial<ProjectMeta>, doc?: ProjectDocument) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => Promise<void>;
  saveProject: () => Promise<void>;
  duplicateProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  updateMeta: (patch: Partial<ProjectMeta>) => void;

  onNodesChange: (changes: NodeChange<TopoNode>[]) => void;
  /** Bind the current selection together so it moves as one. */
  groupSelected: () => void;
  /** Release the group a node belongs to. */
  ungroup: (nodeId: string) => void;
  /** Every node in this node's group, itself included. Empty if ungrouped. */
  groupMembers: (nodeId: string) => string[];
  /** Binds each subnet's devices together. Returns how many groups were made. */
  groupBySubnet: () => { groups: number; ungrouped: number };
  tidyLayout: () => { moved: number; rows: number; locked: number };
  routeLinks: () => number;
  addLayer: (name: string) => void;
  removeLayer: (id: string) => void;
  setLayer: (id: string, patch: Partial<Layer>) => void;
  /** Releases every link somebody pinned, so they all follow again. */
  unpinLinks: () => number;
  /** Lines a selection up on one edge, or evens the gaps between them. */
  copySelection: () => number;
  paste: () => number;
  selectAll: () => void;
  selectNone: () => void;
  beginEditing: (id: string | null) => void;
  arrange: (
    ids: string[],
    how: 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom' | 'across' | 'down',
  ) => number;
  onEdgesChange: (changes: EdgeChange<TopoEdge>[]) => void;
  addNode: (node: TopoNode) => void;
  addEdge: (edge: TopoEdge) => void;
  updateNodeData: (id: string, patch: Partial<DeviceNodeData & NoteNodeData>) => void;
  /** The same change applied to many nodes as one undoable step. Applying it
   *  node by node would leave forty entries in the undo history for one
   *  action, and undoing would then have to be pressed forty times. */
  updateManyNodeData: (
    ids: string[],
    patch: Partial<DeviceNodeData & NoteNodeData>,
    label?: string,
  ) => void;
  /** Rewrites each selected node's data from its own current value, for
   *  changes that are not the same everywhere — adding a tag to nodes that
   *  have different tags already. */
  mapManyNodeData: (
    ids: string[],
    change: (data: DeviceNodeData & NoteNodeData) => Partial<DeviceNodeData & NoteNodeData>,
    label?: string,
  ) => void;
  updateEdgeData: (id: string, patch: Partial<LinkData>) => void;
  deleteSelected: () => void;
  select: (nodeId: string | null, edgeId: string | null) => void;

  upsertProbe: (probe: Probe) => void;
  /** Applies one timing policy to every check in the project. */
  setProbeTiming: (intervalSeconds: number, failureThreshold: number) => number;
  removeProbe: (probeId: string) => void;
  probesFor: (objectId: string) => Probe[];
  nodeStatus: (nodeId: string) => HealthStatus;
  linkStatus: (edgeId: string) => HealthStatus;

  commit: (label?: string) => void;
  undo: () => void;
  redo: () => void;

  startValidation: () => Promise<void>;
  stopValidation: () => Promise<void>;
  applyEngineEvent: (payload: unknown) => void;
  testNow: (probe: Probe) => Promise<ProbeResultDto>;
  loadEvents: () => Promise<void>;

  setSettings: (patch: Partial<AppSettings>) => void;
  loadSettings: () => Promise<void>;
  chooseFolder: (which: 'backupFolder' | 'exportFolder') => Promise<string | null>;
  clearFolder: (which: 'backupFolder' | 'exportFolder') => Promise<void>;
  loadIconLibrary: (dir: string) => Promise<void>;
  setCanvas: (patch: Partial<ProjectDocument['canvas']>) => void;
  setPanelOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setStatusMessage: (msg: string | null) => void;
}

export const emptyDocument = (): ProjectDocument => ({
  nodes: [],
  edges: [],
  probes: [],
  canvas: { gridEnabled: true, snapEnabled: true, minimap: true, nodeStyle: 'glyph' },
});

const HISTORY_LIMIT = 60;

/**
 * Per-machine view preferences: which panels are open.
 *
 * localStorage is the right home for these — unlike the icon library folder,
 * which the backend also reads and so belongs in the database. Nothing outside
 * this file reads them, they are meaningless on another machine, and losing
 * them costs a click.
 */
function viewPref(key: string, fallback = true): boolean {
  try {
    const v = localStorage.getItem(`coreview.view.${key}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function rememberView(key: string, open: boolean): void {
  try {
    localStorage.setItem(`coreview.view.${key}`, open ? '1' : '0');
  } catch {
    /* private mode, or storage disabled — the panel just reopens next time */
  }
}

/** The group a node belongs to, if any. */
function groupOf(node: TopoNode | undefined): string | undefined {
  return (node?.data as { groupId?: string } | undefined)?.groupId;
}

/**
 * Applies React Flow's changes, then carries the rest of a group along.
 *
 * A group is drawn as nothing at all — it is a device and the notes that
 * explain it staying together, not a box around them. So the only place it
 * exists is here: when one member is dragged, its companions move by the same
 * delta.
 *
 * Members React Flow already moved are skipped. Dragging a multi-selection
 * emits a position change per node, and moving those again would send anything
 * both selected and grouped twice as far.
 */
function moveGroups(changes: NodeChange<TopoNode>[], before: TopoNode[]): TopoNode[] {
  const after = applyNodeChanges(changes, before) as TopoNode[];

  const deltas = new Map<string, { dx: number; dy: number }>();
  const movedItself = new Set<string>();
  for (const c of changes) {
    if (c.type !== 'position' || !c.position) continue;
    movedItself.add(c.id);
    const was = before.find((n) => n.id === c.id);
    const groupId = groupOf(was);
    if (!was || !groupId || deltas.has(groupId)) continue;
    deltas.set(groupId, {
      dx: c.position.x - was.position.x,
      dy: c.position.y - was.position.y,
    });
  }
  // A section carries whatever is standing in it. Membership is geometric and
  // recomputed, so nothing has to be re-assigned when a device is dragged into
  // one — and a device dragged out is simply out.
  const dragged: { id: string; dx: number; dy: number }[] = [];
  for (const c of changes) {
    if (c.type !== 'position' || !c.position) continue;
    const was = before.find((n) => n.id === c.id);
    if (!was) continue;
    dragged.push({
      id: c.id,
      dx: c.position.x - was.position.x,
      dy: c.position.y - was.position.y,
    });
  }
  const fromZones = zoneDeltas(dragged, before);

  if (deltas.size === 0 && fromZones.size === 0) return after;

  return after.map((n) => {
    if (movedItself.has(n.id)) return n;
    const groupId = groupOf(n);
    const d = (groupId ? deltas.get(groupId) : undefined) ?? fromZones.get(n.id);
    // A locked companion stays put, the same as it would under its own drag.
    if (!d || (n.data as { locked?: boolean }).locked) return n;
    return { ...n, position: { x: n.position.x + d.dx, y: n.position.y + d.dy } };
  });
}

/** What was copied, kept for the session rather than per project, so a chunk
 *  of one diagram can be pasted into another. */
let clipboard: Clipping | null = null;

function snapshot(doc: ProjectDocument): HistoryEntry {
  return {
    nodes: JSON.parse(JSON.stringify(doc.nodes)),
    edges: JSON.parse(JSON.stringify(doc.edges)),
    probes: JSON.parse(JSON.stringify(doc.probes)),
  };
}

export const useStore = create<Store>((set, get) => ({
  projects: [],
  meta: null,
  doc: emptyDocument(),
  dirty: false,
  lastSavedAt: null,
  selectedNodeId: null,
  editingNodeId: null,
  selectedEdgeId: null,
  iconLibrary: [],
  iconLibraryDir: null,
  iconLibraryError: null,
  settings: {
    reduceMotion:
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    highContrast: false,
    minimap: viewPref('minimap'),
    paper: 'fit',
    orientation: 'landscape',
    ground: 'dark',
    backupFolder: null,
    exportFolder: null,
  },
  panelOpen: viewPref('panelOpen'),
  // Which panels are open is a view preference for this machine, not part of
  // the project, so it lives in localStorage rather than the document (which
  // would mark it dirty and travel in an export) or the settings table.
  paletteOpen: viewPref('paletteOpen'),
  inspectorOpen: viewPref('inspectorOpen'),
  session: { id: null, state: 'stopped', startedAt: null },
  runtime: new Map(),
  events: [],
  statusMessage: null,
  past: [],
  future: [],

  async refreshProjects() {
    set({ projects: await ipc.listProjects() });
  },

  async createProject(partial, doc) {
    const now = Date.now();
    const meta: ProjectMeta = {
      id: uid(),
      name: partial.name?.trim() || 'Untitled project',
      customer: partial.customer ?? '',
      site: partial.site ?? '',
      ticket: partial.ticket ?? '',
      engineer: partial.engineer ?? '',
      description: partial.description ?? '',
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    const document = doc ?? emptyDocument();
    // Re-key probes so a seeded sample never shares ids with another project.
    document.probes = document.probes.map((p) => ({ ...p, projectId: meta.id }));
    await ipc.saveProject({ meta, documentVersion: 1, document });
    set({ meta, doc: document, dirty: false, lastSavedAt: now, past: [], future: [] });
    await get().refreshProjects();
  },

  async openProject(id) {
    await get().closeProject();
    const pkg = await ipc.loadProject(id);
    if (!pkg) {
      set({ statusMessage: 'That project could not be found in local storage.' });
      return;
    }
    const doc = { ...emptyDocument(), ...(pkg.document as ProjectDocument) };
    set({
      meta: pkg.meta,
      doc,
      dirty: false,
      lastSavedAt: pkg.meta.updatedAt,
      past: [],
      future: [],
      runtime: new Map(),
      events: [],
      selectedNodeId: null,
      selectedEdgeId: null,
    });
    await get().loadEvents();
  },

  async closeProject() {
    // Closing always stops probing first (test cases 14, 15).
    if (get().session.state !== 'stopped') await get().stopValidation();
    if (get().meta && get().dirty) await get().saveProject();
    set({
      meta: null,
      doc: emptyDocument(),
      dirty: false,
      runtime: new Map(),
      events: [],
      past: [],
      future: [],
      selectedNodeId: null,
      selectedEdgeId: null,
    });
  },

  async saveProject() {
    const { meta, doc } = get();
    if (!meta) return;
    const updated = { ...meta, updatedAt: Date.now() };
    await ipc.saveProject({ meta: updated, documentVersion: 1, document: doc });
    set({ meta: updated, dirty: false, lastSavedAt: updated.updatedAt });
    await get().refreshProjects();
  },

  async duplicateProject(id) {
    const pkg = await ipc.loadProject(id);
    if (!pkg) return;
    const now = Date.now();
    const meta: ProjectMeta = {
      ...pkg.meta,
      id: uid(),
      name: `${pkg.meta.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    const doc = pkg.document as ProjectDocument;
    // Deep copy so edits to the duplicate cannot touch the original.
    const copy: ProjectDocument = JSON.parse(JSON.stringify(doc));
    copy.probes = copy.probes.map((p) => ({ ...p, projectId: meta.id }));
    await ipc.saveProject({ meta, documentVersion: 1, document: copy });
    await get().refreshProjects();
  },

  async deleteProject(id) {
    if (get().meta?.id === id) await get().closeProject();
    await ipc.deleteProject(id);
    await get().refreshProjects();
  },

  updateMeta(patch) {
    const meta = get().meta;
    if (!meta) return;
    set({ meta: { ...meta, ...patch }, dirty: true });
  },

  onNodesChange(changes) {
    const structural = changes.some((c) => c.type === 'remove' || c.type === 'add');
    if (structural) get().commit();
    set((s) => ({
      doc: { ...s.doc, nodes: moveGroups(changes, s.doc.nodes) },
      dirty: true,
    }));
  },

  groupSelected() {
    const selected = get().doc.nodes.filter((n) => n.selected);
    // One object is not a group, and grouping is only meaningful across two.
    if (selected.length < 2) return;
    get().commit('Group');
    const groupId = uid();
    const ids = new Set(selected.map((n) => n.id));
    set((s) => ({
      doc: {
        ...s.doc,
        nodes: s.doc.nodes.map((n) =>
          ids.has(n.id) ? ({ ...n, data: { ...n.data, groupId } } as TopoNode) : n,
        ),
      },
      dirty: true,
    }));
  },

  ungroup(nodeId) {
    const groupId = groupOf(get().doc.nodes.find((n) => n.id === nodeId));
    if (!groupId) return;
    get().commit('Ungroup');
    set((s) => ({
      doc: {
        ...s.doc,
        nodes: s.doc.nodes.map((n) => {
          if (groupOf(n) !== groupId) return n;
          const data = { ...n.data };
          delete (data as { groupId?: string }).groupId;
          return { ...n, data } as TopoNode;
        }),
      },
      dirty: true,
    }));
  },

  groupBySubnet() {
    const { assignments, subnets, ungrouped } = bucketBySubnet(get().doc.nodes);
    if (assignments.size === 0) return { groups: 0, ungrouped };
    get().commit('Group by subnet');
    // One id per subnet rather than the subnet string itself: a group id is
    // opaque everywhere else, and making it meaningful here would invite
    // something to start parsing it.
    const ids = new Map(subnets.map((s) => [s, uid()]));
    set((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => {
          const subnet = assignments.get(n.id);
          return subnet
            ? ({ ...n, data: { ...n.data, groupId: ids.get(subnet) } } as TopoNode)
            : n;
        }),
      },
      dirty: true,
    }));
    return { groups: subnets.length, ungrouped };
  },

  tidyLayout() {
    const nodes = get().doc.nodes;
    const { moved, rows } = evenOutSpacing(nodes);
    const locked = nodes.filter((n) => (n.data as { locked?: boolean }).locked).length;
    if (moved.size === 0) return { moved: 0, rows, locked };
    get().commit('Tidy layout');
    set((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => {
          const at = moved.get(n.id);
          return at ? ({ ...n, position: at } as TopoNode) : n;
        }),
      },
      dirty: true,
    }));
    return { moved: moved.size, rows, locked };
  },

  routeLinks() {
    const changed = chooseLinkSides(get().doc.nodes, get().doc.edges);
    if (changed.length === 0) return 0;
    get().commit('Re-route links');
    const byId = new Map(changed.map((c) => [c.id, c]));
    set((state) => ({
      doc: {
        ...state.doc,
        edges: state.doc.edges.map((e) => {
          const want = byId.get(e.id);
          return want
            ? { ...e, sourceHandle: want.sourceHandle, targetHandle: want.targetHandle }
            : e;
        }),
      },
      dirty: true,
    }));
    return changed.length;
  },

  addLayer(name) {
    const layers = layersOf(get().doc.canvas.layers);
    get().commit('Add a view');
    set((s) => ({
      doc: { ...s.doc, canvas: { ...s.doc.canvas, layers: withNewLayer(layers, name, uid()) } },
      dirty: true,
    }));
  },

  removeLayer(id) {
    const layers = layersOf(get().doc.canvas.layers);
    get().commit('Remove a view');
    // The objects on it are deliberately left alone: they fall back to being
    // on every view, which is where an unassigned object lives. Deleting a
    // view of the network must not delete the network.
    set((s) => ({
      doc: { ...s.doc, canvas: { ...s.doc.canvas, layers: withoutLayer(layers, id) } },
      dirty: true,
    }));
  },

  setLayer(id, patch) {
    const layers = layersOf(get().doc.canvas.layers);
    set((s) => ({
      doc: {
        ...s.doc,
        canvas: {
          ...s.doc.canvas,
          layers: layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        },
      },
      // Which views are on is part of how the diagram was left.
      dirty: true,
    }));
  },

  copySelection() {
    const { nodes, edges } = get().doc;
    clipboard = copySelection(nodes, edges);
    return clipboard.nodes.length;
  },

  paste() {
    if (!clipboard || clipboard.nodes.length === 0) return 0;
    const fresh = pasteClipping(clipboard, { x: 40, y: 40 }, uid);
    get().commit('Paste');
    set((state) => ({
      doc: {
        ...state.doc,
        // The paste is selected and everything else is not, so it can be
        // dragged into place straight away.
        nodes: [
          ...state.doc.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
          ...fresh.nodes,
        ],
        edges: [...state.doc.edges, ...fresh.edges],
      },
      dirty: true,
      selectedNodeId: fresh.nodes.length === 1 ? fresh.nodes[0]!.id : null,
      selectedEdgeId: null,
    }));
    // Pasting again offsets further, so a run of pastes makes a row rather
    // than a stack nobody can separate.
    clipboard = {
      nodes: fresh.nodes.map((n) => ({ ...n })),
      edges: fresh.edges.map((e) => ({ ...e })),
    };
    return fresh.nodes.length;
  },

  selectNone() {
    set((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
        edges: state.doc.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      },
      selectedNodeId: null,
      selectedEdgeId: null,
    }));
  },

  beginEditing(id) {
    set({ editingNodeId: id });
  },

  selectAll() {
    set((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => (n.selected ? n : { ...n, selected: true })),
      },
      selectedNodeId: null,
      selectedEdgeId: null,
    }));
  },

  arrange(ids, how) {
    const wanted = new Set(ids);
    const boxes = get()
      .doc.nodes.filter((n) => wanted.has(n.id) && !(n.data as { locked?: boolean }).locked)
      .map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        w: n.width ?? n.measured?.width ?? 168,
        h: n.height ?? n.measured?.height ?? 92,
      }));
    const moved =
      how === 'across'
        ? distribute(boxes, 'x')
        : how === 'down'
          ? distribute(boxes, 'y')
          : alignTo(boxes, how);
    if (moved.size === 0) return 0;
    get().commit('Arrange');
    set((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((n) => {
          const at = moved.get(n.id);
          return at ? ({ ...n, position: at } as TopoNode) : n;
        }),
      },
      dirty: true,
    }));
    return moved.size;
  },

  unpinLinks() {
    const pinned = get().doc.edges.filter(
      (e) => (e.data as { pinnedSides?: boolean } | undefined)?.pinnedSides,
    );
    if (pinned.length === 0) return 0;
    const ids = new Set(pinned.map((e) => e.id));
    get().commit('Release links');
    set((state) => ({
      doc: {
        ...state.doc,
        edges: state.doc.edges.map((e) =>
          ids.has(e.id) ? ({ ...e, data: { ...e.data, pinnedSides: false } } as TopoEdge) : e,
        ),
      },
      dirty: true,
    }));
    return pinned.length;
  },

  groupMembers(nodeId) {
    const nodes = get().doc.nodes;
    const groupId = groupOf(nodes.find((n) => n.id === nodeId));
    return groupId ? nodes.filter((n) => groupOf(n) === groupId).map((n) => n.id) : [];
  },

  onEdgesChange(changes) {
    const structural = changes.some((c) => c.type === 'remove' || c.type === 'add');
    if (structural) get().commit();
    set((s) => ({
      doc: { ...s.doc, edges: applyEdgeChanges(changes, s.doc.edges) as TopoEdge[] },
      dirty: true,
    }));
  },

  addNode(node) {
    get().commit();
    set((s) => ({ doc: { ...s.doc, nodes: [...s.doc.nodes, node] }, dirty: true }));
  },

  addEdge(edge) {
    get().commit();
    set((s) => ({ doc: { ...s.doc, edges: [...s.doc.edges, edge] }, dirty: true }));
  },

  updateNodeData(id, patch) {
    set((s) => ({
      doc: {
        ...s.doc,
        nodes: s.doc.nodes.map((n) =>
          n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as TopoNode) : n,
        ),
      },
      dirty: true,
    }));
  },

  updateManyNodeData(ids, patch, label) {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    get().commit(label ?? 'Edit devices');
    set((s) => ({
      doc: {
        ...s.doc,
        nodes: s.doc.nodes.map((n) =>
          wanted.has(n.id) ? ({ ...n, data: { ...n.data, ...patch } } as TopoNode) : n,
        ),
      },
      dirty: true,
    }));
  },

  mapManyNodeData(ids, change, label) {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    get().commit(label ?? 'Edit devices');
    set((s) => ({
      doc: {
        ...s.doc,
        nodes: s.doc.nodes.map((n) =>
          wanted.has(n.id)
            ? ({
                ...n,
                data: { ...n.data, ...change(n.data as DeviceNodeData & NoteNodeData) },
              } as TopoNode)
            : n,
        ),
      },
      dirty: true,
    }));
  },

  updateEdgeData(id, patch) {
    set((s) => ({
      doc: {
        ...s.doc,
        edges: s.doc.edges.map((e) =>
          e.id === id ? { ...e, data: { ...(e.data as LinkData), ...patch } } : e,
        ),
      },
      dirty: true,
    }));
  },

  deleteSelected() {
    const { doc, selectedNodeId, selectedEdgeId } = get();
    get().commit();
    const selectedNodes = new Set(
      doc.nodes.filter((n) => n.selected || n.id === selectedNodeId).map((n) => n.id),
    );
    const selectedEdges = new Set(
      doc.edges.filter((e) => e.selected || e.id === selectedEdgeId).map((e) => e.id),
    );
    const lockedIds = new Set(
      doc.nodes.filter((n) => (n.data as { locked?: boolean }).locked).map((n) => n.id),
    );
    const nodes = doc.nodes.filter((n) => !selectedNodes.has(n.id) || lockedIds.has(n.id));
    const keptNodeIds = new Set(nodes.map((n) => n.id));
    const edges = doc.edges.filter(
      (e) =>
        !selectedEdges.has(e.id) && keptNodeIds.has(e.source) && keptNodeIds.has(e.target),
    );
    const removed = new Set([...selectedNodes, ...selectedEdges]);
    set({
      doc: {
        ...doc,
        nodes,
        edges,
        probes: doc.probes.filter((p) => !removed.has(p.objectId)),
      },
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: true,
    });
  },

  select(nodeId, edgeId) {
    set({ selectedNodeId: nodeId, selectedEdgeId: edgeId });
  },

  upsertProbe(probe) {
    set((s) => {
      const existing = s.doc.probes.findIndex((p) => p.id === probe.id);
      const probes = [...s.doc.probes];
      if (existing >= 0) probes[existing] = probe;
      else probes.push(probe);
      // Exactly one primary per object.
      if (probe.isPrimary) {
        for (let i = 0; i < probes.length; i += 1) {
          const p = probes[i]!;
          if (p.objectId === probe.objectId && p.id !== probe.id && p.isPrimary) {
            probes[i] = { ...p, isPrimary: false };
          }
        }
      }
      return { doc: { ...s.doc, probes }, dirty: true };
    });
  },

  setProbeTiming(intervalSeconds, failureThreshold) {
    // Clamped rather than validated: the field is a number input, and a
    // interval of zero would spin a check as fast as the machine allows.
    const interval = Math.min(3600, Math.max(1, Math.round(intervalSeconds)));
    const threshold = Math.min(60, Math.max(1, Math.round(failureThreshold)));
    const probes = get().doc.probes;
    if (probes.length === 0) return 0;
    get().commit('Check timing');
    set((s) => ({
      doc: {
        ...s.doc,
        probes: s.doc.probes.map((p) => ({
          ...p,
          intervalSeconds: interval,
          failureThreshold: threshold,
        })),
      },
      dirty: true,
    }));
    return probes.length;
  },

  removeProbe(probeId) {
    set((s) => ({
      doc: { ...s.doc, probes: s.doc.probes.filter((p) => p.id !== probeId) },
      dirty: true,
    }));
  },

  probesFor(objectId) {
    return get().doc.probes.filter((p) => p.objectId === objectId);
  },

  nodeStatus(nodeId) {
    const { doc, runtime, session } = get();
    const node = doc.nodes.find((n) => n.id === nodeId);
    const maintenance = Boolean((node?.data as DeviceNodeData | undefined)?.maintenance);
    if (session.state !== 'running' && !maintenance) {
      const probes = get().probesFor(nodeId);
      // Stopped means unknown, except where the operator disabled monitoring.
      if (probes.length > 0 && probes.every((p) => !p.enabled)) return 'disabled';
      return 'unknown';
    }
    return computeNodeStatus(get().probesFor(nodeId), runtime, maintenance);
  },

  linkStatus(edgeId) {
    const { doc, runtime, session } = get();
    const edge = doc.edges.find((e) => e.id === edgeId);
    if (!edge) return 'unknown';
    const data = (edge.data ?? {}) as LinkData;
    return computeLinkStatus({
      link: {
        enabled: data.enabled ?? true,
        maintenance: data.maintenance ?? false,
        healthRule: data.healthRule ?? { type: 'manual' },
      },
      sourceStatus: get().nodeStatus(edge.source),
      targetStatus: get().nodeStatus(edge.target),
      linkProbes: doc.probes.filter((p) => p.objectId === edgeId),
      allProbes: doc.probes,
      runtime,
      sessionRunning: session.state === 'running',
    });
  },

  commit() {
    set((s) => ({
      past: [...s.past, snapshot(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
    }));
  },

  undo() {
    const { past, doc } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({
      doc: { ...doc, ...prev },
      past: past.slice(0, -1),
      future: [snapshot(doc), ...get().future].slice(0, HISTORY_LIMIT),
      dirty: true,
    });
  },

  redo() {
    const { future, doc } = get();
    const next = future[0];
    if (!next) return;
    set({
      doc: { ...doc, ...next },
      future: future.slice(1),
      past: [...get().past, snapshot(doc)].slice(-HISTORY_LIMIT),
      dirty: true,
    });
  },

  async startValidation() {
    const { meta, doc } = get();
    if (!meta) return;
    set({ session: { ...get().session, state: 'starting' }, statusMessage: null });
    try {
      const probes = doc.probes
        .filter((p) => p.enabled && p.kind !== 'manual')
        .map((p) => ({ ...p, projectId: meta.id }));
      if (probes.length === 0) {
        set({
          session: { id: null, state: 'stopped', startedAt: null },
          statusMessage:
            'No enabled probes in this project. Add an ICMP, TCP or DNS target to a node or link first.',
        });
        return;
      }
      const info = await ipc.startValidation(meta.id, meta.engineer || 'operator', probes);
      set({
        session: { id: info.sessionId, state: 'running', startedAt: Date.now() },
        runtime: new Map(),
        statusMessage: `Validating ${info.probeCount} target${info.probeCount === 1 ? '' : 's'} from this machine.`,
      });
    } catch (err) {
      set({
        session: { id: null, state: 'error', startedAt: null },
        statusMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async stopValidation() {
    set({ session: { ...get().session, state: 'stopping' } });
    try {
      await ipc.stopValidation();
    } finally {
      set({
        session: { id: null, state: 'stopped', startedAt: null },
        runtime: new Map(),
      });
    }
  },

  applyEngineEvent(payload) {
    const p = payload as {
      kind: string;
      result?: {
        probeId: string;
        rttMs: number | null;
        summary: string;
        timestampMs: number;
        outcome: string;
      };
      status?: HealthStatus;
      transition?: {
        probeId: string;
        objectKind: 'node' | 'link';
        objectId: string;
        timestampMs: number;
        previous: HealthStatus;
        current: HealthStatus;
        message: string;
      };
      state?: SessionState;
    };

    if (p.kind === 'sample' && p.result) {
      const r = p.result;
      set((s) => {
        const runtime = new Map(s.runtime);
        const prev = runtime.get(r.probeId);
        const cfg = s.doc.probes.find((x) => x.id === r.probeId);
        runtime.set(r.probeId, {
          probeId: r.probeId,
          status: p.status ?? 'unknown',
          lastRttMs: r.rttMs,
          lastSuccessMs: r.outcome === 'success' ? r.timestampMs : (prev?.lastSuccessMs ?? null),
          lastFailureMs: r.outcome !== 'success' ? r.timestampMs : (prev?.lastFailureMs ?? null),
          lastSummary: r.summary,
          consecutiveFailures:
            r.outcome === 'success' ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
          failureThreshold: cfg?.failureThreshold ?? 3,
        });
        return { runtime };
      });
    }

    if (p.kind === 'transition' && p.transition) {
      const t = p.transition;
      const { meta, doc, session } = get();
      if (!meta) return;
      const probe = doc.probes.find((x) => x.id === t.probeId);
      const objectName =
        t.objectKind === 'node'
          ? ((doc.nodes.find((n) => n.id === t.objectId)?.data as DeviceNodeData | undefined)
              ?.label ?? t.objectId)
          : linkName(get(), t.objectId);
      const row: EventRow = {
        id: uid(),
        projectId: meta.id,
        sessionId: session.id,
        timestampMs: t.timestampMs,
        objectType: t.objectKind,
        objectId: t.objectId,
        objectName,
        eventType: 'transition',
        previousStatus: t.previous,
        currentStatus: t.current,
        probeType: probe?.kind ?? null,
        target: probe?.target ?? null,
        rttMs: get().runtime.get(t.probeId)?.lastRttMs ?? null,
        message: t.message,
      };
      set((s) => ({ events: [row, ...s.events].slice(0, 5000) }));
      void ipc.recordEvent(row);
    }

    if (p.kind === 'sessionState' && p.state) {
      set((s) => ({ session: { ...s.session, state: p.state! } }));
    }
  },

  async testNow(probe) {
    return ipc.testProbeNow(probe);
  },

  async loadEvents() {
    const meta = get().meta;
    if (!meta) return;
    set({ events: await ipc.listEvents(meta.id) });
  },

  setSettings(patch) {
    if (patch.minimap !== undefined) rememberView('minimap', patch.minimap);
    set((s) => ({ settings: { ...s.settings, ...patch } }));
  },

  /** Reads the folders back from the database on startup. Without this they
   *  would have to be re-picked every session, which is the whole point of
   *  storing them. */
  async loadSettings() {
    const stored = await ipc.getSettings();
    set((s) => ({
      settings: {
        ...s.settings,
        backupFolder: stored.backupFolder ?? null,
        exportFolder: stored.exportFolder ?? null,
      },
      iconLibraryDir: stored.iconLibraryDir ?? s.iconLibraryDir,
    }));
    if (stored.iconLibraryDir) {
      // Re-index the folder rather than trusting a remembered list: the icons
      // live outside the app and may have changed since last time.
      void get().loadIconLibrary(stored.iconLibraryDir);
    }
  },

  /** Opens the folder picker, checks the folder can actually be written to,
   *  and stores it. Returns the chosen path, or null if cancelled. */
  async chooseFolder(which) {
    const label = which === 'backupFolder' ? 'Choose a folder for configuration backups' : 'Choose a folder for exports';
    const current = get().settings[which] ?? undefined;
    const picked = await ipc.pickFolder(label, current);
    if (!picked) return null;
    try {
      await ipc.checkFolderWritable(picked);
    } catch (err) {
      set({ statusMessage: err instanceof Error ? err.message : String(err) });
      return null;
    }
    await ipc.setSetting(which, picked);
    set((s) => ({ settings: { ...s.settings, [which]: picked } }));
    return picked;
  },

  async clearFolder(which) {
    await ipc.setSetting(which, null);
    set((s) => ({ settings: { ...s.settings, [which]: null } }));
  },

  /** Index a folder of SVGs and expose them in the palette.
   *  Desktop only: in browser mode there is no filesystem access. */
  async loadIconLibrary(dir: string) {
    if (!isDesktop) {
      set({ iconLibraryError: 'An icon library needs the desktop app.' });
      return;
    }
    try {
      const lib = await ipc.listIconLibrary(dir);
      set({
        iconLibrary: lib.icons,
        iconLibraryDir: lib.dir,
        iconLibraryError: lib.skipped.length
          ? `${lib.icons.length} loaded, ${lib.skipped.length} skipped: ${lib.skipped.slice(0, 3).join('; ')}`
          : null,
      });
      // Into the database, which is where loadSettings reads it back from on
      // startup. This wrote to localStorage, which nothing has ever read, so
      // the folder had to be typed in again every session even though the
      // backend has stored the key and re-indexed on startup all along.
      try {
        await ipc.setSetting('iconLibraryDir', lib.dir);
      } catch {
        /* the icons still loaded; only remembering the folder failed */
      }
    } catch (e) {
      set({ iconLibrary: [], iconLibraryError: String(e) });
    }
  },

  setCanvas(patch) {
    set((s) => ({ doc: { ...s.doc, canvas: { ...s.doc.canvas, ...patch } }, dirty: true }));
  },

  setPanelOpen(open) {
    rememberView('panelOpen', open);
    set({ panelOpen: open });
  },

  setPaletteOpen(open) {
    rememberView('paletteOpen', open);
    set({ paletteOpen: open });
  },

  setInspectorOpen(open) {
    rememberView('inspectorOpen', open);
    set({ inspectorOpen: open });
  },

  setStatusMessage(msg) {
    set({ statusMessage: msg });
  },
}));

function linkName(state: Store, edgeId: string): string {
  const edge = state.doc.edges.find((e) => e.id === edgeId);
  if (!edge) return edgeId;
  const label = (n?: TopoNode) => (n?.data as DeviceNodeData | undefined)?.label ?? '?';
  const src = label(state.doc.nodes.find((n) => n.id === edge.source));
  const dst = label(state.doc.nodes.find((n) => n.id === edge.target));
  return `${src} ↔ ${dst}`;
}
