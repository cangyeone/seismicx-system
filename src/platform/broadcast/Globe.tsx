import { useEffect, useRef, useState, useMemo } from "react";
import type { Quake, Station } from "../types";
import type { TourSettings } from "../broadcastState";
import type { GlobeEngine, MapReadiness } from "./globeEngine";
import { cameraPose } from "./mapCamera";
import type { MapCamera } from "./mapCamera";
import CanvasGlobe from "./CanvasGlobe";
interface Props {
  event: Quake | null;
  events: Quake[];
  stations: Station[];
  moving: boolean;
  settings: TourSettings;
  elapsed: number;
  inset?: boolean;
}
export default function MapScene(input: Props) {
  const stations = useMemo(
    () =>
      input.settings.showStations && !input.inset
        ? input.stations.filter((s) => s.enabled)
        : [],
    [input.stations, input.settings.showStations, input.inset],
  );
  const props = { ...input, stations };
  if (props.settings.renderer === "detail") return <DetailedGlobe {...props} />;
  return (
    <div
      className={
        props.inset
          ? "broadcast-terrain-scene"
          : "broadcast-globe broadcast-globe-3d"
      }
      data-renderer={props.settings.renderer}
    >
      <CanvasGlobe {...props} flat={props.settings.renderer === "flat"} />
      {!props.inset && <div className="broadcast-vignette" />}
      {!props.inset && (
        <div className="broadcast-map-status">
          {props.settings.renderer === "flat"
            ? "轻量平面地图"
            : "简洁地球 · 球面投影"}{" "}
          · Natural Earth / USGS
        </div>
      )}
    </div>
  );
}
function DetailedGlobe(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    credits = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const current = useRef({ ...props, received: performance.now() });
  const received =
    props.elapsed !== current.current.elapsed ||
    props.event?.id !== current.current.event?.id
      ? performance.now()
      : current.current.received;
  current.current = { ...props, received };
  const engine = useRef<GlobeEngine | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<MapReadiness>({
    terrainLevel: -1,
    terrainError: false,
    imageryReady: false,
    imageryError: false,
    refining: true,
  });
  const [loaded, setLoaded] = useState(false);
  const inset = !!props.inset;
  useEffect(() => {
    if (!host.current || !credits.current) return;
    setFailed(false);
    setLoaded(false);
    let stopped = false,
      visible = true,
      raf = 0,
      last = 0;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
    });
    observer.observe(host.current);
    void import("./globeEngine")
      .then(({ GlobeEngine }) => {
        if (stopped) return;
        try {
          const scene = new GlobeEngine(
            host.current!,
            credits.current!,
            inset,
            (s) => {
              if (!stopped)
                setState((previous) =>
                  JSON.stringify(previous) === JSON.stringify(s) ? previous : s,
                );
            },
            marker.current!,
          );
          engine.current = scene;
          setLoaded(true);
          let lastCamera: MapCamera | undefined,
            lastCameraKey = "";
          const tick = (now: number) => {
            if (stopped) return;
            raf = requestAnimationFrame(tick);
            if (!visible || document.hidden || now - last < (inset ? 100 : 40))
              return;
            last = now;
            const p = current.current,
              moving = p.moving && !reduced.matches;
            const fraction =
              (p.elapsed + (moving ? (now - p.received) / 1000 : 0)) /
              p.settings.duration;
            const event = p.event;
            let pose = inset
              ? {
                  longitude: event?.longitude || 0,
                  latitude: event?.latitude || 0,
                  range: 80000,
                  heading:
                    p.settings.motion && !reduced.matches
                      ? -18 + Math.sin(fraction * Math.PI * 2) * 18
                      : -18,
                  pitch: -42,
                }
              : cameraPose(
                  p.settings.camera,
                  event?.longitude ?? 105,
                  event?.latitude ?? 30,
                  fraction,
                  {
                    longitude: p.settings.regionLongitude,
                    latitude: p.settings.regionLatitude,
                    range: p.settings.regionRange * 1000,
                    heading: 0,
                    pitch: -55,
                  },
                  p.settings.motion && !reduced.matches,
                );
            if (
              !inset &&
              host.current!.clientWidth < 540 &&
              pose.range > 12000000
            )
              pose.range *= 0.7;
            const cameraKey = [
              event?.id,
              event?.latitude,
              event?.longitude,
              p.settings.camera,
              p.settings.regionLatitude,
              p.settings.regionLongitude,
              p.settings.regionRange,
              p.settings.motion,
              host.current!.clientWidth,
              host.current!.clientHeight,
            ].join(":");
            if (!moving && cameraKey === lastCameraKey && lastCamera)
              pose = lastCamera;
            try {
              scene.setSurface(inset ? "relief" : p.settings.surface);
              scene.setData(event, p.events, p.stations);
              const actual = scene.camera(
                pose,
                !inset && moving && p.settings.camera === "epicenter",
              );
              lastCamera = actual;
              lastCameraKey = cameraKey;
              scene.frame(now, moving);
              if (host.current) {
                host.current.dataset.rangeKm = (pose.range / 1000).toFixed(1);
                host.current.dataset.center = `${actual.latitude.toFixed(3)},${actual.longitude.toFixed(3)}`;
              }
            } catch {
              cancelAnimationFrame(raf);
              scene.destroy();
              engine.current = null;
              setFailed(true);
            }
          };
          raf = requestAnimationFrame(tick);
        } catch {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      engine.current?.destroy();
      engine.current = null;
    };
  }, [inset, attempt]);
  const label = failed
    ? "当前设备无法启用三维渲染"
    : state.terrainError
      ? state.terrainLevel < 0
        ? "地形源暂不可用 · 椭球底图"
        : "部分地形暂缺 · 保留已有精度"
      : state.imageryError
        ? "底图连接受限 · 部分区域暂缺"
        : !state.imageryReady
          ? "正在加载开放底图"
          : state.terrainLevel < 0
            ? "正在加载真实高程"
            : state.refining
              ? "正在细化地形与影像…"
              : "真实三维地形 · 高程 ×2";
  return (
    <div
      className={
        inset ? "broadcast-terrain-scene" : "broadcast-globe broadcast-globe-3d"
      }
      data-renderer={failed ? "fallback" : loaded ? "cesium" : "loading"}
      data-terrain-level={state.terrainLevel}
      data-imagery-ready={state.imageryReady}
      data-tiles-loaded={
        !state.refining && state.imageryReady && state.terrainLevel >= 0
      }
    >
      <div
        ref={host}
        className="broadcast-cesium"
        aria-label={inset ? "震中当地三维地形" : "三维地球与震中位置"}
      />
      {failed && !inset && (
        <CanvasGlobe
          event={props.event}
          events={props.events}
          stations={props.stations}
          moving={props.moving}
          settings={props.settings}
        />
      )}
      {!inset && <div className="broadcast-vignette" />}
      <div ref={credits} className="broadcast-engine-credits" />
      <div
        ref={marker}
        className={`broadcast-epicenter ${props.moving ? "" : "is-paused"}`}
        aria-hidden="true"
      >
        <i className="broadcast-epicenter-glow" />
        <i className="broadcast-epicenter-ring" />
        <i className="broadcast-epicenter-ring second" />
        <i className="broadcast-epicenter-dot" />
        <span>
          {inset
            ? "震中"
            : `震中 · ${props.event?.magnitude_type || "M"} ${props.event?.magnitude?.toFixed(1) ?? "—"}`}
        </span>
      </div>
      <div className="broadcast-map-status" role="status">
        <i className={state.terrainLevel >= 0 && !failed ? "ready" : ""} />
        {label}
        {failed && (
          <button onClick={() => setAttempt((n) => n + 1)}>重试三维</button>
        )}
      </div>
      {inset && (
        <div className="broadcast-terrain-caption">
          震中周边 · 开放 DEM / NASA 地形晕渲
        </div>
      )}
    </div>
  );
}
