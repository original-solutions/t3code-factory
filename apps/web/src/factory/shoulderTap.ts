import type { EnvironmentId } from "@t3tools/contracts";

import type { FactoryAttentionItem } from "./api";
import { causeKey, groupByCause, signedOutLine } from "./attentionCauses";
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
 * The items `items` adds to the causes `seen` held: a repo a signed-out gh newly fails is not news
 * once the sign-out was. With no `seen` (the first read) nothing is news: what was there before
 * you looked is already in the bins.
 */
export function attentionNews(
  seen: ReadonlySet<string> | undefined,
  items: ReadonlyArray<FactoryAttentionItem>,
): { readonly fresh: ReadonlyArray<FactoryAttentionItem>; readonly seen: ReadonlySet<string> } {
  const keys = new Set(items.map(causeKey));
  return {
    fresh: seen === undefined ? [] : items.filter((item) => !seen.has(causeKey(item))),
    seen: keys,
  };
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
 * What to say about `fresh` (non-empty) from one environment: one cause by name, a burst as one
 * count of causes. `label` names the environment when there are several.
 */
export function tapOf(
  environmentId: EnvironmentId,
  label: string | null,
  fresh: ReadonlyArray<FactoryAttentionItem>,
): ShoulderTap {
  const where = label === null ? "" : ` · ${label}`;
  const causes = groupByCause(fresh.map((item) => ({ environmentId, item })));
  if (causes.length === 1) {
    const cause = causes[0]!;
    if (cause.kind === "signed-out") {
      return {
        title: "The factory's gh is signed out",
        body: clip(`${signedOutLine(cause.repos)}${where}`),
        runId: null,
        environmentId,
      };
    }
    const item = cause.entry.item;
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
  const named = causes
    .slice(0, 2)
    .map((cause) =>
      cause.kind === "signed-out"
        ? "GitHub sign-in"
        : (runHeadline(cause.entry.item) ?? cause.entry.item.message),
    );
  const more = causes.length - named.length;
  return {
    title: `${causes.length} new things need you in the factory`,
    body: clip([...named, ...(more > 0 ? [`and ${more} more`] : [])].join(" · ") + where),
    runId: null,
    environmentId,
  };
}
