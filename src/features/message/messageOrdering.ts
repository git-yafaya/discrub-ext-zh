import type { Message } from 'discrub-core/types/discord-types';
import { SortDirection } from 'discrub-core/common-enum';
import { getSortedMessages } from 'discrub-core/discrub-utils';

const ts = (m: Message): number => new Date(m.timestamp).getTime();

/**
 * Merge a freshly fetched page into an already-sorted list without
 * re-sorting the whole list (#263).
 *
 * `getSortedMessages` copies every message and parses two timestamps per
 * comparison, so calling it on the full list for every page made Load All
 * quadratic: at 30K messages that was 300 pages of 30K-element sorts,
 * two minutes of main-thread work. Pages arrive in order (the list
 * endpoint walks `before`, the search iterator cap-shifts by oldest seen),
 * so a page normally belongs entirely at one end of the list. That case
 * is a concat; anything else falls back to the full sort, so the result
 * is always sorted under `order`.
 */
export const appendSortedPage = (
  existing: Message[],
  fresh: Message[],
  order: SortDirection,
): Message[] => {
  if (fresh.length === 0) return existing;
  const page = getSortedMessages(fresh, order);
  if (existing.length === 0) return page;

  const first = ts(existing[0]);
  const last = ts(existing[existing.length - 1]);
  const pageFirst = ts(page[0]);
  const pageLast = ts(page[page.length - 1]);
  const desc = order === SortDirection.DESCENDING;

  // Page sits after the tail (older under DESC, newer under ASC).
  if (desc ? pageFirst <= last : pageFirst >= last) return existing.concat(page);
  // Page sits before the head.
  if (desc ? pageLast >= first : pageLast <= first) return page.concat(existing);

  return getSortedMessages(existing.concat(page), order);
};
