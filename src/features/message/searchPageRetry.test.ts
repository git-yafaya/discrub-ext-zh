import { describe, it, expect, vi } from 'vitest';
import {
  fetchSearchPageWithRetry,
  describeSearchFailure,
  indexingWaitMs,
  INDEXING_WAITS,
  type SearchPageResponse,
} from './searchPageRetry';
import type { RootState } from '@/app/store';
import { initialAppState } from '@features/app/appTypes';

const getStateWith = (overrides: Partial<RootState['app']> = {}): (() => RootState) => {
  const app = { ...initialAppState, ...overrides };
  return () => ({ app } as RootState);
};

const page = (count = 1): SearchPageResponse => ({
  success: true,
  status: 200,
  data: {
    messages: Array.from({ length: count }, (_, i) => [{ id: `m${i}`, timestamp: '2026-01-01T00:00:00Z' }]),
    total_results: count,
  } as unknown as SearchPageResponse['data'],
});

const indexing: SearchPageResponse = { success: true, status: 202 };
const fast = { indexingWaitMs: () => 5, baseDelayMs: 5 };

describe('fetchSearchPageWithRetry (#262)', () => {
  it('returns a 200 page untouched on the first try', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page(3));
    const result = await fetchSearchPageWithRetry(fetchPage, { getState: getStateWith(), ...fast });
    expect(result.success).toBe(true);
    expect(result.data?.total_results).toBe(3);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('waits out a 202 and returns the page that follows, announcing each wait', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(indexing)
      .mockResolvedValueOnce(indexing)
      .mockResolvedValueOnce(page(2));
    const onIndexingWait = vi.fn();
    const result = await fetchSearchPageWithRetry(fetchPage, {
      getState: getStateWith(), onIndexingWait, ...fast,
    });
    expect(result.success).toBe(true);
    expect(result.data?.total_results).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(onIndexingWait).toHaveBeenCalledTimes(2);
    expect(onIndexingWait).toHaveBeenNthCalledWith(1, 1, 5);
    expect(onIndexingWait).toHaveBeenNthCalledWith(2, 2, 5);
  });

  it('gives up after INDEXING_WAITS 202 answers and reports status 202 as a failure', async () => {
    const fetchPage = vi.fn().mockResolvedValue(indexing);
    const result = await fetchSearchPageWithRetry(fetchPage, { getState: getStateWith(), ...fast });
    expect(result.success).toBe(false);
    expect(result.status).toBe(202);
    expect(result.data).toBeUndefined();
    expect(fetchPage).toHaveBeenCalledTimes(INDEXING_WAITS + 1);
  });

  it('retries a transient 503 and succeeds, announcing the retry', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ success: false, status: 503 })
      .mockResolvedValueOnce(page(1));
    const onRetry = vi.fn();
    const result = await fetchSearchPageWithRetry(fetchPage, { getState: getStateWith(), onRetry, ...fast });
    expect(result.success).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe(1);
  });

  it('does not retry a 403 and hands it back with its status', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ success: false, status: 403 });
    const onRetry = vi.fn();
    const result = await fetchSearchPageWithRetry(fetchPage, { getState: getStateWith(), onRetry, ...fast });
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a 503 that clears into a 202 still waits for the index', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ success: false, status: 503 })
      .mockResolvedValueOnce(indexing)
      .mockResolvedValueOnce(page(1));
    const result = await fetchSearchPageWithRetry(fetchPage, { getState: getStateWith(), ...fast });
    expect(result.success).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops waiting on a 202 when the operation is cancelled', async () => {
    let cancelled = false;
    const getState = () => ({ app: { ...initialAppState, discrubCancelled: cancelled } } as RootState);
    const fetchPage = vi.fn().mockImplementation(async () => {
      cancelled = true;
      return indexing;
    });
    const result = await fetchSearchPageWithRetry(fetchPage, {
      getState, indexingWaitMs: () => 2000, baseDelayMs: 5,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(202);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops waiting on a 202 when the thunk signal aborts', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn().mockImplementation(async () => {
      controller.abort();
      return indexing;
    });
    const result = await fetchSearchPageWithRetry(fetchPage, {
      getState: getStateWith(), signal: controller.signal, indexingWaitMs: () => 2000, baseDelayMs: 5,
    });
    expect(result.success).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('waits 1s, 2s, 3s, then caps at 5s between 202 attempts', () => {
    expect([1, 2, 3, 5, 6].map(indexingWaitMs)).toEqual([1000, 2000, 3000, 5000, 5000]);
  });
});

describe('describeSearchFailure (#262)', () => {
  it('names the HTTP status for a channel search', () => {
    expect(describeSearchFailure({ success: false, status: 403 }, 'channel'))
      .toBe('Failed to search messages (HTTP 403)');
  });

  it('names the HTTP status for a thread search', () => {
    expect(describeSearchFailure({ success: false, status: 404 }, 'thread'))
      .toBe('Failed to search thread messages (HTTP 404)');
  });

  it('explains an exhausted 202 wait', () => {
    expect(describeSearchFailure({ success: false, status: 202 }, 'thread'))
      .toMatch(/still indexing this thread/);
    expect(describeSearchFailure({ success: false, status: 202 }, 'channel'))
      .toMatch(/still indexing this conversation/);
  });

  it('explains a request that never got an answer', () => {
    expect(describeSearchFailure({ success: false }, 'thread'))
      .toMatch(/^Failed to search thread messages\. Discord did not answer/);
    expect(describeSearchFailure({ success: false }, 'channel'))
      .toMatch(/^Failed to search messages\. Discord did not answer/);
  });
});
