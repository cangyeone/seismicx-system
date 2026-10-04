let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerMapCache() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  registration ??= navigator.serviceWorker.register("/map-cache-worker.js", {
    type: "module",
    scope: "/",
    updateViaCache: "none",
  });
  // A disabled/private browser cache must never prevent the live application loading.
  void registration.catch(() => {});
  return registration;
}
export interface CacheStats {
  count: number;
  bytes: number;
  done?: number;
  failed?: number;
  error?: string;
}
export async function mapCacheCommand(
  type: "stats" | "clear" | "warm",
): Promise<CacheStats> {
  const reg = await registerMapCache();
  if (!reg)
    throw Error("当前连接使用服务器缓存；浏览器持久缓存需 HTTPS 或本机访问。");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(
      () => {
        channel.port1.close();
        reject(Error("地图缓存操作超时，可稍后重试。"));
      },
      type === "warm" ? 180000 : 8000,
    );
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timeout);
      channel.port1.close();
      data.error ? reject(Error(data.error)) : resolve(data);
    };
    const send = () =>
      (navigator.serviceWorker.controller || reg.active)?.postMessage(
        { type },
        [channel.port2],
      );
    if (reg.active) send();
    else navigator.serviceWorker.ready.then(send).catch(reject);
  });
}
