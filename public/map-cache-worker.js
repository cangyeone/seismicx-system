import {
  CACHE_NAME,
  MAX_BYTES,
  MAX_ITEM,
  MAX_ENTRIES,
  MAX_AGE,
  cacheable,
} from "./map-cache-policy.js";
let writing = Promise.resolve(),
  index;
let epoch = 0;
const serial = (fn) => (writing = writing.then(fn, fn));
async function entries(cache) {
  if (!index) {
    index = new Map();
    for (const key of await cache.keys()) {
      const r = await cache.match(key);
      index.set(key.url, {
        size: +(r.headers.get("X-Map-Bytes") || MAX_ITEM),
        saved: +(r.headers.get("X-Map-Saved") || 0),
      });
    }
  }
  return index;
}
async function save(request, response, generation) {
  if (
    !response.ok ||
    response.status !== 200 ||
    response.type === "opaque" ||
    /no-store|private/i.test(response.headers.get("Cache-Control") || "")
  )
    return;
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_ITEM) return;
  return serial(async () => {
    if (generation !== epoch) return;
    const cache = await caches.open(CACHE_NAME),
      items = await entries(cache);
    let size =
      [...items.values()].reduce((n, v) => n + v.size, 0) -
      (items.get(request.url)?.size || 0);
    items.delete(request.url);
    for (const [url, old] of items) {
      if (
        size + blob.size <= MAX_BYTES &&
        items.size < MAX_ENTRIES &&
        Date.now() - old.saved < MAX_AGE
      )
        break;
      await cache.delete(url);
      items.delete(url);
      size -= old.size;
    }
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    headers.set("X-Map-Bytes", String(blob.size));
    headers.set("X-Map-Saved", String(Date.now()));
    await cache.put(request, new Response(blob, { status: 200, headers }));
    items.set(request.url, { size: blob.size, saved: Date.now() });
  });
}
async function retrieve(request, event) {
  const generation = epoch;
  try {
    const cached = await (await caches.open(CACHE_NAME)).match(request);
    if (
      cached &&
      Date.now() - +(cached.headers.get("X-Map-Saved") || 0) < MAX_AGE
    )
      return cached;
  } catch {
    /* Storage can be disabled; ordinary network access remains available. */
  }
  const response = await fetch(request);
  const saved = save(request, response.clone(), generation).catch(() => {});
  if (event) event.waitUntil(saved);
  else await saved;
  return response;
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("seismicx-map-") && key !== CACHE_NAME)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  if (
    cacheable(event.request.url, self.location.origin, event.request.method) &&
    !event.request.headers.has("Authorization")
  )
    event.respondWith(retrieve(event.request, event));
});
let warming;
async function warm() {
  const urls = ["/world.geojson", "/plates.geojson"];
  for (const kind of ["satellite", "elevation"])
    for (let z = 0; z <= 2; z++)
      for (let x = 0; x < 2 ** z; x++)
        for (let y = 0; y < 2 ** z; y++)
          urls.push(`/api/map/tiles/${kind}/${z}/${x}/${y}`);
  let done = 0,
    failed = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (urls.length) {
        const path = urls.shift();
        try {
          const r = await retrieve(
            new Request(new URL(path, self.location.origin)),
          );
          if (!r.ok) throw Error();
          done++;
        } catch {
          failed++;
        }
      }
    }),
  );
  return { done, failed };
}
self.addEventListener("message", (event) => {
  const port = event.ports[0];
  if (!port || !["stats", "clear", "warm"].includes(event.data?.type)) return;
  event.waitUntil(
    (async () => {
      try {
        let result = {};
        if (event.data.type === "clear") {
          epoch++;
          await serial(async () => {
            await caches.delete(CACHE_NAME);
            index = undefined;
          });
        }
        if (event.data.type === "warm") {
          if (!warming)
            warming = warm().finally(() => {
              warming = undefined;
            });
          result = await warming;
        }
        await writing;
        const items = await entries(await caches.open(CACHE_NAME));
        port.postMessage({
          ...result,
          count: items.size,
          bytes: [...items.values()].reduce((n, v) => n + v.size, 0),
        });
      } catch {
        port.postMessage({
          error: "浏览器未允许持久缓存，仍可使用服务器缓存。",
        });
      }
    })(),
  );
});
