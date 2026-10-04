import { useAdmin } from "./auth";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  LocateFixed,
  Play,
  Save,
  Trash2,
} from "lucide-react";
import { api, patch, post, time, value } from "./api";
import { Badge, Busy, Field, Modal } from "./ui";
import type { Quake, Pick, Station } from "./types";
import Waveforms from "./Waveforms";
import { DetectionForm } from "./Forms";
export default function EventDetail({
  id,
  onBack,
  onChange,
}: {
  id: string;
  onBack: () => void;
  onChange: () => void;
}) {
  const admin = useAdmin();
  const [event, setEvent] = useState<Quake | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [detect, setDetect] = useState(false),
    [pick, setPick] = useState<Partial<Pick> | null>(null),
    [loading, setLoading] = useState(false);
  const load = () =>
    api<Quake>(`/events/${encodeURIComponent(id)}`)
      .then(setEvent)
      .catch((e) => setError(e.message));
  useEffect(() => {
    setEvent(null);
    load();
  }, [id]);
  if (!event)
    return (
      <>
        <button onClick={onBack}>
          <ArrowLeft size={16} />
          返回
        </button>
        {error ? <p className="error-text">{error}</p> : <Busy />}
      </>
    );
  const stations = event.stations || [];
  return (
    <>
      <div className="detail-heading">
        <button className="icon-button" aria-label="返回目录" onClick={onBack}>
          <ArrowLeft />
        </button>
        <div>
          <h1>{event.place}</h1>
          <p className="mono">
            {event.id} · {time(event.origin_time)} UTC
          </p>
        </div>
        <Badge status={event.status} />
        {admin && (
          <button onClick={() => setDetect(true)}>
            <Play size={15} />
            自动检测
          </button>
        )}
        <button
          onClick={() => {
            load();
            onChange();
          }}
        >
          刷新结果
        </button>
      </div>
      {error && <div className="alert error-text">{error}</div>}
      {notice && <div className="alert">{notice}</div>}
      <div className="review-layout">
        <div className="review-main">
          <Waveforms
            key={event.id}
            event={event}
            stations={
              event.picks?.length
                ? stations.filter((s) =>
                    event.picks?.some((p) => p.station_id === s.id),
                  )
                : stations
            }
            editable={admin}
            onChanged={async () => {
              await load();
              onChange();
            }}
          />
          <section className="panel">
            <div className="panel-head">
              <h3>震相拾取</h3>
              <span className="muted">
                {admin ? "点击一行进行校正 · " : ""}
                {event.picks?.length || 0} 个震相
              </span>
              {admin && (
                <button
                  onClick={() =>
                    setPick({
                      station_id: stations[0]?.id,
                      time: event.origin_time,
                      phase: "Pg",
                    })
                  }
                >
                  添加震相
                </button>
              )}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>台站</th>
                    <th>震相</th>
                    <th>到时 UTC</th>
                    <th>置信度</th>
                    <th>来源</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {event.picks?.map((p) => (
                    <tr key={p.id}>
                      <td className="mono" onClick={() => admin && setPick(p)}>
                        {p.station_id}
                      </td>
                      <td
                        className={p.phase.startsWith("P") ? "teal" : "amber"}
                        onClick={() => admin && setPick(p)}
                      >
                        {p.phase}
                      </td>
                      <td className="mono" onClick={() => admin && setPick(p)}>
                        {time(p.time)}
                      </td>
                      <td>{value(p.score, 2)}</td>
                      <td>
                        <button
                          disabled={!admin}
                          className="text-button"
                          onClick={() => admin && setPick(p)}
                        >
                          {p.method === "manual" ? "人工" : "PNSN"}
                          {admin ? " · 修改" : ""}
                        </button>
                      </td>
                      <td>
                        {admin && (
                          <button
                            className="icon-button"
                            aria-label="删除震相"
                            onClick={async () => {
                              try {
                                await api(
                                  `/picks/${p.id}?version=${p.version}&reason=${encodeURIComponent("人工移除错误震相")}`,
                                  { method: "DELETE" },
                                );
                                await load();
                                onChange();
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!event.picks?.length && (
                <p className="inline-empty">暂无已关联震相。</p>
              )}
            </div>
          </section>
        </div>
        <aside className="location-panel panel">
          <div className="panel-head">
            <h3>
              <LocateFixed size={17} /> 定位结果
            </h3>
            <span className="mono">v{event.version}</span>
          </div>
          <div className="qc-notes">
            {(JSON.parse(event.provenance || "{}").qc || []).map(
              (q: string) => (
                <p key={q}>质量标记：{q}</p>
              ),
            )}
          </div>
          <div className="location-summary">
            <div className="magnitude">
              {value(event.magnitude)}
              <span>{event.magnitude_type || "M"}</span>
            </div>
            <div>
              <span>震源深度</span>
              <b>
                {value(event.depth_km)} <small>km</small>
              </b>
            </div>
          </div>
          <div className="location-metrics">
            <span>
              RMS <b>{value(event.rms, 2)} s</b>
            </span>
            <span>
              方位角空缺 <b>{value(event.azimuth_gap, 0)}°</b>
            </span>
            <span>
              震相数量 <b>{event.n_picks}</b>
            </span>
          </div>
          {!admin && (
            <dl className="public-location">
              <dt>发震时间 UTC</dt>
              <dd>{time(event.origin_time)}</dd>
              <dt>纬度 / 经度</dt>
              <dd>
                {event.latitude.toFixed(3)}° / {event.longitude.toFixed(3)}°
              </dd>
              <dt>结果状态</dt>
              <dd>
                <Badge status={event.status} />
              </dd>
            </dl>
          )}
          {admin && (
            <>
              <form
                key={event.version}
                onSubmit={async (e) => {
                  e.preventDefault();
                  setLoading(true);
                  setError("");
                  const d = new FormData(e.currentTarget);
                  try {
                    await patch(`/events/${encodeURIComponent(event.id)}`, {
                      origin_time: new Date(
                        String(d.get("origin")) + "Z",
                      ).toISOString(),
                      latitude: Number(d.get("lat")),
                      longitude: Number(d.get("lon")),
                      depth_km: Number(d.get("depth")),
                      magnitude: d.get("mag") ? Number(d.get("mag")) : null,
                      magnitude_type: d.get("magtype"),
                      place: event.place,
                      notes: event.notes,
                      monitored: event.monitored,
                      status: d.get("status"),
                      version: event.version,
                      reason: d.get("reason"),
                    });
                    await load();
                    onChange();
                    setNotice("人工校正已保存，原值与修改原因已记录。");
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                <Field label="发震时间 UTC">
                  <input
                    name="origin"
                    type="datetime-local"
                    step=".001"
                    defaultValue={new Date(event.origin_time)
                      .toISOString()
                      .slice(0, -1)}
                    required
                  />
                </Field>
                <div className="form-grid">
                  <Field label="纬度 / °">
                    <input
                      name="lat"
                      type="number"
                      step="any"
                      min="-90"
                      max="90"
                      defaultValue={event.latitude}
                      required
                    />
                  </Field>
                  <Field label="经度 / °">
                    <input
                      name="lon"
                      type="number"
                      step="any"
                      min="-180"
                      max="180"
                      defaultValue={event.longitude}
                      required
                    />
                  </Field>
                  <Field label="深度 / km">
                    <input
                      name="depth"
                      type="number"
                      min="0"
                      max="800"
                      step="any"
                      defaultValue={event.depth_km}
                      required
                    />
                  </Field>
                  <Field label="震级">
                    <input
                      name="mag"
                      type="number"
                      min="-3"
                      max="10"
                      step=".01"
                      defaultValue={event.magnitude ?? ""}
                    />
                  </Field>
                  <Field label="震级类型">
                    <input name="magtype" defaultValue={event.magnitude_type} />
                  </Field>
                  <Field label="复核状态">
                    <select name="status" defaultValue="reviewed">
                      <option value="reviewed">已复核</option>
                      <option value="candidate">待复核</option>
                      <option value="rejected">排除事件</option>
                    </select>
                  </Field>
                </div>
                <Field label="修改原因">
                  <input
                    name="reason"
                    required
                    minLength={2}
                    placeholder="记录校正依据"
                  />
                </Field>
                <button className="primary full" disabled={loading}>
                  <Save size={15} />
                  保存人工校正
                </button>
              </form>
              <div className="relocate">
                <h4>根据震相重新定位</h4>
                <p>使用当前后台定位参数与速度模型，至少 3 个台站。</p>
                <button
                  className="full"
                  disabled={(event.picks?.length || 0) < 4}
                  onClick={async () => {
                    try {
                      await post(
                        `/events/${encodeURIComponent(id)}/relocate`,
                        {},
                      );
                      setNotice("重新定位已排队。任务完成后点击“刷新结果”。");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <LocateFixed size={15} />
                  重新定位
                </button>
              </div>
              <form
                className="relocate"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  try {
                    await post(`/events/${encodeURIComponent(id)}/magnitude`, {
                      region: d.get("region"),
                    });
                    setNotice(
                      "仪器响应标定与 ML 计算已排队；完成后需复核区域曲线与饱和效应。",
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <h4>响应标定 ML</h4>
                <p>
                  使用技能中的 seedtools DD1。自动读取事件时段的仪器响应；区域 R
                  曲线需由使用者核验。
                </p>
                <Field label="区域修正曲线">
                  <select name="region" defaultValue="R13">
                    {["R11", "R12", "R13", "R14", "R15"].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Field>
                <button
                  className="full"
                  disabled={!event.picks?.some((p) => p.phase.startsWith("S"))}
                >
                  计算候选 ML
                </button>
              </form>
            </>
          )}
          <div className="provenance">
            <h4>结果来源</h4>
            <p>
              {event.source} · {event.method}
            </p>
            <p>{event.velocity_model || "外部目录速度模型未提供"}</p>
            {admin && (
              <>
                <h4>修改记录</h4>
                {event.audit?.length ? (
                  event.audit.slice(0, 5).map((a) => (
                    <p key={a.id}>
                      <Check size={12} />
                      {a.reason}
                      <small>{time(a.created_at)}</small>
                    </p>
                  ))
                ) : (
                  <p>暂无人工修改</p>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
      {detect && (
        <DetectionForm
          stations={stations}
          selected={stations
            .filter((s) => (s.distance_km || 0) < 300)
            .slice(0, 8)
            .map((s) => s.id)}
          origin={event.origin_time}
          eventId={id}
          onClose={() => setDetect(false)}
          onSaved={() => setNotice("编目任务已提交，结果将进入候选目录。")}
        />
      )}
      {pick && (
        <Modal
          title={pick.id ? "校正震相到时" : "添加震相"}
          onClose={() => setPick(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              try {
                const body = {
                  station_id: d.get("station"),
                  phase: d.get("phase"),
                  time: new Date(String(d.get("time")) + "Z").toISOString(),
                  reason: d.get("reason"),
                  version: pick.version || 1,
                };
                if (pick.id) await patch(`/picks/${pick.id}`, body);
                else
                  await post(`/events/${encodeURIComponent(id)}/picks`, body);
                setPick(null);
                await load();
                onChange();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Field label="台站">
              <select name="station" defaultValue={pick.station_id}>
                {stations.map((s: Station) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {s.distance_km?.toFixed(1)} km
                  </option>
                ))}
              </select>
            </Field>
            <Field label="震相">
              <select name="phase" defaultValue={pick.phase}>
                {["Pg", "Sg", "Pn", "Sn", "P", "S"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Field label="到时 UTC">
              <input
                name="time"
                type="datetime-local"
                step=".001"
                defaultValue={
                  pick.time
                    ? new Date(pick.time).toISOString().slice(0, -1)
                    : ""
                }
                required
              />
            </Field>
            <Field label="修改依据">
              <input
                name="reason"
                required
                minLength={2}
                defaultValue="人工波形复核"
              />
            </Field>
            <footer>
              <button type="button" onClick={() => setPick(null)}>
                取消
              </button>
              <button className="primary">保存震相</button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
