import { useEffect, useState } from "react";
import type { Wave } from "../types";
import type { TimeWindow } from "./waveMath";
import { api } from "../api";
export function useWaveData(
  ids: string[],
  originMs: number,
  view: TimeWindow,
  enabled: boolean,
  points = 1600,
  revision = 0,
) {
  const [waves, setWaves] = useState<Wave[]>([]),
    [busy, setBusy] = useState(false),
    [errors, setErrors] = useState<string[]>([]);
  const key = ids.join("\n");
  useEffect(() => {
    if (!enabled || !key) return;
    const controller = new AbortController();
    setBusy(true);
    setErrors([]);
    const timer = setTimeout(async () => {
      const data: Wave[] = [],
        issues: string[] = [],
        selected = key.split("\n");
      const params = new URLSearchParams({
        start: new Date(originMs + view.start * 1000).toISOString(),
        end: new Date(originMs + view.end * 1000).toISOString(),
        points: String(points),
      });
      for (
        let i = 0;
        i < selected.length && !controller.signal.aborted;
        i += 2
      ) {
        await Promise.all(
          selected.slice(i, i + 2).map(async (id) => {
            try {
              data.push(
                await api<Wave>(
                  `/waveforms/${encodeURIComponent(id)}?${params}`,
                  { signal: controller.signal },
                ),
              );
            } catch (e) {
              if (!controller.signal.aborted)
                issues.push(`${id}: ${(e as Error).message}`);
            }
          }),
        );
      }
      if (!controller.signal.aborted) {
        setWaves(data);
        setErrors(issues);
        setBusy(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, originMs, view.start, view.end, enabled, points, revision]);
  return { waves, busy, errors };
}
