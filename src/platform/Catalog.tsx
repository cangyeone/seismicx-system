import type { Quake } from "./types";
import { Badge, Empty } from "./ui";
import { time, value } from "./api";
import { ArrowUpRight } from "lucide-react";
export function CatalogTable({
  events,
  onSelect,
  compact = false,
}: {
  events: Quake[];
  onSelect: (e: Quake) => void;
  compact?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>
              发震时间 <span>UTC</span>
            </th>
            <th>地点 / 事件</th>
            <th>震级</th>
            <th>
              深度 <span>km</span>
            </th>
            {!compact && <th>震相 / RMS</th>}
            <th>状态</th>
            <th>来源</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr
              key={e.id}
              onClick={() => onSelect(e)}
              tabIndex={0}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") onSelect(e);
              }}
            >
              <td className="mono">{time(e.origin_time)}</td>
              <td className="place-cell">
                {e.place}
                <small>
                  {e.latitude.toFixed(2)}° / {e.longitude.toFixed(2)}°
                </small>
              </td>
              <td>
                <b className={(e.magnitude ?? 0) >= 5 ? "amber" : "bright"}>
                  {value(e.magnitude)}
                </b>{" "}
                <small>{e.magnitude_type}</small>
              </td>
              <td className="mono">{value(e.depth_km)}</td>
              {!compact && (
                <td className="mono">
                  {e.n_picks} <span>/ {value(e.rms, 2)} s</span>
                </td>
              )}
              <td>
                <Badge status={e.status} />
              </td>
              <td className="muted">{e.source}</td>
              <td>
                <button aria-label={`查看 ${e.place}`} className="icon-button">
                  <ArrowUpRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!events.length && (
        <Empty>没有符合条件的事件。可同步公共目录或录入历史地震。</Empty>
      )}
    </div>
  );
}
