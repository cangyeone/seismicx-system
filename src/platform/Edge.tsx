import { useEffect, useState } from "react";
import { Cpu, Activity, Radio, Layers } from "lucide-react";
import { api, time, value } from "./api";
interface EdgeState {
  platform_name: string;
  enabled: boolean;
  backend: string;
  max_stations: number;
  interval_seconds: number;
  window_seconds: number;
  disk_free_gb: number;
  edge?: {
    processed_stations: number;
    input_lag_median_seconds?: number;
    input_lag_p95_seconds?: number;
    stale_stations?: number;
    max_input_lag_seconds?: number;
    online_seen: number;
    subscribed: number;
    picks: number;
    cycle_seconds: number;
    lagging: boolean;
    heartbeat: string;
    window_start: string;
    window_end: string;
    error?: string;
    errors?: { station: string; error: string }[];
    association_jobs: number;
  };
  npu?: {
    batch_size: number;
    batches: number;
    inference_seconds: number;
    backend: string;
    stations: number;
    heartbeat: string;
  };
  llm?: { busy: boolean; model: string };
  benchmark?: { median_seconds: number; max_abs_error: number };
  recent_picks: {
    id: string;
    station_id: string;
    phase: string;
    time: string;
    score: number;
  }[];
}
export default function EdgePage() {
  const [state, setState] = useState<EdgeState | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () =>
      api<EdgeState>("/edge/status")
        .then((x) => {
          if (active) {
            setState(x);
            setError("");
          }
        })
        .catch((e) => active && setError(e.message));
    load();
    const timer = setInterval(load, 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const edge = state?.edge,
    npu = state?.npu;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>边缘推理</h1>
          <p>BM1684X · 连续三分量处理 · 区域关联与定位</p>
        </div>
        <span className="badge reviewed">{state?.backend || "加载中"}</span>
      </div>
      {error && <div className="alert error-text">{error}</div>}
      {!state?.enabled && (
        <div className="alert">
          此部署尚未启用 NPU 连续处理；CPU 编目仍可使用。
        </div>
      )}
      <div className="metrics">
        <div>
          <span>
            <Radio size={15} /> 本周期有效台站
          </span>
          <b>
            {edge?.processed_stations ?? "—"}
            <small>/ {edge?.subscribed ?? 0} 订阅</small>
          </b>
        </div>
        <div>
          <span>
            <Cpu size={15} /> NPU 计算时间
          </span>
          <b>
            {value(npu?.inference_seconds, 3)}
            <small>s</small>
          </b>
        </div>
        <div>
          <span>
            <Layers size={15} /> 批量 / 批次
          </span>
          <b>
            {npu?.batch_size ?? 8}
            <small>/ {npu?.batches ?? 0}</small>
          </b>
        </div>
        <div>
          <span>
            <Activity size={15} /> 全流程耗时
          </span>
          <b>
            {value(edge?.cycle_seconds, 1)}
            <small>/ {state?.interval_seconds ?? 60} s</small>
          </b>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>连续处理状态</h3>
          </div>
          <dl>
            <dt>最新周期 UTC</dt>
            <dd>{time(edge?.heartbeat)}</dd>
            <dt>输入时间窗</dt>
            <dd>{state?.window_seconds} 秒，重叠处理</dd>
            <dt>原始震相 / 关联任务</dt>
            <dd>
              {edge?.picks ?? 0} / {edge?.association_jobs ?? 0}
            </dd>
            <dt>采样延迟 中位 / P95</dt>
            <dd>{value(edge?.input_lag_median_seconds, 1)} / {value(edge?.input_lag_p95_seconds, 1)} 秒</dd>
            <dt>超时或无采样</dt>
            <dd>{edge?.stale_stations ?? 0} 台 · 阈值 {edge?.max_input_lag_seconds ?? 180} 秒</dd>
            <dt>计算进度</dt>
            <dd>
              {edge?.lagging
                ? "处理积压，请减小订阅规模"
                : edge
                  ? "本周期计算已完成"
                  : "等待连续数据"}
            </dd>
            <dt>本地 2B 模型</dt>
            <dd>
              {state?.llm?.busy
                ? "分析中 · 震相推理等待 NPU"
                : "可用 · 按需调用"}
            </dd>
            <dt>剩余磁盘</dt>
            <dd>{state?.disk_free_gb} GB</dd>
          </dl>
          {edge?.error && <p className="error-text">{edge.error}</p>}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>算法与容量</h3>
          </div>
          <dl>
            <dt>震相模型</dt>
            <dd>PNSN v3 · FP16 · Pg / Sg / Pn / Sn</dd>
            <dt>每批输入</dt>
            <dd>8 × 3 × 10,240 · 100 Hz</dd>
            <dt>当前配置容量</dt>
            <dd>{state?.max_stations} 台（受数据完整性影响）</dd>
            <dt>计算基准</dt>
            <dd>
              {state?.benchmark
                ? `${(state.benchmark.median_seconds * 1000).toFixed(2)} ms / 批`
                : "尚未载入实测记录"}
            </dd>
            <dt>精度对照</dt>
            <dd>
              {state?.benchmark
                ? `最大概率差 ${state.benchmark.max_abs_error.toFixed(6)}`
                : "以实测为准"}
            </dd>
          </dl>
          <p className="inline-empty">
            原始震相不是已定位地震。区域多台关联通过后才进入候选目录。计算基准不等于整机台站容量。
          </p>
        </section>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h3>实时震相</h3>
          <span className="muted">跨窗口去重 · 最近50条 · 待关联</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>台站</th>
                <th>震相</th>
                <th>到时 UTC</th>
                <th>置信度</th>
                <th>推理</th>
              </tr>
            </thead>
            <tbody>
              {state?.recent_picks.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.station_id}</td>
                  <td className={p.phase.startsWith("P") ? "teal" : "amber"}>
                    {p.phase}
                  </td>
                  <td className="mono">{time(p.time)}</td>
                  <td>{p.score.toFixed(3)}</td>
                  <td>BM1684X</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state?.recent_picks.length && (
            <p className="inline-empty">等待完整三分量波形与模型检测结果。</p>
          )}
        </div>
      </section>
      {!!edge?.errors?.length && (
        <details className="panel errors">
          <summary>
            {edge.errors.length} 个台站在本周期尚未满足连续处理条件
          </summary>
          {edge.errors.map((x) => (
            <p key={x.station}>
              {x.station}：{x.error}
            </p>
          ))}
        </details>
      )}
    </>
  );
}
