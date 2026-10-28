# Web: preloaded server configuration is garbage-collected after five minutes

## Summary

After browsing photos for several minutes, navigating to another photo can fail with:

```text
Error: server/config must be loaded first
```

The affected code is present in upstream main at `256eb55dbe92ac77e02794442f9487e88ffed2b1`. The cache-expiration behavior was reproduced with Query Core 5.104.3 and a memoized initializer using fake timers, as described below.

## Reproduction

1. Open the Web UI and log in.
2. Browse photos without reloading the tab for more than five minutes. Avoid keeping a component that observes `getServerConfigQuery` mounted (the login/onboarding screens observe it; the normal photo viewer does not).
3. Navigate to another photo or route so the root layout load function runs again.

Expected: navigation continues normally.

Actual: the root layout catches `server/config must be loaded first` and displays an error. Reloading the tab initializes the configuration again.

## Cause

- `web/src/lib/utils/server.ts` fetches configuration through `queryClient.query(...)`. Its exported `init` is memoized with a constant key.
- `web/src/lib/queries/client.ts` sets `staleTime: Infinity`, but does not configure `gcTime` for preloaded settings.
- TanStack Query removes inactive, unobserved queries after its default five-minute garbage-collection interval. Synchronous `getQueryData` reads do not attach observers.
- On a later root layout load, the memoized initializer resolves without fetching again. `readPreloadedQuery(getServerConfigQuery())` then finds no data and throws.

`staleTime` controls freshness, not retention. Other synchronously consumed preloaded configuration queries have the same lifetime mismatch.

## Verification

Using the installed Query Core 5.104.3 in browser mode with fake timers, an unobserved `['server', 'config']` query remains present at 299,999 ms and disappears at 300,000 ms. Calling a constant-key memoized initializer again does not fetch it again. Setting `gcTime: Infinity` retains it through the same sequence.

The deployed stack was also traced to `getPreloadedData` → `readPreloadedQuery` → the root `+layout.ts` load function.

## Suggested fix

Retain the small preloaded configuration caches for the lifetime of the application, for example:

```ts
client.setQueryDefaults(['server', 'config'], { gcTime: Infinity });
client.setQueryDefaults(['config'], { gcTime: Infinity });
```

Keep explicit invalidation/refetch behavior and the existing logout removal of private user/admin configuration. Ordinary asset/album queries should retain normal garbage collection.

Regression coverage should verify reads after more than five minutes without observers, normal collection of unrelated queries, and removal of private configuration on logout.
