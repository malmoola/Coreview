/**
 * Turning a palette drag payload into a node.
 *
 * Extracted from Canvas so it can be tested directly: HTML5 drag-and-drop does
 * not fire from synthetic events, so driving a real drop in a headless browser
 * is not practical. The decision logic is the part worth covering, and it is
 * pure.
 */
import type { DeviceNodeData, DeviceType, NoteNodeData } from '../types/domain';
import type { TopoNode } from '../state/store';
import type { IconLibEntry } from './ipc';

/** Base64 of a UTF-8 string, safe for non-ASCII in an SVG. */
export function svgToDataUrl(svg: string): string {
  const utf8 = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export interface DropDeps {
  makeDeviceNode: (type: DeviceType, x: number, y: number) => TopoNode;
  makeNote: (x: number, y: number, variant?: NoteNodeData['variant']) => TopoNode;
  iconLibrary: IconLibEntry[];
}

/**
 * Returns the node a palette payload should create, or null if the payload is
 * not one we recognise.
 *
 * Payloads:
 *   'note' | 'change-note'   annotation nodes
 *   'icon:<id>'              an SVG from the local icon library
 *   '<deviceType>'           one of the built-in glyphs
 */
export function nodeForDrop(
  payload: string,
  x: number,
  y: number,
  deps: DropDeps,
): TopoNode | null {
  const raw = payload.trim();
  if (!raw) return null;

  if (raw === 'note' || raw === 'change-note') {
    return deps.makeNote(x, y, raw === 'change-note' ? 'change' : 'plain');
  }

  if (raw.startsWith('icon:')) {
    const id = raw.slice('icon:'.length);
    if (!id) return null;
    const icon = deps.iconLibrary.find((i) => i.id === id);
    const node = deps.makeDeviceNode('generic', x, y);
    const data = node.data as DeviceNodeData;
    // Keep the reference even when the icon is not currently loaded, so a
    // project made against a library that is temporarily missing still says
    // which icon it wanted.
    data.iconRef = id;
    data.label = icon?.name ?? id;
    // The inlined copy is what makes an exported project render on a machine
    // without the library folder.
    if (icon) data.imageDataUrl = svgToDataUrl(icon.svg);
    return node;
  }

  return deps.makeDeviceNode(raw as DeviceType, x, y);
}
