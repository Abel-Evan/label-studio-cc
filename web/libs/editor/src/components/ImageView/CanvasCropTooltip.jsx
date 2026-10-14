import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The hover source lives in the Konva tree (RectRegion) while the tooltip must render in the
// DOM tree, so bridge them with a single-listener pub/sub instead of threading React state
// through the react-konva / react-dom reconciler boundary.
let hoverListener = null;

export function setCanvasHover(payload) {
  hoverListener?.(payload);
}

export function onCanvasHover(fn) {
  hoverListener = fn;
  return () => {
    if (hoverListener === fn) hoverListener = null;
  };
}

const CANVAS_BBOX_RE = /画布位置:\s*\[\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*\]/;
const CANVAS_PATH_RE = /画布图片:\s*(\S+)/;

function parseCanvasInfo(region) {
  const result = region?.results?.find((r) => r.from_name?.name === "canvas");
  const lines = result?.mainValue ?? result?.value?.text;

  if (!Array.isArray(lines)) return null;
  const text = lines.join("\n");
  const bbox = text.match(CANVAS_BBOX_RE);
  const path = text.match(CANVAS_PATH_RE);

  if (!bbox || !path) return null;
  const nums = bbox.slice(1, 5).map(Number);

  if (nums.some((n) => Number.isNaN(n))) return null;
  return { bbox: nums, path: path[1] };
}

const cardStyle = {
  position: "fixed",
  pointerEvents: "none",
  zIndex: 1000,
  background: "#fff",
  border: "1px solid #ccc",
  borderRadius: 4,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
  padding: 4,
};

const CanvasCropTooltip = ({ region, x, y }) => {
  const info = useMemo(() => parseCanvasInfo(region), [region]);
  const canvasRef = useRef(null);
  const cropRef = useRef(null);
  const [size, setSize] = useState(null);

  useEffect(() => {
    if (!info) {
      setSize(null);
      return undefined;
    }
    let cancelled = false;
    const img = new Image();

    img.onload = () => {
      if (cancelled) return;
      const [nx, ny, nw, nh] = info.bbox;
      const sx = Math.max(0, Math.round(nx * img.naturalWidth));
      const sy = Math.max(0, Math.round(ny * img.naturalHeight));
      const sw = Math.max(1, Math.round(nw * img.naturalWidth));
      const sh = Math.max(1, Math.round(nh * img.naturalHeight));

      cropRef.current = { img, sx, sy, sw, sh };
      setSize({ sw, sh });
    };
    img.onerror = () => {
      if (!cancelled) setSize(null);
    };
    img.src = `/api/canvas-image/?path=${encodeURIComponent(info.path)}`;

    return () => {
      cancelled = true;
    };
  }, [info]);

  useEffect(() => {
    const crop = cropRef.current;
    const canvas = canvasRef.current;

    if (!size || !crop || !canvas) return;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, size.sw, size.sh);
    ctx.drawImage(crop.img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size.sw, size.sh);
  }, [size]);

  if (!info || !size) return null;

  return (
    <div style={{ ...cardStyle, left: x + 12, top: y + 12 }}>
      <canvas ref={canvasRef} width={size.sw} height={size.sh} style={{ display: "block", maxWidth: 360, height: "auto" }} />
    </div>
  );
};

export const CanvasCropTooltipHost = () => {
  const [hover, setHover] = useState(null);

  useEffect(() => onCanvasHover(setHover), []);

  if (!hover?.region) return null;
  return createPortal(<CanvasCropTooltip region={hover.region} x={hover.x} y={hover.y} />, document.body);
};
