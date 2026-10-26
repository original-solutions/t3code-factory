import { InlineButton } from "~/components/ui/button";

import type { LinkRef } from "./format";
import { TouchLink } from "./TouchLink";

/** A reference that is a link when it has a target, else plain text; `touch` on the phone cards. */
export function Ref({ text, href, touch = false }: LinkRef & { readonly touch?: boolean }) {
  if (href === null) return <span className="min-w-0 break-all">{text}</span>;
  const anchor = <a href={href} rel="noreferrer" target="_blank" />;
  return touch ? (
    <TouchLink render={anchor}>{text}</TouchLink>
  ) : (
    <InlineButton render={anchor}>{text}</InlineButton>
  );
}
