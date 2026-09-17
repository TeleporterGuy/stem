import { useCallback, useEffect, useState } from 'react';

/**
 * Overlay scrollbar for a pane whose width must not change when it starts to
 * overflow. Chromium's styled scrollbars are classic (they take layout space),
 * so the native one is hidden with CSS and a thumb element is drawn on top of
 * the content instead. The host gets an `is-scrolling` class while the user
 * scrolls (cleared ~900ms after they stop) so the thumb can fade in and out.
 *
 * Markup:
 *   <div ref={host} class="…">          position: relative; overflow: hidden
 *     <div ref={scroller}>…</div>       overflow-y: auto; native scrollbar hidden
 *     <div ref={thumb} class="…" />     position: absolute; top: 0
 *   </div>
 *
 * Callback refs (not useRef) so mounting the pane later, or remounting it,
 * re-attaches the listeners.
 */
export function useOverlayScrollbar() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [thumb, setThumb] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!host || !scroller || !thumb) return;
    let hideTimer: number | undefined;
    let thumbHeight = 0;

    const layout = () => {
      const { scrollHeight, clientHeight, scrollTop } = scroller;
      const range = scrollHeight - clientHeight;
      if (range <= 1) {
        thumb.style.display = 'none';
        return;
      }
      thumb.style.display = '';
      thumbHeight = Math.max(24, (clientHeight / scrollHeight) * clientHeight);
      const top = (scrollTop / range) * (clientHeight - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${top}px)`;
    };
    // Synchronous on purpose: requestAnimationFrame is throttled to nothing in
    // an occluded window, and the work is a handful of style writes.
    const onScroll = () => {
      layout();
      host.classList.add('is-scrolling');
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => host.classList.remove('is-scrolling'), 900);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });

    // Content growing/shrinking (a detail opening) or the pane resizing both
    // change the thumb size without any scroll event.
    const ro = new ResizeObserver(layout);
    ro.observe(scroller);
    for (const child of Array.from(scroller.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      ro.disconnect();
      ro.observe(scroller);
      for (const child of Array.from(scroller.children)) ro.observe(child);
      layout();
    });
    mo.observe(scroller, { childList: true });

    // Dragging the thumb scrolls the pane proportionally.
    let dragStartY = 0;
    let dragStartTop = 0;
    const onPointerMove = (e: PointerEvent) => {
      const range = scroller.scrollHeight - scroller.clientHeight;
      const travel = scroller.clientHeight - thumbHeight;
      if (travel <= 0) return;
      scroller.scrollTop = dragStartTop + ((e.clientY - dragStartY) / travel) * range;
    };
    const onPointerUp = (e: PointerEvent) => {
      thumb.releasePointerCapture(e.pointerId);
      thumb.removeEventListener('pointermove', onPointerMove);
      thumb.removeEventListener('pointerup', onPointerUp);
      thumb.removeEventListener('pointercancel', onPointerUp);
      host.classList.remove('is-dragging');
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragStartY = e.clientY;
      dragStartTop = scroller.scrollTop;
      thumb.setPointerCapture(e.pointerId);
      thumb.addEventListener('pointermove', onPointerMove);
      thumb.addEventListener('pointerup', onPointerUp);
      thumb.addEventListener('pointercancel', onPointerUp);
      host.classList.add('is-dragging');
    };
    thumb.addEventListener('pointerdown', onPointerDown);

    layout();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      thumb.removeEventListener('pointerdown', onPointerDown);
      thumb.removeEventListener('pointermove', onPointerMove);
      thumb.removeEventListener('pointerup', onPointerUp);
      thumb.removeEventListener('pointercancel', onPointerUp);
      ro.disconnect();
      mo.disconnect();
      clearTimeout(hideTimer);
      host.classList.remove('is-scrolling', 'is-dragging');
    };
  }, [host, scroller, thumb]);

  return {
    hostRef: useCallback((el: HTMLElement | null) => setHost(el), []),
    scrollerRef: useCallback((el: HTMLElement | null) => setScroller(el), []),
    thumbRef: useCallback((el: HTMLElement | null) => setThumb(el), [])
  };
}
