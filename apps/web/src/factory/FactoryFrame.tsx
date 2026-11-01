import type { ReactNode } from "react";

import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "~/env";

import { readAheadHandlers } from "./readAhead";

/**
 * The page chrome the Factory pages share: titlebar row with `header`, then the scrolling body,
 * whose run links read their run ahead so it opens at once.
 */
export function FactoryFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
        {...readAheadHandlers}
      >
        <WorkspacePageHeader electron={isElectron}>{header}</WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">{children}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
