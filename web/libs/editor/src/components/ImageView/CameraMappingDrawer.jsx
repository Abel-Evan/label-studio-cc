/**
 * Right-side drawer for the "机位映射" fork feature.
 *
 * Opened from the green-region context menu (ImageView.handleCameraMapping).
 * Occupies one third of the viewport width, slides in from the right, and
 * closes on overlay click / Escape.
 *
 * Content flow:
 * 1. fetch every project (`/api/projects/`) and keep those with a non-empty
 *    `description` whose name (split by "_") shares the current project's first
 *    two segments (skipped when the current name has no "_"); the current
 *    project is never filtered out — it is pinned first and badged (标识);
 * 2. for each kept project, resolve and show the image of the task that
 *    matches the current frame id;
 * 3. register all kept projects as cameras on a TrackPlayer instance
 *    (机位号 = 项目 id，标定内容 = 项目 description) for the mapping logic to use;
 * 4. each frame image is zoomable/draggable (ZoomableFrame); the mapped point
 *    marker lives inside the transformed layer so it stays on the right pixel.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAP_H, MAP_W, RET, TrackPlayer } from "../../lbk_track_player";

const API_BASE = window.APP_SETTINGS?.hostname ?? "";

const apiGet = async (path) => {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "same-origin" });

  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
};

/**
 * Pick an image URL out of a task's data payload: the conventional `image`
 * key first, otherwise the first string value that looks like an image.
 * Relative LS media URLs (/data/upload/...) are resolved against the host.
 */
const extractImageUrl = (data) => {
  if (!data || typeof data !== "object") return null;

  const raw = data.image ?? Object.values(data).flat().find(
    (v) => typeof v === "string" && /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)(\?.*)?$/i.test(v),
  );

  if (typeof raw !== "string" || !raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${API_BASE}/${raw.replace(/^\//, "")}`;
};

/**
 * Resolve the frame image inside ONE project.
 *
 * NOTE: LS task ids are globally unique (a task belongs to exactly one
 * project), so the literal lookup is "fetch the task by id, verify it lives
 * in this project". If the cross-camera correspondence in your data actually
 * keys off something else (frame number, file name inside task.data), THIS is
 * the single function to adapt.
 */
const fetchFrameImage = async (projectId, frameId) => {
  const task = await apiGet(`/api/tasks/${frameId}/`);

  if (!task || task.project !== projectId) return null;
  return extractImageUrl(task.data);
};

/**
 * 名字过滤的分组键：项目名以 "_" 分割后取前两段（同一批次/同一场比赛的其他机位）。
 * 名字不含 "_"（或前两段里有空值）时返回 null —— 表示不参与名字过滤，全部保留。
 */
const namePrefix = (title) => {
  const parts = String(title ?? "").split("_");

  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return [parts[0], parts[1]];
};

/** prefix 为 null 时一律通过；否则候选项目名前两段必须与当前项目一致 */
const matchesNamePrefix = (title, prefix) => {
  if (!prefix) return true;
  const candidate = namePrefix(title);

  return candidate !== null && candidate[0] === prefix[0] && candidate[1] === prefix[1];
};

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483646, // one below the context menu's ceiling, above every in-app layer
  background: "rgba(0, 0, 0, 0.1)",
};

const drawerStyle = (visible) => ({
  position: "fixed",
  top: 0,
  right: 0,
  height: "100vh",
  // one third of the screen, as required
  width: "33.333vw",
  minWidth: 320, // keep the content usable on narrow windows
  zIndex: 2147483646,
  background: "#fff",
  boxShadow: "-4px 0 16px rgba(0, 0, 0, 0.15)",
  display: "flex",
  flexDirection: "column",
  transform: visible ? "translateX(0)" : "translateX(100%)",
  transition: "transform 0.25s ease",
});

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid rgba(0, 0, 0, 0.1)",
  flexShrink: 0,
};

const titleStyle = { fontSize: 15, fontWeight: 600, color: "rgba(0, 0, 0, 0.88)" };

const closeBtnStyle = {
  border: "none",
  background: "transparent",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  color: "rgba(0, 0, 0, 0.45)",
  padding: 4,
};

const bodyStyle = { padding: 16, overflowY: "auto", flex: 1 };

const cardStyle = {
  marginBottom: 12,
  border: "1px solid rgba(0, 0, 0, 0.1)",
  borderRadius: 6,
  background: "#fff",
  overflow: "hidden", // 图片直接贴到卡片边缘，裁切圆角
};

const cardHeaderStyle = { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 2px" };

const cardTitleStyle = { fontSize: 14, fontWeight: 600, color: "rgba(0, 0, 0, 0.88)", flex: 1, minWidth: 0 };

const currentProjectBadgeStyle = {
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 500,
  color: "#d46b08",
  background: "#fff7e6",
  border: "1px solid #ffd591",
  borderRadius: 4,
  padding: "0 6px",
  lineHeight: "20px",
};

const metaTextStyle = { fontSize: 12, color: "rgba(0, 0, 0, 0.45)", marginBottom: 8, padding: "0 12px" };

const imageStyle = {
  display: "block",
  width: "100%", // 撑满卡片宽度，高度按原比例自动缩放（不再用 maxHeight+contain 收窄）
  background: "rgba(0, 0, 0, 0.02)",
};

const placeholderStyle = {
  margin: "0 12px 12px",
  padding: "24px 8px",
  textAlign: "center",
  fontSize: 12,
  color: "rgba(0, 0, 0, 0.35)",
  background: "rgba(0, 0, 0, 0.02)",
  border: "1px dashed rgba(0, 0, 0, 0.12)",
  borderRadius: 4,
};

const statusTextStyle = { padding: "24px 8px", textAlign: "center", fontSize: 13, color: "rgba(0, 0, 0, 0.45)" };

// 映射落点红点。不在被缩放的图层内部，而是放在裁剪层（stage）里用 JS 算出屏幕坐标：
// 图片盒 = stage 尺寸，点 (fx, fy) → stage 坐标 = offset + fx * stageSize * zoom。
// 这样红点永远按原生 1:1 光栅化（尺寸/边框均为整数），放大后不会变形、不会发虚。
const dotStyle = (x, y, zoom, offset, stage) => ({
  position: "absolute",
  left: offset.x + (x / MAP_W) * stage.w * zoom,
  top: offset.y + (y / MAP_H) * stage.h * zoom,
  width: 12,
  height: 12,
  marginLeft: -6,
  marginTop: -6,
  borderRadius: "50%",
  background: "red",
  border: "2px solid #fff",
  boxShadow: "0 0 4px rgba(0, 0, 0, 0.5)",
  pointerEvents: "none",
  zIndex: 1,
});

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
// false = 图片上直接滚轮即放大；true = 按住 Ctrl/⌘ 才放大，普通滚轮留给抽屉上下滚动
const ZOOM_REQUIRES_MODIFIER = false;

const frameStageStyle = (dragging) => ({
  position: "relative",
  overflow: "hidden",
  cursor: dragging ? "grabbing" : "grab",
  touchAction: "none", // 让 pointer 拖拽在触控板/触摸屏上不被浏览器手势抢走
  userSelect: "none", // 拖动时不选中卡片文字
  background: "rgba(0, 0, 0, 0.02)",
});

// 被缩放/平移的那一层：只包图片。willChange 仅在交互期间开启，
// 静止时让浏览器按最终缩放比例重新光栅化，图片不会停留在低清纹理上
const frameLayerStyle = (zoom, offset, active) => ({
  position: "relative",
  transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
  transformOrigin: "0 0",
  willChange: active ? "transform" : "auto",
});

const zoomControlsStyle = {
  position: "absolute",
  right: 8,
  top: 8,
  display: "flex",
  alignItems: "center",
  gap: 4,
  zIndex: 1, // 处于被缩放层之外，不随图片放大
};

const zoomBtnStyle = {
  border: "1px solid rgba(0, 0, 0, 0.15)",
  background: "rgba(255, 255, 255, 0.92)",
  borderRadius: 4,
  width: 24,
  height: 24,
  lineHeight: "22px",
  fontSize: 14,
  cursor: "pointer",
  color: "rgba(0, 0, 0, 0.65)",
  padding: 0,
};

const zoomBadgeStyle = {
  fontSize: 11,
  color: "rgba(0, 0, 0, 0.6)",
  background: "rgba(255, 255, 255, 0.92)",
  border: "1px solid rgba(0, 0, 0, 0.08)",
  borderRadius: 4,
  padding: "0 6px",
  lineHeight: "22px",
};

const zoomHintStyle = {
  position: "absolute",
  left: 8,
  bottom: 8,
  zIndex: 1,
  fontSize: 11,
  color: "rgba(255, 255, 255, 0.9)",
  background: "rgba(0, 0, 0, 0.45)",
  borderRadius: 4,
  padding: "2px 6px",
  pointerEvents: "none",
};

/**
 * 可局部放大/拖动的图片容器。renderOverlay( zoom, offset, stageSize ) 产出的覆盖层
 * （映射红点）作为 stage 的直接子元素，用当前变换自行算出屏幕坐标：既保证贴住图片
 * 上同一个物理点，又不受图片纹理放大影响（始终 1:1 光栅化）。
 */
const ZoomableFrame = ({ src, alt, renderOverlay }) => {
  const stageRef = useRef(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // stage 尺寸（= 图片盒尺寸）：红点百分比坐标换算屏幕像素需要它
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  // 原生 wheel 监听与指针拖拽需要读到最新值，用 ref 镜像一份避开闭包陈状态
  const zoomRef = useRef(MIN_ZOOM);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef(null);

  // 平移量上限：放大后图片边缘不能离开视口（留出空白）
  const clampOffset = (nextZoom, nextOffset) => {
    const stage = stageRef.current;

    if (!stage) return nextOffset;
    return {
      x: Math.min(0, Math.max(stage.clientWidth * (1 - nextZoom), nextOffset.x)),
      y: Math.min(0, Math.max(stage.clientHeight * (1 - nextZoom), nextOffset.y)),
    };
  };

  const commit = (nextZoom, nextOffset) => {
    zoomRef.current = nextZoom;
    offsetRef.current = nextOffset;
    setZoom(nextZoom);
    setOffset(nextOffset);
  };

  // 以 pivot（client 坐标）为不动点缩放：缩放前后鼠标下的图像点保持不动
  const applyZoom = (nextZoom, pivot) => {
    const stage = stageRef.current;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));

    if (!stage) {
      commit(z, { x: 0, y: 0 });
      return;
    }
    const rect = stage.getBoundingClientRect();
    const px = pivot ? pivot.x - rect.left : rect.width / 2;
    const py = pivot ? pivot.y - rect.top : rect.height / 2;
    const ratio = z / zoomRef.current;
    const raw = { x: px - (px - offsetRef.current.x) * ratio, y: py - (py - offsetRef.current.y) * ratio };

    commit(z, clampOffset(z, raw));
  };

  const resetZoom = () => commit(MIN_ZOOM, { x: 0, y: 0 });

  useEffect(() => {
    const stage = stageRef.current;

    if (!stage) return undefined;
    const onWheel = (e) => {
      if (ZOOM_REQUIRES_MODIFIER && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault(); // React 的 onWheel 是 passive 监听，必须用原生监听才能阻止抽屉滚动
      applyZoom(zoomRef.current * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  // 跟踪 stage 尺寸：图片加载完成、抽屉宽度变化时重新测量，红点落位才不会偏
  useEffect(() => {
    const stage = stageRef.current;

    if (!stage || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setStageSize({ w: stage.clientWidth, h: stage.clientHeight });
    const observer = new ResizeObserver(measure);

    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, []);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origin: offsetRef.current };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;

    if (!drag) return;
    const raw = {
      x: drag.origin.x + (e.clientX - drag.startX),
      y: drag.origin.y + (e.clientY - drag.startY),
    };

    commit(zoomRef.current, clampOffset(zoomRef.current, raw));
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
  };

  // 图片尺寸变化（首次加载完成）后重新测量 + 限幅，避免红点/画面落在可视区外
  const handleImageLoad = () => {
    const stage = stageRef.current;

    if (stage) setStageSize({ w: stage.clientWidth, h: stage.clientHeight });
    commit(zoomRef.current, clampOffset(zoomRef.current, offsetRef.current));
  };

  return (
    <div
      ref={stageRef}
      style={frameStageStyle(dragging)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={resetZoom}
    >
      <div style={frameLayerStyle(zoom, offset, dragging)}>
        <img src={src} alt={alt} style={imageStyle} onLoad={handleImageLoad} draggable={false} />
      </div>
      {renderOverlay ? renderOverlay(zoom, offset, stageSize) : null}
      <div
        style={zoomControlsStyle}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button type="button" style={zoomBtnStyle} title="缩小" onClick={() => applyZoom(zoomRef.current / 1.4)}>
          −
        </button>
        <span style={zoomBadgeStyle}>{Math.round(zoom * 100)}%</span>
        <button type="button" style={zoomBtnStyle} title="放大" onClick={() => applyZoom(zoomRef.current * 1.4)}>
          +
        </button>
        <button type="button" style={zoomBtnStyle} title="复位" onClick={resetZoom}>
          ⟲
        </button>
      </div>
      {zoom > MIN_ZOOM ? null : <div style={zoomHintStyle}>滚轮放大 · 拖动平移 · 双击复位</div>}
    </div>
  );
};

/**
 * @param data {{
 *   projectId: string|null,
 *   taskId: number|string|null,
 *   region: { id: string, labelName: string|null, bbox: number[]|null, bboxCoords: object|null },
 * }} context resolved at right-click time; see ImageView.handleCameraMapping
 */
export const CameraMappingDrawer = ({ data, onClose }) => {
  // flip on the next frame so the first paint is still off-screen -> CSS transition slides in
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // [{ project, image, mapping }] — projects with frame image and mapped green-box point
  const [entries, setEntries] = useState([]);
  // 生效的名字过滤键（"a_b"）；null = 当前项目名不含 "_"，不参与名字过滤
  const [nameFilter, setNameFilter] = useState(null);
  // TrackPlayer instance: cameras are registered from the filtered project list
  // (cam id = project id, calibration text = project description)
  const playerRef = useRef(null);
  const [cameraCount, setCameraCount] = useState(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));

    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const { projectId, taskId, region } = data ?? {};

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const listData = await apiGet("/api/projects/?page_size=1000");
        const all = listData.results ?? [];
        const currentId = Number(projectId);
        const currentProject = all.find((p) => p.id === currentId);
        // 当前项目名的前两段作为过滤键；不含 "_" 时为 null（跳过名字过滤）
        const prefix = namePrefix(currentProject?.title);

        // 过滤：description 为空 + 名字前两段与当前项目不一致。
        // 当前项目不参与过滤（始终保留，仅打「当前项目」徽标），且置顶方便与源机位对照
        const others = all.filter(
          (p) => p.id !== currentId && (p.description ?? "").trim() !== "" && matchesNamePrefix(p.title, prefix),
        );
        const projects = currentProject ? [currentProject, ...others] : others;

        const resolved = await Promise.all(
          projects.map(async (p) => ({
            project: p,
            image: taskId == null ? null : await fetchFrameImage(p.id, taskId).catch(() => null),
          })),
        );

        // 遍历出的项目全部注册为机位：loadCameras 内部逐个调用 addCamera。
        // 当前项目已在列表里（= 源机位），缺了它 cams.get 找不到源相机，映射全部 ret=-1
        if (!playerRef.current) playerRef.current = new TrackPlayer();
        const registered = await playerRef.current.loadCameras(projects);

        // 源像素：绿框底部中心点（bboxCoords 是 0..100 百分比，换算到 3840x2160 地图坐标系）
        const bbox = region?.bboxCoords;
        const srcCamId = currentId;
        const srcX = bbox ? ((bbox.left + bbox.right) / 2 / 100) * MAP_W : null;
        const srcY = bbox ? (bbox.bottom / 100) * MAP_H : null;

        // 遍历每个项目（目标机位号 = 项目 id）做像素映射，结果挂到对应卡片上
        // 日志里的坐标统一换算成百分比小数（0..1，像素 / 地图尺寸），便于直接落库/回显
        const pct = { x: srcX == null ? null : srcX / MAP_W, y: srcY == null ? null : srcY / MAP_H };
        const mapped = resolved.map((entry) => {
          if (srcX == null || !Number.isFinite(srcCamId)) return { ...entry, mapping: null };
          const mapping = playerRef.current.mapPixelBetweenCams(srcCamId, srcX, srcY, Number(entry.project.id));
          const ok = mapping.ret === RET.OK;

          console.log("[camera-mapping] mapPixelBetweenCams", {
            srcCamId,
            src: pct,
            dstCamId: entry.project.id,
            ret: mapping.ret,
            x: ok ? mapping.x / MAP_W : null,
            y: ok ? mapping.y / MAP_H : null,
          });
          return { ...entry, mapping };
        });

        if (cancelled) return;
        console.log("[camera-mapping] done", {
          srcCamId,
          srcPercent: pct,
          nameFilter: prefix ? `${prefix[0]}_${prefix[1]}` : null,
          projectCount: projects.length,
          registeredCameras: registered,
          targets: mapped.map((m) => ({
            camId: m.project.id,
            ret: m.mapping?.ret ?? "skipped",
            x: m.mapping?.ret === RET.OK ? m.mapping.x / MAP_W : null,
            y: m.mapping?.ret === RET.OK ? m.mapping.y / MAP_H : null,
          })),
        });
        setEntries(mapped);
        setNameFilter(prefix ? `${prefix[0]}_${prefix[1]}` : null);
        setCameraCount(registered);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, taskId, region]);

  return createPortal(
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={drawerStyle(visible)} data-testid="camera-mapping-drawer">
        <div style={headerStyle}>
          <span style={titleStyle}>机位映射</span>
          <button type="button" style={closeBtnStyle} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div style={bodyStyle}>
          <div style={metaTextStyle}>
            项目 {projectId ?? "-"} · 帧 {taskId ?? "-"} · 绿框 {data?.region?.id ?? "-"}
            {data?.region?.bboxCoords
              ? `（left ${data.region.bboxCoords.left.toFixed(2)}, top ${data.region.bboxCoords.top.toFixed(2)}, right ${data.region.bboxCoords.right.toFixed(2)}, bottom ${data.region.bboxCoords.bottom.toFixed(2)}）`
              : ""}
          </div>

          {!loading ? (
            <div style={metaTextStyle} data-testid="camera-mapping-name-filter">
              {nameFilter ? `名称过滤：前两段 =「${nameFilter}」` : "名称过滤：未启用（当前项目名不含「_」）"}
            </div>
          ) : null}

          {cameraCount != null ? (
            <div style={metaTextStyle} data-testid="camera-mapping-registered">
              已注册机位 {cameraCount} / {entries.length}（机位号 = 项目 ID，标定内容取自项目描述）
            </div>
          ) : null}

          {loading ? <div style={statusTextStyle}>加载中…</div> : null}
          {error ? <div style={statusTextStyle}>加载失败：{error}</div> : null}
          {!loading && !error && !entries.length ? <div style={statusTextStyle}>没有可展示的项目</div> : null}

          {entries.map(({ project, image, mapping }) => (
            <div key={project.id} style={cardStyle} data-testid={`camera-mapping-project-${project.id}`}>
              <div style={cardHeaderStyle}>
                <span style={cardTitleStyle}>{project.title || `项目 ${project.id}`}</span>
                {Number(projectId) === project.id ? <span style={currentProjectBadgeStyle}>当前项目</span> : null}
              </div>
              <div style={metaTextStyle}>
                ID {project.id}
                {project.description
                  ? ` · ${project.description.replace(/\s+/g, " ").slice(0, 80)}${project.description.length > 80 ? "…" : ""}`
                  : ""}
              </div>
              {image ? (
                <ZoomableFrame
                  src={image}
                  alt={`${project.title || project.id} · 帧 ${taskId}`}
                  renderOverlay={(zoom, offset, size) =>
                    mapping?.ret === RET.OK && size.w > 0 ? (
                      <span
                        style={dotStyle(mapping.x, mapping.y, zoom, offset, size)}
                        data-testid={`camera-mapping-dot-${project.id}`}
                      />
                    ) : null
                  }
                />
              ) : (
                <div style={placeholderStyle}>该项目中未找到对应帧图片</div>
              )}
            </div>
          ))}
          {/* TODO: 机位映射的具体业务操作（选定目标机位帧等）在此接入 */}
        </div>
      </div>
    </>,
    document.body,
  );
};
