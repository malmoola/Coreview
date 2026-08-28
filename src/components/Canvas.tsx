import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { DeviceNode } from './nodes/DeviceNode';
import { NoteNode } from './nodes/NoteNode';
import { EdgeMarkerDefs, LiveEdge, STATUS_COLOR } from './edges/LiveEdge';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useStore, type TopoEdge, type TopoNode } from '../state/store';
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import type { DeviceNodeData, DeviceType, NoteNodeData } from '../types/domain';

const nodeTypes = { device: DeviceNode, note: NoteNode };
const edgeTypes = { live: LiveEdge };

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
  return {
    id: uid(),
    type: 'device',
    position: { x, y },
    width: 168,
    height: 92,
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
    textColor: variant === 'change' ? '#f2e6c8' : '#d8e2ec',
    background: variant === 'change' ? '#2a2313' : '#141c26',
    borderColor: variant === 'change' ? '#8a6d1f' : '#25313f',
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
  const [menu, setMenu] = useState<MenuState | null>(null);

  const doc = useStore((s) => s.doc);
  const store = useStore();

  const onConnect: OnConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
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
          color: STATUS_COLOR.unknown,
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
      const raw = event.dataTransfer.getData('application/livetopo');
      if (!raw) return;
      const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (raw === 'note' || raw === 'change-note') {
        store.addNode(makeNote(position.x, position.y, raw === 'change-note' ? 'change' : 'plain'));
        return;
      }
      store.addNode(makeDeviceNode(raw as DeviceType, position.x, position.y));
    },
    [rf, store],
  );

  const nodeMenu = (nodeId: string): MenuItem[] => {
    const node = doc.nodes.find((n) => n.id === nodeId);
    const locked = Boolean((node?.data as { locked?: boolean } | undefined)?.locked);
    const maintenance = Boolean((node?.data as DeviceNodeData | undefined)?.maintenance);
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
      {
        label: doc.canvas.gridEnabled ? 'Hide grid' : 'Show grid',
        onSelect: () => store.setCanvas({ gridEnabled: !doc.canvas.gridEnabled }),
      },
    ];
  };

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
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

  return (
    <div className="lt-canvas" ref={wrapper} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <EdgeMarkerDefs />
      <ReactFlow
        nodes={doc.nodes}
        edges={doc.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={store.onNodesChange}
        onEdgesChange={store.onEdgesChange}
        onConnect={onConnect}
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
        snapToGrid={doc.canvas.snapEnabled}
        snapGrid={[10, 10]}
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        fitView
        proOptions={{ hideAttribution: false }}
        defaultEdgeOptions={{ type: 'live' }}
      >
        {doc.canvas.gridEnabled && (
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1d2733" />
        )}
        <Controls showInteractive={false} />
        {doc.canvas.minimap && (
          <MiniMap
            pannable
            zoomable
            className="lt-minimap"
            nodeColor={(n) => (n.type === 'note' ? '#37475a' : '#48607a')}
            maskColor="rgba(8,12,17,0.75)"
          />
        )}
      </ReactFlow>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
