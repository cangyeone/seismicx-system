import { useId, useRef, useState } from "react";
import type { Quake, Station } from "./types";
import { time } from "./api";
import { Activity, Download, MousePointer2 } from "lucide-react";
import { Empty } from "./ui";
import { tracePath, type TimeWindow } from "./review/waveMath";
import { useWaveData } from "./review/useWaveData";
import TimeNavigation, {
  useWheelZoom,
  svgPoint,
} from "./review/TimeNavigation";
import StationReview from "./review/StationReview";
export default function Waveforms({
  event,
  stations,
  editable = false,
  onChanged = async () => {},
}: {
  event: Quake;
  stations: Station[];
  editable?: boolean;
  onChanged?: () => Promise<void>;
}) {
  const [duration, setDuration] = useState(180),
    [gain, setGain] = useState(1),
    [component, setComponent] = useState("Z"),
    [loaded, setLoaded] = useState(false),
    [revision, setRevision] = useState(0);
  const [view, setView] = useState<TimeWindow>({ start: -20, end: 160 }),
    [focus, setFocus] = useState<{ station: Station; time: number } | null>(
      null,
    );
  const svg = useRef<SVGSVGElement>(null),
    clip = useId(),
    originMs = Date.parse(event.origin_time),
    bounds = { start: -20, end: duration - 20 };
  const { waves, busy, errors } = useWaveData(
    stations.slice(0, 8).map((s) => s.id),
    originMs,
    view,
    loaded,
    1600,
    revision,
  );
  useWheelZoom(svg, view, bounds, setView, 120, 900, !!waves.length);
  const chartStations = stations.filter((s) =>
    waves.some((w) => w.station_id === s.id),
  );
  const maxDistance =
    Math.max(...chartStations.map((s) => s.distance_km || 0), 10) * 1.08;
  const y = (distance: number) => 52 + (distance / maxDistance) * 440;
  const labelY: Record<string, number> = {};
  let previousLabel = 520;
  [...chartStations]
    .sort((a, b) => (b.distance_km || 0) - (a.distance_km || 0))
    .forEach((s) => {
      labelY[s.id] = Math.min(y(s.distance_km || 0), previousLabel - 34);
      previousLabel = labelY[s.id];
    });
  const x = (seconds: number) =>
    120 + ((seconds - view.start) / (view.end - view.start)) * 780;
  return (
    <section className="panel wave-panel">
      <div className="panel-head">
        <h3>
          <Activity size={17} /> 震中距–时间波形
        </h3>
        <span className="muted">真实 miniSEED · counts</span>
      </div>
      <div className="wave-toolbar">
        <label>
          分量{" "}
          <select
            aria-label="波形分量"
            value={component}
            onChange={(e) => setComponent(e.target.value)}
          >
            <option>Z</option>
            <option>N</option>
            <option>E</option>
          </select>
        </label>
        <label>
          窗口{" "}
          <select
            aria-label="波形窗口"
            value={duration}
            onChange={(e) => {
              const d = +e.target.value;
              setDuration(d);
              setView({ start: -20, end: d - 20 });
            }}
          >
            <option value={180}>3 分钟</option>
            <option value={600}>10 分钟</option>
            <option value={1800}>30 分钟</option>
          </select>
        </label>
        <label>
          增益{" "}
          <input
            aria-label="波形增益"
            type="range"
            min=".3"
            max="5"
            step=".1"
            value={gain}
            onChange={(e) => setGain(+e.target.value)}
          />
        </label>
        <button
          className="primary"
          onClick={() => {
            setLoaded(true);
            setRevision((n) => n + 1);
          }}
          disabled={busy || !stations.length}
        >
          <Download size={14} />
          {busy ? "正在读取…" : "读取事件波形"}
        </button>
      </div>
      {waves.length ? (
        <>
          <div className="wave-canvas">
            <svg
              ref={svg}
              viewBox="0 0 940 550"
              aria-label="震中距时间波形"
              data-start={view.start}
              data-end={view.end}
              onClick={(e) => {
                const p = svgPoint(e.currentTarget, e.clientX, e.clientY);
                if (
                  p.x < 120 ||
                  p.x > 900 ||
                  p.y < 36 ||
                  p.y > 505 ||
                  !chartStations.length
                )
                  return;
                const station = chartStations.reduce((a, b) =>
                  Math.abs(y(a.distance_km || 0) - p.y) <
                  Math.abs(y(b.distance_km || 0) - p.y)
                    ? a
                    : b,
                );
                setFocus({
                  station,
                  time:
                    view.start + ((p.x - 120) / 780) * (view.end - view.start),
                });
              }}
            >
              <defs>
                <clipPath id={clip}>
                  <rect x="120" y="36" width="780" height="469" />
                </clipPath>
              </defs>
              <text x="10" y="22" className="axis-label">
                震中距 / km
              </text>
              {Array.from({ length: 7 }, (_, i) => {
                const seconds = view.start + (i * (view.end - view.start)) / 6;
                return (
                  <g key={i}>
                    <line
                      x1={x(seconds)}
                      x2={x(seconds)}
                      y1="36"
                      y2="505"
                      className="chart-grid"
                    />
                    <text
                      x={x(seconds)}
                      y="526"
                      className="axis-label"
                      textAnchor="middle"
                    >
                      {seconds.toFixed(view.end - view.start < 10 ? 2 : 0)} s
                    </text>
                  </g>
                );
              })}
              {waves.map((w) => {
                const s = chartStations.find((s) => s.id === w.station_id);
                if (!s) return null;
                const trace =
                  w.traces.find((t) => t.id.endsWith(component)) ||
                  w.traces.find((t) =>
                    t.id.endsWith(
                      component === "E"
                        ? "2"
                        : component === "N"
                          ? "1"
                          : component,
                    ),
                  );
                if (!trace) return null;
                return (
                  <g key={s.id}>
                    <line
                      x1="120"
                      x2="900"
                      y1={y(s.distance_km || 0)}
                      y2={y(s.distance_km || 0)}
                      className="chart-grid"
                    />
                    <g
                      role="button"
                      tabIndex={0}
                      aria-label={`查看台站 ${s.id} 波形`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFocus({
                          station: s,
                          time: (view.start + view.end) / 2,
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          setFocus({
                            station: s,
                            time: (view.start + view.end) / 2,
                          });
                      }}
                    >
                      <rect
                        x="8"
                        y={labelY[s.id] - 22}
                        width="102"
                        height="36"
                        fill="transparent"
                      />
                      <text
                        x="108"
                        y={labelY[s.id] - 5}
                        textAnchor="end"
                        className="trace-label"
                      >
                        {s.network}.{s.station}
                      </text>
                      <text
                        x="108"
                        y={labelY[s.id] + 10}
                        textAnchor="end"
                        className="axis-label"
                      >
                        {s.distance_km?.toFixed(1)}
                      </text>
                    </g>
                    <line
                      x1="111"
                      x2="119"
                      y1={labelY[s.id]}
                      y2={y(s.distance_km || 0)}
                      stroke="#60788a"
                      strokeWidth=".6"
                    />
                    <path
                      clipPath={`url(#${clip})`}
                      d={tracePath(
                        trace,
                        originMs,
                        view,
                        120,
                        780,
                        y(s.distance_km || 0),
                        17 * gain,
                      )}
                      className="wave-path"
                    />
                  </g>
                );
              })}
              {event.picks?.map((p) => {
                const s = chartStations.find((s) => s.id === p.station_id),
                  t = (Date.parse(p.time) - originMs) / 1000;
                return s && t >= view.start && t <= view.end ? (
                  <g key={p.id}>
                    <line
                      x1={x(t)}
                      x2={x(t)}
                      y1={y(s.distance_km || 0) - 22}
                      y2={y(s.distance_km || 0) + 22}
                      className={p.phase.startsWith("P") ? "pick-p" : "pick-s"}
                    />
                    <text
                      x={x(t) + 4}
                      y={y(s.distance_km || 0) - 22}
                      className="pick-label"
                    >
                      {p.phase}
                    </text>
                  </g>
                ) : null;
              })}
            </svg>
          </div>
          <TimeNavigation view={view} bounds={bounds} onChange={setView} />
        </>
      ) : (
        <Empty>
          <Activity size={38} />
          <strong>
            {busy ? "正在读取真实波形…" : "加载事件附近台站的真实波形"}
          </strong>
          <span>按实际震中距排列 · 点击波形打开单台窗口</span>
          <small>公共台站可能没有该时段数据；缺失波形会保留错误提示。</small>
        </Empty>
      )}
      <div className="wave-footer">
        <span>
          <MousePointer2 size={13} />
          滚轮缩放 · 点击波形打开单台{editable ? "标注" : "查看"}窗口
        </span>
        <span>T₀ {time(event.origin_time)} UTC</span>
        <span className="teal">P 波</span>
        <span className="amber">S 波</span>
      </div>
      {!!errors.length && (
        <details className="errors">
          <summary>{errors.length} 个台站数据不可用</summary>
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </details>
      )}
      {focus && (
        <StationReview
          key={focus.station.id}
          event={event}
          station={focus.station}
          initialTime={focus.time}
          bounds={bounds}
          editable={editable}
          onChanged={onChanged}
          onClose={() => setFocus(null)}
        />
      )}
    </section>
  );
}
