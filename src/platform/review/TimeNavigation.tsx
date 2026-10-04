import { useEffect, useRef, type RefObject } from "react";
import { zoomWindow, panWindow, type TimeWindow } from "./waveMath";
export function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const matrix = svg.getScreenCTM();
  return matrix
    ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
    : { x: 0, y: 0 };
}
export function useWheelZoom(
  svg: RefObject<SVGSVGElement | null>,
  view: TimeWindow,
  bounds: TimeWindow,
  setView: (v: TimeWindow) => void,
  left: number,
  right: number,
  enabled: boolean,
) {
  const latest = useRef({ view, bounds, setView });
  latest.current = { view, bounds, setView };
  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      const point = svgPoint(node, e.clientX, e.clientY);
      if (point.x < left || point.x > right) return;
      e.preventDefault();
      const p = latest.current,
        delta =
          e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1);
      const next = zoomWindow(
        p.view,
        Math.exp(Math.max(-240, Math.min(240, delta)) * 0.003),
        (point.x - left) / (right - left),
        p.bounds,
      );
      latest.current.view = next;
      p.setView(next);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [svg, left, right, enabled]);
}
export default function TimeNavigation({
  view,
  bounds,
  onChange,
}: {
  view: TimeWindow;
  bounds: TimeWindow;
  onChange: (v: TimeWindow) => void;
}) {
  const span = view.end - view.start;
  return (
    <div className="wave-time-navigation">
      <button
        aria-label="放大波形时间轴"
        onClick={() => onChange(zoomWindow(view, 0.5, 0.5, bounds))}
      >
        ＋
      </button>
      <button
        aria-label="缩小波形时间轴"
        onClick={() => onChange(zoomWindow(view, 2, 0.5, bounds))}
      >
        −
      </button>
      <button onClick={() => onChange(bounds)}>重置视图</button>
      <input
        aria-label="波形时间滚动条"
        type="range"
        min={bounds.start}
        max={Math.max(bounds.start, bounds.end - span)}
        step=".001"
        value={view.start}
        disabled={span >= bounds.end - bounds.start}
        onChange={(e) => onChange(panWindow(view, +e.target.value, bounds))}
      />
      <output>
        {view.start.toFixed(2)}–{view.end.toFixed(2)} s ·{" "}
        {((bounds.end - bounds.start) / span).toFixed(1)}×
      </output>
    </div>
  );
}
