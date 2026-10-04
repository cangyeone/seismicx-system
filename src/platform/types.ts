export interface Station {
  id: string;
  network: string;
  station: string;
  location: string;
  channel: string;
  latitude: number;
  longitude: number;
  elevation_m: number;
  name: string;
  provider: string;
  enabled: boolean;
  status: string;
  last_sample: string | null;
  latency_s: number | null;
  error: string | null;
  distance_km?: number;
}
export interface Pick {
  id: string;
  event_id: string;
  station_id: string;
  phase: string;
  time: string;
  score: number | null;
  residual_s: number | null;
  method: string;
  version: number;
}
export interface Quake {
  id: string;
  origin_time: string;
  latitude: number;
  longitude: number;
  depth_km: number;
  magnitude: number | null;
  magnitude_type: string;
  place: string;
  source: string;
  status: string;
  rms: number | null;
  n_picks: number;
  azimuth_gap: number | null;
  method: string;
  velocity_model: string;
  version: number;
  monitored: boolean;
  notes: string;
  provenance: string;
  picks?: Pick[];
  stations?: Station[];
  audit?: { id: number; reason: string; created_at: string }[];
  alternate_reports?: Quake[];
}
export interface Overview {
  platform_name: string;
  stations: number;
  enabled: number;
  online: number;
  events_24h: number;
  candidates: number;
  latency_s: number | null;
  sources: Record<
    string,
    { ok: boolean; error?: string; fetched_at: string } | null
  >;
  collector: Record<string, unknown> | null;
  worker: { heartbeat: string } | null;
  time: string;
}
export interface Job {
  id: string;
  kind: string;
  status: string;
  progress: string;
  error: string | null;
  result: string | null;
  created_at: string;
  payload: string;
}
export interface Wave {
  station_id: string;
  source: string;
  traces: {
    id: string;
    start: string;
    sample_rate: number;
    sample_stride?: number;
    npts: number;
    units: string;
    points: [number, number | null, number | null][];
  }[];
}
export interface Stats {
  count: number;
  days: number;
  magnitude_min: number | null;
  magnitude_max: number | null;
  reviewed: number;
  candidates: number;
  missing_magnitude: number;
  high_rms: number;
  daily: { date: string; count: number }[];
  magnitude_histogram: { magnitude: number; count: number }[];
  sources: Record<string, number>;
  caveats: string[];
}
export interface Analysis {
  statistics: Stats;
  mode: string;
  text: string;
  model: string | null;
  total_budget?: number;
  truncated?: boolean;
}
