/**
 * Finding a device on a diagram too big to scan by eye.
 *
 * Past a hundred nodes, panning around looking for one switch is the slowest
 * thing anyone does with a diagram. Typing its name should be enough.
 *
 * Matches on everything someone might have in their head — the name, the
 * address, the model, a tag — because which of those they remember depends on
 * why they are looking.
 */
import type { DeviceNodeData, NoteNodeData } from '../types/domain';
import type { TopoNode } from '../state/store';

export interface Match {
  id: string;
  label: string;
  /** What the text matched, so the list can say why a row is in it. */
  matchedOn: 'name' | 'address' | 'model' | 'tag' | 'note';
  detail: string;
}

/** Everything on the diagram that answers to this text. */
export function findNodes(nodes: TopoNode[], query: string, limit = 20): Match[] {
  const want = query.trim().toLowerCase();
  if (!want) return [];

  const out: Match[] = [];
  for (const n of nodes) {
    if (n.type === 'note') {
      const d = n.data as NoteNodeData;
      const text = `${d.title ?? ''} ${d.body ?? ''}`;
      if (text.toLowerCase().includes(want)) {
        out.push({
          id: n.id,
          label: d.title?.trim() || 'Note',
          matchedOn: 'note',
          detail: firstLineContaining(d.body ?? '', want),
        });
      }
      continue;
    }

    const d = n.data as DeviceNodeData;
    const label = d.label ?? '';
    const address =
      d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';
    const tag = (d.tags ?? []).find((t) => t.toLowerCase().includes(want));

    // Ordered by what someone is most likely to have typed, so the first hit
    // is usually the one they meant.
    if (label.toLowerCase().includes(want)) {
      out.push({ id: n.id, label, matchedOn: 'name', detail: address });
    } else if (address.toLowerCase().includes(want)) {
      out.push({ id: n.id, label, matchedOn: 'address', detail: address });
    } else if ((d.model ?? '').toLowerCase().includes(want)) {
      out.push({ id: n.id, label, matchedOn: 'model', detail: d.model ?? '' });
    } else if (tag) {
      out.push({ id: n.id, label, matchedOn: 'tag', detail: tag });
    }
    if (out.length >= limit) break;
  }

  // An exact name is what someone typing a full hostname wants at the top,
  // and a prefix beats a match buried in the middle of a longer name.
  return out.sort((a, b) => rank(a, want) - rank(b, want));
}

function rank(m: Match, want: string): number {
  const label = m.label.toLowerCase();
  if (label === want) return 0;
  if (label.startsWith(want)) return 1;
  if (m.matchedOn === 'name') return 2;
  if (m.matchedOn === 'address') return 3;
  return 4;
}

function firstLineContaining(body: string, want: string): string {
  const line = body.split('\n').find((l) => l.toLowerCase().includes(want));
  return (line ?? '').trim().slice(0, 60);
}
