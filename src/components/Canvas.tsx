import { nodeForDrop } from '../lib/paletteDrop';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  ConnectionMode,
  type Connection,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { DeviceNode } from './nodes/DeviceNode';
import { NoteNode } from './nodes/NoteNode';
import { EdgeMarkerDefs, LiveEdge } from './edges/LiveEdge';
import { STATUS_COLOR_DARK, canvasPalette } from '../theme';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { FindBox } from './FindBox';
import { collapseView, groupIdOf, isCollapsed } from '../lib/collapse';
import { routeForView } from '../lib/routeLinks';
import { alignmentFor, type Box, type Guide } from '../lib/alignment';
import { useStore, type TopoEdge, type TopoNode } from '../state/store';
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import type { DeviceNodeData, DeviceType, NoteNodeData } from '../types/domain';

const nodeTypes = { device: DeviceNode, note: NoteNode };
const edgeTypes = { live: LiveEdge };

/** How big a shape arrives. A section is an area, so it arrives as one — a
 *  176x96 section would have to be resized before it could hold anything. */
function defaultSize(type: DeviceType): { width: number; height: number } {
  if (type === 'zone') return { width: 420, height: 300 };
  return { width: 168, height: 92 };
}

export function makeDeviceNode(type: DeviceType, x: number, y: number): TopoNode {
  const data: DeviceNodeData = {
    label: DEVICE_LABEL[type],
    deviceType: type,
    tags: [],
    addresses: [],
    locked: false,
    maintenance: false,
    showDetails: true,
  };
  const { width, height } = defaultSize(type);
  return {
    id: uid(),
    type: 'device',
    position: { x, y },
    width,
    height,
    data,
  };
}

export function makeNote(x: number, y: number, variant: NoteNodeData['variant'] = 'plain'): TopoNode {
  const data: NoteNodeData = {
    title: variant === 'change' ? 'Change note' : undefined,
    body:
      variant === 'change'
        ? '## Pre-check\n- [ ] Baseline captured\n\n## Implementation\n- [ ] Step 1\n\n## Rollback\n- [ ] Restore config'
        : 'Note',
    variant,
    fontSize: 13,
    // Left unset on purpose: a note nobody has coloured follows the ground,
    // so a diagram drawn on black and printed on white does not carry dark
    // blocks through the middle of the page.
    locked: false,
  };
  return { id: uid(), type: 'note', position: { x, y }, width: 260, height: 160, data };
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function Canvas() {
  const wrapper = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const ground = useStore((s) => s.settings.ground);
  const palette = canvasPalette(ground);

  const [finding, setFinding] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  // A view, not a document change: folding a site must not touch what is
  // saved, so expanding restores exactly what was there.
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);

  const doc = useStore((s) => s.doc);
  const store = useStore();

  const onConnect: OnConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      // Loose connections let any side reach any side, which also means a
      // node can be dropped on itself. A link from a device to itself is
      // never what someone meant to draw.
      if (c.source === c.target) return;
      const edge: TopoEdge = {
        id: uid(),
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle ?? null,
        targetHandle: c.targetHandle ?? null,
        type: 'live',
        data: {
          sourcePortLabel: '',
          targetPortLabel: '',
          label: '',
          pathType: 'smoothstep',
          direction: 'forward',
          width: 2,
          // A stored default, not a drawn one: what is saved in the document
          // must not depend on which ground the person who drew it was using.
          color: STATUS_COLOR_DARK.unknown,
          enabled: true,
          maintenance: false,
          healthRule: { type: 'both-endpoints' },
        },
      };
      store.addEdge(edge);
      store.select(null, edge.id);
    },
    [store],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData('application/coreview');
      if (!raw) return;
      const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = nodeForDrop(raw, position.x, position.y, {
        makeDeviceNode,
        makeNote,
        iconLibrary: store.iconLibrary,
      });
      if (node) store.addNode(node);
    },
    [rf, store],
  );

  const nodeMenu = (nodeId: string): MenuItem[] => {
    // A folded box stands for objects rather than being one. Offering to
    // duplicate or delete it would act on an id that is not in the document.
    if (isCollapsed(nodeId)) {
      return [
        {
          label: 'Open this group',
          onSelect: () =>
            setFolded((was) => {
              const next = new Set(was);
              next.delete(groupIdOf(nodeId));
              return next;
            }),
        },
      ];
    }
    const node = doc.nodes.find((n) => n.id === nodeId);
    const locked = Boolean((node?.data as { locked?: boolean } | undefined)?.locked);
    const maintenance = Boolean((node?.data as DeviceNodeData | undefined)?.maintenance);
    const members = store.groupMembers(nodeId);
    const selectedCount = doc.nodes.filter((n) => n.selected).length;
    return [
      { label: 'Edit properties', onSelect: () => store.select(nodeId, null) },
      {
        label: 'Duplicate',
        onSelect: () => {
          if (!node) return;
          store.addNode({
            ...node,
            id: uid(),
            position: { x: node.position.x + 40, y: node.position.y + 40 },
            selected: false,
          } as TopoNode);
        },
      },
      {
        label: maintenance ? 'Clear maintenance' : 'Set maintenance',
        onSelect: () => store.updateNodeData(nodeId, { maintenance: !maintenance }),
      },
      {
        label: locked ? 'Unlock' : 'Lock',
        onSelect: () => store.updateNodeData(nodeId, { locked: !locked }),
      },
      ...(members.length > 1
        ? [
            {
              label: `Fold this group into one box (${members.length} objects)`,
              onSelect: () => {
                const group = (
                  doc.nodes.find((n) => n.id === nodeId)?.data as { groupId?: string }
                )?.groupId;
                if (group) setFolded((was) => new Set(was).add(group));
              },
            },
            {
              label: `Ungroup (${members.length} objects)`,
              onSelect: () => store.ungroup(nodeId),
            },
          ]
        : selectedCount > 1
          ? [{ label: `Group ${selectedCount} objects`, onSelect: () => store.groupSelected() }]
          : []),
      { label: 'Bring forward', onSelect: () => reorder(nodeId, 1) },
      { label: 'Send backward', onSelect: () => reorder(nodeId, -1) },
      {
        label: 'Delete',
        danger: true,
        onSelect: () => {
          store.select(nodeId, null);
          store.deleteSelected();
        },
      },
    ];
  };

  const reorder = (nodeId: string, delta: number) => {
    const nodes = [...doc.nodes];
    const i = nodes.findIndex((n) => n.id === nodeId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= nodes.length) return;
    const a = nodes[i]!;
    const b = nodes[j]!;
    nodes[i] = b;
    nodes[j] = a;
    store.commit();
    useStore.setState((s) => ({ doc: { ...s.doc, nodes }, dirty: true }));
  };

  const edgeMenu = (edgeId: string): MenuItem[] => {
    const edge = doc.edges.find((e) => e.id === edgeId);
    const data = edge?.data;
    return [
      { label: 'Edit link properties', onSelect: () => store.select(null, edgeId) },
      {
        label: 'Reverse flow direction',
        onSelect: () =>
          store.updateEdgeData(edgeId, {
            direction: data?.direction === 'forward' ? 'reverse' : 'forward',
          }),
      },
      {
        label: 'Cycle path type',
        onSelect: () => {
          const order = ['smoothstep', 'bezier', 'step', 'straight'] as const;
          const next = order[(order.indexOf(data?.pathType ?? 'smoothstep') + 1) % order.length]!;
          store.updateEdgeData(edgeId, { pathType: next });
        },
      },
      {
        label: data?.maintenance ? 'Clear maintenance' : 'Set maintenance',
        onSelect: () => store.updateEdgeData(edgeId, { maintenance: !data?.maintenance }),
      },
      {
        label: 'Delete',
        danger: true,
        onSelect: () => {
          store.select(null, edgeId);
          store.deleteSelected();
        },
      },
    ];
  };

  const paneMenu = (clientX: number, clientY: number): MenuItem[] => {
    const p = rf.screenToFlowPosition({ x: clientX, y: clientY });
    return [
      { label: 'Add note', onSelect: () => store.addNode(makeNote(p.x, p.y)) },
      { label: 'Add change note', onSelect: () => store.addNode(makeNote(p.x, p.y, 'change')) },
      { label: 'Add container', onSelect: () => store.addNode(makeDeviceNode('site', p.x, p.y)) },
      { label: 'Fit view', onSelect: () => rf.fitView({ padding: 0.2 }) },
      { label: 'Find a device…', onSelect: () => setFinding(true) },
      ...(folded.size > 0
        ? [
            {
              label: `Open all folded groups (${folded.size})`,
              onSelect: () => setFolded(new Set()),
            },
          ]
        : []),
      {
        label: doc.canvas.gridEnabled ? 'Hide grid' : 'Show grid',
        onSelect: () => store.setCanvas({ gridEnabled: !doc.canvas.gridEnabled }),
      },
      {
        label:
          (doc.canvas.nodeStyle ?? 'glyph') === 'glyph'
            ? 'Draw devices as cards'
            : 'Draw devices as symbols',
        onSelect: () =>
          store.setCanvas({
            nodeStyle: (doc.canvas.nodeStyle ?? 'glyph') === 'glyph' ? 'card' : 'glyph',
          }),
      },
      {
        label: 'Tidy the layout',
        onSelect: () => {
          const { moved, rows, locked } = store.tidyLayout();
          store.setStatusMessage(
            moved === 0
              ? 'Nothing to tidy — the spacing is already even.'
              : `Evened out ${moved} device${moved === 1 ? '' : 's'} across ${rows} row${
                  rows === 1 ? '' : 's'
                }. Nothing was rearranged.` +
                (locked ? ` ${locked} locked device${locked === 1 ? '' : 's'} left alone.` : ''),
          );
        },
      },
      {
        label: (doc.canvas.lineJumps ?? true) ? 'Stop hopping crossed links' : 'Hop crossed links',
        onSelect: () =>
          store.setCanvas({ lineJumps: !(doc.canvas.lineJumps ?? true) }),
      },
      {
        label: 'Let every link follow its devices',
        onSelect: () => {
          const freed = store.unpinLinks();
          store.setStatusMessage(
            freed === 0
              ? 'Every link already follows its devices.'
              : `${freed} link${freed === 1 ? '' : 's'} released. They will swing round to the ` +
                'nearer side as you move things.',
          );
        },
      },
      {
        label: 'Group each subnet together',
        onSelect: () => {
          const { groups, ungrouped } = store.groupBySubnet();
          store.setStatusMessage(
            groups === 0
              ? 'Nothing to group — no two devices share a /24.'
              : `Grouped ${groups} subnet${groups === 1 ? '' : 's'}. Dragging one device now moves its whole subnet.` +
                (ungrouped ? ` ${ungrouped} device${ungrouped === 1 ? '' : 's'} left ungrouped.` : ''),
          );
        },
      },
      {
        label: doc.canvas.minimap ? 'Hide the overview box' : 'Show the overview box',
        onSelect: () => store.setCanvas({ minimap: !doc.canvas.minimap }),
      },
    ];
  };

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void store.saveProject();
      } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        store.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const sel = doc.nodes.find((n) => n.selected);
        if (sel) {
          store.addNode({
            ...sel,
            id: uid(),
            position: { x: sel.position.x + 40, y: sel.position.y + 40 },
            selected: false,
          } as TopoNode);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelected();
      } else if (e.key === 'f' && !mod) {
        rf.fitView({ padding: 0.2 });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [doc.nodes, rf, store]);

  // React Flow decides whether a node can be dragged from a `draggable` field
  // on the node itself. `locked` lives in `data`, which it never looks at, so
  // "Lock position" hid the resize handles — the one part DeviceNode reads
  // directly — and left the node as draggable as before.
  const view = useMemo(() => {
    const folded_ = collapseView(doc.nodes, doc.edges, folded);
    // Routed after folding, so a link redrawn to a folded box leaves the side
    // of the box that faces where it is going.
    return { nodes: folded_.nodes, edges: routeForView(folded_.nodes, folded_.edges) };
  }, [doc.nodes, doc.edges, folded]);

  const nodes = useMemo(
    () =>
      view.nodes.map((n) => {
        const locked = Boolean((n.data as { locked?: boolean }).locked);
        // A section is a backdrop: it has to sit under the devices standing
        // in it, or it covers them and the diagram is a set of empty boxes.
        const zIndex = (n.data as { deviceType?: string }).deviceType === 'zone' ? 0 : 1;
        return locked ? { ...n, draggable: false, zIndex } : { ...n, zIndex };
      }),
    [view.nodes],
  );

  const boxOf = (n: TopoNode): Box => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? 168,
    h: n.height ?? n.measured?.height ?? 92,
  });

  /** Lines a dragged device up with the ones already placed, as the move
   *  arrives rather than after it.
   *
   *  Correcting the position from `onNodeDrag` does not hold: React Flow is
   *  mid-drag and its next event overwrites whatever was written, so the
   *  guide appeared and the device landed a few pixels out anyway. Rewriting
   *  the change on its way through is the only point at which the corrected
   *  position is the one React Flow goes on to use.
   *
   *  Grid snapping is not a substitute. It quantises to ten pixels, which is
   *  not the same as being in line — two devices can both sit on the grid and
   *  still be four pixels out from each other, and four pixels out is what a
   *  diagram looks untidy for. */
  const onNodesChange = useCallback(
    (changes: NodeChange<TopoNode>[]) => {
      // Defaulted on. A document saved before this existed has no value here,
      // and reading that as "off" quietly disabled guides for every diagram
      // already drawn.
      if (!(doc.canvas.snapEnabled ?? true)) {
        store.onNodesChange(changes);
        return;
      }
      // Includes the last change of a drag, which arrives with `dragging`
      // already false and carries React Flow's own final position. Skipping
      // it let the guide show all the way through and then put the device
      // back where the pointer was, a few pixels out.
      const dragging = changes.filter(
        (c): c is NodeChange<TopoNode> & { id: string; position: { x: number; y: number } } =>
          c.type === 'position' && Boolean(c.position),
      );
      if (dragging.length !== 1) {
        // Nothing to line up against for a multi-selection drag: the whole
        // group is moving and its members are already in line with each other.
        if (dragging.length === 0 && changes.some((c) => c.type === 'position')) setGuides([]);
        store.onNodesChange(changes);
        return;
      }

      const moving = dragging[0]!;
      const node = doc.nodes.find((n) => n.id === moving.id);
      if (!node) {
        store.onNodesChange(changes);
        return;
      }
      // In diagram units. Ten screen pixels at quarter zoom is forty units,
      // and a snap that grabs from forty away feels like the device is being
      // taken out of your hands.
      const tolerance = 7 / Math.max(0.2, rf.getZoom());
      const others = doc.nodes.filter((n) => n.id !== moving.id && !n.selected).map(boxOf);
      const found = alignmentFor({ ...boxOf(node), ...moving.position }, others, tolerance);
      setGuides(found.guides);
      store.onNodesChange(
        changes.map((c) =>
          c === moving ? { ...c, position: { x: found.x, y: found.y } } : c,
        ) as NodeChange<TopoNode>[],
      );
    },
    [doc.canvas.snapEnabled, doc.nodes, rf, store],
  );

  return (
    <div className="cv-canvas" ref={wrapper} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <EdgeMarkerDefs />
      <ReactFlow
        nodes={nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={store.onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={() => setGuides([])}
        /* Every side of a device is a source, so a link can leave whichever
           side faces where it is going. Loose mode is what lets one of those
           sources also be the end of a link. */
        connectionMode={ConnectionMode.Loose}
        onNodeClick={(_, n) => store.select(n.id, null)}
        onEdgeClick={(_, e) => store.select(null, e.id)}
        onPaneClick={() => {
          store.select(null, null);
          setMenu(null);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          store.select(n.id, null);
          setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n.id) });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          store.select(null, edge.id);
          setMenu({ x: e.clientX, y: e.clientY, items: edgeMenu(edge.id) });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const ev = e as React.MouseEvent;
          setMenu({ x: ev.clientX, y: ev.clientY, items: paneMenu(ev.clientX, ev.clientY) });
        }}
        /* No grid snap. It quantises to ten pixels, which is not the same as
           being in line — two devices can both sit on the grid and still be
           four pixels out from each other — and it fights the alignment
           guides for the last few pixels of every drag. Lining up with the
           neighbours is what people are actually trying to do. */
        /* Left-drag pans, which is what every diagram tool does and what
           people reach for first. It used to draw a selection box, so the
           only way to move around a diagram larger than the window was the
           minimap. Shift-drag still draws the box, and Ctrl-click still adds
           to a selection. */
        panOnDrag
        selectionOnDrag={false}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Control"
        panOnScroll={false}
        deleteKeyCode={null}
        fitView
        /* React Flow is MIT, and its authors ask rather than require that the
           badge stay. It is a link out to their site sitting on top of the
           operator's diagram, and it was being mistaken for part of Coreview. */
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'live' }}
      >
        <ViewportPortal>
          {guides.map((g) => (
            <div
              key={`${g.orientation}-${g.at}-${g.from}`}
              className={`cv-guide is-${g.orientation}`}
              style={
                g.orientation === 'vertical'
                  ? { left: g.at, top: g.from, height: g.to - g.from }
                  : { top: g.at, left: g.from, width: g.to - g.from }
              }
            />
          ))}
        </ViewportPortal>
        {doc.canvas.gridEnabled && (
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={palette.grid} />
        )}
        <Controls showInteractive={false} />
        {doc.canvas.minimap && (
          <MiniMap
            pannable
            zoomable
            className="cv-minimap"
            nodeColor={(n) => (n.type === 'note' ? palette.minimapNote : palette.minimapNode)}
            maskColor={palette.minimapMask}
          />
        )}
      </ReactFlow>
      {finding && <FindBox onClose={() => setFinding(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
