import { createAction } from '@reduxjs/toolkit';
import { storage } from '@/extension/storage';

/**
 * #271: the per-user record of package messages that are no longer on
 * Discord, shared by the package purge, the live purge, and the message
 * table's delete actions.
 *
 * Two persisted blobs, both `Record<channelId, messageId[]>`:
 *   - `deleted:{userId}`: every id known to be gone. Real deletions and
 *     404s alike. This is the v1 shape and meaning, so every reader,
 *     the prune, and a downgrade keep working.
 *   - `gone:{userId}`: the subset a DELETE answered 404 for, i.e. the
 *     message was already gone before Discrub tried. Provenance shown
 *     to the user is the union minus this subset.
 *
 * This module imports no slice. It owns the read-modify-write so that
 * two runs writing at once (a purge feeding the cache while a package
 * delete runs) cannot clobber each other: writes are serialised on an
 * in-module promise chain and each one re-reads the persisted blob
 * immediately before writing.
 */

export type DeletedCacheMap = Record<string, string[]>;

export type DeletionKind = 'deleted' | 'gone';

export function deletedCacheKey(userId: string): string {
  return `deleted:${userId}`;
}

export function goneCacheKey(userId: string): string {
  return `gone:${userId}`;
}

async function readMap(key: string): Promise<DeletedCacheMap> {
  try {
    const value = await storage.package.get<DeletedCacheMap>(key);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function writeMap(key: string, map: DeletedCacheMap): Promise<void> {
  try {
    await storage.package.set(key, map);
  } catch {
    /* storage is best-effort */
  }
}

/** Every id known to be gone (real deletions plus confirmed 404s). */
export function readDeletedCache(userId: string): Promise<DeletedCacheMap> {
  return readMap(deletedCacheKey(userId));
}

/** The subset that was already gone when Discrub tried to delete it. */
export function readGoneCache(userId: string): Promise<DeletedCacheMap> {
  return readMap(goneCacheKey(userId));
}

export function writeDeletedCache(userId: string, map: DeletedCacheMap): Promise<void> {
  return writeMap(deletedCacheKey(userId), map);
}

export function writeGoneCache(userId: string, map: DeletedCacheMap): Promise<void> {
  return writeMap(goneCacheKey(userId), map);
}

function mergeInto(map: DeletedCacheMap, channelId: string, ids: string[]): DeletedCacheMap {
  const existing = map[channelId] ?? [];
  const merged = Array.from(new Set([...existing, ...ids]));
  return { ...map, [channelId]: merged };
}

let writeChain: Promise<void> = Promise.resolve();

/**
 * Adds `ids` for one channel to the persisted caches. `'deleted'` lands
 * in the union only; `'gone'` lands in both the union and the gone
 * subset. Serialised: concurrent callers queue behind each other and
 * every write starts from a fresh read of the persisted blob.
 */
export function recordDeletions(
  userId: string,
  channelId: string,
  ids: string[],
  kind: DeletionKind,
): Promise<void> {
  if (ids.length === 0) return writeChain;
  const run = async () => {
    const deleted = await readDeletedCache(userId);
    await writeDeletedCache(userId, mergeInto(deleted, channelId, ids));
    if (kind === 'gone') {
      const gone = await readGoneCache(userId);
      await writeGoneCache(userId, mergeInto(gone, channelId, ids));
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/**
 * Dispatched by the live purge and the message table when they delete a
 * message that belongs to a channel in the loaded package, so the
 * package view stops offering it and a later package purge skips it.
 * Handled in packageSlice's extraReducers; defined here so purgeSlice
 * and messageSlice never import the package slice.
 */
export const externalDeletionsRecorded = createAction<{ channelId: string; ids: string[] }>(
  'package/externalDeletionsRecorded',
);

/** The slice of RootState this module needs, kept structural to avoid importing the store. */
interface PackageStateLike {
  package: {
    parsed: { user: { id: string }; channels: { id: string }[] } | null;
  };
}

/**
 * Records deletions made outside package mode. A no-op unless a package
 * is loaded and it contains `channelId`. Updates Redux first (so the UI
 * greys the rows at once) and then the persisted union. Best-effort:
 * never throws.
 */
export async function notePackageDeletions(
  getState: () => PackageStateLike,
  dispatch: (action: ReturnType<typeof externalDeletionsRecorded>) => unknown,
  channelId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const parsed = getState().package?.parsed;
  if (!parsed || !parsed.channels.some((c) => c.id === channelId)) return;
  dispatch(externalDeletionsRecorded({ channelId, ids }));
  try {
    await recordDeletions(parsed.user.id, channelId, ids, 'deleted');
  } catch {
    /* best-effort */
  }
}
