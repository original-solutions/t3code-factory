import { FactoryIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";

import { useFactoryAttentionCount } from "./useFactoryData";

/**
 * The sidebar's Factory glyph, with the open attention count at the top-right; hidden at zero.
 * A fragment, so the svg is the `SidebarMenuButton`'s direct child and gets its neighbours' size
 * and colour rules. The badge hangs off an anchor with no insets and the icon's `size-4`, placed
 * from the icon alone; the anchor comes first so `[&>span:last-child]:truncate` misses it.
 */
export function FactoryNavIcon() {
  const count = useFactoryAttentionCount();
  return (
    <>
      {count > 0 ? (
        <span className="pointer-events-none absolute size-4">
          <span className="absolute -top-1 -right-2 flex">
            <Badge size="sm" variant="destructive">
              {count}
            </Badge>
          </span>
        </span>
      ) : null}
      <FactoryIcon />
    </>
  );
}
