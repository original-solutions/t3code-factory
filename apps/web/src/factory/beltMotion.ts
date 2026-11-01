import { useState } from "react";

import { holdBins, placesOf, tileMotions, type Belt, type Place, type TileMotion } from "./belt";

/** How long a slide takes; belt.css has the rest of the transition of `.factory-ghost`. */
const SLIDE_MS = 750;
/** How long the place of a tile that left its lane is remembered, for a bin to want it. */
const MEMORY_MS = 5000;
/** The least time between two beats of a tile's strip, so a busy agent never keeps it moving. */
export const BEAT_GAP_MS = 2500;
/** How big a tile is when it lands in a bin. */
const BIN_SCALE = "scale(.55)";

interface Seen {
  readonly places: ReadonlyMap<string, Place> | null;
  /** What changed in the latest read of the belt: played once, after the commit that shows it. */
  readonly motions: ReadonlyArray<TileMotion>;
  /** The runs still sliding into a bin: the bin does not count them yet. */
  readonly landing: ReadonlySet<string>;
}

const FIRST_READ: Seen = {
  places: null,
  motions: [],
  landing: new Set(),
};

/** Where a ghost sits, and how big it is. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A tile that left the DOM: where it was in the page, and what it looked like. */
interface Departed {
  readonly rect: Box;
  readonly node: HTMLElement;
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export const samePlaces = (a: ReadonlyMap<string, Place>, b: ReadonlyMap<string, Place>) =>
  a.size === b.size && Array.from(a).every(([key, place]) => b.get(key) === place);

/** Plays `cls`, a one-shot animation of belt.css, from its start, and drops it when it ends. */
export function oneShot(element: Element | null | undefined, cls: string) {
  if (!(element instanceof HTMLElement)) return;
  element.classList.remove(cls);
  // Reading the layout restarts an animation the class had already played.
  void element.offsetWidth;
  element.classList.add(cls);
  const end = (event: Event) => {
    // An animation of a child bubbles up here and is not this one's end.
    if (event.target !== element) return;
    element.classList.remove(cls);
    element.removeEventListener("animationend", end);
  };
  element.addEventListener("animationend", end);
}

/**
 * A copy of `node` in `layer` at `box` (a rect in the page), for a tile that has left the page. It
 * is no link and is hidden from assistive tech: the real tile is the one to find. belt.css makes it
 * transition its transform and opacity; this sets how long.
 */
function ghostOf(layer: HTMLElement, node: HTMLElement, box: Box) {
  const origin = layer.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = `${node.className} factory-ghost`;
  if (node.dataset.station !== undefined) ghost.dataset.station = node.dataset.station;
  ghost.setAttribute("aria-hidden", "true");
  for (const child of node.childNodes) ghost.append(child.cloneNode(true));
  ghost.style.left = `${box.left - origin.left}px`;
  ghost.style.top = `${box.top - origin.top}px`;
  ghost.style.width = `${box.width}px`;
  ghost.style.height = `${box.height}px`;
  ghost.style.transitionDuration = `${SLIDE_MS}ms`;
  layer.append(ghost);
  return ghost;
}

/**
 * Flies a copy of `source` in `layer`, from where it was to the box `last`, and calls `onLand`
 * once, when the transform ends (or is cancelled, or does not run at all).
 */
function fly(
  layer: HTMLElement,
  source: Departed,
  last: { readonly left: number; readonly top: number },
  end: { readonly transform: string; readonly opacity?: string },
  onLand: () => void,
) {
  const { rect, node } = source;
  // `last` may be a DOMRect, whose getters a spread does not copy.
  const ghost = ghostOf(layer, node, {
    left: last.left,
    top: last.top,
    width: rect.width,
    height: rect.height,
  });
  // It sits at its final box and starts displaced back to where it was: the FLIP "invert".
  ghost.style.transform = `translate(${rect.left - last.left}px, ${rect.top - last.top}px)`;
  // Style the start before the end is set, or the browser takes the end for the start.
  void ghost.getBoundingClientRect();
  ghost.style.transform = end.transform;
  if (end.opacity !== undefined) ghost.style.opacity = end.opacity;

  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    clearTimeout(fallback);
    ghost.remove();
    onLand();
  };
  ghost.addEventListener("transitionend", (event) => {
    if (event.propertyName === "transform") land();
  });
  ghost.addEventListener("transitioncancel", land);
  // A slide with nowhere to go (or a hidden tab) fires no transition event.
  const fallback = setTimeout(land, SLIDE_MS + 250);
}

/**
 * What the motion keeps between renders, outside React's state. A tile that changes post is
 * removed and mounted again: `tileRef` sees it go and `play` flies a copy to where it lands. A tile
 * that leaves for no place draws nothing, as the lane closes up over it; its place is remembered
 * for `MEMORY_MS`, to fly from if a bin lists it. A run that comes back on a lane forgets it.
 */
function createMotion() {
  const tiles = new Map<string, HTMLElement>();
  const departed = new Map<string, Departed>();
  // Where every tile was when the commit removed its first one, by key.
  const before = new Map<string, DOMRect>();
  let played: ReadonlyArray<TileMotion> | null = null;

  /** On every tile, with its run's key in `data-tile`. */
  const tileRef = (node: HTMLElement | null) => {
    const key = node?.dataset.tile;
    if (node === null || key === undefined) return;
    tiles.set(key, node);
    return () => {
      if (tiles.get(key) !== node) return;
      // React runs this while the element is still in the page. The first removal of a commit
      // measures every tile, as a lane closes up behind each tile it loses.
      if (before.size === 0) {
        for (const [tileKey, tile] of tiles) before.set(tileKey, tile.getBoundingClientRect());
        // Such places are good for the commit they were taken in, not for a later move.
        queueMicrotask(() => {
          before.clear();
          departed.clear();
        });
      }
      tiles.delete(key);
      departed.set(key, { rect: before.get(key) ?? node.getBoundingClientRect(), node });
    };
  };

  /** Where a tile that left its lane for no place stood, relative to the layer, and when. */
  const remembered = new Map<
    string,
    { readonly node: HTMLElement; readonly box: Box; readonly at: number }
  >();

  /** Plays `motions` in `layer`, once every tile of their commit is in place. */
  const play = (
    layer: HTMLElement,
    motions: ReadonlyArray<TileMotion>,
    landed: (keys: ReadonlyArray<string>) => void,
  ) => {
    const root = layer.parentElement;
    // Each read plays once, however often the layer's ref is set again.
    if (root === null || motions === played) return;
    played = motions;
    const find = (selector: string) => root.querySelector(selector);
    const origin = layer.getBoundingClientRect();
    const now = Date.now();
    for (const [key, memory] of remembered) {
      if (now - memory.at > MEMORY_MS) remembered.delete(key);
    }
    /** Takes a remembered place out of memory, as it was in the page. */
    const recall = (key: string): Departed | undefined => {
      const memory = remembered.get(key);
      if (memory === undefined) return undefined;
      remembered.delete(key);
      const { left, top, width, height } = memory.box;
      return {
        rect: { left: left + origin.left, top: top + origin.top, width, height },
        node: memory.node,
      };
    };
    const slide = (tile: HTMLElement, from: Departed, to: Place) => {
      tile.style.visibility = "hidden";
      fly(layer, from, tile.getBoundingClientRect(), { transform: "" }, () => {
        tile.style.visibility = "";
        oneShot(tile, "factory-tile-glow");
        oneShot(find(`[data-post="${to}"]`), "factory-post-flash");
      });
    };
    const immediate: Array<string> = [];
    for (const motion of motions) {
      const tile = tiles.get(motion.key);
      if (motion.kind === "enter") {
        // Back on the rail, a run's old place is no use: it fades in like any new run.
        remembered.delete(motion.key);
        oneShot(tile, "factory-tile-enter");
      } else if (motion.kind === "slide") {
        const from = departed.get(motion.key);
        // A tile folded into a lane's `+N` has no element to fly from or to.
        if (tile === undefined || from === undefined) continue;
        slide(tile, from, motion.to);
      } else if (motion.kind === "exit") {
        const from = departed.get(motion.key);
        if (from === undefined) continue;
        // Relative to the layer, so a scroll before it is wanted does not stale it.
        const { left, top, width, height } = from.rect;
        const box = { left: left - origin.left, top: top - origin.top, width, height };
        remembered.set(motion.key, { node: from.node, box, at: now });
      } else {
        const from = motion.kind === "leave" ? departed.get(motion.key) : recall(motion.key);
        const bin = find(`[data-bin="${motion.to}"]`);
        if (bin === null || from === undefined) {
          immediate.push(motion.key);
          continue;
        }
        const box = bin.getBoundingClientRect();
        const last = {
          left: box.left + (box.width - from.rect.width) / 2,
          top: box.top + (box.height - from.rect.height) / 2,
        };
        fly(layer, from, last, { transform: BIN_SCALE, opacity: "0" }, () => {
          landed([motion.key]);
          // Only Done has a post.
          if (motion.to === "done") oneShot(find('[data-post="done"]'), "factory-post-flash");
        });
      }
    }
    if (immediate.length > 0) landed(immediate);
  };

  return { tileRef, play };
}

/**
 * Motion for the belt's tiles, from the belt as each poll derives it. Draw `shown`, put `tileRef` on
 * every tile (the run's key in `data-tile`) and `layerRef` on an empty last child of the element
 * holding the tiles and bins. `live` is false until the belt has a first read; that one, and
 * `prefers-reduced-motion`, move nothing.
 */
export function useBeltMotion(belt: Belt, live: boolean) {
  const [motion] = useState(createMotion);
  const [seen, setSeen] = useState(FIRST_READ);

  const places = placesOf(belt);
  if (live && (seen.places === null || !samePlaces(seen.places, places))) {
    const motions = reducedMotion() ? [] : tileMotions(seen.places, places);
    const landing = new Set(seen.landing);
    for (const { kind, key } of motions) {
      if (kind === "leave" || kind === "arrive") landing.add(key);
    }
    setSeen({ places, motions, landing });
  }

  // Last child of the belt, so it is set after every tile ref of the commit that shows the motions.
  const layerRef = (layer: HTMLDivElement | null) => {
    if (layer === null) return;
    motion.play(layer, seen.motions, (keys) =>
      setSeen((current) => {
        const landing = new Set(current.landing);
        for (const key of keys) landing.delete(key);
        return { ...current, landing };
      }),
    );
  };

  return { shown: holdBins(belt, places, seen.landing), tileRef: motion.tileRef, layerRef };
}
