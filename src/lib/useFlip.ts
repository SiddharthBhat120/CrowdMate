import { useLayoutEffect, useRef, type RefObject } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * FLIP animation (First, Last, Invert, Play) for a list whose items move.
 *
 * Each child needs a `data-flip-key`. After React updates the DOM we:
 *   1. WRITE: clear any leftover inline transforms,
 *   2. READ:  measure every item once (one layout, no read/write interleaving),
 *   3. WRITE: move each item back to where it was with `transform`,
 *   4. PLAY:  next frame, transition the transform to zero.
 * Only `transform` and `opacity` animate, so the browser can run the motion on
 * the compositor without re-running layout every frame.
 */
export function useFlip(containerRef: RefObject<HTMLElement | null>, dependencyKey: string) {
  const previous = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(container.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.flipKey);

    // 1. writes
    for (const item of items) {
      item.style.transition = 'none';
      item.style.transform = '';
      item.style.opacity = '';
    }
    // 2. reads (a single layout pass for the whole list)
    const tops = new Map<string, number>();
    // offsetTop is relative to the list (which is position: relative), so page scrolling doesn't matter.
    for (const item of items) tops.set(item.dataset.flipKey!, item.offsetTop);

    const before = previous.current;
    previous.current = tops;
    if (before.size === 0 || prefersReducedMotion()) return;

    // 3. writes: invert
    const animated: HTMLElement[] = [];
    for (const item of items) {
      const key = item.dataset.flipKey!;
      const oldTop = before.get(key);
      const newTop = tops.get(key)!;
      if (oldTop === undefined) {
        item.style.opacity = '0';
        item.style.transform = 'translateY(12px)';
        animated.push(item);
      } else if (oldTop !== newTop) {
        item.style.transform = `translateY(${oldTop - newTop}px)`;
        animated.push(item);
      }
    }
    if (animated.length === 0) return;

    // 4. play. Two frames: the first lets the browser paint the inverted
    // position, the second starts the transition from there.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        for (const item of animated) {
          item.style.transition = 'transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 240ms ease-out';
          item.style.transform = '';
          item.style.opacity = '';
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [containerRef, dependencyKey]);
}
