// Every JSON API response goes through here so caching policy lives in one
// place. `no-store` matters more than it looks: without it, some intermediate
// layer (a browser's heuristic cache, a proxy) can serve a stale group state
// after a mutation, which looks identical to "the sync is broken."
export function json(c, data, status = 200) {
  c.header("Cache-Control", "no-store");
  return c.json(data, status);
}
