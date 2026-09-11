import type { Message } from 'discrub-core/types/discord-types';

export interface AuthorOverlayEntry {
  userName?: string;
  displayName?: string;
  nick?: string;
}

/**
 * Overlay message authors onto a user map used for markdown rendering.
 *
 * #263: ServerView rebuilds its user map whenever the loaded list changes
 * (every Load All page, every bulk-delete flush), so this runs over every
 * loaded message each time. An author already recorded with the same
 * username and display name is left as is instead of being re-spread.
 * A changed username or a new global name still replaces the entry, and a
 * cached nickname survives the replacement.
 */
export const overlayMessageAuthors = (
  map: Record<string, AuthorOverlayEntry>,
  messages: Message[],
): Record<string, AuthorOverlayEntry> => {
  messages.forEach((msg) => {
    const author = msg.author;
    if (!author) return;
    const cur = map[author.id];
    const displayName = author.global_name || cur?.displayName;
    if (cur && cur.userName === author.username && cur.displayName === displayName) return;
    map[author.id] = { ...cur, userName: author.username, displayName };
  });
  return map;
};
