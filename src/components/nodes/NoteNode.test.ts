import { describe, expect, it } from 'vitest';
import { inline } from './NoteNode';

describe('inline (LT-096 — [text](url) links)', () => {
  it('renders a link as an anchor with the right href and text', () => {
    const parts = inline('see [the runbook](https://wiki.example/runbook) for steps');
    const link = parts.find((p) => (p as { type?: string }).type === 'a');
    expect(link).toBeDefined();
    const props = (link as { props: { href: string; children: string } }).props;
    expect(props.href).toBe('https://wiki.example/runbook');
    expect(props.children).toBe('the runbook');
  });

  it('leaves an unmatched bracket as plain text, not a broken link', () => {
    const parts = inline('this has [brackets] but no url');
    const anchors = parts.filter((p) => (p as { type?: string }).type === 'a');
    expect(anchors).toHaveLength(0);
    const joined = parts.map((p) => (p as { props: { children: unknown } }).props.children).join('');
    expect(joined).toContain('[brackets]');
  });

  it('still renders bold and code alongside a link on the same line', () => {
    const parts = inline('**bold** then [a link](https://example.com) then `code`');
    const types = parts.map((p) => (p as { type?: string }).type);
    expect(types).toContain('strong');
    expect(types).toContain('a');
    expect(types).toContain('code');
  });
});
