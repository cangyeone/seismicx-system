import { useState } from "react";
import { Field, Modal } from "./ui";
import { post } from "./api";
import type { Station } from "./types";
export function EventForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="录入历史地震" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const d = new FormData(e.currentTarget);
          try {
            await post("/events", {
              origin_time: new Date(String(d.get("time")) + "Z").toISOString(),
              place: d.get("place"),
              latitude: Number(d.get("lat")),
              longitude: Number(d.get("lon")),
              depth_km: Number(d.get("depth")),
              magnitude: d.get("mag") ? Number(d.get("mag")) : null,
              magnitude_type: d.get("magtype"),
              notes: d.get("notes"),
              monitored: true,
            });
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          使用 UTC 时间。录入后可下载历史波形、检测震相并人工复核。
        </p>
        <div className="form-grid">
          <Field label="发震时间 UTC">
            <input
              name="time"
              type="datetime-local"
              step=".001"
              required
              defaultValue="2019-07-06T03:19:53"
            />
          </Field>
          <Field label="地震地点">
            <input
              name="place"
              required
              placeholder="如：Ridgecrest, California"
            />
          </Field>
          <Field label="纬度 / °">
            <input
              name="lat"
              type="number"
              step="any"
              min="-90"
              max="90"
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
              required
            />
          </Field>
          <Field label="深度 / km">
            <input
              name="depth"
              type="number"
              step="any"
              min="0"
              max="800"
              required
            />
          </Field>
          <Field label="震级（可留空）">
            <input name="mag" type="number" step=".1" min="-3" max="10" />
          </Field>
          <Field label="震级类型">
            <select name="magtype">
              <option>ML</option>
              <option>Mw</option>
              <option>mb</option>
              <option>Ms</option>
            </select>
          </Field>
          <Field label="备注">
            <input name="notes" />
          </Field>
        </div>
        {error && <p className="error-text">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在保存…" : "创建历史监测事件"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function StationForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <Modal title="接入台站" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          try {
            await post("/stations", {
              network: d.get("network"),
              station: d.get("station"),
              location: d.get("location"),
              channel: d.get("channel"),
              latitude: Number(d.get("lat")),
              longitude: Number(d.get("lon")),
              elevation_m: Number(d.get("elevation")),
              provider: d.get("provider"),
              name: d.get("name"),
              enabled: true,
            });
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <div className="form-grid">
          {[
            ["network", "台网", "CI"],
            ["station", "台站", "CLC"],
            ["location", "位置码（可空）", ""],
            ["channel", "通道选择器", "HH?"],
            ["name", "台站名称", ""],
          ].map(([name, label, placeholder]) => (
            <Field key={name} label={label}>
              <input
                name={name}
                defaultValue={placeholder}
                required={!["location", "name"].includes(name)}
              />
            </Field>
          ))}
          <Field label="数据源">
            <select name="provider">
              <option>EARTHSCOPE</option>
              <option>SCEDC</option>
              <option>GEOFON</option>
              <option>BGR</option>
              <option>INGV</option>
              <option>INFP</option>
            </select>
          </Field>
          <Field label="纬度">
            <input
              name="lat"
              type="number"
              step="any"
              min="-90"
              max="90"
              required
            />
          </Field>
          <Field label="经度">
            <input
              name="lon"
              type="number"
              step="any"
              min="-180"
              max="180"
              required
            />
          </Field>
          <Field label="高程 / m">
            <input name="elevation" type="number" defaultValue="0" />
          </Field>
        </div>
        {error && <p className="error-text">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary">保存并订阅</button>
        </footer>
      </form>
    </Modal>
  );
}
export function DetectionForm({
  stations,
  selected = [],
  eventId,
  origin,
  onClose,
  onSaved,
}: {
  stations: Station[];
  selected?: string[];
  eventId?: string;
  origin?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = origin
    ? new Date(new Date(origin).getTime() - 20000)
    : new Date(Date.now() - 600000);
  const [ids, setIds] = useState(selected),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState("");
  return (
    <Modal title="创建自动编目任务" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const d = new FormData(e.currentTarget);
          try {
            await post("/jobs/detect", {
              start: new Date(String(d.get("start")) + "Z").toISOString(),
              end: new Date(String(d.get("end")) + "Z").toISOString(),
              station_ids: ids,
              event_id: eventId,
              ...(d.get("vp") ? { vp: Number(d.get("vp")) } : {}),
              ...(d.get("vs") ? { vs: Number(d.get("vs")) } : {}),
              ...(d.get("score") ? { min_score: Number(d.get("score")) } : {}),
              ...(d.get("velocity")
                ? { velocity_name: d.get("velocity") }
                : {}),
            });
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="note">
          PNSN v3 → Python REAL → 网格定位。请选择跨度 ≤2000 km 的区域台网，至少
          3
          台；输出为待复核候选事件。以下算法参数留空时使用后台配置；单次置信度下限只会进一步提高筛选门槛。
        </p>
        <div className="form-grid">
          <Field label="开始时间 UTC">
            <input
              name="start"
              type="datetime-local"
              step="1"
              required
              defaultValue={initial.toISOString().slice(0, 19)}
            />
          </Field>
          <Field label="结束时间 UTC（单批 ≤30 分钟）">
            <input
              name="end"
              type="datetime-local"
              step="1"
              required
              defaultValue={new Date(initial.getTime() + 300000)
                .toISOString()
                .slice(0, 19)}
            />
          </Field>
          <Field label="Vp / km·s⁻¹">
            <input
              name="vp"
              type="number"
              step=".1"
              min="3"
              max="9"
              placeholder="使用后台配置"
            />
          </Field>
          <Field label="Vs / km·s⁻¹">
            <input
              name="vs"
              type="number"
              step=".1"
              min="1.5"
              max="5"
              placeholder="使用后台配置"
            />
          </Field>
          <Field label="速度模型名称">
            <input name="velocity" placeholder="使用后台配置" />
          </Field>
          <Field label="关联置信度下限">
            <input
              name="score"
              type="number"
              step=".05"
              min=".1"
              max="1"
              placeholder="使用后台 P / S 阈值"
            />
          </Field>
        </div>
        <div className="select-header">
          <b>选择台站 · {ids.length} / 32</b>
          <input
            placeholder="筛选台网 / 台站"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="station-select">
          {stations
            .filter((s) =>
              (s.id + s.name).toLowerCase().includes(search.toLowerCase()),
            )
            .map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(s.id)}
                  disabled={!ids.includes(s.id) && ids.length >= 32}
                  onChange={(e) =>
                    setIds(
                      e.target.checked
                        ? [...ids, s.id]
                        : ids.filter((i) => i !== s.id),
                    )
                  }
                />
                <span className="mono">{s.id}</span>
                <small>
                  {s.provider} · {s.latitude.toFixed(2)},{" "}
                  {s.longitude.toFixed(2)}
                </small>
              </label>
            ))}
        </div>
        {error && <p className="error-text">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !ids.length}>
            {busy ? "提交中…" : "运行自动编目"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
