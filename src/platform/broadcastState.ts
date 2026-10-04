import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Quake } from "./types";
import {
  filterEvents,
  matchesEvent,
  mergeNotices,
} from "./broadcast/liveEvents";

export type DisplayMode = "map" | "fixed" | "tour";
export type CameraMode = "epicenter" | "region" | "global";
export type MapRenderer = "detail" | "simple" | "flat";
export type MapSurface = "satellite" | "relief";
export type Bulletin = Quake & { seq: number; received_at: string };
export interface BroadcastFeed {
  events: Quake[];
  notices: Bulletin[];
  cursor: number;
  time: string;
  poll_seconds: number;
  sources: Record<
    string,
    {
      ok: boolean;
      fetched_at?: string;
      attempted_at?: string;
      error?: string;
    } | null
  >;
}
export interface TourSettings {
  duration: number;
  minMagnitude: number;
  source: string;
  sound: boolean;
  showAI: boolean;
  showGeology: boolean;
  showScience: boolean;
  layoutLocked: boolean;
  renderer: MapRenderer;
  showWaves: boolean;
  showStations: boolean;
  showEvents: boolean;
  motion: boolean;
  candidates: boolean;
  camera: CameraMode;
  surface: MapSurface;
  regionLatitude: number;
  regionLongitude: number;
  regionRange: number;
}
const defaults: TourSettings = {
  duration: 40,
  minMagnitude: 2,
  source: "all",
  sound: false,
  showAI: true,
  showGeology: true,
  showScience: true,
  layoutLocked: false,
  renderer: "simple",
  showWaves: true,
  showStations: true,
  showEvents: true,
  motion: true,
  candidates: false,
  camera: "epicenter",
  surface: "satellite",
  regionLatitude: 35,
  regionLongitude: 105,
  regionRange: 3500,
};
function readSettings(): TourSettings {
  try {
    const raw = JSON.parse(
      localStorage.getItem("seismicx-tour-settings") || "{}",
    );
    return {
      ...defaults,
      ...Object.fromEntries(
        Object.keys(defaults)
          .filter(
            (k) => typeof raw[k] === typeof defaults[k as keyof TourSettings],
          )
          .map((k) => [k, raw[k]]),
      ),
      duration: Math.max(20, Math.min(120, Number(raw.duration) || 40)),
      minMagnitude: Math.max(
        -2,
        Math.min(
          8,
          raw.minMagnitude === undefined ? 2 : Number(raw.minMagnitude) || 0,
        ),
      ),
      source: ["all", "USGS", "CENC", "SeismicX"].includes(raw.source)
        ? raw.source
        : "all",
      camera: ["epicenter", "region", "global"].includes(raw.camera)
        ? raw.camera
        : "epicenter",
      renderer: ["detail", "simple", "flat"].includes(raw.renderer)
        ? raw.renderer
        : "simple",
      surface: raw.surface === "relief" ? "relief" : "satellite",
      regionLatitude: Number.isFinite(raw.regionLatitude)
        ? Math.max(-85, Math.min(85, raw.regionLatitude))
        : 35,
      regionLongitude: Number.isFinite(raw.regionLongitude)
        ? Math.max(-180, Math.min(180, raw.regionLongitude))
        : 105,
      regionRange: Number.isFinite(raw.regionRange)
        ? Math.max(25, Math.min(20000, raw.regionRange))
        : 3500,
    };
  } catch {
    return defaults;
  }
}
function initialMode(): DisplayMode {
  if (location.pathname === "/admin") return "fixed";
  if (new URLSearchParams(location.search).get("view") === "broadcast")
    return "tour";
  const saved = localStorage.getItem("seismicx-display-mode");
  return saved === "fixed" || saved === "tour" ? saved : "map";
}
export function useBroadcast(locked: boolean) {
  const [feed, setFeed] = useState<BroadcastFeed | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [settings, setSettings] = useState<TourSettings>(readSettings);
  const [mode, setModeState] = useState<DisplayMode>(initialMode);
  const [paused, setPaused] = useState(false);
  const [currentId, setCurrentId] = useState("");
  const [activeNotice, setActiveNotice] = useState<Bulletin | null>(null);
  const [notice, setNotice] = useState<Bulletin | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pending = useRef<Bulletin[]>([]);
  const cursor = useRef<number | null>(null);
  const currentRef = useRef("");
  const settingsRef = useRef(settings);
  const playlistRef = useRef<Quake[]>([]);
  const lastTick = useRef(performance.now());
  const progress = useRef(0);
  settingsRef.current = settings;
  const playlist = useMemo(
    () => filterEvents(feed?.events || [], settings),
    [feed?.events, settings.minMagnitude, settings.source, settings.candidates],
  );
  playlistRef.current = playlist;
  const event =
    playlist.find((e) => e.id === currentId) ||
    (activeNotice?.id === currentId && matchesEvent(activeNotice, settings)
      ? activeNotice
      : null);
  const select = useCallback((e: Quake, bulletin: Bulletin | null = null) => {
    if (bulletin)
      pending.current = pending.current.filter(
        (item) => item.id !== bulletin.id,
      );
    currentRef.current = e.id;
    setCurrentId(e.id);
    setActiveNotice(bulletin);
    progress.current = 0;
    setElapsed(0);
    lastTick.current = performance.now();
  }, []);
  const next = useCallback(
    (direction = 1) => {
      const urgent = direction > 0 ? pending.current.shift() : null;
      if (urgent) {
        select(urgent, urgent);
        return;
      }
      const list = playlistRef.current;
      if (!list.length) return;
      const at = list.findIndex((e) => e.id === currentRef.current);
      select(list[(at + direction + list.length) % list.length]);
    },
    [select],
  );
  const setMode = useCallback((value: DisplayMode) => {
    setModeState(value);
    setPaused(false);
    localStorage.setItem("seismicx-display-mode", value);
    progress.current = 0;
    setElapsed(0);
    if (value !== "tour" && document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
  }, []);
  useEffect(() => {
    localStorage.setItem("seismicx-tour-settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (
      playlist.length &&
      !playlist.some((e) => e.id === currentRef.current) &&
      (!activeNotice || !matchesEvent(activeNotice, settings))
    )
      select(playlist[0]);
    pending.current = pending.current.filter(
      (e) =>
        (e.magnitude ?? -2) >= settings.minMagnitude &&
        (settings.source === "all" || e.source === settings.source) &&
        (settings.candidates || e.status !== "candidate"),
    );
  }, [
    playlist,
    activeNotice,
    settings.minMagnitude,
    settings.source,
    settings.candidates,
    select,
  ]);
  useEffect(() => {
    if (locked) {
      cursor.current = null;
      return;
    }
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const result = await api<BroadcastFeed>(
          `/broadcast/feed${cursor.current === null ? "" : `?after=${cursor.current}`}`,
          { signal: controller.signal },
        );
        if (stopped) return;
        cursor.current = result.cursor;
        setFeed(result);
        setConnectionError("");
        const options = settingsRef.current;
        const fresh = mergeNotices([], result.notices, options);
        if (fresh.length) {
          pending.current = mergeNotices(pending.current, fresh, options);
          setNotice(fresh[0]);
          if (options.sound && "speechSynthesis" in window) {
            const e = fresh[0];
            const utterance = new SpeechSynthesisUtterance(
              `收到${e.source === "CENC" ? "中国地震台网" : e.source}速报。${e.place}，震级${e.magnitude ?? "待定"}，深度${e.depth_km}千米。${e.status === "candidate" ? "候选事件，尚未复核。" : "请以官方发布为准。"}`,
            );
            utterance.lang = "zh-CN";
            utterance.rate = 0.92;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
          }
        }
      } catch (error) {
        if (!stopped) setConnectionError((error as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [locked]);
  useEffect(() => {
    if (mode === "tour" && !paused && pending.current.length) next();
  }, [notice, mode, paused, next]);
  useEffect(() => {
    lastTick.current = performance.now();
    if (mode !== "tour" || paused || !event) return;
    const timer = setInterval(() => {
      const now = performance.now();
      progress.current += Math.min(2, (now - lastTick.current) / 1000);
      lastTick.current = now;
      if (progress.current >= settings.duration) next();
      else setElapsed(progress.current);
    }, 250);
    return () => clearInterval(timer);
  }, [mode, paused, settings.duration, !!event, next]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 30000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    let wasFullscreen = !!document.fullscreenElement;
    const fullscreenChange = () => {
      const active = !!document.fullscreenElement;
      if (wasFullscreen && !active && mode === "tour") setMode("fixed");
      wasFullscreen = active;
    };
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode === "tour") setMode("fixed");
    };
    window.addEventListener("keydown", handle);
    document.addEventListener("fullscreenchange", fullscreenChange);
    document.body.classList.toggle(
      "broadcast-immersive",
      mode === "tour" && !locked,
    );
    return () => {
      window.removeEventListener("keydown", handle);
      document.removeEventListener("fullscreenchange", fullscreenChange);
      document.body.classList.remove("broadcast-immersive");
    };
  }, [mode, locked, setMode]);
  return {
    feed,
    connectionError,
    settings,
    setSettings,
    mode,
    setMode,
    paused,
    setPaused,
    event,
    playlist,
    select,
    next,
    activeNotice,
    notice,
    dismissNotice: () => setNotice(null),
    elapsed,
  };
}
export type BroadcastController = ReturnType<typeof useBroadcast>;
