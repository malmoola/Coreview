import { describe, expect, it } from 'vitest';

import { joinPath, slug } from './exports';

describe('joinPath', () => {
  it('joins a POSIX folder', () => {
    expect(joinPath('/home/me/exports', 'a.coreview')).toBe('/home/me/exports/a.coreview');
  });

  it('does not double the separator when the folder already ends with one', () => {
    expect(joinPath('/home/me/exports/', 'a.coreview')).toBe('/home/me/exports/a.coreview');
  });

  it('uses a backslash for a Windows folder', () => {
    // The picker returns native paths, and mixing separators produces a path
    // that looks right and does not exist.
    expect(joinPath('C:\\Users\\me\\Exports', 'a.coreview')).toBe('C:\\Users\\me\\Exports\\a.coreview');
    expect(joinPath('C:\\Users\\me\\Exports\\', 'a.coreview')).toBe('C:\\Users\\me\\Exports\\a.coreview');
  });

  it('treats a UNC path as a Windows path', () => {
    expect(joinPath('\\\\server\\share\\exports', 'a.coreview')).toBe(
      '\\\\server\\share\\exports\\a.coreview',
    );
  });
});

describe('slug', () => {
  it('makes a filename out of a project name', () => {
    expect(slug('Sample — Branch office validation')).toBe('sample-branch-office-validation');
  });

  it('never returns an empty name', () => {
    // An empty filename would produce a path ending in a separator.
    expect(slug('!!!')).toBe('project');
    expect(slug('')).toBe('project');
  });
});
