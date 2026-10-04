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
  Pin,
  Map,
} from "lucide-react";
import type { Quake, Station, Overview } from "./types";
import { value, time } from "./api";
import { Badge, Empty } from "./ui";
import WorldMap from "./Map";
import type { BroadcastController } from "./broadcastState";
import { lazy, Suspense } from "react";
const BroadcastStage = lazy(() => import("./broadcast/Stage"));
import { CatalogTable } from "./Catalog";
export default function OverviewPage({
  overview,
  events,
  stations,
  navigate,
  onSelect,
  setQuery,
  broadcast,
}: {
  broadcast: BroadcastController;
  overview: Overview | null;
  events: Quake[];
  stations: Station[];
  navigate: (id: string) => void;
  onSelect: (e: Quake) => void;
  setQuery: (s: string) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>监测总览</h1>
          <p>全球观测网络 · 实时数据接入 · 地震自动编目</p>
        </div>
        <span className="live-label">
          <i className="status-dot" />
          真实公共数据
        </span>
      </div>
      <div className="metrics">
        <div>
          <span>
            <Radio size={17} />
            接入台站
          </span>
          <b>
            {overview?.stations ?? "—"}
            <small>个</small>
          </b>
          <p>
            <i className="status-dot" />
            {overview?.online ?? 0} 在线{" "}
            <span>{overview?.enabled ?? 0} 已订阅</span>
          </p>
        </div>
        <div>
          <span>
            <Activity size={17} />近 24 小时地震
          </span>
          <b>
            {overview?.events_24h ?? "—"}
            <small>个</small>
          </b>
          <p>
            USGS / 中国地震台网 <span>及本地检测</span>
          </p>
        </div>
        <div>
          <span>
            <CheckSquare size={17} />
            待复核事件
          </span>
          <b className="amber">
            {overview?.candidates ?? "—"}
            <small>个</small>
          </b>
          <p>
            自动检测候选{" "}
            <button className="text-button" onClick={() => navigate("review")}>
              开始复核 <ArrowRight size={12} />
            </button>
          </p>
        </div>
        <div>
          <span>
            <Clock size={17} />
            数据延迟
          </span>
          <b>
            {value(overview?.latency_s)}
            <small>秒</small>
          </b>
          <p>
            已订阅台站 <span>采样延迟中位数</span>
          </p>
        </div>
      </div>
      <div
        className={
          "overview-main " +
          (broadcast.mode === "fixed" ? "broadcast-expanded" : "")
        }
      >
        <section className="panel map-panel">
          <div className="panel-head">
            <h3>全球地震监测</h3>
            <div className="broadcast-map-actions">
              <button
                aria-pressed={broadcast.mode === "map"}
                onClick={() => broadcast.setMode("map")}
              >
                <Map size={13} />
                <span className="map-mode-label">分布图</span>
              </button>
              <button
                aria-pressed={broadcast.mode === "fixed"}
                onClick={() => broadcast.setMode("fixed")}
              >
                <Pin size={13} />
                固定显示
              </button>
              <button onClick={() => broadcast.setMode("tour")}>
                <Play size={13} />
                动画展示
              </button>
            </div>
          </div>
          {broadcast.mode === "fixed" ? (
            <Suspense
              fallback={<div className="empty-state">正在准备固定展示…</div>}
            >
              <BroadcastStage
                controller={broadcast}
                stations={stations}
                onDetail={onSelect}
              />
            </Suspense>
          ) : (
            <WorldMap
              stations={stations}
              events={events}
              alertId={broadcast.notice?.id}
              onEvent={onSelect}
              onStation={(s) => {
                navigate("stations");
                setQuery(s.id);
              }}
            />
          )}
        </section>
        <section className="panel recent-panel">
          <div className="panel-head">
            <h3>最近地震</h3>
            <button className="text-button" onClick={() => navigate("catalog")}>
              全部 <ArrowRight size={14} />
            </button>
          </div>
          <div className="recent-list">
            {events.slice(0, 7).map((e) => (
              <button
                key={e.id}
                className="recent-event"
                onClick={() => onSelect(e)}
              >
                <span
                  className={
                    "mag-box " + ((e.magnitude ?? 0) >= 5 ? "strong" : "")
                  }
                >
                  {value(e.magnitude)}
                  <small>{e.magnitude_type || "M"}</small>
                </span>
                <span>
                  <b>{e.place}</b>
                  <small>{time(e.origin_time).slice(5)} UTC</small>
                  <span className="recent-meta">
                    {value(e.depth_km)} km <Badge status={e.status} />
                  </span>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            {!events.length && <Empty>正在等待目录数据</Empty>}
          </div>
        </section>
      </div>
      <section className="panel catalog-panel">
        <div className="panel-head">
          <h3>最近事件目录</h3>
          <span className="muted">点击事件查看波形与定位</span>
          <button className="text-button" onClick={() => navigate("catalog")}>
            查看完整目录 <ArrowRight size={15} />
          </button>
        </div>
        <CatalogTable events={events.slice(0, 5)} onSelect={onSelect} />
      </section>
    </>
  );
}
