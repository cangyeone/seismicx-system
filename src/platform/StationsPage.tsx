import { useAdmin } from "./auth";
import {
  Activity,
  Radio,
  CheckSquare,
  Clock,
  ArrowRight,
  ChevronRight,
  Plus,
  Play,
  Search,
} from "lucide-react";
import type { Quake, Station, Overview } from "./types";
import { value, time } from "./api";
import { Badge, Empty } from "./ui";
import WorldMap from "./Map";
import { CatalogTable } from "./Catalog";
export default function StationsPage({
  stations,
  filteredStations,
  selectedStations,
  setSelectedStations,
  query,
  setQuery,
  setModal,
  onSelect,
  setLiveStation,
  toggleStation,
}: {
  stations: Station[];
  filteredStations: Station[];
  selectedStations: string[];
  setSelectedStations: (v: string[]) => void;
  query: string;
  setQuery: (s: string) => void;
  setModal: (s: string) => void;
  onSelect: (e: Quake) => void;
  setLiveStation: (s: Station) => void;
  toggleStation: (s: Station) => void;
}) {
  const admin = useAdmin();
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{admin ? "台站管理" : "台站分布"}</h1>
          <p>清单表示已发现台站；在线状态仅由实际收到的采样确定</p>
        </div>
        {admin && (
          <>
            <button onClick={() => setModal("detect")}>
              <Play size={15} />
              自动编目
            </button>
            <button className="primary" onClick={() => setModal("station")}>
              <Plus size={16} />
              接入台站
            </button>
          </>
        )}
      </div>
      <section className="panel station-map">
        <WorldMap
          stations={filteredStations}
          events={[]}
          onEvent={onSelect}
          onStation={(s) => setQuery(s.id)}
        />
      </section>
      <div className="filterbar">
        <div className="search">
          <Search size={16} />
          <input
            placeholder="搜索台网、台站或数据源"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span>
          {filteredStations.length} 台站{" "}
          {admin && `· ${selectedStations.length} 已选`}
        </span>
        {admin && <span className="muted">采集器会自动读取订阅变化</span>}
      </div>
      <section className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {admin && <th />}
                <th>台网.台站.位置</th>
                <th>名称</th>
                <th>经纬度</th>
                <th>通道 / 数据源</th>
                <th>状态 / 延迟</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredStations.map((s) => (
                <tr key={s.id}>
                  {admin && (
                    <td>
                      <input
                        aria-label={`选择 ${s.id}`}
                        type="checkbox"
                        checked={selectedStations.includes(s.id)}
                        onChange={(e) =>
                          setSelectedStations(
                            e.target.checked
                              ? [...selectedStations, s.id]
                              : selectedStations.filter((id) => id !== s.id),
                          )
                        }
                      />
                    </td>
                  )}
                  <td className="mono bright">{s.id}</td>
                  <td className="place-cell">{s.name}</td>
                  <td className="mono">
                    {s.latitude.toFixed(2)}° / {s.longitude.toFixed(2)}°
                  </td>
                  <td>
                    {s.channel}
                    <small className="block">{s.provider}</small>
                  </td>
                  <td>
                    <Badge status={s.status} />
                    <small className="block">
                      {s.latency_s === null
                        ? "尚未收到采样"
                        : `${value(s.latency_s, 0)} s`}
                    </small>
                  </td>
                  <td>
                    <button onClick={() => setLiveStation(s)}>波形</button>{" "}
                    {admin && (
                      <button onClick={() => toggleStation(s)}>
                        {s.enabled ? "暂停订阅" : "启用订阅"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
