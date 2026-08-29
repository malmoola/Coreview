import { create } from 'zustand';
import type { Edge, Node } from '@xyflow/react';
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react';

import { ipc, isDesktop, type ProbeResultDto, type IconLibEntry } from '../lib/ipc';
import { uid } from '../lib/id';
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
  canvas: { gridEnabled: boolean; snapEnabled: boolean; minimap: boolean };
}

export interface AppSettings {
  reduceMotion: boolean;
  highContrast: boolean;
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
  selectedEdgeId: string | null;
  settings: AppSettings;
  /** Runtime-indexed icon library. Never persisted with the project — the
   *  project stores an iconRef plus an inlined copy instead. */
  iconLibrary: IconLibEntry[];
  iconLibraryDir: string | null;
  iconLibraryError: string | null;
  panelOpen: boolean;

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
  onEdgesChange: (changes: EdgeChange<TopoEdge>[]) => void;
  addNode: (node: TopoNode) => void;
  addEdge: (edge: TopoEdge) => void;
  updateNodeData: (id: string, patch: Partial<DeviceNodeData & NoteNodeData>) => void;
  updateEdgeData: (id: string, patch: Partial<LinkData>) => void;
  deleteSelected: () => void;
  select: (nodeId: string | null, edgeId: string | null) => void;

  upsertProbe: (probe: Probe) => void;
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
  setStatusMessage: (msg: string | null) => void;
}

export const emptyDocument = (): ProjectDocument => ({
  nodes: [],
  edges: [],
  probes: [],
  canvas: { gridEnabled: true, snapEnabled: true, minimap: true },
});

const HISTORY_LIMIT = 60;

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
  selectedEdgeId: null,
  iconLibrary: [],
  iconLibraryDir: null,
  iconLibraryError: null,
  settings: {
    reduceMotion:
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    highContrast: false,
    backupFolder: null,
    exportFolder: null,
  },
  panelOpen: true,
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
      doc: { ...s.doc, nodes: applyNodeChanges(changes, s.doc.nodes) as TopoNode[] },
      dirty: true,
    }));
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
      try {
        localStorage.setItem('coreview.iconLibraryDir', lib.dir);
      } catch {
        /* storage unavailable — the folder just is not remembered */
      }
    } catch (e) {
      set({ iconLibrary: [], iconLibraryError: String(e) });
    }
  },

  setCanvas(patch) {
    set((s) => ({ doc: { ...s.doc, canvas: { ...s.doc.canvas, ...patch } }, dirty: true }));
  },

  setPanelOpen(open) {
    set({ panelOpen: open });
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
