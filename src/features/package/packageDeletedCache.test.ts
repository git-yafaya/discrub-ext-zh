import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storage } from '@/extension/storage';
import {
  recordDeletions,
  readDeletedCache,
  readGoneCache,
  notePackageDeletions,
  externalDeletionsRecorded,
} from './packageDeletedCache';

const USER = 'u1';

describe('packageDeletedCache (#271)', () => {
  beforeEach(async () => {
    await storage.package.clear();
  });

  it('records real deletions in the union only', async () => {
    await recordDeletions(USER, '200', ['1', '2'], 'deleted');
    expect(await readDeletedCache(USER)).toEqual({ '200': ['1', '2'] });
    expect(await readGoneCache(USER)).toEqual({});
  });

  it('records already-gone ids in both the union and the gone subset', async () => {
    await recordDeletions(USER, '200', ['1'], 'deleted');
    await recordDeletions(USER, '200', ['2', '3'], 'gone');
    expect(await readDeletedCache(USER)).toEqual({ '200': ['1', '2', '3'] });
    expect(await readGoneCache(USER)).toEqual({ '200': ['2', '3'] });
  });

  it('dedupes ids and keeps other channels', async () => {
    await recordDeletions(USER, '200', ['1'], 'deleted');
    await recordDeletions(USER, '300', ['9'], 'deleted');
    await recordDeletions(USER, '200', ['1', '4'], 'deleted');
    expect(await readDeletedCache(USER)).toEqual({ '200': ['1', '4'], '300': ['9'] });
  });

  it('serialises concurrent writes so both land', async () => {
    await Promise.all([
      recordDeletions(USER, '200', ['a'], 'deleted'),
      recordDeletions(USER, '200', ['b'], 'gone'),
      recordDeletions(USER, '300', ['c'], 'deleted'),
    ]);
    expect(await readDeletedCache(USER)).toEqual({ '200': ['a', 'b'], '300': ['c'] });
    expect(await readGoneCache(USER)).toEqual({ '200': ['b'] });
  });

  it('is a no-op for an empty id list', async () => {
    await recordDeletions(USER, '200', [], 'gone');
    expect(await readDeletedCache(USER)).toEqual({});
    expect(await readGoneCache(USER)).toEqual({});
  });

  describe('notePackageDeletions', () => {
    const parsed = { user: { id: USER }, channels: [{ id: '200' }] };

    it('does nothing without a loaded package', async () => {
      const dispatch = vi.fn();
      await notePackageDeletions(() => ({ package: { parsed: null } }), dispatch, '200', ['1']);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readDeletedCache(USER)).toEqual({});
    });

    it('does nothing for a channel the package does not hold', async () => {
      const dispatch = vi.fn();
      await notePackageDeletions(() => ({ package: { parsed } }), dispatch, '999', ['1']);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readDeletedCache(USER)).toEqual({});
    });

    it('dispatches the package action and persists the union for a held channel', async () => {
      const dispatch = vi.fn();
      await notePackageDeletions(() => ({ package: { parsed } }), dispatch, '200', ['1', '2']);
      expect(dispatch).toHaveBeenCalledWith(externalDeletionsRecorded({ channelId: '200', ids: ['1', '2'] }));
      expect(await readDeletedCache(USER)).toEqual({ '200': ['1', '2'] });
      expect(await readGoneCache(USER)).toEqual({});
    });
  });
});
