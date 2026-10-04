import { useEffect, useState } from "react";
import type { Station, Wave } from "./types";
import { api, time } from "./api";
import { Badge, Modal } from "./ui";
import { Pause, Play, RefreshCw } from "lucide-react";
export default function LiveStation({
  station,
  onClose,
}: {
  station: Station;
  onClose: () => void;
}) {
  const [wave, setWave] = useState<Wave | null>(null),
    [error, setError] = useState(""),
    [paused, setPaused] = useState(false),
    [stamp, setStamp] = useState("");
  useEffect(() => {
    if (paused) return;
    let active = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const end = new Date(Date.now() - 60000);
        const start = new Date(end.getTime() - 180000);
        const result = await api<Wave>(
          `/waveforms/${encodeURIComponent(station.id)}?start=${start.toISOString()}&end=${end.toISOString()}`,
        );
        if (active) {
          setWave(result);
          setStamp(end.toISOString());
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        busy = false;
      }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [station.id, paused]);
  return (
    <Modal title={`${station.id} · 连续波形`} onClose={onClose}>
      <div className="live-station">
        <div className="wave-toolbar">
          <Badge status={station.status} />
          <span>
            {station.provider} · {station.channel}
          </span>
          <button onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}{" "}
            {paused ? "继续" : "暂停"}
          </button>
        </div>
        <p className="muted">
          最近 3 分钟 · 请求截止到当前时间前 60 秒 · 每 15 秒刷新
        </p>
        {error && <p className="error-text">{error}</p>}
        {!wave && !error && (
          <p className="muted">
            <RefreshCw size={16} className="spin" />
            正在读取真实连续波形…
          </p>
        )}
        {wave?.traces.map((t) => {
          const peak = Math.max(
            1,
            ...t.points.map((p) =>
              Math.max(Math.abs(p[1] || 0), Math.abs(p[2] || 0)),
            ),
          );
          const length = Math.max(1, t.npts / t.sample_rate);
          let d = "";
          t.points.forEach((p) => {
            if (p[1] !== null && p[2] !== null)
              d += `M${(p[0] / length) * 520},${50 - (p[1] / peak) * 35}L${(p[0] / length) * 520},${50 - (p[2] / peak) * 35}`;
          });
          return (
            <div key={t.id} className="live-trace">
              <span className="mono">
                {t.id} · {t.sample_rate} Hz · counts
              </span>
              <svg viewBox="0 0 520 100">
                <line x1="0" x2="520" y1="50" y2="50" className="chart-grid" />
                <path d={d} className="wave-path" />
              </svg>
              <small>{time(t.start)} UTC</small>
            </div>
          );
        })}
        <p className="muted">
          {stamp
            ? `请求窗口截止 ${time(stamp)} UTC`
            : "未用模拟波形填充缺失数据"}
        </p>
      </div>
    </Modal>
  );
}
