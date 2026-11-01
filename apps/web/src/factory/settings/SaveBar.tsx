import { ArrowRightIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { PendingChange } from "./tuning";

const shown = (value: string) => (value === "" ? "empty" : value);

/**
 * The machine config's Save, pinned to the bottom of the page while there is something to save,
 * with each change it would write and a way back to what the file holds.
 */
export function SaveBar({
  changes,
  canWrite,
  saving,
  saved,
  onSave,
  onDiscard,
}: {
  readonly changes: ReadonlyArray<PendingChange>;
  readonly canWrite: boolean;
  readonly saving: boolean;
  readonly saved: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}) {
  const dirty = changes.length > 0;
  return (
    <div
      data-save-bar={dirty ? "dirty" : "clean"}
      className={
        dirty
          ? "sticky bottom-3 z-10 mx-3 flex flex-col gap-3 rounded-xl border border-primary/40 bg-background px-3 py-2.5 shadow-lg sm:mx-4 sm:flex-row sm:items-center sm:px-4"
          : "mx-3 flex flex-col gap-3 px-0 sm:mx-4 sm:flex-row sm:items-center"
      }
    >
      <div className="min-w-0 flex-1 text-sm">
        {dirty ? (
          <>
            <p className="font-medium">
              {changes.length === 1 ? "1 unsaved change" : `${changes.length} unsaved changes`}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {changes.map((change) => (
                <li key={change.key} className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                  <span>{change.label}</span>
                  <span className="break-all font-mono line-through decoration-muted-foreground/60">
                    {shown(change.from)}
                  </span>
                  <ArrowRightIcon aria-label="to" className="size-3 shrink-0" />
                  <span className="break-all font-mono text-foreground">{shown(change.to)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : saved ? (
          <p role="status" className="text-muted-foreground">
            Saved
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {dirty ? (
          <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
        ) : null}
        <Button size="sm" disabled={!canWrite || saving} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
