/** The Factory page's parts a key or a skip link jumps to, in page order. */
export const FACTORY_SECTIONS = [
  { id: "belt", key: "b", label: "Belt" },
  { id: "attention", key: "a", label: "Needs attention" },
  { id: "info", key: "n", label: "Needs info" },
  { id: "stuck", key: "s", label: "Stuck" },
  { id: "runs", key: "r", label: "Runs" },
] as const;

export type FactorySectionId = (typeof FACTORY_SECTIONS)[number]["id"];

/**
 * Spread on a section's root so it can be jumped to. The scroll margin clears the sticky Showing
 * line; the ring shows where focus landed.
 */
export const jumpTarget = (id: FactorySectionId) =>
  ({
    "data-factory-jump": id,
    tabIndex: -1,
  }) as const;

export const JUMP_TARGET_CLASS =
  "scroll-mt-16 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const sectionEl = (id: FactorySectionId) =>
  document.querySelector<HTMLElement>(`[data-factory-jump="${id}"]`);

/** The sections the page shows right now, in page order. */
export const sectionsShown = () => FACTORY_SECTIONS.filter(({ id }) => sectionEl(id) !== null);

/** Moves focus to a section and scrolls it to the top; false when the page does not show it. */
export function jumpToSection(id: FactorySectionId): boolean {
  const target = sectionEl(id);
  if (target === null) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
  return true;
}
