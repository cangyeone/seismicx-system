import { useEffect, useState } from "react";
import { api, time, setCSRF } from "./api";
import { Badge } from "./ui";
import type { Job } from "./types";
import {
  Workflow,
  ShieldCheck,
  SlidersHorizontal,
  Save,
  RefreshCw,
} from "lucide-react";
type Values = Record<string, string | number>;
export interface RuntimeSettings {
  revision: number;
  config: Record<string, Values>;
  updated_at: string | null;
}
interface Config {
  runtime: RuntimeSettings;
  runtime_schema: {
    $defs: Record<
      string,
      {
        properties: Record<
          string,
          {
            minimum?: number;
            maximum?: number;
            minLength?: number;
            maxLength?: number;
            type: string;
            enum?: string[];
          }
        >;
      }
    >;
  };
  algorithms: {
    picker: string;
    association: string;
    location: string;
    revision: string;
  };
  seedlink: string;
  cloud_llm: { configured: boolean };
}
const sections = [
  [
    "phase",
    "震相筛选",
    "PNSN v3 · 原始连续波形不滤波。阈值分别用于 P / S 震相进入关联前的筛选；原始拾取保留。",
    "Phase",
  ],
  [
    "association",
    "多台站关联",
    "Python REAL · 区域台网。搜索网格上限 50,000 点，防止过密网格占满开发板。",
    "Association",
  ],
  [
    "location",
    "震源定位",
    "Skill 网格定位 · 均匀速度基线。正式目录需结合区域速度模型与人工复核。",
    "Location",
  ],
  [
    "system",
    "系统与模型",
    "下一轮采集目录、推理或模型任务自动读取。已开始的编目任务保留提交时的参数版本。",
    "System",
  ],
];
const labels: Record<string, string> = {
  p_threshold: "P 震相置信度",
  s_threshold: "S 震相置信度",
  search_radius_deg: "关联搜索半径 / °",
  max_depth_km: "关联最大深度 / km",
  grid_spacing_deg: "水平搜索步长 / °",
  depth_spacing_km: "深度搜索步长 / km",
  event_window_s: "事件分离时间 / s",
  max_azimuth_gap_deg: "最大方位角空缺 / °",
  min_p: "最少 P 震相",
  min_s: "最少 S 震相",
  min_total: "最少总震相",
  min_both: "最少 P+S 双震相台站",
  max_origin_std_s: "最大发震时刻标准差 / s",
  min_ps_separation_s: "最小 P–S 间隔 / s",
  window_multiplier: "到时窗口倍数",
  jobs: "REAL 并行线程",
  vp: "P 波速度 / km·s⁻¹",
  vs: "S 波速度 / km·s⁻¹",
  velocity_name: "速度模型名称",
  min_picks: "定位最少震相数",
  min_depth: "定位最小深度 / km",
  max_depth: "定位最大深度 / km",
  pad_degree: "定位边界扩展 / °",
  grid_lat: "纬度网格点数",
  grid_lon: "经度网格点数",
  grid_depth: "深度网格点数",
  origin_time_pad: "发震时间搜索扩展 / s",
  platform_name: "系统名称",
  catalog_poll_seconds: "全球 / 中国目录轮询 / s",
  broadcast_ai_interval_seconds: "自动 AI 解读最小间隔 / s",
  edge_interval_seconds: "NPU 推理周期 / s",
  edge_window_seconds: "NPU 波形窗口 / s",
  edge_max_input_lag_seconds: "允许输入数据延迟 / s",
  edge_max_stations: "每轮最大处理台站数",
  edge_input_delay_seconds: "波形缓冲等待 / s",
  broadcast_llm_provider: "演播 AI 来源（解读 / 科普）",
  llm_base_url: "本地模型接口 / v1",
  llm_model: "本地模型名称",
  llm_context_tokens: "模型总上下文预算 / tokens",
  llm_output_tokens: "模型最大输出 / tokens",
  cloud_llm_base_url: "在线模型接口 / v1",
  cloud_llm_model: "在线模型名称",
};
export function Jobs({ jobs }: { jobs: Job[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>
          <Workflow size={17} /> 编目任务
        </h3>
        <span className="muted">持久化队列 · 最近 50 项</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>创建时间 UTC</th>
              <th>任务</th>
              <th>状态</th>
              <th>进度 / 结果</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="mono">{time(j.created_at)}</td>
                <td>
                  {(
                    {
                      detect: "自动编目",
                      relocate: "重新定位",
                      sync: "数据同步",
                    } as Record<string, string>
                  )[j.kind] || j.kind}
                  <small className="block mono">{j.id.slice(0, 10)}</small>
                </td>
                <td>
                  <Badge status={j.status} />
                </td>
                <td className="job-result">
                  {j.error ? (
                    <details>
                      <summary className="error-text">查看失败原因</summary>
                      <pre>{j.error}</pre>
                    </details>
                  ) : j.result ? (
                    <details>
                      <summary>
                        {JSON.parse(j.result).message || "查看运行结果"}
                      </summary>
                      <pre>{JSON.stringify(JSON.parse(j.result), null, 2)}</pre>
                    </details>
                  ) : (
                    j.progress || "等待工作进程"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!jobs.length && (
          <p className="inline-empty">
            还没有任务。可从台站页或事件复核页创建自动编目任务。
          </p>
        )}
      </div>
    </section>
  );
}
export default function SettingsPage({ jobs }: { jobs: Job[] }) {
  const [config, setConfig] = useState<Config | null>(null),
    [draft, setDraft] = useState<RuntimeSettings | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [username, setUsername] = useState("");
  const load = () =>
    api<Config>("/settings")
      .then((c) => {
        setConfig(c);
        setDraft(c.runtime);
        setDirty(false);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<{ username: string }>("/auth/session").then((s) =>
      setUsername(s.username),
    );
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>后台设置</h1>
          <p>算法参数、推理资源和系统信息 · 仅管理员可访问</p>
        </div>
        <span className="admin-badge">
          <ShieldCheck size={15} /> {username}
        </span>
      </div>
      {error && (
        <div className="alert error-text" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert" role="status">
          {notice}
        </div>
      )}
      {draft && config && (
        <form
          className="admin-settings"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            try {
              const saved = await api<RuntimeSettings>("/settings", {
                method: "PUT",
                body: JSON.stringify({
                  revision: draft.revision,
                  config: draft.config,
                }),
              });
              setDraft(saved);
              setDirty(false);
              setNotice(`配置 v${saved.revision} 已保存；下一轮任务自动生效。`);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="admin-savebar">
            <div>
              <SlidersHorizontal size={18} />
              <span>
                配置 v{draft.revision}
                <small>
                  {dirty
                    ? "有未保存更改"
                    : draft.updated_at
                      ? `${time(draft.updated_at)} UTC`
                      : "使用部署默认值"}
                </small>
              </span>
            </div>
            <div>
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setNotice("");
                  load();
                }}
                disabled={busy}
              >
                <RefreshCw size={15} />
                重新载入
              </button>
              <button className="primary" disabled={busy || !dirty}>
                <Save size={15} />
                {busy ? "保存中…" : "保存配置"}
              </button>
            </div>
          </div>
          <div className="admin-settings-grid">
            {sections.map(([group, title, description, schema]) => (
              <section
                className="panel admin-section"
                data-group={group}
                key={group}
              >
                <div className="panel-head">
                  <h3>{title}</h3>
                  <span>
                    {group === "phase"
                      ? "PNSN v3"
                      : group === "association"
                        ? "REAL"
                        : group === "location"
                          ? "GRID"
                          : "EDGE / LLM"}
                  </span>
                </div>
                <p className="admin-description">{description}</p>
                <div className="admin-fields">
                  {Object.entries(draft.config[group]).map(([key, val]) => {
                    const spec =
                      config.runtime_schema.$defs[schema].properties[key];
                    return (
                      <label
                        key={key}
                        className={typeof val === "string" ? "wide-field" : ""}
                      >
                        {labels[key] || key}
                        {spec.enum ? (
                          <select
                            aria-label={labels[key] || key}
                            value={val}
                            onChange={(e) => {
                              setDirty(true);
                              setNotice("");
                              setDraft({
                                ...draft,
                                config: {
                                  ...draft.config,
                                  [group]: {
                                    ...draft.config[group],
                                    [key]: e.target.value,
                                  },
                                },
                              });
                            }}
                          >
                            {spec.enum.map((v) => (
                              <option key={v} value={v}>
                                {v === "local"
                                  ? "本地小模型（默认）"
                                  : v === "cloud"
                                    ? "在线大模型"
                                    : v}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={
                              spec.type === "number" || spec.type === "integer"
                                ? "number"
                                : "text"
                            }
                            value={val}
                            min={spec.minimum}
                            max={spec.maximum}
                            minLength={spec.minLength}
                            maxLength={spec.maxLength}
                            step={spec.type === "integer" ? "1" : "any"}
                            required={!key.startsWith("cloud_")}
                            onChange={(e) => {
                              setDirty(true);
                              setNotice("");
                              setDraft({
                                ...draft,
                                config: {
                                  ...draft.config,
                                  [group]: {
                                    ...draft.config[group],
                                    [key]:
                                      spec.type === "number" ||
                                      spec.type === "integer"
                                        ? e.target.value === ""
                                          ? ""
                                          : Number(e.target.value)
                                        : e.target.value,
                                  },
                                },
                              });
                            }}
                          />
                        )}
                        {key === "broadcast_llm_provider" && (
                          <small>
                            统一用于演播解读、科普和区域摘要。在线模式使用下方接口与模型，密钥由部署环境管理。访客不能更改模型来源。
                          </small>
                        )}
                        {spec.minimum != null && (
                          <small>
                            {spec.minimum} – {spec.maximum}
                          </small>
                        )}
                      </label>
                    );
                  })}
                </div>
                {group === "system" && (
                  <p className="admin-description">
                    在线 API
                    密钥由部署环境安全配置，不向浏览器返回。在线接口已配置：
                    {config.cloud_llm.configured ? "是" : "否"}
                    。本机演播使用开发板的本地模型解读。
                  </p>
                )}
              </section>
            ))}
          </div>
        </form>
      )}
      <section className="panel admin-section credentials-panel">
        <div className="panel-head">
          <h3>
            <ShieldCheck size={17} />
            后台账号
          </h3>
          <span>更新后撤销所有登录会话</span>
        </div>
        <form
          className="admin-credentials"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const d = new FormData(e.currentTarget);
            if (d.get("password") !== d.get("confirm")) {
              setError("两次新密码不一致");
              setBusy(false);
              return;
            }
            try {
              await api("/auth/credentials", {
                method: "PUT",
                body: JSON.stringify({
                  username: d.get("username"),
                  current_password: d.get("current_password"),
                  password: d.get("password"),
                }),
              });
              setCSRF("");
              window.dispatchEvent(new Event("seismicx-session-expired"));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            用户名
            <input
              name="username"
              autoComplete="username"
              value={username}
              minLength={3}
              maxLength={64}
              pattern="[A-Za-z0-9_.\-]+"
              required
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            当前密码
            <input
              name="current_password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
          </label>
          <label>
            新密码
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="留空保留原密码"
            />
          </label>
          <label>
            确认新密码
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="再次输入新密码"
            />
          </label>
          <button className="primary" disabled={busy}>
            更新账号并重新登录
          </button>
        </form>
      </section>
      <section className="panel admin-section">
        <div className="panel-head">
          <h3>部署与算法版本</h3>
        </div>
        <p className="admin-description">
          {config?.algorithms.picker} → {config?.algorithms.association} →{" "}
          {config?.algorithms.location}
          <br />
          Skill {config?.algorithms.revision.slice(0, 12)} · SeedLink{" "}
          {config?.seedlink}
        </p>
      </section>
      <Jobs jobs={jobs} />
    </>
  );
}
