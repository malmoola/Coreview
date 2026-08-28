import { describe, expect, it } from 'vitest';
import { csvCell, eventsToCsv, parseCsv, parseLinkCsv, parseNodeCsv } from './csv';
import type { EventRow } from '../types/domain';

describe('csv writing', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it('neutralises spreadsheet formula injection in device names', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  /** Test case 18. */
  it('exports transitions with timestamp, target, type, rtt and message', () => {
    const e: EventRow = {
      id: '1',
      projectId: 'p',
      sessionId: 's',
      timestampMs: 1700000000000,
      objectType: 'node',
      objectId: 'n1',
      objectName: 'CORE-SW-01',
      eventType: 'transition',
      previousStatus: 'healthy',
      currentStatus: 'down',
      probeType: 'icmp',
      target: '10.10.20.2',
      rttMs: null,
      message: 'Request timed out',
    };
    const csv = eventsToCsv([e]);
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('previous_status,current_status');
    expect(row).toContain('CORE-SW-01');
    expect(row).toContain('healthy,down');
    expect(row).toContain('10.10.20.2');
    expect(row).toContain('Request timed out');
  });
});

describe('csv reading', () => {
  it('handles quoted fields and CRLF', () => {
    expect(parseCsv('a,b\r\n"1,1",2\r\n')).toEqual([
      ['a', 'b'],
      ['1,1', '2'],
    ]);
  });

  it('imports nodes and reports unusable rows instead of silently dropping them', () => {
    const { rows, errors } = parseNodeCsv(
      'name,type,ip,probe type,port,tags\nFW-01,firewall,10.0.0.1,icmp,,edge;hq\n,router,10.0.0.2,icmp,,\n',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags).toEqual(['edge', 'hq']);
    expect(errors[0]).toContain('Row 3');
  });

  it('defaults an unrecognised health rule instead of failing the import', () => {
    const { rows } = parseLinkCsv('source name,target name,health rule\nA,B,nonsense\n');
    expect(rows[0]?.healthRule).toBe('both-endpoints');
  });
});
