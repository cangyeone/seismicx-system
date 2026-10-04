import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import { GripHorizontal, MoveDiagonal2 } from "lucide-react";
import {
  CARD_LAYOUT_KEY,
  clampCard,
  readCard,
  type CardId,
  type CardRect,
} from "./cardLayout";
export default function FloatingCard({
  id,
  label,
  className = "",
  locked,
  reset,
  children,
}: {
  id: CardId;
  label: string;
  className?: string;
  locked: boolean;
  reset: number;
  children: ReactNode;
}) {
  const node = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const saved = useRef<CardRect | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    rect: CardRect;
    width: number;
    height: number;
    resize: boolean;
  } | null>(null);
  const raf = useRef(0);
  const apply = (r: CardRect) => {
    const el = node.current;
    if (!el) return;
    saved.current = r;
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
  };
  const persist = () => {
    if (!saved.current) return;
    try {
      const all = JSON.parse(localStorage.getItem(CARD_LAYOUT_KEY) || "{}");
      localStorage.setItem(
        CARD_LAYOUT_KEY,
        JSON.stringify({ ...all, [id]: saved.current }),
      );
    } catch {
      /* Ephemeral layout still works. */
    }
  };
  useEffect(() => {
    const el = node.current,
      stage = el?.closest<HTMLElement>(".broadcast-stage");
    if (!el || !stage) return;
    let raw = null;
    try {
      raw = localStorage.getItem(CARD_LAYOUT_KEY);
    } catch {
      /* private mode */
    }
    saved.current = readCard(raw, id);
    const resize = () => {
      const desktop =
        stage.clientWidth > 700 &&
        stage.clientHeight > 600 &&
        matchMedia("(min-width:1101px)").matches;
      setWide(desktop);
      if (desktop)
        apply(clampCard(saved.current!, stage.clientWidth, stage.clientHeight));
      else {
        el.style.left = "";
        el.style.top = "";
        el.style.width = "";
        el.style.height = "";
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf.current);
      drag.current = null;
    };
  }, [id, reset]);
  const begin = (e: PointerEvent<HTMLButtonElement>, resize: boolean) => {
    if (!wide || locked || e.button !== 0) return;
    const stage = node.current?.closest<HTMLElement>(".broadcast-stage");
    if (!stage || !saved.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      rect: { ...saved.current },
      width: stage.clientWidth,
      height: stage.clientHeight,
      resize,
    };
    node.current!.classList.add("is-adjusting");
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / d.width,
      dy = (e.clientY - d.y) / d.height;
    const rect = clampCard(
      d.resize
        ? { ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy }
        : { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy },
      d.width,
      d.height,
    );
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => apply(rect));
  };
  const end = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    // Flush the final pointer position before persisting, even when released between frames.
    const d = drag.current;
    cancelAnimationFrame(raf.current);
    const dx = (e.clientX - d.x) / d.width,
      dy = (e.clientY - d.y) / d.height;
    apply(
      clampCard(
        d.resize
          ? { ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy }
          : { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy },
        d.width,
        d.height,
      ),
    );
    drag.current = null;
    node.current?.classList.remove("is-adjusting");
    persist();
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, resize: boolean) => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) ||
      !saved.current ||
      locked
    )
      return;
    e.preventDefault();
    const stage = node.current!.closest<HTMLElement>(".broadcast-stage")!;
    const dx =
      (e.key === "ArrowLeft" ? -10 : e.key === "ArrowRight" ? 10 : 0) /
      stage.clientWidth;
    const dy =
      (e.key === "ArrowUp" ? -10 : e.key === "ArrowDown" ? 10 : 0) /
      stage.clientHeight;
    const r = saved.current;
    apply(
      clampCard(
        resize
          ? { ...r, w: r.w + dx, h: r.h + dy }
          : { ...r, x: r.x + dx, y: r.y + dy },
        stage.clientWidth,
        stage.clientHeight,
      ),
    );
    persist();
  };
  return (
    <section
      ref={node}
      className={`broadcast-card floating-card ${className} ${wide ? "is-floating" : "is-adaptive"}`}
      data-card={id}
      aria-label={label}
    >
      {children && <div className="floating-card-content">{children}</div>}
      {wide && !locked && (
        <>
          <button
            className="card-drag-handle"
            aria-label={`移动${label}`}
            title="拖动位置；方向键微调"
            onPointerDown={(e) => begin(e, false)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={() => {
              cancelAnimationFrame(raf.current);
              if (drag.current) apply(drag.current.rect);
              drag.current = null;
              node.current?.classList.remove("is-adjusting");
            }}
            onKeyDown={(e) => key(e, false)}
          >
            <GripHorizontal size={18} />
          </button>
          <button
            className="card-resize-handle"
            aria-label={`缩放${label}`}
            title="拖动调整宽高；方向键微调"
            onPointerDown={(e) => begin(e, true)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={() => {
              cancelAnimationFrame(raf.current);
              if (drag.current) apply(drag.current.rect);
              drag.current = null;
              node.current?.classList.remove("is-adjusting");
            }}
            onKeyDown={(e) => key(e, true)}
          >
            <MoveDiagonal2 size={16} />
          </button>
        </>
      )}
    </section>
  );
}
