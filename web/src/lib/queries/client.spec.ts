import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { queryClient, readPreloadedQuery } from '$lib/queries/client';

describe('preloaded configuration lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryClient.clear();
  });

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });

  it.each([
    ['server', 'config'],
    ['config', 'public'],
    ['config', 'user'],
    ['config', 'admin'],
  ])('keeps %s/%s readable after five minutes without observers', async (...queryKey) => {
    const queryFn = vi.fn().mockResolvedValue({ enabled: true });
    const options = { queryKey, queryFn };
    await queryClient.query(options);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(readPreloadedQuery(options)).toEqual({ enabled: true });
    expect(queryFn).toHaveBeenCalledOnce();
  });

  it('still collects ordinary inactive queries', async () => {
    const queryKey = ['album', 'test'];
    await queryClient.query({ queryKey, queryFn: () => Promise.resolve({ id: 'test' }) });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
  });

  it('removes private configuration on logout while keeping public configuration', () => {
    const keys = [
      ['server', 'config'],
      ['config', 'public'],
      ['config', 'user'],
      ['config', 'admin'],
    ];
    for (const key of keys) {
      queryClient.setQueryData(key, { enabled: true });
    }
    eventManager.emit('AuthLogout');
    expect(queryClient.getQueryData(keys[0])).toBeDefined();
    expect(queryClient.getQueryData(keys[1])).toBeDefined();
    expect(queryClient.getQueryData(keys[2])).toBeUndefined();
    expect(queryClient.getQueryData(keys[3])).toBeUndefined();
  });
});
