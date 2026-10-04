import { memo, useEffect, useRef, useState } from "react";
import {
  geoDistance,
  geoGraticule10,
  geoOrthographic,
  geoMercator,
  geoPath,
  interpolateNumber,
} from "d3";
import type { FeatureCollection } from "geojson";
import type { Quake, Station } from "../types";
import type { TourSettings } from "../broadcastState";
let geography: Promise<[FeatureCollection, FeatureCollection]> | undefined;
function loadGeography() {
  if (!geography)
    geography = Promise.all(
      ["/world.geojson", "/plates.geojson"].map((url) =>
        fetch(url).then((r) => {
          if (!r.ok) throw new Error("地图数据不可用");
          return r.json();
        }),
      ),
    ).catch((error) => {
      geography = undefined;
      throw error;
    }) as Promise<[FeatureCollection, FeatureCollection]>;
  return geography;
}
export default memo(function Globe({
  event,
  events,
  stations,
  moving,
  settings,
  flat = false,
  inset = false,
}: {
  event: Quake | null;
  events: Quake[];
  stations: Station[];
  moving: boolean;
  settings: TourSettings;
  flat?: boolean;
  inset?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<
    [FeatureCollection, FeatureCollection] | null
  >(null);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const state = useRef({ event, events, stations, moving, settings });
  if (
    state.current.event !== event ||
    state.current.events !== events ||
    state.current.stations !== stations ||
    state.current.moving !== moving ||
    state.current.settings !== settings
  )
    revision.current++;
  state.current = { event, events, stations, moving, settings };
  useEffect(() => {
    let mounted = true;
    loadGeography()
      .then((d) => {
        if (mounted) setData(d);
      })
      .catch((e) => {
        if (mounted) setError(e.message);
      });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    const canvas = ref.current,
      ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !data) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let width = 1200,
      height = 800,
      frame = 0,
      last = 0,
      phase = 0,
      flight = 1,
      lastId = "",
      lastRevision = -1,
      onScreen = true;
    let center = [110, 18],
      from = center,
      target = center,
      zoom = 0.95;
    const resize = () => {
      revision.current++;
      const box = canvas.getBoundingClientRect();
      width = box.width;
      height = box.height;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      revision.current++;
    });
    visibility.observe(canvas);
    resize();
    const projection = flat ? geoMercator() : geoOrthographic(),
      path = geoPath(projection, ctx),
      grid = geoGraticule10();
    const draw = (stamp: number) => {
      frame = requestAnimationFrame(draw);
      if (
        !onScreen ||
        !width ||
        !height ||
        document.hidden ||
        stamp - last < (inset ? 100 : 40)
      )
        return; // 25 fps is ample for camera motion.
      const dt = Math.min((stamp - last) / 1000, 0.1);
      last = stamp;
      const {
        event: quake,
        events: quakes,
        stations: sites,
        moving: animate,
        settings: options,
      } = state.current;
      const motion = animate && !reduce.matches;
      if (!motion && lastRevision === revision.current) return;
      lastRevision = revision.current;
      if (quake && quake.id !== lastId) {
        lastId = quake.id;
        from = [...center];
        // Shortest longitude arc avoids a full spin across the date line.
        const delta = ((quake.longitude - center[0] + 540) % 360) - 180;
        target = [
          center[0] + delta,
          Math.max(-72, Math.min(72, quake.latitude)),
        ];
        flight = inset ? 1 : 0;
        phase = 0;
      }
      if (motion) {
        phase += dt;
        flight = Math.min(1, flight + dt / 3.6);
      } else if (reduce.matches || (!animate && lastId && flight === 0))
        flight = 1;
      const ease = flight * flight * (3 - 2 * flight);
      center = [
        interpolateNumber(from[0], target[0])(ease),
        interpolateNumber(from[1], target[1])(ease),
      ];
      if (!inset && options.camera !== "epicenter")
        center = [options.regionLongitude, options.regionLatitude];
      const cycle = (phase % options.duration) / options.duration;
      zoom = inset
        ? 1.7
        : options.camera === "global"
          ? 0.96
          : options.camera === "region"
            ? Math.max(1, Math.min(5, 6000 / options.regionRange))
            : 1 + (motion ? Math.sin(cycle * Math.PI) ** 2 * 0.8 : 0.12);
      const cx = width < 650 ? width * 0.52 : width * 0.48,
        cy = height * 0.45;
      const radius = Math.min(width * 0.46, height * 0.52) * zoom;
      projection
        .translate([cx, cy])
        .scale(
          flat
            ? Math.min(width / (2 * Math.PI), height / (2 * Math.PI)) * zoom
            : radius,
        )
        .rotate(flat ? [-center[0], 0, 0] : [-center[0], -center[1], -8])
        .center(
          flat
            ? [0, options.camera === "global" && !inset ? 0 : center[1]]
            : [0, 0],
        )
        .clipAngle(flat ? null : 90)
        .clipExtent([
          [0, 0],
          [width, height],
        ]);
      ctx.clearRect(0, 0, width, height);
      const aura = ctx.createRadialGradient(
        cx,
        cy,
        radius * 0.93,
        cx,
        cy,
        radius * 1.16,
      );
      aura.addColorStop(0, "rgba(54,191,227,.22)");
      aura.addColorStop(0.4, "rgba(28,105,160,.12)");
      aura.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, width, height);
      const ocean = ctx.createRadialGradient(
        cx - radius * 0.45,
        cy - radius * 0.6,
        radius * 0.05,
        cx,
        cy,
        radius * 1.1,
      );
      ocean.addColorStop(0, "#123849");
      ocean.addColorStop(0.5, "#0b202f");
      ocean.addColorStop(1, "#06111d");
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.fillStyle = ocean;
      ctx.fill();
      ctx.strokeStyle = "#477b96";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      path(grid);
      ctx.strokeStyle = "rgba(93,170,191,.14)";
      ctx.lineWidth = 0.65;
      ctx.stroke();
      for (const feature of data[0].features) {
        ctx.beginPath();
        path(feature);
        ctx.fillStyle = "#204959";
        ctx.fill();
        ctx.strokeStyle = "rgba(108,209,209,.65)";
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      ctx.beginPath();
      path(data[1]);
      ctx.strokeStyle = "rgba(239,156,95,.48)";
      ctx.lineWidth = 0.85;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Physical globe shading stays separate from the illustrative epicenter pulse.
      const shadow = ctx.createRadialGradient(
        cx - radius * 0.35,
        cy - radius * 0.35,
        radius * 0.1,
        cx,
        cy,
        radius * 1.02,
      );
      shadow.addColorStop(0, "rgba(0,0,0,0)");
      shadow.addColorStop(0.55, "rgba(0,5,15,.05)");
      shadow.addColorStop(1, "rgba(0,4,14,.75)");
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.fillStyle = shadow;
      if (!flat) ctx.fill();
      const visible = (lon: number, lat: number) =>
        flat || geoDistance([center[0], center[1]], [lon, lat]) < Math.PI / 2;
      for (const station of sites) {
        if (!visible(station.longitude, station.latitude)) continue;
        const p = projection([station.longitude, station.latitude]);
        if (!p) continue;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - 2.7);
        ctx.lineTo(p[0] + 2.6, p[1] + 2);
        ctx.lineTo(p[0] - 2.6, p[1] + 2);
        ctx.closePath();
        ctx.fillStyle = station.status === "online" ? "#59e7d2" : "#547d89";
        ctx.fill();
      }
      for (const q of quakes) {
        if (!visible(q.longitude, q.latitude) || q.id === quake?.id) continue;
        const p = projection([q.longitude, q.latitude]);
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(
          p[0],
          p[1],
          Math.max(3, Math.min(5.5, (q.magnitude || 2) * 0.8)),
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = "rgba(255,190,111,.92)";
        ctx.fill();
        ctx.strokeStyle = "#211814";
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
      if (quake && visible(quake.longitude, quake.latitude)) {
        const p = projection([quake.longitude, quake.latitude]);
        if (p) {
          for (let ring = 0; ring < 4; ring++) {
            const fraction = ((motion ? phase / 3 : 0.3) + ring / 4) % 1;
            ctx.beginPath();
            ctx.arc(p[0], p[1], 8 + fraction * 72, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255,189,105,${(1 - fraction) * 0.7})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
          ctx.shadowColor = "#ffbd69";
          ctx.shadowBlur = 25;
          ctx.beginPath();
          ctx.arc(p[0], p[1], 5.5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffe3a3";
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = "rgba(255,222,172,.7)";
          ctx.beginPath();
          ctx.moveTo(p[0] - 16, p[1]);
          ctx.lineTo(p[0] - 10, p[1]);
          ctx.moveTo(p[0] + 10, p[1]);
          ctx.lineTo(p[0] + 16, p[1]);
          ctx.stroke();
        }
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
    };
  }, [data, flat, inset]);
  return (
    <>
      <canvas
        ref={ref}
        className="broadcast-globe"
        data-ready={!!data}
        data-event-count={events.filter((e) => e.id !== event?.id).length}
        data-station-count={stations.length}
        role="img"
        aria-label={`全球台站、板块边界与地震分布${event ? `，当前震中 ${event.place}` : ""}`}
      />
      {error && (
        <div className="broadcast-map-error">{error}，目录信息仍可查看</div>
      )}
    </>
  );
});
