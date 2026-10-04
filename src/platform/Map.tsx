import { useEffect, useMemo, useState } from "react";
import { geoNaturalEarth1, geoPath, geoGraticule10 } from "d3";
import type { FeatureCollection } from "geojson";
import type { Quake, Station } from "./types";
import { Crosshair, Minus, Plus } from "lucide-react";
export default function WorldMap({
  stations,
  events,
  onEvent,
  onStation,
  selected,
  alertId,
}: {
  stations: Station[];
  events: Quake[];
  onEvent: (e: Quake) => void;
  onStation?: (s: Station) => void;
  selected?: string;
  alertId?: string;
}) {
  const [world, setWorld] = useState<FeatureCollection | null>(null),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState(false);
  useEffect(() => {
    fetch("/world.geojson")
      .then((r) => r.json())
      .then(setWorld)
      .catch(() => setError(true));
  }, []);
  const projection = useMemo(
    () => geoNaturalEarth1().scale(166).translate([480, 263]),
    [],
  );
  const path = geoPath(projection);
  return (
    <div className="world-map">
      <svg viewBox="0 0 960 530" role="img" aria-label="全球台站和地震分布图">
        <defs>
          <clipPath id="map-clip">
            <rect width="960" height="530" />
          </clipPath>
        </defs>
        <g clipPath="url(#map-clip)">
          <g
            transform={`translate(${480 - 480 * zoom},${265 - 265 * zoom}) scale(${zoom})`}
          >
            <path d={path(geoGraticule10()) || ""} className="graticule" />
            {world?.features.map((f, i) => (
              <path key={i} d={path(f) || ""} className="land" />
            ))}
            {stations.map((s) => {
              const p = projection([s.longitude, s.latitude]);
              return (
                p && (
                  <path
                    key={s.id}
                    d={`M ${p[0]} ${p[1] - 3} l 3 6 h -6 Z`}
                    className={
                      "station-marker " + (s.status === "online" ? "live" : "")
                    }
                    tabIndex={0}
                    onClick={() => onStation?.(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onStation?.(s);
                    }}
                  >
                    <title>
                      {s.id} · {s.name}
                    </title>
                  </path>
                )
              );
            })}
            {events.slice(0, 200).map((e) => {
              const p = projection([e.longitude, e.latitude]);
              const r = Math.max(3, (e.magnitude ?? 2) * 1.8);
              return (
                p && (
                  <g
                    key={e.id}
                    className="event-marker"
                    onClick={() => onEvent(e)}
                    tabIndex={0}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") onEvent(e);
                    }}
                    aria-label={`${e.place} M${e.magnitude}`}
                  >
                    {alertId === e.id && (
                      <circle
                        cx={p[0]}
                        cy={p[1]}
                        r={r + 4}
                        className="new-quake-pulse"
                      />
                    )}
                    <circle
                      cx={p[0]}
                      cy={p[1]}
                      r={r}
                      className={selected === e.id ? "selected" : ""}
                    />
                    <circle cx={p[0]} cy={p[1]} r="1.5" className="epicenter" />
                    <title>
                      {e.place} · M{e.magnitude ?? "—"} · {e.source}
                    </title>
                  </g>
                )
              );
            })}
          </g>
        </g>
        <text x="28" y="494" className="map-label">
          WGS 84 · 全球观测网络
        </text>
      </svg>
      {error && <div className="map-error">底图加载失败，台站坐标仍可查看</div>}
      <div className="map-controls">
        <button
          aria-label="放大地图"
          onClick={() => setZoom(Math.min(zoom + 0.3, 3))}
        >
          <Plus size={17} />
        </button>
        <button
          aria-label="缩小地图"
          onClick={() => setZoom(Math.max(zoom - 0.3, 1))}
        >
          <Minus size={17} />
        </button>
        <button aria-label="重置地图" onClick={() => setZoom(1)}>
          <Crosshair size={17} />
        </button>
      </div>
      <div className="map-credit">Natural Earth · 数据以实际接收状态为准</div>
    </div>
  );
}
