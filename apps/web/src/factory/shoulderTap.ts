import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryAttentionItem } from "./api";
import { withoutRepoPrefix } from "./format";

/** One notice for what a status read newly put in Needs attention. */
export interface ShoulderTap {
  readonly title: string;
  readonly body: string;
  /** The run its one item is about, whose page it opens; null opens the Factory page. */
  readonly runId: string | null;
  readonly environmentId: EnvironmentId;
}

/**
 * The items `items` adds to the ids `seen` held. With no `seen` (the first read) nothing is news:
 * what was there before you looked is already in the bins.
 */
export function attentionNews(
  seen: ReadonlySet<string> | undefined,
  items: ReadonlyArray<FactoryAttentionItem>,
): { readonly fresh: ReadonlyArray<FactoryAttentionItem>; readonly seen: ReadonlySet<string> } {
  const ids = new Set(items.map((item) => item.id));
  return { fresh: seen === undefined ? [] : items.filter((item) => !seen.has(item.id)), seen: ids };
}

const MAX_BODY = 160;

const clip = (text: string): string =>
  text.length <= MAX_BODY ? text : `${text.slice(0, MAX_BODY - 1).trimEnd()}…`;

const runHeadline = (item: FactoryAttentionItem): string | null => {
  if (item.run === null || item.repo === null || item.issue === null) return null;
  const ref = `${item.repo} #${item.issue}`;
  return item.kind === "needs-info"
    ? `${ref} needs info`
    : item.kind === "stuck"
      ? `${ref} is stuck`
      : null;
};

/**
 * What to say about `fresh` (non-empty) from one environment: one item by name, a burst as one
 * count. `label` names the environment when there are several.
 */
export function tapOf(
  environmentId: EnvironmentId,
  label: string | null,
  fresh: ReadonlyArray<FactoryAttentionItem>,
): ShoulderTap {
  const where = label === null ? "" : ` · ${label}`;
  if (fresh.length === 1) {
    const item = fresh[0]!;
    const headline = runHeadline(item);
    return {
      title: headline ?? "The factory needs you",
      body: clip(
        `${headline === null ? item.message : withoutRepoPrefix(item.message, item.repo)}${where}`,
      ),
      runId: headline === null ? null : item.run,
      environmentId,
    };
  }
  const named = fresh.slice(0, 2).map((item) => runHeadline(item) ?? item.message);
  const more = fresh.length - named.length;
  return {
    title: `${fresh.length} new things need you in the factory`,
    body: clip([...named, ...(more > 0 ? [`and ${more} more`] : [])].join(" · ") + where),
    runId: null,
    environmentId,
  };
}
