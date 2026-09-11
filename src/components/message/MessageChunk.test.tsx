import { describe, it, expect } from 'vitest';
import { chunkPropsAreEqual } from './MessageChunk';
import { createMockMessage } from '../../test/fixtures';

// #263: one selection click must not re-render every visible chunk.
describe('chunkPropsAreEqual', () => {
  const a = createMockMessage({ id: 'a' });
  const b = createMockMessage({ id: 'b' });
  const base = {
    chunk: { key: 'a', authorId: 'u', firstTimestamp: a.timestamp, messages: [a, b] },
    selectedIds: new Set<string>(),
    formattingContext: {} as any,
    fullUserMap: {},
    cachedUserMap: {},
    guildId: null,
    guildRoles: null,
    settings: null,
    onToggleSelect: () => {},
    onAuthorClick: () => {},
    onMentionClick: () => {},
    onOpenAttachments: () => {},
    onOpenReactions: () => {},
  };

  it('is equal when a new Set has the same membership for this chunk', () => {
    expect(chunkPropsAreEqual(base, { ...base, selectedIds: new Set(['zzz']) })).toBe(true);
  });

  it('is not equal when one of the chunk messages changed selection', () => {
    expect(chunkPropsAreEqual(base, { ...base, selectedIds: new Set(['b']) })).toBe(false);
    const prev = { ...base, selectedIds: new Set(['a']) };
    expect(chunkPropsAreEqual(prev, { ...base, selectedIds: new Set() })).toBe(false);
  });

  it('still re-renders when any other prop changes', () => {
    expect(chunkPropsAreEqual(base, { ...base, highlightedMessageId: 'a' })).toBe(false);
    expect(chunkPropsAreEqual(base, { ...base, fullUserMap: {} })).toBe(false);
  });
});
