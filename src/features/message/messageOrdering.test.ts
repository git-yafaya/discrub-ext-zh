import { describe, it, expect } from 'vitest';
import type { Message } from 'discrub-core/types/discord-types';
import { SortDirection } from 'discrub-core/common-enum';
import { appendSortedPage } from './messageOrdering';

const msg = (id: string, secondsAgo: number): Message =>
  ({ id, channel_id: 'c', content: id, timestamp: new Date(Date.UTC(2026, 0, 1) - secondsAgo * 1000).toISOString() }) as Message;
const ids = (list: Message[]) => list.map((m) => m.id);
const isSorted = (list: Message[], order: SortDirection) =>
  list.every((m, i) => i === 0 || (order === SortDirection.DESCENDING
    ? new Date(list[i - 1].timestamp) >= new Date(m.timestamp)
    : new Date(list[i - 1].timestamp) <= new Date(m.timestamp)));

describe('appendSortedPage (#263)', () => {
  const newest = [msg('a', 0), msg('b', 10), msg('c', 20)];
  const older = [msg('d', 30), msg('e', 40)];

  it('returns the existing list untouched for an empty page', () => {
    expect(appendSortedPage(newest, [], SortDirection.DESCENDING)).toBe(newest);
  });

  it('returns the sorted page when the list is empty', () => {
    const out = appendSortedPage([], [msg('e', 40), msg('d', 30)], SortDirection.DESCENDING);
    expect(ids(out)).toEqual(['d', 'e']);
  });

  it('appends an older page under DESC without re-sorting the head', () => {
    const out = appendSortedPage(newest, older, SortDirection.DESCENDING);
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // The existing head objects are reused, not copied.
    expect(out[0]).toBe(newest[0]);
  });

  it('prepends an older page under ASC', () => {
    const asc = [...newest].reverse();
    const out = appendSortedPage(asc, older, SortDirection.ASCENDING);
    expect(ids(out)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(isSorted(out, SortDirection.ASCENDING)).toBe(true);
  });

  it('places a newer page at the head under DESC', () => {
    const out = appendSortedPage(older, newest, SortDirection.DESCENDING);
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sorts the page itself before merging', () => {
    const out = appendSortedPage(newest, [msg('e', 40), msg('d', 30)], SortDirection.DESCENDING);
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('falls back to a full sort when the page overlaps the list', () => {
    const out = appendSortedPage(newest, [msg('x', 15), msg('y', 50)], SortDirection.DESCENDING);
    expect(ids(out)).toEqual(['a', 'b', 'x', 'c', 'y']);
    expect(isSorted(out, SortDirection.DESCENDING)).toBe(true);
  });

  it('treats a page equal to the boundary timestamp as an append', () => {
    const out = appendSortedPage(newest, [msg('tie', 20)], SortDirection.DESCENDING);
    expect(ids(out)).toEqual(['a', 'b', 'c', 'tie']);
  });
});
