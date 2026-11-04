/**
 * Custom right-click menu on the image canvas for this fork.
 *
 * Behavior (kept fully additive — no existing click/draw/hotkey logic is touched):
 * - Right-click INSIDE an annotation region: suppress the native browser menu and show
 *   a custom menu (e.g. "机位映射"). The region's label color is irrelevant — any region matches.
 * - Right-click anywhere else (empty canvas): do nothing, the native browser menu behaves as before.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Find the topmost region of the image object that contains the given viewport point.
 * Coordinates follow the same conversion chain as `Image.event()`:
 * screen (relative to the Konva stage) -> zoom-fixed canvas -> internal 0..100 percent.
 */
export const findRegionAtPoint = (item, clientX, clientY) => {
  const stage = item?.stageRef;

  if (!stage) return null;

  const rect = stage.container().getBoundingClientRect();
  const [canvasX, canvasY] = item.fixZoomedCoords([clientX - rect.left, clientY - rect.top]);
  const x = item.canvasToInternalX(canvasX);
  const y = item.canvasToInternalY(canvasY);
  const regions = item.regs ?? [];

  // Iterate in reverse paint order so the visually topmost region wins
  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i];

    if (region.hidden || region.isDrawing) continue;

    const bbox = region.bboxCoords;

    if (!bbox) continue;
    if (x < bbox.left || x > bbox.right || y < bbox.top || y > bbox.bottom) continue;

    return region;
  }

  return null;
};

const menuStyle = {
  position: "fixed",
  // max int: must beat every in-app layer (Tooltip/AutoSubmit use 99999, editors 11000)
  zIndex: 2147483647,
  minWidth: 140,
  padding: "4px 0",
  background: "#fff",
  border: "1px solid rgba(0, 0, 0, 0.1)",
  borderRadius: 6,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
};

const itemStyle = {
  padding: "6px 12px",
  fontSize: 13,
  lineHeight: "18px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  color: "rgba(0, 0, 0, 0.88)",
};

/**
 * Viewport-positioned context menu rendered in a portal.
 * Closes on outside click, Escape and resize.
 * (Deliberately NOT closed on scroll: selecting a region with the same right-click makes
 * side panels scroll the item into view, and a window-capture scroll listener would then
 * dismiss the menu within milliseconds of it opening.)
 */
export const ImageRegionContextMenu = ({ menu, actions, onClose }) => {
  const menuRef = useRef(null);
  // live delta applied to the base position while the page scrolls under the menu
  const [scrollDelta, setScrollDelta] = useState({ dx: 0, dy: 0 });
  const baseRef = useRef({ x: menu.x, y: menu.y });

  /**
   * Selecting the region with the same right-click makes KonvaRegion.scrollToRegion()
   * smooth-scroll `.lsf-main-content`; a fixed menu would stay behind and detach from
   * the green box. Track the scrolling ancestor (found via the canvas anchor element,
   * same walk-up heuristic as scrollToRegion) and shift the menu by the scroll delta.
   */
  useLayoutEffect(() => {
    const anchor = menu.anchor;

    baseRef.current = { x: menu.x, y: menu.y };
    setScrollDelta({ dx: 0, dy: 0 });
    if (!anchor?.parentElement) return undefined;

    let scroller = anchor.parentElement;

    while (scroller && scroller !== document.body) {
      const { scrollTop, scrollLeft } = scroller;

      if (scrollTop || scrollLeft || scroller.className?.includes("main-content")) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) return undefined;

    const startTop = scroller.scrollTop;
    const startLeft = scroller.scrollLeft;
    const handleScroll = () => {
      setScrollDelta({ dx: startLeft - scroller.scrollLeft, dy: startTop - scroller.scrollTop });
    };

    scroller.addEventListener("scroll", handleScroll);

    return () => scroller.removeEventListener("scroll", handleScroll);
  }, [menu.anchor, menu.x, menu.y]);

  useEffect(() => {
    const handleMouseDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    const handleResize = () => onClose();

    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [onClose]);

  // Keep the menu inside the viewport; +3px offset so the still-held right button
  // from the opening gesture never lands on the menu itself
  const left = Math.max(4, Math.min(baseRef.current.x + 3 + scrollDelta.dx, window.innerWidth - 160));
  const top = Math.max(4, Math.min(baseRef.current.y + 3 + scrollDelta.dy, window.innerHeight - 8 - actions.length * 30));

  return createPortal(
    <div
      ref={menuRef}
      style={{ ...menuStyle, left, top }}
      data-testid="image-region-context-menu"
      // swallow follow-up events so the canvas never sees the menu interaction
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {actions.map((action) => (
        <div
          key={action.label}
          style={itemStyle}
          data-testid={`image-region-context-menu-item-${action.label}`}
          onClick={() => action.onClick(menu)}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(0, 0, 0, 0.04)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {action.label}
        </div>
      ))}
    </div>,
    document.body,
  );
};
