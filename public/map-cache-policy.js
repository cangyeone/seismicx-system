// Only public, immutable application resources and fixed-source maps belong here.
export const CACHE_NAME = "seismicx-map-v1-cesium146";
export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_ITEM = 6 * 1024 * 1024;
export const MAX_ENTRIES = 1200;
export const MAX_AGE = 30 * 86400 * 1000;
export function cacheable(url, origin, method = "GET") {
  const u = new URL(url, origin);
  if (method !== "GET" || u.origin !== origin || u.search) return false;
  return (
    /^\/api\/map\/tiles\/(elevation|satellite|relief)\/\d{1,2}\/\d+\/\d+$/.test(
      u.pathname,
    ) ||
    /^\/(world|plates)\.geojson$/.test(u.pathname) ||
    /^\/assets\/[\w.-]+-[\w-]+\.(js|css)$/.test(u.pathname) ||
    /^\/cesium\/(Assets|ThirdParty|Workers|Widgets)\/[\w./-]+$/.test(u.pathname)
  );
}
