import { useAdmin } from "./auth";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
const MarkdownReport = lazy(() => import("./MarkdownReport"));
import { Sparkles, BarChart3, ArrowRight } from "lucide-react";
import { api, value } from "./api";
import type { Analysis as AnalysisResult } from "./types";
interface ReportStatus {
  status: string;
  message?: string;
  report?: AnalysisResult;
  generated_at?: string;
}
export default function AnalysisPage() {
  const admin = useAdmin();
  const [result, setResult] = useState<AnalysisResult | null>(null),
    [days, setDays] = useState(7),
    [source, setSource] = useState("all"),
    [question, setQuestion] = useState(
      "分析当前目录的质量、震级分布与地震活动性变化。",
    ),
    [provider, setProvider] = useState("local"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState("");
  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResult(null);
    setError("");
    setBusy(false);
    setProgress("");
    void api<AnalysisResult>("/analysis", {
      method: "POST",
      body: JSON.stringify({ days, source, use_llm: false }),
      signal: controller.signal,
    })
      .then((r) => {
        if (!controller.signal.aborted) setResult(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [days, source]);
  const run = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setProgress("正在提交本地模型分析任务…");
    try {
      if (
        admin &&
        (provider === "cloud" ||
          question !== "分析当前目录的质量、震级分布与地震活动性变化。")
      ) {
        setProgress(
          provider === "cloud"
            ? "在线模型正在生成报告…"
            : "本地小模型分析中，等待 NPU 任务完成…",
        );
        const result = await api<AnalysisResult>("/analysis", {
          method: "POST",
          body: JSON.stringify({
            days,
            source,
            question,
            use_llm: true,
            provider,
          }),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setResult(result);
      } else {
        const path = `/analysis/report?days=${days}&source=${encodeURIComponent(source)}`;
        const started = Date.now();
        let prepare: boolean = true;
        while (!controller.signal.aborted) {
          const result: ReportStatus = await api<ReportStatus>(path, {
            method: prepare ? "POST" : "GET",
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (result.status === "ready" && result.report) {
            setResult(result.report);
            break;
          }
          if (result.status === "failed") throw new Error(result.message);
          if (Date.now() - started > 240000)
            throw new Error("模型任务仍在处理中，稍后再次点击可读取结果。");
          setProgress(result.message || "等待本地模型分析报告…");
          prepare = result.status === "idle" || result.status === "deferred";
          await new Promise<void>((resolve) => {
            const stop = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener("abort", stop);
              resolve();
            }, 1500);
            controller.signal.addEventListener("abort", stop, { once: true });
          });
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setProgress("");
      }
    }
  };
  const stats = result?.statistics;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>地震活动性分析</h1>
          <p>以目录统计为依据，结合小模型进行辅助解读</p>
        </div>
        <select
          aria-label="分析时间范围"
          value={days}
          onChange={(e) => setDays(+e.target.value)}
        >
          <option value={1}>过去 24 小时</option>
          <option value={7}>过去 7 天</option>
          <option value={30}>过去 30 天</option>
          <option value={3650}>过去 10 年</option>
        </select>
        <select
          aria-label="分析目录来源"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="all">全部来源</option>
          <option value="USGS">USGS</option>
          <option value="CENC">中国地震台网</option>
          <option value="SeismicX">本系统检测</option>
          <option value="manual">人工目录</option>
        </select>
      </div>
      <div className="metrics">
        <div>
          <span>目录事件</span>
          <b>
            {stats?.count ?? "—"}
            <small>个</small>
          </b>
        </div>
        <div>
          <span>最大震级</span>
          <b>
            {value(stats?.magnitude_max)}
            <small>M</small>
          </b>
        </div>
        <div>
          <span>已复核 / 候选</span>
          <b>
            {stats?.reviewed ?? 0}
            <small>/ {stats?.candidates ?? 0}</small>
          </b>
        </div>
        <div>
          <span>缺失震级</span>
          <b>
            {stats?.missing_magnitude ?? 0}
            <small>个</small>
          </b>
        </div>
      </div>
      <div className="analysis-charts">
        <section className="panel">
          <div className="panel-head">
            <h3>
              <BarChart3 size={17} /> 每日事件数
            </h3>
            <span>UTC</span>
          </div>
          <div className="bar-chart">
            {stats?.daily.slice(-30).map((d, i, all) => (
              <div key={d.date} title={`${d.date}: ${d.count}`}>
                <b>{d.count || ""}</b>
                <span
                  style={{
                    height: `${Math.max(2, (d.count / Math.max(1, ...all.map((x) => x.count))) * 160)}px`,
                  }}
                />
                <small>
                  {i % Math.max(1, Math.floor(all.length / 7)) === 0
                    ? d.date.slice(5)
                    : ""}
                </small>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>震级分布</h3>
            <span>分箱 ΔM = 0.5</span>
          </div>
          <div className="bar-chart amber-bars">
            {stats?.magnitude_histogram.map((d, _, all) => (
              <div key={d.magnitude}>
                <b>{d.count}</b>
                <span
                  style={{
                    height: `${Math.max(2, (d.count / Math.max(1, ...all.map((x) => x.count))) * 160)}px`,
                  }}
                />
                <small>{d.magnitude.toFixed(1)}</small>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="panel analysis-assistant">
        <div className="panel-head">
          <h3>
            <Sparkles size={18} /> 目录分析助手
          </h3>
          <span className="muted">
            仅传输统计摘要 · 总预算 &lt; 8000 tokens
          </span>
        </div>
        <div className="assistant-body">
          <div>
            {admin ? (
              <>
                <textarea
                  aria-label="分析问题"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={1000}
                  disabled={busy}
                />
                <div className="assistant-options">
                  <select
                    aria-label="分析模型来源"
                    disabled={busy}
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                  >
                    <option value="local">本地小模型 / 开发板 2B</option>
                    <option value="cloud">在线大模型</option>
                  </select>
                </div>
              </>
            ) : (
              <p className="note">
                点击下方按钮，使用本地小模型分析当前时间范围和目录来源。报告在右侧显示；相同范围五分钟内复用报告。
              </p>
            )}
            <button
              className="primary analysis-run"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy
                ? "分析中…"
                : provider === "cloud" && admin
                  ? "开始在线分析"
                  : "开始本地分析"}
              <ArrowRight size={15} />
            </button>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
          </div>
          <div
            className="analysis-text"
            aria-label="目录分析报告"
            aria-busy={busy}
          >
            <span className="teal">
              {result?.mode === "llm" ? result.model : "统计分析"}
            </span>
            {busy && (
              <p role="status" className="analysis-progress">
                {progress}
              </p>
            )}
            <Suspense fallback={<p>正在准备报告…</p>}>
              <MarkdownReport
                text={result?.text || "选择数据范围并开始分析。"}
              />
            </Suspense>
            {result?.total_budget && (
              <small>输入上限 + 输出预算：{result.total_budget} tokens</small>
            )}
            {result?.truncated && (
              <p role="status" className="analysis-progress">
                报告达到输出上限，内容可能未完整。
              </p>
            )}
          </div>
        </div>
        <div className="analysis-caveats">
          {result?.mode === "llm" && (
            <p>
              模型文字仅供辅助解读；数量、单位和结论应与上方统计核对，2B
              模型仍可能出现推理错误。
            </p>
          )}
          {stats?.caveats.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </div>
      </section>
    </>
  );
}
