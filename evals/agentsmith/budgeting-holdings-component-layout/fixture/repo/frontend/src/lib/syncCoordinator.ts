import { api, Env, SyncResponse } from "@/lib/api";

const pending = new Map<Env, Promise<SyncResponse>>();
const completed = new Map<Env, SyncResponse>();
const benchmarkPending = new Map<Env, Promise<void>>();
const benchmarkCompleted = new Set<Env>();

/** Deduplicate the all-account refresh across views for the current browser session. */
export function syncAllOnce(env: Env): Promise<SyncResponse> {
  const cached = completed.get(env);
  if (cached) return Promise.resolve(cached);

  const running = pending.get(env);
  if (running) return running;

  const request = api
    .syncAll(env, {})
    .then((result) => {
      completed.set(env, result);
      return result;
    })
    .finally(() => pending.delete(env));
  pending.set(env, request);
  return request;
}

/** Refresh benchmark prices at most once per environment during this browser session. */
export function refreshBenchmarkOnce(env: Env): Promise<void> {
  if (benchmarkCompleted.has(env)) return Promise.resolve();
  const running = benchmarkPending.get(env);
  if (running) return running;
  const request = api
    .refreshInvestmentBenchmark(env)
    .then(() => {
      benchmarkCompleted.add(env);
    })
    .finally(() => benchmarkPending.delete(env));
  benchmarkPending.set(env, request);
  return request;
}
