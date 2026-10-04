import type { CameraMode } from "../broadcastState";

export interface MapCamera {
  longitude: number;
  latitude: number;
  range: number;
  heading: number;
  pitch: number;
}
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

// Range is slant distance in metres; the target is the surface epicenter, not the focus.
export function cameraPose(
  mode: CameraMode,
  longitude: number,
  latitude: number,
  fraction: number,
  fixed: MapCamera,
  animated: boolean,
): MapCamera {
  if (mode === "region") return fixed;
  if (mode === "global")
    return {
      longitude: fixed.longitude,
      latitude: fixed.latitude,
      range: 22000000,
      heading: 0,
      pitch: -90,
    };
  const t = Math.max(0, Math.min(1, fraction));
  const close = animated
    ? smooth((t - 0.08) / 0.3) * (1 - smooth((t - 0.78) / 0.22))
    : 0.65;
  return {
    longitude,
    latitude,
    range: Math.exp(
      Math.log(19000000) * (1 - close) + Math.log(100000) * close,
    ),
    heading: animated ? 24 * Math.sin(t * Math.PI * 2) * close : 0,
    pitch: -90 + close * 42,
  };
}
