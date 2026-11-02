import { ArrowRightIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { PendingChange } from "./tuning";

const shown = (value: string) => (value === "" ? "empty" : value);

/**
 * The machine config card's foot: the file a save writes and its Save, pinned to the bottom of the
 * view while there is something to save, with each change it would write and a way back.
 */
export function SaveBar({
  file,
  changes,
  canWrite,
  saving,
  saved,
  onSave,
  onDiscard,
}: {
  readonly file: string;
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
          ? "sticky bottom-0 z-10 flex flex-col gap-3 rounded-b-xl bg-card px-3 pt-3 pb-2.5 shadow-lg sm:flex-row sm:items-center sm:px-4"
          : "flex flex-col gap-3 rounded-b-xl bg-muted/32 px-3 py-2.5 sm:flex-row sm:items-center sm:px-4"
      }
    >
      {dirty ? <span aria-hidden className="absolute inset-x-0 top-0 h-0.75 bg-primary" /> : null}
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
        ) : (
          <p role={saved ? "status" : undefined} className="text-xs text-muted-foreground">
            {saved ? "Saved to " : "Writes "}
            <code className="break-all">{file}</code>
          </p>
        )}
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
