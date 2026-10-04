import { AdminContext, type AdminSession } from "./platform/auth";
import { setCSRF } from "./platform/api";
import StationsPage from "./platform/StationsPage";
import OverviewPage from "./platform/OverviewPage";
import EdgePage from "./platform/Edge";
import Access from "./platform/Access";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useBroadcast } from "./platform/broadcastState";
import "./platform/broadcast/broadcast.css";
const BroadcastStage = lazy(() => import("./platform/broadcast/Stage"));
import {
  Activity,
  Radio,
  Table2,
  CheckSquare,
  History,
  ChartNoAxesCombined,
  Database,
  RefreshCw,
  ArrowRight,
  Plus,
  Download,
  Search,
  Play,
  Clock,
  Menu,
  X,
  Signal,
  ChevronRight,
  Cpu,
} from "lucide-react";
import type { Quake, Station, Overview, Job } from "./platform/types";
import { api, post, patch, time, value, download } from "./platform/api";
import { Badge, Empty } from "./platform/ui";
import WorldMap from "./platform/Map";
import { CatalogTable } from "./platform/Catalog";
import { EventForm, StationForm, DetectionForm } from "./platform/Forms";
import EventDetail from "./platform/EventDetail";
import AnalysisPage from "./platform/Analysis";
import LiveStation from "./platform/LiveStation";
import SettingsPage, { Jobs } from "./platform/Settings";
const navigation = [
  { id: "overview", label: "监测总览", icon: Activity },
  { id: "stations", label: "台站分布", icon: Radio },
  { id: "edge", label: "边缘推理", icon: Cpu },
  { id: "catalog", label: "地震目录", icon: Table2 },
  { id: "review", label: "人工复核", icon: CheckSquare },
  { id: "history", label: "历史监测", icon: History },
  { id: "analysis", label: "活动性分析", icon: ChartNoAxesCombined },
  { id: "settings", label: "后台管理", icon: Database },
];
export default function App() {
  const [session, setSession] = useState<AdminSession>({
    authenticated: false,
  });
  const admin = session.authenticated;
  const broadcast = useBroadcast(false);
  useEffect(() => {
    api<AdminSession>("/auth/session")
      .then((s) => {
        setSession(s);
        setCSRF(s.csrf || "");
      })
      .catch(() => {});
    const expired = () => {
      setSession({ authenticated: false });
      setCSRF("");
      setModal("");
    };
    window.addEventListener("seismicx-session-expired", expired);
    return () =>
      window.removeEventListener("seismicx-session-expired", expired);
  }, []);
  const logout = async () => {
    try {
      await post("/auth/logout");
      setSession({ authenticated: false });
      setCSRF("");
      setModal("");
      setSelected(null);
      navigate("overview");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [liveStation, setLiveStation] = useState<Station | null>(null);
  const [page, setPage] = useState(
      location.pathname === "/admin" ? "settings" : "overview",
    ),
    [events, setEvents] = useState<Quake[]>([]),
    [stations, setStations] = useState<Station[]>([]),
    [overview, setOverview] = useState<Overview | null>(null),
    [jobs, setJobs] = useState<Job[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [modal, setModal] = useState(""),
    [query, setQuery] = useState(""),
    [source, setSource] = useState("all"),
    [status, setStatus] = useState("all"),
    [selectedStations, setSelectedStations] = useState<string[]>([]),
    [menu, setMenu] = useState(false),
    [clock, setClock] = useState(new Date()),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0);
  const requestVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const [e, s, o, j] = await Promise.all([
        api<{ items: Quake[]; total: number }>(
          `/events?limit=200&offset=${offset}&q=${encodeURIComponent(query)}&source=${source}&status=${page === "review" ? "candidate" : status}&monitored=${page === "history"}`,
        ),
        api<Station[]>("/stations"),
        api<Overview>("/overview"),
        admin ? api<Job[]>("/jobs") : Promise.resolve([] as Job[]),
      ]);
      if (version !== requestVersion.current) return;
      setEvents(e.items);
      setTotal(e.total);
      setStations(s);
      setOverview(o);
      setJobs(j);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, query, source, status, offset, admin]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 8000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const navigate = (id: string) => {
    setPage(id);
    history.replaceState(null, "", id === "settings" ? "/admin" : "/");
    if (id === "settings") broadcast.setMode("fixed");
    setEvents([]);
    setTotal(0);
    setSelected(null);
    setQuery("");
    setSource("all");
    setStatus("all");
    setOffset(0);
    setMenu(false);
    setNotice("");
  };
  const onSelect = (e: Quake) => {
    setSelected(e.id);
    setNotice("");
  };
  const sync = async () => {
    setRefreshing(true);
    try {
      if (admin) {
        await post("/sync");
        setNotice("数据同步已排队，完成后自动刷新。");
      }
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const toggleStation = async (s: Station) => {
    try {
      await patch(`/stations/${encodeURIComponent(s.id)}`, {
        network: s.network,
        station: s.station,
        location: s.location,
        channel: s.channel,
        latitude: s.latitude,
        longitude: s.longitude,
        elevation_m: s.elevation_m,
        name: s.name,
        provider: s.provider,
        enabled: !s.enabled,
      });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const fresh = (stamp: string | undefined) =>
    stamp && Date.now() - new Date(stamp).getTime() < 30000;
  const filteredStations = stations.filter((s) =>
    (s.id + s.name + s.provider).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <AdminContext.Provider value={admin}>
      <div
        className="app-shell"
        inert={broadcast.mode === "tour" ? true : undefined}
        aria-hidden={broadcast.mode === "tour" ? true : undefined}
      >
        <aside className={"sidebar " + (menu ? "open" : "")}>
          <div className="brand">
            SEISMIC <b>X</b>
            <small>
              {overview?.platform_name?.replace(/^SeismicX\s*/, "") ||
                "边缘推理平台"}
            </small>
          </div>
          <button
            className="mobile-close icon-button"
            aria-label="关闭导航"
            onClick={() => setMenu(false)}
          >
            <X />
          </button>
          <nav>
            {navigation
              .filter(
                (n) => admin || !["edge", "review", "history"].includes(n.id),
              )
              .map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={page === id ? "active" : ""}
                  onClick={() => navigate(id)}
                >
                  <Icon size={19} />
                  {label}
                  {id === "review" && !!overview?.candidates && (
                    <em>{overview.candidates}</em>
                  )}
                </button>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="mini-wave">╱╲╱╲│╱╲╱</div>
            <span>从连续波形，到地震目录</span>
            <small>
              SEISMIC X <span>v2.1</span>
            </small>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <button
              className="mobile-menu icon-button"
              aria-label="打开导航"
              onClick={() => setMenu(true)}
            >
              <Menu />
            </button>
            <span className="breadcrumb">
              观测工作台 <ChevronRight size={14} />{" "}
              {navigation.find((n) => n.id === page)?.label}
              {selected && (admin ? " / 事件复核" : " / 事件详情")}
            </span>
            <div className="topbar-actions">
              {admin && (
                <button
                  onClick={logout}
                  className="admin-session"
                  title={`当前管理员 ${session.username}`}
                >
                  退出后台
                </button>
              )}
              <span className="utc">
                <i />
                UTC <b>{time(clock.toISOString())}</b>
              </span>
              <button onClick={sync} disabled={refreshing}>
                <RefreshCw size={15} className={refreshing ? "spin" : ""} />
                刷新数据
              </button>
            </div>
          </header>
          <main>
            {error && (
              <div className="alert error-text">
                {error}
                {error.includes("令牌") && (
                  <button onClick={() => navigate("settings")}>设置令牌</button>
                )}
              </div>
            )}
            {notice && (
              <div className="alert">
                <span>{notice}</span>
                <button
                  className="icon-button"
                  aria-label="关闭提示"
                  onClick={() => setNotice("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {!admin &&
            ["settings", "edge", "review", "history"].includes(page) ? (
              <Access
                onReady={(s) => {
                  setSession(s);
                  setPage("settings");
                  setError("");
                }}
                onBack={() => navigate("overview")}
              />
            ) : selected ? (
              <EventDetail
                key={`${selected}-${admin}`}
                id={selected}
                onBack={() => setSelected(null)}
                onChange={reload}
              />
            ) : (
              <>
                {page === "overview" && (
                  <OverviewPage
                    broadcast={broadcast}
                    overview={overview}
                    events={events}
                    stations={stations}
                    navigate={navigate}
                    onSelect={onSelect}
                    setQuery={setQuery}
                  />
                )}
                {page === "edge" && <EdgePage />}
                {page === "stations" && (
                  <StationsPage
                    stations={stations}
                    filteredStations={filteredStations}
                    selectedStations={selectedStations}
                    setSelectedStations={setSelectedStations}
                    query={query}
                    setQuery={setQuery}
                    setModal={setModal}
                    onSelect={onSelect}
                    setLiveStation={setLiveStation}
                    toggleStation={toggleStation}
                  />
                )}
                {["catalog", "review", "history"].includes(page) && (
                  <>
                    <div className="page-heading">
                      <div>
                        <h1>
                          {page === "catalog"
                            ? "地震目录"
                            : page === "review"
                              ? "人工复核"
                              : "历史地震监测"}
                        </h1>
                        <p>
                          {page === "review"
                            ? "校正震相与震级，检查定位质量，形成可追溯的地震目录"
                            : page === "history"
                              ? "录入已知地震，回放历史波形，复查检测与定位结果"
                              : "外部参考目录与自动检测结果保留独立来源"}
                        </p>
                      </div>
                      {admin && (
                        <button onClick={() => setModal("event")}>
                          <Plus size={15} />
                          录入地震
                        </button>
                      )}
                      <button
                        className="primary"
                        onClick={() =>
                          download(
                            `/catalog/export?monitored=${page === "history"}&q=${encodeURIComponent(query)}&source=${source}&status=${page === "review" ? "candidate" : status}`,
                            "seismicx-catalog.csv",
                          ).catch((e) => setError(e.message))
                        }
                      >
                        <Download size={15} />
                        导出 CSV
                      </button>
                      <button
                        onClick={() =>
                          download(
                            `/catalog/export?format=quakeml&monitored=${page === "history"}&q=${encodeURIComponent(query)}&source=${source}&status=${page === "review" ? "candidate" : status}`,
                            "seismicx-catalog.xml",
                          ).catch((e) => setError(e.message))
                        }
                      >
                        QuakeML
                      </button>
                    </div>
                    <div className="filterbar">
                      <div className="search">
                        <Search size={16} />
                        <input
                          value={query}
                          onChange={(e) => {
                            setQuery(e.target.value);
                            setOffset(0);
                          }}
                          placeholder="搜索地点或事件编号"
                        />
                      </div>
                      <select
                        value={source}
                        onChange={(e) => {
                          setSource(e.target.value);
                          setOffset(0);
                        }}
                      >
                        <option value="all">全部来源</option>
                        <option value="USGS">USGS 参考目录</option>
                        <option value="SeismicX">SeismicX 检测</option>
                        <option value="manual">人工录入</option>
                      </select>
                      {page !== "review" && (
                        <select
                          value={status}
                          onChange={(e) => {
                            setStatus(e.target.value);
                            setOffset(0);
                          }}
                        >
                          <option value="all">全部状态</option>
                          <option value="reviewed">已复核</option>
                          <option value="candidate">待复核</option>
                          <option value="external">外部目录</option>
                        </select>
                      )}
                      <span>共 {total} 个事件</span>
                    </div>
                    <section className="panel">
                      <CatalogTable events={events} onSelect={onSelect} />
                    </section>
                    <div className="pagination">
                      <button
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 200))}
                      >
                        上一页
                      </button>
                      <span>
                        {offset + 1}–{Math.min(offset + 200, total)} / {total}
                      </span>
                      <button
                        disabled={offset + 200 >= total}
                        onClick={() => setOffset(offset + 200)}
                      >
                        下一页
                      </button>
                    </div>
                    {page === "review" && <Jobs jobs={jobs} />}
                  </>
                )}
                {page === "analysis" && <AnalysisPage />}
                {page === "settings" && <SettingsPage jobs={jobs} />}
              </>
            )}
          </main>
          <footer className="statusbar">
            <span>
              <Database size={15} /> 数据源{" "}
              <i
                className={
                  "status-dot " + (overview?.sources.catalog?.ok ? "" : "off")
                }
              />
              {overview?.sources.catalog?.ok ? "USGS 已连接" : "等待连接"}
              <span className="status-secondary">
                {" "}
                / {String(overview?.collector?.server || "公共 FDSN")}
              </span>
            </span>
            <span>
              <Signal size={15} /> 采集{" "}
              <i
                className={
                  "status-dot " +
                  (fresh(String(overview?.collector?.heartbeat || ""))
                    ? ""
                    : "off")
                }
              />
              {fresh(String(overview?.collector?.heartbeat || ""))
                ? "运行中"
                : "未运行"}
            </span>
            <span>
              <Activity size={15} /> 编目{" "}
              <i
                className={
                  "status-dot " +
                  (fresh(overview?.worker?.heartbeat) ? "" : "off")
                }
              />
              {fresh(overview?.worker?.heartbeat) ? "就绪" : "工作进程未启动"}
            </span>
            <span className="status-secondary">
              自动刷新 8 s · 所有时间 UTC
            </span>
          </footer>
        </div>
        {liveStation && (
          <LiveStation
            station={liveStation}
            onClose={() => setLiveStation(null)}
          />
        )}
        {admin && modal === "event" && (
          <EventForm onClose={() => setModal("")} onSaved={reload} />
        )}{" "}
        {admin && modal === "station" && (
          <StationForm onClose={() => setModal("")} onSaved={reload} />
        )}{" "}
        {admin && modal === "detect" && (
          <DetectionForm
            stations={stations}
            selected={selectedStations.slice(0, 32)}
            onClose={() => setModal("")}
            onSaved={() => {
              reload();
              setNotice("任务已提交，可在后台管理页查看进度。");
            }}
          />
        )}
      </div>
      {broadcast.mode === "tour" &&
        createPortal(
          <Suspense
            fallback={
              <div className="broadcast-stage is-immersive">
                <div className="broadcast-empty">正在准备地震演播…</div>
              </div>
            }
          >
            <BroadcastStage
              controller={broadcast}
              stations={stations}
              onDetail={onSelect}
            />
          </Suspense>,
          document.body,
        )}
      {broadcast.notice && broadcast.mode !== "tour" && (
        <div className="broadcast-notice" role="status">
          <Activity size={22} />
          <div>
            <h4>收到新速报 · {broadcast.notice.source}</h4>
            <p>
              M {value(broadcast.notice.magnitude)} · {broadcast.notice.place}
            </p>
            <small>
              {time(broadcast.notice.origin_time)} UTC · 深度{" "}
              {value(broadcast.notice.depth_km)} km
              {broadcast.notice.status === "candidate" ? " · 候选未复核" : ""}
            </small>
            <button
              onClick={() => {
                broadcast.select(broadcast.notice!, broadcast.notice);
                broadcast.setMode("tour");
                broadcast.dismissNotice();
              }}
            >
              在地图上展示
            </button>
          </div>
          <button
            className="notice-close"
            aria-label="关闭速报提示"
            onClick={broadcast.dismissNotice}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </AdminContext.Provider>
  );
}
