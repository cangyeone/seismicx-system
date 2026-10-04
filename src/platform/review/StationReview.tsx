import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Quake, Pick, Station } from "../types";
import { api, post, patch } from "../api";
import { Modal } from "../ui";
import {
  PHASES,
  clampWindow,
  tracePath,
  sampleTime,
  type Phase,
  type TimeWindow,
} from "./waveMath";
import { useWaveData } from "./useWaveData";
import TimeNavigation, { useWheelZoom, svgPoint } from "./TimeNavigation";
interface Draft {
  id?: string;
  version?: number;
  time: string;
  phase: Phase;
}
export default function StationReview({
  event,
  station,
  bounds,
  initialTime,
  editable,
  onChanged,
  onClose,
}: {
  event: Quake;
  station: Station;
  bounds: TimeWindow;
  initialTime: number;
  editable: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const originMs = Date.parse(event.origin_time);
  const [view, setView] = useState(() =>
    clampWindow({ start: initialTime - 10, end: initialTime + 10 }, bounds),
  );
  const [phase, setPhase] = useState<Phase>("Pg"),
    [draft, setDraft] = useState<Draft | null>(null),
    [gain, setGain] = useState(1),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reason, setReason] = useState("人工波形复核");
  const svg = useRef<SVGSVGElement>(null),
    dragging = useRef(false),
    suppressClick = useRef(false),
    clip = useId();
  const { waves, busy, errors } = useWaveData(
    [station.id],
    originMs,
    view,
    true,
    6000,
  );
  useWheelZoom(svg, view, bounds, setView, 90, 970, !!waves.length);
  const picks = (event.picks || []).filter((p) => p.station_id === station.id);
  const choosePhase = (next: Phase) => {
    setPhase(next);
    setDraft((d) => (d ? { ...d, phase: next } : d));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.ctrlKey &&
        /^(Digit|Numpad)[1-6]$/.test(e.code) &&
        editable &&
        !saving
      ) {
        e.preventDefault();
        choosePhase(PHASES[Number(e.code.slice(-1)) - 1]);
      }
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        if (draft) setDraft(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [draft, editable, saving, onClose]);
  const x = (t: string) =>
    90 +
    (((Date.parse(t) - originMs) / 1000 - view.start) /
      (view.end - view.start)) *
      880;
  const traces = useMemo(
    () =>
      ["Z", "N", "E"].map(
        (component) =>
          waves[0]?.traces.find((t) => t.id.endsWith(component)) ||
          waves[0]?.traces.find((t) =>
            t.id.endsWith(
              component === "N" ? "1" : component === "E" ? "2" : component,
            ),
          ),
      ),
    [waves],
  );
  const paths = useMemo(
    () =>
      traces.map((t, i) =>
        t ? tracePath(t, originMs, view, 90, 880, 95 + i * 120, 45 * gain) : "",
      ),
    [traces, originMs, view, gain],
  );
  const pointerTime = (clientX: number, clientY: number) => {
    const p = svgPoint(svg.current!, clientX, clientY);
    let t =
      view.start +
      Math.max(0, Math.min(1, (p.x - 90) / 880)) * (view.end - view.start);
    const row = Math.max(0, Math.min(2, Math.floor((p.y - 35) / 120))),
      trace = traces[row] || traces.find(Boolean);
    if (trace) t = sampleTime(t, trace, originMs);
    t = Math.max(bounds.start, Math.min(bounds.end, t));
    return new Date(originMs + t * 1000).toISOString();
  };
  const select = (p: Pick) => {
    setDraft({
      id: p.id,
      version: p.version,
      time: p.time,
      phase: p.phase as Phase,
    });
    setPhase(p.phase as Phase);
    setError("");
    setNotice("");
  };
  const save = async (remove = false) => {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (reason.trim().length < 2)
        throw new Error("请填写至少两个字的修改依据");
      if (remove && draft.id)
        await api(
          `/picks/${draft.id}?version=${draft.version}&reason=${encodeURIComponent(reason)}`,
          { method: "DELETE" },
        );
      else {
        const body = {
          station_id: station.id,
          phase: draft.phase,
          time: draft.time,
          version: draft.version || 1,
          reason,
        };
        if (draft.id) await patch(`/picks/${draft.id}`, body);
        else await post(`/events/${encodeURIComponent(event.id)}/picks`, body);
      }
      await onChanged();
      setDraft(null);
      setNotice(
        remove
          ? "震相已删除，事件已返回待复核状态。"
          : "震相已保存，事件已返回待复核状态。",
      );
    } catch (e) {
      setError((e as Error).message);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };
  const selected = picks.find((p) => p.id === draft?.id);
  const dirty =
    !!draft &&
    (!selected ||
      selected.time !== draft.time ||
      selected.phase !== draft.phase);
  return (
    <Modal
      title={`${editable ? "台站震相标注" : "台站波形"} · ${station.id}`}
      onClose={() => !saving && onClose()}
      className="station-review-modal"
    >
      <div className="station-review-body">
        <div className="station-review-toolbar">
          <span>{station.distance_km?.toFixed(1)} km · 三分量 · counts</span>
          <label>
            增益{" "}
            <input
              aria-label="单台波形增益"
              type="range"
              min=".3"
              max="5"
              step=".1"
              value={gain}
              onChange={(e) => setGain(+e.target.value)}
            />
          </label>
          <span role="status">
            {busy
              ? "正在读取当前视窗的真实采样…"
              : traces.some((t) => t?.sample_stride === 1)
                ? "已显示原始采样点"
                : "已显示最小/最大值包络 · 放大可读取细节"}
          </span>
        </div>
        {editable && (
          <div className="phase-selector" aria-label="震相类型">
            {PHASES.map((p, i) => (
              <button
                key={p}
                aria-pressed={phase === p}
                disabled={saving}
                onClick={() => choosePhase(p)}
              >
                {p} <small>Ctrl+{i + 1}</small>
              </button>
            ))}
          </div>
        )}
        <p className="review-hint">
          滚轮以鼠标位置缩放，底部滚动条平移时间。
          {editable &&
            "点击波形放置标注，拖动已有震相线调整到时；修改后点击“保存震相”。"}
        </p>
        <div className="station-wave-chart">
          <svg
            ref={svg}
            viewBox="0 0 1000 450"
            preserveAspectRatio="none"
            aria-label="单台三分量波形"
            data-start={view.start}
            data-end={view.end}
            onClick={(e) => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              const p = svgPoint(e.currentTarget, e.clientX, e.clientY);
              if (
                editable &&
                !saving &&
                traces.some(Boolean) &&
                p.x >= 90 &&
                p.x <= 970 &&
                p.y >= 35 &&
                p.y <= 400
              ) {
                setDraft({ time: pointerTime(e.clientX, e.clientY), phase });
                setError("");
                setNotice("");
              }
            }}
            onPointerMove={(e) => {
              if (dragging.current)
                setDraft(
                  (d) => d && { ...d, time: pointerTime(e.clientX, e.clientY) },
                );
            }}
            onPointerUp={(e) => {
              if (dragging.current) {
                dragging.current = false;
                suppressClick.current = true;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }
            }}
            onPointerCancel={() => {
              dragging.current = false;
              suppressClick.current = false;
            }}
          >
            <defs>
              <clipPath id={clip}>
                <rect x="90" y="35" width="880" height="365" />
              </clipPath>
            </defs>
            {Array.from({ length: 7 }, (_, i) => (
              <g key={i}>
                <line
                  x1={90 + (i * 880) / 6}
                  x2={90 + (i * 880) / 6}
                  y1="35"
                  y2="400"
                  className="chart-grid"
                />
                <text
                  x={90 + (i * 880) / 6}
                  y="425"
                  textAnchor="middle"
                  className="axis-label"
                >
                  {(view.start + (i * (view.end - view.start)) / 6).toFixed(2)}{" "}
                  s
                </text>
              </g>
            ))}
            {traces.map((t, i) => (
              <g key={i}>
                <text x="15" y={95 + i * 120} className="trace-label">
                  {["Z", "N", "E"][i]}
                </text>
                <text x="15" y={114 + i * 120} className="axis-label">
                  {t ? `${t.sample_rate} Hz` : "无数据"}
                </text>
                <line
                  x1="90"
                  x2="970"
                  y1={95 + i * 120}
                  y2={95 + i * 120}
                  className="chart-grid"
                />
                {t && (
                  <path
                    clipPath={`url(#${clip})`}
                    className="wave-path"
                    d={paths[i]}
                  />
                )}
              </g>
            ))}
            {[
              ...picks.filter((p) => p.id !== draft?.id),
              ...(draft ? [{ ...draft, id: draft.id || "draft" }] : []),
            ]
              .filter((p) => x(p.time) >= 90 && x(p.time) <= 970)
              .map((p) => (
                <g
                  key={p.id}
                  data-pick-id={p.id}
                  className={`review-pick ${p.id === (draft?.id || "draft") ? "is-selected" : ""}`}
                  role={editable ? "button" : undefined}
                  tabIndex={editable ? 0 : undefined}
                  aria-label={`${p.phase} ${p.time}`}
                  onKeyDown={(e) => {
                    if (
                      editable &&
                      !saving &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      const found = picks.find((q) => q.id === p.id);
                      if (found) select(found);
                    }
                  }}
                  onPointerDown={(e) => {
                    if (!editable || saving || e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const found = picks.find((q) => q.id === p.id);
                    if (found && found.id !== draft?.id) select(found);
                    dragging.current = true;
                    svg.current!.setPointerCapture(e.pointerId);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    suppressClick.current = false;
                  }}
                >
                  <rect
                    x={x(p.time) - 7}
                    y="15"
                    width="14"
                    height="385"
                    fill="transparent"
                  />
                  <line
                    x1={x(p.time)}
                    x2={x(p.time)}
                    y1="35"
                    y2="400"
                    className={p.phase.startsWith("P") ? "pick-p" : "pick-s"}
                  />
                  <text x={x(p.time) + 4} y="26" className="pick-label">
                    {p.phase}
                    {p.id === (draft?.id || "draft") && dirty ? " *" : ""}
                  </text>
                </g>
              ))}
          </svg>
        </div>
        <TimeNavigation view={view} bounds={bounds} onChange={setView} />
        <div className="review-station-picks">
          {picks.map((p) => (
            <button
              key={p.id}
              disabled={!editable || saving}
              aria-pressed={draft?.id === p.id}
              onClick={() => select(p)}
            >
              {p.phase} · {p.time.slice(11, 23)}
            </button>
          ))}
        </div>
        {editable && (
          <div className="pick-editor">
            <label>
              到时 UTC{" "}
              <input
                aria-label="标注到时 UTC"
                type="datetime-local"
                step=".001"
                disabled={!draft || saving}
                value={
                  draft ? new Date(draft.time).toISOString().slice(0, -1) : ""
                }
                onChange={(e) => {
                  const ms = Date.parse(e.target.value + "Z");
                  if (Number.isFinite(ms))
                    setDraft(
                      (d) => d && { ...d, time: new Date(ms).toISOString() },
                    );
                }}
              />
            </label>
            <label>
              修改依据{" "}
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={saving}
              />
            </label>
            <button
              className="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存震相"}
            </button>
            <button
              disabled={!draft?.id || saving}
              onClick={() => void save(true)}
            >
              删除所选震相
            </button>
            <button disabled={!draft || saving} onClick={() => setDraft(null)}>
              取消修改
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="teal">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {!!errors.length && (
          <p role="alert" className="error-text">
            {errors.join("；")}
          </p>
        )}
      </div>
    </Modal>
  );
}
