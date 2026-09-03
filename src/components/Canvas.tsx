import { nodeForDrop } from '../lib/paletteDrop';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  ConnectionMode,
  SelectionMode,
  type Connection,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { DeviceNode } from './nodes/DeviceNode';
import { NoteNode } from './nodes/NoteNode';
import { EdgeMarkerDefs, LiveEdge, nearestFractionOnPath } from './edges/LiveEdge';
import { allPaths } from './edges/pathRegistry';
import { STATUS_COLOR_DARK, canvasPalette } from '../theme';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { FindBox } from './FindBox';
import { ColourLegend } from './ColourLegend';
import { ShortcutHelp } from './ShortcutHelp';
import { Page } from './Page';
import { effectivePage, pageForContent } from '../lib/pageRect';
import { collapseView, groupIdOf, isCollapsed } from '../lib/collapse';
import { routeForView } from '../lib/routeLinks';
import { alignmentFor, spacingHint, type Box, type Guide } from '../lib/alignment';
import { isEditable, isVisible, layersOf } from '../lib/layers';
import { resetToDefault, styleOf } from '../lib/linkDefaults';
import { useStore, type TopoEdge, type TopoNode } from '../state/store';
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import type { DeviceNodeData, DeviceType, LinkData, NoteNodeData } from '../types/domain';

const nodeTypes = { device: DeviceNode, note: NoteNode };
const edgeTypes = { live: LiveEdge };

/** How big a shape arrives. A section is an area, so it arrives as one — a
 *  176x96 section would have to be resized before it could hold anything. */
function defaultSize(type: DeviceType): { width: number; height: number } {
  if (type === 'zone') return { width: 420, height: 300 };
  if (type === 'callout') return { width: 190, height: 64 };
  if (type === 'text') return { width: 168, height: 44 };
  // Shapes keep the card proportions; a device is its glyph (LT-053), and a
  // glyph's bounds are square so the corners sit on the drawn shape.
  if (['rectangle', 'rounded', 'circle', 'diamond', 'cloud'].includes(type)) {
    return { width: 168, height: 92 };
  }
  return { width: 76, height: 76 };
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
  const settings = useStore((s) => s.settings);
  const palette = canvasPalette(ground);

  const [finding, setFinding] = useState(false);
  const [help, setHelp] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  /** Space held: the pointer becomes a hand and drags the diagram. */
  const [panning, setPanning] = useState(false);
  /** Space was let go mid-drag: the hand stays until the button comes up. */
  const releaseAfterDrag = useRef(false);
  /** Alt held: the guides stand down and the drag is free-hand. Sometimes a
   *  device has to sit deliberately two pixels off, and a snap that cannot be
   *  refused is a snap that gets fought. A ref, not state — it is read inside
   *  the drag path and must not re-render the canvas per keypress. */
  const altDown = useRef(false);
  const panFrom = useRef<{
    from: { x: number; y: number; zoom: number };
    startX: number;
    startY: number;
  } | null>(null);
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

      // A line out of a piece of text is a leader, not a cable. Drawing one
      // from a note and then having to turn off its health, its arrow and its
      // packet dots by hand is three steps to say something obvious.
      const annotation = (id: string) => {
        const n = doc.nodes.find((x) => x.id === id);
        if (!n) return false;
        if (n.type === 'note') return true;
        const kind = (n.data as { deviceType?: string }).deviceType;
        return kind === 'text' || kind === 'callout';
      };
      const leader = annotation(c.source) || annotation(c.target);
      const edge: TopoEdge = {
        id: uid(),
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle ?? null,
        targetHandle: c.targetHandle ?? null,
        type: 'live',
        data: {
          ...(leader ? { kind: 'leader' as const } : {}),
          sourcePortLabel: '',
          targetPortLabel: '',
          label: '',
          pathType: leader ? 'straight' : 'smoothstep',
          direction: leader ? 'none' : 'forward',
          width: 2,
          // A stored default, not a drawn one: what is saved in the document
          // must not depend on which ground the person who drew it was using.
          color: STATUS_COLOR_DARK.unknown,
          enabled: true,
          maintenance: false,
          healthRule: leader ? { type: 'manual' } : { type: 'both-endpoints' },
        },
      };
      store.addEdge(edge);
      store.select(null, edge.id);
    },
    [store, doc.nodes],
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
        // The user's own folder first, so an id clash resolves to their
        // icon; the bundled set (D-022) backs it.
        iconLibrary: [...store.iconLibrary, ...store.bundledIcons],
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
      ...(selectedCount > 1
        ? ([
            ['left', 'Line up their left edges'],
            ['centre', 'Line up their centres'],
            ['right', 'Line up their right edges'],
            ['top', 'Line up their tops'],
            ['middle', 'Line up their middles'],
            ['bottom', 'Line up their bottoms'],
            ['across', 'Even the gaps across'],
            ['down', 'Even the gaps down'],
          ] as const).map(([how, label]) => ({
            label,
            onSelect: () => {
              const ids = doc.nodes.filter((n) => n.selected).map((n) => n.id);
              const moved = store.arrange(ids, how);
              store.setStatusMessage(
                moved === 0
                  ? 'They are already arranged that way.'
                  : `Moved ${moved} object${moved === 1 ? '' : 's'}.`,
              );
            },
          }))
        : []),
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
      // LT-068: hand a link back to auto-routing.
      ...(data?.waypoints?.length
        ? [{ label: 'Reset routing', onSelect: () => store.updateEdgeData(edgeId, { waypoints: [] }) }]
        : []),
      // LT-079: back to the look the operator chose — colour, path, flow,
      // width, line style — leaving the ports, label and health rule alone.
      {
        label: 'Reset to default style',
        onSelect: () => {
          store.commit();
          store.updateEdgeData(edgeId, resetToDefault(doc.canvas.linkStyle));
        },
      },
      {
        label: 'Save this style as the default',
        onSelect: () => {
          if (!data) return;
          store.setCanvas({ linkStyle: styleOf(data) });
          store.setStatusMessage('New links will look like this one.');
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
      { label: 'Fit view', onSelect: () => fitEverything() },
      {
        label: 'Fit page to content',
        onSelect: () => {
          // The one deliberate shrink. Growth is automatic; going back is not,
          // because a sheet that snaps smaller on its own makes the layout
          // jump under the pointer.
          store.setCanvas({ pageRect: pageForContent(doc.nodes) });
          store.setStatusMessage('The page now fits what is on it.');
        },
      },
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
      ...(['health', 'role', 'subnet', 'tag', 'vlan'] as const)
        .filter((by) => by !== (doc.canvas.colourBy ?? 'health'))
        .map((by) => ({
          label:
            by === 'health'
              ? 'Colour devices by health'
              : by === 'role'
                ? 'Colour devices by what they are'
                : by === 'vlan'
                ? 'Colour devices by VLAN'
                : `Colour devices by ${by}`,
          onSelect: () => store.setCanvas({ colourBy: by }),
        })),
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
        label: settings.minimap ? 'Hide the overview box' : 'Show the overview box',
        onSelect: () => store.setSettings({ minimap: !settings.minimap }),
      },
    ];
  };

  /** Double-click on bare canvas puts text where you clicked and starts
   *  typing. Every drawing tool does this, and the alternative — find the
   *  palette, drag a text shape out, double-click it — is three steps to
   *  write a word.
   *
   *  A native listener in the capture phase, because React Flow does not let
   *  a double-click on the pane reach anything above it: the React handler on
   *  the wrapper never ran, and nothing said why. */
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const write = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // Only on the canvas itself. Double-clicking a device renames it, and
      // dropping a text box on the thing being renamed is a surprise.
      if (!target?.classList.contains('react-flow__pane')) return;
      const at = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = makeDeviceNode('text', at.x - 60, at.y - 14);
      (node.data as DeviceNodeData).label = 'Text';
      node.width = 140;
      node.height = 30;
      store.addNode(node);
      store.beginEditing(node.id);
    };
    el.addEventListener('dblclick', write, true);
    return () => el.removeEventListener('dblclick', write, true);
  }, [rf, store]);

  /** Fit the sheet, not just what is on it.
   *
   *  Fitting to the devices alone puts the page edge off-screen, so the one
   *  thing that says where the drawing surface is cannot be seen. When the
   *  page is off, there is nothing to fit but the devices. */
  const fitEverything = useCallback(() => {
    if (!(doc.canvas.page ?? true)) {
      // A fit keeps the old ceiling: LT-047 opened the wheel's walls, and
      // unbounded fitting turns two close devices into a monitor-filling
      // glyph.
      rf.fitView({ padding: 0.2, maxZoom: 2 });
      return;
    }
    // The same rect the page renderer draws — one function, not two copies.
    const sheet = effectivePage(doc.canvas.pageRect, doc.nodes);
    rf.fitBounds({ x: sheet.x, y: sheet.y, width: sheet.w, height: sheet.h }, { padding: 0.08 });
    if (rf.getZoom() > 2) rf.zoomTo(2);
  }, [doc.canvas.page, doc.canvas.pageRect, doc.nodes, rf]);

  // Space held is "grab the diagram". Kept separate from the shortcut handler
  // below because it has to watch both the press and the release, and must
  // not fire while someone is typing a device name.
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return Boolean(
        el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable),
      );
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altDown.current = true;
      if (e.code !== 'Space' || e.repeat || typing(e.target)) return;
      // Space scrolls the page otherwise, which on a canvas means nothing
      // visible happens and the diagram jumps.
      e.preventDefault();
      setPanning(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altDown.current = false;
      if (e.code !== 'Space') return;
      // A drag already under way keeps going until the *button* is released
      // (LT-075). Space starts the hand; letting go of it half way through a
      // drag is what everyone does, and tearing the hand away there left the
      // diagram sliding to a stop under the cursor instead of following it.
      if (panFrom.current) {
        releaseAfterDrag.current = true;
        return;
      }
      setPanning(false);
    };
    // Releasing space while the window is not focused would otherwise leave
    // the canvas stuck in panning.
    const blur = () => {
      altDown.current = false;
      panFrom.current = null;
      releaseAfterDrag.current = false;
      setPanning(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+Alt+letter arranges a multiple selection — the keyboard half of
      // the context menu's align and distribute.
      if (mod && e.altKey) {
        const how = ({
          l: 'left', c: 'centre', r: 'right',
          t: 'top', m: 'middle', b: 'bottom',
          h: 'across', v: 'down',
        } as const)[e.key.toLowerCase() as 'l'];
        if (how) {
          const ids = doc.nodes.filter((n) => n.selected).map((n) => n.id);
          if (ids.length > 1) {
            e.preventDefault();
            const moved = store.arrange(ids, how);
            store.setStatusMessage(
              moved === 0
                ? 'They are already arranged that way.'
                : `Moved ${moved} object${moved === 1 ? '' : 's'}.`,
            );
            return;
          }
        }
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        store.selectAll();
      } else if (mod && e.key.toLowerCase() === 'c') {
        const copied = store.copySelection();
        if (copied > 0) {
          e.preventDefault();
          store.setStatusMessage(`Copied ${copied} object${copied === 1 ? '' : 's'}.`);
        }
      } else if (mod && e.key.toLowerCase() === 'v') {
        const pasted = store.paste();
        if (pasted > 0) {
          e.preventDefault();
          store.setStatusMessage(`Pasted ${pasted} object${pasted === 1 ? '' : 's'}.`);
        }
      } else if (mod && e.key.toLowerCase() === 'f') {
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
          // Offset by one grid step, and the copy takes the selection — the
          // original must let go of it, or the next Delete removes both.
          store.selectNone();
          store.addNode({
            ...sel,
            id: uid(),
            position: { x: sel.position.x + 60, y: sel.position.y + 60 },
            selected: true,
          } as TopoNode);
        }
      } else if (e.key.startsWith('Arrow') && !mod) {
        // Arrows nudge by a pixel, Shift-arrows by a grid step. The keyboard
        // is how the last two pixels of a layout actually get done.
        const ids = doc.nodes
          .filter((n) => n.selected && !(n.data as { locked?: boolean }).locked)
          .map((n) => n.id);
        if (ids.length > 0) {
          e.preventDefault();
          const step = e.shiftKey ? 60 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          store.onNodesChange(
            doc.nodes
              .filter((n) => ids.includes(n.id))
              .map((n) => ({
                id: n.id,
                type: 'position' as const,
                position: { x: n.position.x + dx, y: n.position.y + dy },
              })),
          );
        }
      } else if (e.key === 'Escape') {
        // Layered: the first Escape closes what is on top, the next clears
        // the selection. One key, nearest thing first.
        if (help) {
          setHelp(false);
          return;
        }
        store.selectNone();
        setGuides([]);
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelected();
      } else if (e.key === 'f' && !mod) {
        fitEverything();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [doc.nodes, rf, store, fitEverything, help]);

  // React Flow decides whether a node can be dragged from a `draggable` field
  // on the node itself. `locked` lives in `data`, which it never looks at, so
  // "Lock position" hid the resize handles — the one part DeviceNode reads
  // directly — and left the node as draggable as before.
  const view = useMemo(() => {
    // Hidden views come out first: everything after this — folding, routing,
    // hops — should be reasoning about the diagram as it is being looked at.
    const layers = layersOf(doc.canvas.layers);
    const anyHidden = layers.some((l) => !l.visible);
    const nodes = anyHidden
      ? doc.nodes.filter((n) => isVisible((n.data as { layers?: string[] }).layers, layers))
      : doc.nodes;
    const alive = new Set(nodes.map((n) => n.id));
    const edges = anyHidden
      ? doc.edges.filter(
          (e) =>
            isVisible((e.data as { layers?: string[] } | undefined)?.layers, layers) &&
            // A link whose device is on a hidden view has nowhere to land.
            alive.has(e.source) &&
            alive.has(e.target),
        )
      : doc.edges;

    const folded_ = collapseView(nodes, edges, folded);
    // Routed after folding, so a link redrawn to a folded box leaves the side
    // of the box that faces where it is going.
    return { nodes: folded_.nodes, edges: routeForView(folded_.nodes, folded_.edges) };
  }, [doc.nodes, doc.edges, doc.canvas.layers, folded]);

  const nodes = useMemo(
    () =>
      view.nodes.map((n) => {
        const layers = layersOf(doc.canvas.layers);
        const locked =
          Boolean((n.data as { locked?: boolean }).locked) ||
          !isEditable((n.data as { layers?: string[] }).layers, layers);
        // A section is a backdrop: it has to sit under the devices standing
        // in it, or it covers them and the diagram is a set of empty boxes.
        const zIndex = (n.data as { deviceType?: string }).deviceType === 'zone' ? 0 : 1;
        return locked ? { ...n, draggable: false, zIndex } : { ...n, zIndex };
      }),
    [view.nodes, doc.canvas.layers],
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
      if (!(doc.canvas.snapEnabled ?? true) || altDown.current) {
        if (altDown.current) setGuides([]);
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
      const dragged = { ...boxOf(node), ...moving.position };
      const found = alignmentFor(dragged, others, tolerance);

      // Lining up is half of tidy; the other half is the gaps being equal.
      // Where both an edge and a rhythm are within reach on the same axis,
      // the one asking for the smaller correction wins: whichever the device
      // was already closer to is the one the person was aiming at.
      const settled = { x: found.x, y: found.y };
      const spacingGuides: Guide[] = [];
      const span = (from: number[], to: number[]) => ({
        from: Math.min(...from),
        to: Math.max(...to),
      });

      // "Nothing to snap to" is not a competitor: when no edge lined up,
      // found.x is just where the box already is, and comparing against that
      // zero made the rhythm unreachable except when an accidental edge
      // alignment happened to coexist.
      const xAligned = found.guides.some((g) => g.orientation === 'vertical');
      const rhythmX = spacingHint(dragged, others, 'x', tolerance);
      if (
        rhythmX !== null &&
        (!xAligned || Math.abs(rhythmX - dragged.x) <= Math.abs(found.x - dragged.x))
      ) {
        settled.x = rhythmX;
        const edges = span(
          [rhythmX, ...others.map((o) => o.x)],
          [rhythmX + dragged.w, ...others.map((o) => o.x + o.w)],
        );
        spacingGuides.push({
          orientation: 'horizontal',
          at: settled.y + dragged.h / 2,
          ...edges,
        });
      }

      const yAligned = found.guides.some((g) => g.orientation === 'horizontal');
      const rhythmY = spacingHint(dragged, others, 'y', tolerance);
      if (
        rhythmY !== null &&
        (!yAligned || Math.abs(rhythmY - dragged.y) <= Math.abs(found.y - dragged.y))
      ) {
        settled.y = rhythmY;
        const edges = span(
          [rhythmY, ...others.map((o) => o.y)],
          [rhythmY + dragged.h, ...others.map((o) => o.y + o.h)],
        );
        spacingGuides.push({
          orientation: 'vertical',
          at: settled.x + dragged.w / 2,
          ...edges,
        });
      }

      // A guide for an edge the device is no longer snapped to would be a
      // line pointing at nothing.
      const keptGuides = found.guides.filter((g) =>
        g.orientation === 'vertical' ? settled.x === found.x : settled.y === found.y,
      );

      setGuides([...keptGuides, ...spacingGuides]);
      store.onNodesChange(
        changes.map((c) =>
          c === moving ? { ...c, position: { x: settled.x, y: settled.y } } : c,
        ) as NodeChange<TopoNode>[],
      );
    },
    [doc.canvas.snapEnabled, doc.nodes, rf, store],
  );


  return (
    <div
      className={`cv-canvas${panning ? ' is-panning' : ''}`}
      ref={wrapper}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
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
        minZoom={0.01}
        maxZoom={100}
        onNodeClick={(_, n) => store.select(n.id, null)}
        onEdgeClick={(_, e) => store.select(null, e.id)}
        /* LT-052: double-click a spot on a link and write straight onto it.
           The empty text renders as an open caret; committing nothing removes
           it, so a stray double-click leaves no debris. */
        onEdgeDoubleClick={(event, edge) => {
          event.preventDefault();
          event.stopPropagation();
          const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const path = allPaths().get(edge.id);
          const at = (path && nearestFractionOnPath(path, flow.x, flow.y)) || 0.5;
          const texts = ((edge.data as LinkData | undefined)?.texts ?? []).concat({
            id: uid(),
            at,
            text: '',
          });
          store.commit();
          store.updateEdgeData(edge.id, { texts });
        }}
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
        /* The way Lucidchart and Visio work, because that is what anyone
           opening this already knows.
        
           Left-drag on empty canvas draws a selection box and the devices it
           catches move together. Holding space turns the pointer into a hand
           and drags the whole diagram — as does the middle button, which is
           the other thing people reach for. Shift-drag still adds to a
           selection, and Ctrl-click still picks devices one at a time. */
        /* React Flow's own arrow-key movement is off: it moved a focused node
           five pixels on top of our one-pixel nudge, so a single press walked
           a device six. Ours is the only keyboard movement. */
        disableKeyboardA11y
        panOnDrag={[1]}
        selectionOnDrag={!panning}
        selectionMode={SelectionMode.Partial}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Control"
        panOnScroll={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ maxZoom: 2 }}
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
        {/* The grid is drawn inside the page now, so it stops at the paper's
            edge. React Flow's own Background painted the whole viewport, which
            is what made the desk and the page look like one surface. */}
        <Page />
        <Controls showInteractive={false} />
        {settings.minimap && (
          <MiniMap
            pannable
            zoomable
            className="cv-minimap"
            nodeColor={(n) => (n.type === 'note' ? palette.minimapNote : palette.minimapNode)}
            maskColor={palette.minimapMask}
          />
        )}
      </ReactFlow>
      <ColourLegend />
      {/* Space held: a sheet over the whole canvas that takes the drag and
          moves the viewport itself.
      
          React Flow's own `panOnDrag` cannot do this, because a drag that
          begins over a device is captured by the device before the pane sees
          it — and a device is exactly where the pointer usually is. Turning
          the nodes off instead does not work either: React Flow sets
          pointer-events on them inline, where no stylesheet reaches. A sheet
          on top is the one thing that reliably gets the pointer first. */}
      {panning && (
        <div
          className="cv-pan-sheet"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const from = rf.getViewport();
            const startX = e.clientX;
            const startY = e.clientY;
            panFrom.current = { from, startX, startY };
          }}
          onPointerMove={(e) => {
            const g = panFrom.current;
            if (!g) return;
            rf.setViewport({
              x: g.from.x + (e.clientX - g.startX),
              y: g.from.y + (e.clientY - g.startY),
              zoom: g.from.zoom,
            });
          }}
          onPointerUp={(e) => {
            panFrom.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            if (releaseAfterDrag.current) {
              releaseAfterDrag.current = false;
              setPanning(false);
            }
          }}
          onPointerCancel={() => {
            panFrom.current = null;
            if (releaseAfterDrag.current) {
              releaseAfterDrag.current = false;
              setPanning(false);
            }
          }}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {finding && <FindBox onClose={() => setFinding(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
