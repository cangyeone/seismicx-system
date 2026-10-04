import { List } from "lucide-react";
import type { BroadcastController } from "../broadcastState";
import { time, value } from "../api";
export default function EventListCard({
  controller: b,
}: {
  controller: BroadcastController;
}) {
  return (
    <>
      <div className="broadcast-card-title">
        <List size={19} />
        <h3>地震列表</h3>
        <small>{b.playlist.length} 个事件</small>
      </div>
      <p className="broadcast-list-status" role="status">
        {b.connectionError
          ? "目录连接中断 · 保留上次列表"
          : `实时更新 · ${time(b.feed?.time).slice(11)} UTC`}
      </p>
      <div className="broadcast-event-list" aria-label="最近地震列表">
        {b.playlist.map((e) => {
          const active =
            e.id === b.event?.id ||
            e.alternate_reports?.some((r) => r.id === b.event?.id);
          return (
            <button
              key={e.id}
              className={active ? "is-current" : ""}
              aria-current={active ? "true" : undefined}
              onClick={() => b.select(e)}
              title={`${e.place} · ${time(e.origin_time)} UTC`}
            >
              <span className="broadcast-list-mag">
                {e.magnitude_type || "M"} <b>{value(e.magnitude)}</b>
              </span>
              <span className="broadcast-list-detail">
                <strong>{e.place}</strong>
                <small>
                  <time dateTime={e.origin_time}>
                    {time(e.origin_time)} UTC
                  </time>
                  <span>
                    {e.source}
                    {e.status === "candidate" ? " · 待复核" : ""}
                  </span>
                </small>
              </span>
            </button>
          );
        })}
        {!b.playlist.length && <p>当前筛选没有事件</p>}
      </div>
    </>
  );
}
