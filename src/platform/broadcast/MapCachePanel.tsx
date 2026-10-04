import { useEffect, useState } from "react";
import { mapCacheCommand, type CacheStats } from "./mapCache";
export default function MapCachePanel() {
  const [stats, setStats] = useState<CacheStats | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    mapCacheCommand("stats")
      .then((s) => active && setStats(s))
      .catch((e) => active && setMessage(e.message));
    return () => {
      active = false;
    };
  }, []);
  const run = async (type: "clear" | "warm") => {
    setBusy(true);
    setMessage(
      type === "warm"
        ? "正在保存全球低缩放级别底图…"
        : "正在清理当前浏览器地图缓存…",
    );
    try {
      const s = await mapCacheCommand(type);
      setStats(s);
      setMessage(
        type === "warm"
          ? `已保存 ${s.done} 项${s.failed ? `，${s.failed} 项源站暂不可用，可重试` : "，刷新可直接复用"}`
          : "已清理；后续浏览会重新保存地图。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="broadcast-region-settings map-cache-panel">
      <legend>地图本地缓存</legend>
      <p>
        浏览过的地图自动保存，刷新优先读取。浏览器最多 128 MB，服务器另存 256
        MB；仅缓存地图与静态资源。
      </p>
      {stats && (
        <small aria-live="polite">
          已保存 {stats.count} 项 · {(stats.bytes / 1048576).toFixed(1)} MB /
          128 MB
        </small>
      )}
      <div className="broadcast-region-actions">
        <button disabled={busy} onClick={() => run("warm")}>
          保存全球概览
        </button>
        <button disabled={busy} onClick={() => run("clear")}>
          清理本机地图缓存
        </button>
      </div>
      <small>
        全球概览包含低级别卫星影像与高程；详细区域随浏览缓存。实时震情仍需联网。
      </small>
      {message && <small role="status">{message}</small>}
    </fieldset>
  );
}
