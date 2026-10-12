import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { DocumentController, type DocumentStatus, maxZoom, zoomSteps } from "./view/document-controller.ts";

/**
 * The document area (WEB-002): the engine's pages drawn on canvases by the tile compositor, a scroller above them that provides native
 * scrolling, and inside it the accessibility mirror with the input bridge. The canvases are hidden from assistive technology, which reads
 * the mirror instead. React renders this frame once; DocumentController does the rest imperatively, so scrolling never re-renders React.
 */
export function DocumentView() {
  const scroller = useRef<HTMLDivElement>(null);
  const extent = useRef<HTMLDivElement>(null);
  const tiles = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const controller = useRef<DocumentController | null>(null);
  const [status, setStatus] = useState<DocumentStatus | null>(null);

  useEffect(() => {
    if (!scroller.current || !extent.current || !tiles.current || !overlay.current || !mirror.current) return;
    const created = new DocumentController(
      {
        scroller: scroller.current,
        extent: extent.current,
        tiles: tiles.current,
        overlay: overlay.current,
        mirror: mirror.current,
      },
      setStatus,
    );
    controller.current = created;
    setStatus(created.status);
    void created.start();
    return () => {
      created.destroy();
      controller.current = null;
    };
  }, []);

  const zoom = status?.zoom ?? 1;
  return (
    <div className="document-view" data-engine-state={status?.engine ?? "starting"} data-input-bridge={status?.bridge}>
      <div className="document-toolbar" role="toolbar" aria-label="View">
        <Button className="tool-button" onPress={() => controller.current?.zoomOut()} isDisabled={zoom <= zoomSteps[0]}>
          Zoom out
        </Button>
        <output className="zoom-level" aria-label="Zoom">
          {Math.round(zoom * 100)}%
        </output>
        <Button className="tool-button" onPress={() => controller.current?.zoomIn()} isDisabled={zoom >= maxZoom}>
          Zoom in
        </Button>
        <p className="document-status" role="status">
          {status?.message ?? ""}
        </p>
      </div>
      <div className="document-stage">
        {/* The pixels are for eyes only; assistive technology reads the accessibility mirror inside the scroller. */}
        <div className="document-canvases" aria-hidden="true">
          <canvas className="document-tiles" ref={tiles} data-testid="document-tiles" />
          <canvas className="document-overlay" ref={overlay} />
        </div>
        <div className="document-scroller" ref={scroller} data-testid="document-scroller">
          <div className="document-extent" ref={extent}>
            <div className="a11y-mirror" ref={mirror} data-testid="a11y-mirror" />
          </div>
        </div>
      </div>
    </div>
  );
}
