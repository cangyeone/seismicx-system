import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BrainCircuit,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe2,
  Maximize,
  Pause,
  Pin,
  Play,
  Radio,
  Settings2,
  Volume2,
  X,
} from "lucide-react";
import type { Quake, Station, Wave } from "../types";
import { api, post, time, value } from "../api";
import type {
  BroadcastController,
  CameraMode,
  MapSurface,
  MapRenderer,
} from "../broadcastState";
import Globe from "./Globe";
import FloatingCard from "./FloatingCard";
import EventListCard from "./EventListCard";
import MapCachePanel from "./MapCachePanel";
import { CARD_LAYOUT_KEY } from "./cardLayout";
import "./broadcast.css";

interface Source {
  title: string;
  url: string;
  kind: string;
  retrieved_at: string;
}
interface Context {
  geology: string;
  local_context: string;
  science: string;
  science_title: string;
  sources: Source[];
  errors: string[];
  retrieved_at: string;
}
interface Brief {
  status: string;
  analysis?: string;
  geology?: string;
  science?: string;
  context?: Context;
  model?: string;
  provider?: string;
  error?: string;
  generated_at?: string;
  total_budget?: number;
  notice?: string;
}
interface WaveBundle {
  status: string;
  waves: (Wave & { distance_km: number })[];
  errors: string[];
  start?: string;
  end?: string;
  note?: string;
}
const ready = (status: string) => status === "ready";
function useEventMedia(
  event: Quake | null,
  next: Quake | undefined,
  enabled: {
    showAI: boolean;
    showGeology: boolean;
    showScience: boolean;
    showWaves: boolean;
  },
) {
  const [brief, setBrief] = useState<Brief | null>(null),
    [waves, setWaves] = useState<WaveBundle | null>(null);
  const key = event
    ? [
        event.id,
        event.version,
        event.origin_time,
        event.latitude,
        event.longitude,
        event.depth_km,
        event.magnitude,
      ].join(":")
    : "";
  const wantAI = enabled.showAI || enabled.showGeology || enabled.showScience;
  useEffect(() => {
    setBrief(null);
    setWaves(null);
    if (!event) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const base = `/broadcast/events/${encodeURIComponent(event.id)}`;
    let briefDone = !wantAI,
      wavesDone = !enabled.showWaves,
      cycles = 0;
    const load = async (prepare: boolean) => {
      const results = await Promise.allSettled([
        !wantAI
          ? Promise.resolve(null)
          : api<Brief>(base + "/brief", {
              method:
                prepare || (!briefDone && cycles % 2 === 0) ? "POST" : "GET",
              signal: controller.signal,
            }),
        wavesDone
          ? Promise.resolve(null)
          : api<WaveBundle>(base + "/waves", {
              method: prepare || cycles % 10 === 0 ? "POST" : "GET",
              signal: controller.signal,
            }),
      ]);
      if (stopped) return;
      const [b, w] = results;
      if (b.status === "fulfilled" && b.value) {
        setBrief(b.value);
        briefDone = b.value.status === "ready";
      } else if (b.status === "rejected" && !briefDone)
        setBrief({
          status: "network_error",
          error: "解读服务连接中断，正在重试",
        });
      if (w.status === "fulfilled" && w.value) {
        setWaves(w.value);
        wavesDone = ready(w.value.status);
      } else if (w.status === "rejected" && !wavesDone)
        setWaves({
          status: "network_error",
          waves: [],
          errors: ["波形服务连接中断，正在重试"],
        });
      cycles++;
      if (wantAI || !wavesDone)
        timer = setTimeout(
          () => void load(false),
          (briefDone && wavesDone) ||
            (b.status === "fulfilled" && b.value?.status === "unavailable")
            ? 30000
            : 5000,
        );
    };
    void load(true);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, wantAI, enabled.showWaves]);
  useEffect(() => {
    if (!next || next.id === event?.id) return;
    // Only prefetch one upcoming event. Server bounds and rate-limits all model work.
    const timer = setTimeout(() => {
      if (wantAI)
        void post(
          `/broadcast/events/${encodeURIComponent(next.id)}/brief`,
        ).catch(() => {});
      if (enabled.showWaves)
        void post(
          `/broadcast/events/${encodeURIComponent(next.id)}/waves`,
        ).catch(() => {});
    }, 12000);
    return () => clearTimeout(timer);
  }, [next?.id, event?.id, wantAI, enabled.showWaves]);
  return { brief, waves };
}
function WaveCard({
  bundle,
  event,
}: {
  bundle: WaveBundle | null;
  event: Quake;
}) {
  const graph = useMemo(() => {
    if (!bundle?.waves.length) return null;
    const origin = Date.parse(event.origin_time),
      duration = bundle.end
        ? Math.max(30, (Date.parse(bundle.end) - origin) / 1000)
        : 580;
    const distances = bundle.waves.map((w) => w.distance_km),
      lo = Math.max(0, Math.min(...distances) - 30),
      hi = Math.max(...distances) + 30;
    const y = (d: number) => 32 + ((d - lo) / (hi - lo)) * 145;
    const x = (t: number) => 115 + ((t + 20) / (duration + 20)) * 550;
    let label = -5;
    const lines = bundle.waves.map((w) => {
      const trace = w.traces[0];
      if (!trace) return null;
      const valid = trace.points.filter((p) => p[1] != null && p[2] != null);
      if (!valid.length) return null;
      const mean =
        valid.reduce((sum, p) => sum + (p[1]! + p[2]!) / 2, 0) / valid.length;
      const max = Math.max(
        1,
        ...valid.flatMap((p) => [
          Math.abs(p[1]! - mean),
          Math.abs(p[2]! - mean),
        ]),
      );
      const offset = (Date.parse(trace.start) - origin) / 1000;
      label = Math.max(y(w.distance_km), label + 33);
      const d = valid
        .map(
          (p) =>
            `M${x(p[0] + offset).toFixed(1)},${(y(w.distance_km) - ((p[1]! - mean) / max) * 15).toFixed(1)}L${x(p[0] + offset).toFixed(1)},${(y(w.distance_km) - ((p[2]! - mean) / max) * 15).toFixed(1)}`,
        )
        .join("");
      return { w, d, baseline: y(w.distance_km), label };
    });
    return { x, y, duration, lo, hi, lines };
  }, [bundle, event.origin_time]);
  return (
    <>
      <div className="broadcast-card-title">
        <Activity size={19} />
        <h3>
          真实波形 <span>· 震中距—时间</span>
        </h3>
        <small>垂直分量 Z</small>
      </div>
      {graph ? (
        <svg
          viewBox="0 0 700 225"
          preserveAspectRatio="none"
          role="img"
          aria-label="真实台站波形，纵轴震中距、横轴相对发震时间"
        >
          {Array.from(
            { length: 6 },
            (_, i) => -20 + ((graph.duration + 20) * i) / 5,
          ).map((t) => (
            <g key={t}>
              <line
                x1={graph.x(t)}
                x2={graph.x(t)}
                y1="20"
                y2="185"
                stroke="#284653"
                strokeDasharray="2 5"
              />
              <text x={graph.x(t)} y="207" textAnchor="middle">
                {Math.round(t)} s
              </text>
            </g>
          ))}
          {graph.lines.map(
            (p) =>
              p && (
                <g key={p.w.station_id}>
                  <line
                    x1="115"
                    x2="665"
                    y1={p.baseline}
                    y2={p.baseline}
                    stroke="#203e4a"
                  />
                  <line
                    x1="103"
                    x2="113"
                    y1={p.label}
                    y2={p.baseline}
                    stroke="#759eaa"
                  />
                  <text
                    x="98"
                    y={p.label - 4}
                    textAnchor="end"
                    className="wave-station-label"
                  >
                    {p.w.station_id.replace(/\.$/, "")}
                  </text>
                  <text x="98" y={p.label + 10} textAnchor="end">
                    {Math.round(p.w.distance_km)} km
                  </text>
                  <path d={p.d} stroke="#65e4d1" strokeWidth=".8" fill="none" />
                </g>
              ),
          )}
          <text x="665" y="224" textAnchor="end">
            相对发震时间 / 秒 · 每道归一化
          </text>
        </svg>
      ) : (
        <div className="broadcast-wave-empty">
          <Activity size={25} />
          <span>
            {bundle?.status === "unavailable"
              ? "该事件时段暂未取得公开台站波形"
              : bundle?.status === "network_error"
                ? "正在重新连接波形服务"
                : "正在调取震中附近台站的真实记录"}
          </span>
          <small>仅展示实际收到的数据 · 不生成模拟波形</small>
        </div>
      )}
      <div className="broadcast-wave-note">
        {graph
          ? "真实记录不等同于已确认震相 · 来源 FDSN / 本地连续波形"
          : "部分地区的公开台站较稀疏，数据也可能尚未发布。"}
      </div>
      {!!bundle?.errors.length && (
        <details className="broadcast-wave-errors">
          <summary>{bundle.errors.length} 个台站暂不可用</summary>
          {bundle.errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </details>
      )}
    </>
  );
}
function SourceLinks({ sources }: { sources: Source[] }) {
  return (
    <div className="broadcast-sources">
      {sources.slice(0, 5).map((s) => (
        <a
          href={s.url}
          key={s.url}
          target="_blank"
          rel="noreferrer"
          title={`检索时间 ${time(s.retrieved_at)} UTC`}
        >
          {s.title}
          <ExternalLink size={10} />
        </a>
      ))}
    </div>
  );
}
export default function BroadcastStage({
  controller: b,
  stations,
  onDetail,
}: {
  controller: BroadcastController;
  stations: Station[];
  onDetail: (e: Quake) => void;
}) {
  const [showSettings, setShowSettings] = useState(false),
    [fullscreenError, setFullscreenError] = useState("");
  const [layoutReset, setLayoutReset] = useState(0);
  const [compactPanel, setCompactPanel] = useState<string | null>(null);
  useEffect(() => setCompactPanel(null), [b.event?.id]);
  const panels = [
    ["waves", "波形", b.settings.showWaves],
    ["events", "地震列表", b.settings.showEvents],
    ["ai", "AI 解读", b.settings.showAI],
    ["context", "区域地质", b.settings.showGeology],
    ["science", "地震科普", b.settings.showScience],
  ] as const;
  const available = panels.filter((p) => p[2]);
  const automaticPanel =
    available[
      Math.min(
        available.length - 1,
        Math.floor((b.elapsed / b.settings.duration) * available.length),
      )
    ]?.[0] || "none";
  const activePanel =
    available.find((p) => p[0] === (compactPanel || automaticPanel))?.[0] ||
    available[0]?.[0] ||
    "none";
  const root = useRef<HTMLDivElement>(null);
  const at = b.playlist.findIndex((e) => e.id === b.event?.id);
  const next =
    b.mode === "tour" && !b.paused
      ? b.playlist[(at + 1) % b.playlist.length]
      : undefined;
  const { brief, waves } = useEventMedia(b.event, next, b.settings);
  const context = brief?.context;
  const modelLabel =
    brief?.provider === "cloud"
      ? "在线大模型"
      : brief?.provider === "local"
        ? "本地小模型"
        : "AI 模型";
  const tour = b.mode === "tour",
    event = b.event;
  const moving = tour && !b.paused && b.settings.motion;
  const phase =
    !tour || b.paused
      ? "fixed"
      : b.elapsed / b.settings.duration < 0.3
        ? "arrival"
        : b.elapsed / b.settings.duration < 0.65
          ? "analysis"
          : "context";
  const startTour = () => {
    b.setMode("tour");
  };
  const fullscreen = async () => {
    try {
      if (!document.fullscreenElement) await root.current?.requestFullscreen();
      else await document.exitFullscreen();
      setFullscreenError("");
    } catch {
      setFullscreenError("浏览器未允许全屏，当前已使用无侧栏演播布局。");
    }
  };
  return (
    <div
      ref={root}
      className={`broadcast-stage ${tour ? "is-immersive" : "is-fixed"} ${moving ? "is-moving" : "is-still"} phase-${phase}`}
      data-compact-panel={activePanel}
      aria-label={tour ? "全屏地震演播" : "固定地震展示"}
    >
      <div className="broadcast-stars" />
      <Globe
        event={event}
        events={b.playlist}
        stations={stations}
        moving={moving}
        settings={b.settings}
        elapsed={b.elapsed}
      />
      <header className="broadcast-header">
        <div className="broadcast-brand">
          SEISMIC <b>X</b>
          <span>地震观测直播</span>
        </div>
        <div className="broadcast-header-right">
          <span className="broadcast-clock">
            UTC {time(new Date().toISOString())}
          </span>
          <span
            className={`broadcast-state ${b.activeNotice ? "is-breaking" : ""}`}
          >
            <i />
            {b.activeNotice
              ? event?.status === "candidate"
                ? "候选待复核"
                : "新收到速报"
              : tour
                ? "近期回放"
                : "固定显示"}
          </span>
        </div>
      </header>

      {event ? (
        <>
          <section
            className="broadcast-event"
            key={event.id}
            aria-live={b.activeNotice ? "polite" : "off"}
          >
            <div className="broadcast-event-index">
              {event.source === "CENC" ? "中国地震台网" : event.source}{" "}
              <span>
                /{" "}
                {event.status === "candidate"
                  ? "自动检测 · 尚未复核"
                  : b.activeNotice
                    ? "收到新速报"
                    : "事件回放"}
              </span>
            </div>
            <div className="broadcast-magnitude">
              <span>{event.magnitude_type || "M"}</span>
              <strong>{value(event.magnitude)}</strong>
            </div>
            <h2>{event.place}</h2>
            <dl className="broadcast-event-facts" aria-label="当前地震参数">
              <div>
                <dt>发震时间</dt>
                <dd>
                  {time(event.origin_time)}
                  <small> UTC</small>
                </dd>
              </div>
              <div>
                <dt>震源深度</dt>
                <dd>
                  {value(event.depth_km)} <small>km</small>
                </dd>
              </div>
              <div>
                <dt>数据来源</dt>
                <dd>
                  {event.source === "CENC"
                    ? "中国地震台网 · 公开目录"
                    : `${event.source} · ${event.status === "candidate" ? "候选事件" : "地震目录"}`}
                </dd>
              </div>
            </dl>
            <div className="broadcast-coordinates">
              <span>震中位置</span>
              {Math.abs(event.latitude).toFixed(2)}°{" "}
              {event.latitude >= 0 ? "N" : "S"} <i />{" "}
              {Math.abs(event.longitude).toFixed(2)}°{" "}
              {event.longitude >= 0 ? "E" : "W"}
            </div>
            {b.activeNotice && (
              <p className="broadcast-received">
                接收于 {time(b.activeNotice.received_at).slice(11)} UTC ·
                受源站发布延迟影响
              </p>
            )}
            <button
              className="broadcast-detail-link"
              onClick={() => {
                b.setMode("map");
                onDetail(event);
              }}
            >
              查看目录与震相 <ChevronRight size={14} />
            </button>
          </section>
          <>
            {b.settings.showAI && (
              <FloatingCard
                id="ai"
                label="AI 事件解读"
                className="broadcast-ai"
                locked={b.settings.layoutLocked}
                reset={layoutReset}
              >
                <div className="broadcast-card-title">
                  <BrainCircuit size={21} />
                  <h3>AI 事件解读</h3>
                  <span className="broadcast-chip">{modelLabel}</span>
                </div>
                <p className="broadcast-analysis-text">
                  {brief?.analysis ||
                    (brief?.status === "unavailable"
                      ? brief.error
                      : brief?.status === "network_error"
                        ? brief.error
                        : `${modelLabel}正在结合目录与公开区域资料生成解读。已确认的震情参数显示在左侧。`)}
                </p>
                {brief?.status !== "ready" && (
                  <div className="broadcast-model-progress">
                    <i
                      className={brief?.status === "unavailable" ? "off" : ""}
                    />
                    {brief?.status === "building"
                      ? brief.provider === "cloud"
                        ? "区域资料已就绪 · 正在请求在线模型"
                        : "区域资料已就绪 · 等待 NPU 空闲时生成"
                      : brief?.status === "unavailable"
                        ? "资料与目录仍可查看"
                        : brief?.provider === "local"
                          ? "解读按事件缓存 · 震相检测与模型共享 NPU"
                          : "解读按事件与模型缓存"}
                  </div>
                )}
                <footer>
                  <span>
                    {brief?.model || modelLabel}
                    {brief?.total_budget
                      ? ` · 预算 ${brief.total_budget} tokens`
                      : " · 基于目录与公开资料"}
                  </span>
                  <small>AI 辅助解读 · 不作地震预测</small>
                </footer>
              </FloatingCard>
            )}
            {b.settings.showGeology && (
              <FloatingCard
                id="context"
                label="区域地质"
                className="broadcast-context"
                locked={b.settings.layoutLocked}
                reset={layoutReset}
              >
                <Globe
                  event={event}
                  events={[]}
                  stations={[]}
                  moving={moving}
                  settings={b.settings}
                  elapsed={b.elapsed}
                  inset
                />
                <div className="broadcast-card-title">
                  <Globe2 size={20} />
                  <h3>区域地质</h3>
                </div>
                <div className="broadcast-context-block">
                  <h4>区域背景</h4>
                  <p>
                    {brief?.geology ||
                      context?.geology ||
                      "正在查询震中周边的板块边界与当地公开资料。"}
                  </p>
                </div>
                {!!context?.sources.length && (
                  <SourceLinks
                    sources={context.sources.filter(
                      (source) => source.kind !== "science",
                    )}
                  />
                )}
                {!!context?.errors?.length && (
                  <small className="broadcast-context-warning">
                    {context.errors.join("；")}
                  </small>
                )}
              </FloatingCard>
            )}
          </>
          {b.settings.showScience && (
            <FloatingCard
              id="science"
              label="地震科普"
              className="broadcast-science-card"
              locked={b.settings.layoutLocked}
              reset={layoutReset}
            >
              <div className="broadcast-card-title">
                <BookOpen size={20} />
                <h3>地震科普</h3>
                <span className="broadcast-chip">随事件选题</span>
              </div>
              <div className="broadcast-science">
                <h4>{context?.science_title || "地震科普"}</h4>
                <p>
                  {brief?.science ||
                    context?.science ||
                    "地震目录可能随着台站资料增加而修订。回放内容不代表当前正在发生地震。"}
                </p>
              </div>
              <small className="science-provenance">
                {brief?.science
                  ? `${modelLabel} · 依据公开科普资料`
                  : `公开科普资料 · ${brief?.status === "unavailable" ? "模型暂不可用" : modelLabel + "解读生成中"}`}
              </small>
              {!!context?.sources.length && (
                <SourceLinks
                  sources={context.sources.filter(
                    (source) => source.kind === "science",
                  )}
                />
              )}
            </FloatingCard>
          )}
          {b.settings.showEvents && (
            <FloatingCard
              id="events"
              label="地震列表"
              className="broadcast-list-card"
              locked={b.settings.layoutLocked}
              reset={layoutReset}
            >
              <EventListCard controller={b} />
            </FloatingCard>
          )}
          {b.settings.showWaves && (
            <FloatingCard
              id="waves"
              label="真实波形"
              className="broadcast-wave"
              locked={b.settings.layoutLocked}
              reset={layoutReset}
            >
              <WaveCard bundle={waves} event={event} />
            </FloatingCard>
          )}
        </>
      ) : (
        <div className="broadcast-empty">
          <Globe2 size={36} />
          <h2>{b.feed ? "当前筛选没有事件" : "正在连接地震目录"}</h2>
          <p>
            {b.feed
              ? "可在设置中调整震级、来源或候选事件筛选。"
              : "等待真实 USGS / 中国地震台网目录"}
          </p>
          <button onClick={() => setShowSettings(true)}>打开演播设置</button>
        </div>
      )}
      <div className="broadcast-controls">
        <div className="broadcast-compact-tabs" aria-label="横屏信息卡片">
          {available.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={activePanel === key}
              onClick={() => setCompactPanel(key)}
            >
              {label}
            </button>
          ))}
          {tour && (
            <button
              aria-pressed={!compactPanel}
              onClick={() => setCompactPanel(null)}
            >
              自动切换
            </button>
          )}
        </div>
        <div className="broadcast-progress">
          <span>
            {b.activeNotice
              ? "速报插播"
              : `近期事件 ${Math.max(0, at + 1)} / ${b.playlist.length}`}
          </span>
          <div>
            <i
              style={{
                width: `${tour ? (b.elapsed / b.settings.duration) * 100 : 100}%`,
              }}
            />
          </div>
          <span>
            {tour
              ? `${Math.floor(b.elapsed).toString().padStart(2, "0")} / ${b.settings.duration}s`
              : "手动切换"}
          </span>
        </div>
        <div className="broadcast-control-buttons">
          <button aria-pressed={!tour} onClick={() => b.setMode("fixed")}>
            <Pin size={15} />
            固定显示
          </button>
          {tour ? (
            <button onClick={() => b.setPaused(!b.paused)}>
              {b.paused ? <Play size={15} /> : <Pause size={15} />}{" "}
              {b.paused ? "继续" : "暂停"}
            </button>
          ) : (
            <button onClick={startTour}>
              <Play size={15} />
              动画展示
            </button>
          )}
          <button
            aria-label="上一事件"
            title="上一事件"
            onClick={() => b.next(-1)}
            disabled={!b.playlist.length}
          >
            <ChevronLeft size={17} />
          </button>
          <button onClick={() => b.next()} disabled={!b.playlist.length}>
            <ChevronRight size={17} />
            下一事件
          </button>
          <button
            aria-expanded={showSettings}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings2 size={16} />
            设置
          </button>
          {tour && (
            <button
              onClick={fullscreen}
              aria-label="浏览器全屏"
              title="浏览器全屏"
            >
              <Maximize size={16} />
            </button>
          )}
          <button onClick={() => b.setMode("map")}>
            <ArrowLeft size={15} />
            {tour ? "退出演播" : "返回地图"}
          </button>
        </div>
        {fullscreenError && <small>{fullscreenError}</small>}
      </div>
      <footer className="broadcast-footer">
        <span>
          <Radio size={12} />
          {stations.filter((s) => s.status === "online").length} 个在线台站{" "}
          <i />{" "}
          {Object.entries(b.feed?.sources || {}).map(([name, s]) => (
            <span
              key={name}
              className={!s?.ok ? "source-down" : ""}
              title={s?.error || `最近同步 ${time(s?.fetched_at)} UTC`}
            >
              {name} {s?.ok ? "●" : "○"}
            </span>
          ))}
        </span>
        <span>
          震中脉冲为示意动画 · 非预警倒计时 <i /> 板块边界 USGS
        </span>
      </footer>
      {b.notice && b.notice.id !== b.activeNotice?.id && tour && (
        <div className="broadcast-queued-notice" role="status">
          <Activity size={16} />
          <span>
            新收到 {b.notice.source} 速报 · M {value(b.notice.magnitude)} ·{" "}
            {b.notice.place}
          </span>
          <button
            onClick={() => {
              b.select(b.notice!, b.notice);
              b.setPaused(false);
              b.dismissNotice();
            }}
          >
            立即展示
          </button>
        </div>
      )}
      {b.connectionError && (
        <div className="broadcast-connection-error">
          速报连接中断 · 正在重试，当前为缓存回放
        </div>
      )}
      {showSettings && (
        <section className="broadcast-settings" aria-label="演播设置">
          <header>
            <h3>演播设置</h3>
            <button
              aria-label="关闭演播设置"
              onClick={() => setShowSettings(false)}
            >
              <X size={17} />
            </button>
          </header>
          <p>设置保存在当前浏览器。新速报按相同筛选插播。</p>
          <fieldset className="broadcast-region-settings broadcast-map-settings">
            <legend>地图显示</legend>
            <div className="broadcast-map-options">
              <h4>地图模式</h4>
              <div className="broadcast-render-modes" aria-label="地图渲染模式">
                {(
                  [
                    ["simple", "简洁地球"],
                    ["flat", "平面地图"],
                    ["detail", "精细三维"],
                  ] as [MapRenderer, string][]
                ).map(([renderer, title]) => (
                  <button
                    key={renderer}
                    aria-pressed={b.settings.renderer === renderer}
                    onClick={() => b.setSettings({ ...b.settings, renderer })}
                  >
                    {title}
                  </button>
                ))}
              </div>
              <h4>镜头视角</h4>
              <div
                className="broadcast-camera-modes"
                role="group"
                aria-label="地图视角"
              >
                {(
                  [
                    ["epicenter", "震中巡游"],
                    ["region", "固定区域"],
                    ["global", "全球视角"],
                  ] as [CameraMode, string][]
                ).map(([camera, title]) => (
                  <button
                    key={camera}
                    aria-pressed={b.settings.camera === camera}
                    onClick={() => b.setSettings({ ...b.settings, camera })}
                  >
                    {title}
                  </button>
                ))}
              </div>
              {b.settings.renderer === "detail" && <h4>地图底图</h4>}
              <div
                className="broadcast-map-surfaces"
                role="group"
                aria-label="地图底图"
              >
                {(
                  [
                    ["satellite", "卫星底图"],
                    ["relief", "地形晕渲"],
                  ] as [MapSurface, string][]
                ).map(
                  ([surface, title]) =>
                    b.settings.renderer === "detail" && (
                      <button
                        key={surface}
                        aria-pressed={b.settings.surface === surface}
                        onClick={() =>
                          b.setSettings({ ...b.settings, surface })
                        }
                      >
                        {title}
                      </button>
                    ),
                )}

                <a href="/map-sources.html" target="_blank" rel="noreferrer">
                  数据来源
                </a>
              </div>
            </div>
          </fieldset>
          <fieldset className="broadcast-region-settings">
            <legend>固定区域 / 全球朝向</legend>
            <div className="broadcast-region-coordinates">
              <label>
                中心纬度
                <input
                  aria-label="中心纬度"
                  type="number"
                  min="-85"
                  max="85"
                  step="0.1"
                  value={b.settings.regionLatitude}
                  onChange={(e) =>
                    b.setSettings({
                      ...b.settings,
                      regionLatitude: Math.max(
                        -85,
                        Math.min(85, +e.target.value),
                      ),
                    })
                  }
                />
              </label>
              <label>
                中心经度
                <input
                  aria-label="中心经度"
                  type="number"
                  min="-180"
                  max="180"
                  step="0.1"
                  value={b.settings.regionLongitude}
                  onChange={(e) =>
                    b.setSettings({
                      ...b.settings,
                      regionLongitude: Math.max(
                        -180,
                        Math.min(180, +e.target.value),
                      ),
                    })
                  }
                />
              </label>
            </div>
            <label>
              区域镜头距离
              <select
                aria-label="区域镜头距离"
                value={b.settings.regionRange}
                onChange={(e) =>
                  b.setSettings({ ...b.settings, regionRange: +e.target.value })
                }
              >
                {[25, 80, 250, 800, 1500, 3500, 7000, 12000, 20000].map(
                  (km) => (
                    <option key={km} value={km}>
                      {km.toLocaleString()} km
                    </option>
                  ),
                )}
              </select>
            </label>
            <div className="broadcast-region-actions">
              <button
                disabled={!event}
                onClick={() =>
                  event &&
                  b.setSettings({
                    ...b.settings,
                    camera: "region",
                    regionLatitude: event.latitude,
                    regionLongitude: event.longitude,
                    regionRange: 250,
                  })
                }
              >
                固定当前震中
              </button>
              <button
                onClick={() =>
                  b.setSettings({
                    ...b.settings,
                    camera: "region",
                    regionLatitude: 35,
                    regionLongitude: 105,
                    regionRange: 3500,
                  })
                }
              >
                中国区域
              </button>
            </div>
            <small>
              固定视角不随事件移动。卫星底图为历史合成影像；地形高程展示放大 2
              倍，脉冲与光柱为震中示意。
            </small>
          </fieldset>
          <fieldset className="broadcast-region-settings">
            <legend>浮动卡片布局</legend>
            <p>
              电脑：拖动卡片顶部手柄移动，拖动右下角改变宽高。支持方向键微调。手机自动排版。
            </p>
            <label className="broadcast-toggle">
              <span>锁定卡片位置和大小</span>
              <input
                type="checkbox"
                checked={b.settings.layoutLocked}
                onChange={(e) =>
                  b.setSettings({
                    ...b.settings,
                    layoutLocked: e.target.checked,
                  })
                }
              />
            </label>
            <button
              onClick={() => {
                try {
                  localStorage.removeItem(CARD_LAYOUT_KEY);
                } catch {
                  /* private mode */
                }
                setLayoutReset((n) => n + 1);
              }}
            >
              恢复默认卡片布局
            </button>
          </fieldset>
          <MapCachePanel />

          <label>
            每个事件时长
            <select
              aria-label="每个事件时长"
              value={b.settings.duration}
              onChange={(e) =>
                b.setSettings({ ...b.settings, duration: +e.target.value })
              }
            >
              {[20, 30, 40, 60, 90, 120].map((n) => (
                <option key={n} value={n}>
                  {n} 秒
                </option>
              ))}
            </select>
          </label>
          <label>
            最低震级
            <select
              aria-label="最低震级"
              value={b.settings.minMagnitude}
              onChange={(e) =>
                b.setSettings({ ...b.settings, minMagnitude: +e.target.value })
              }
            >
              {[-2, 0, 2, 2.5, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n === -2 ? "包含未定震级" : `M ${n}+`}
                </option>
              ))}
            </select>
          </label>
          <label>
            目录来源
            <select
              aria-label="目录来源"
              value={b.settings.source}
              onChange={(e) =>
                b.setSettings({ ...b.settings, source: e.target.value })
              }
            >
              <option value="all">全部来源</option>
              <option value="CENC">中国地震台网</option>
              <option value="USGS">USGS 全球</option>
              <option value="SeismicX">SeismicX 自动编目</option>
            </select>
          </label>
          {(
            [
              ["showAI", "AI 事件解读"],
              ["showEvents", "地震列表卡片"],
              ["showStations", "地图显示台站位置"],
              ["showGeology", "区域地质卡片"],
              ["showScience", "地震科普卡片"],
              ["showWaves", "真实事件波形"],
              ["motion", "镜头推进与震中动画"],
              ["candidates", "包括未复核候选事件"],
              ["sound", "新速报语音播报"],
            ] as const
          ).map(([k, label]) => (
            <label className="broadcast-toggle" key={k}>
              <span>
                {k === "sound" && <Volume2 size={14} />} {label}
              </span>
              <input
                type="checkbox"
                checked={b.settings[k]}
                onChange={(e) =>
                  b.setSettings({ ...b.settings, [k]: e.target.checked })
                }
              />
            </label>
          ))}
          <small>
            语音使用浏览器语音引擎，需要首次交互并允许播放。按 Esc
            可离开演播；直播可使用 OBS 窗口采集。
          </small>
        </section>
      )}
    </div>
  );
}
