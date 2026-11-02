import { KeyboardIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { FACTORY_SECTIONS, jumpToSection, sectionsShown } from "./pageSections";

const GROUPS: ReadonlyArray<{ title: string; keys: ReadonlyArray<[ReactNode, string]> }> = [
  {
    title: "Factory page: jump to",
    keys: FACTORY_SECTIONS.map(({ key, label }) => [<Kbd key={key}>{key}</Kbd>, label]),
  },
  {
    title: "Runs list",
    keys: [
      [
        <>
          <Kbd>j</Kbd> <Kbd>k</Kbd>
        </>,
        "Step through runs",
      ],
      [<Kbd key="enter">Enter</Kbd>, "Open the run"],
      [<Kbd key="slash">/</Kbd>, "Search runs"],
      [<Kbd key="esc">Esc</Kbd>, "Clear the search, then leave it"],
    ],
  },
  {
    title: "Run page",
    keys: [
      [
        <>
          <Kbd>j</Kbd> <Kbd>k</Kbd>
        </>,
        "Next or previous run of the list you came from",
      ],
      [<Kbd key="esc">Esc</Kbd>, "Back to that list"],
    ],
  },
  { title: "Anywhere", keys: [[<Kbd key="help">?</Kbd>, "This list"]] },
];

/** Every key the Factory pages answer to, opened with `?` or the header's keyboard button. */
export function FactoryKeysDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {GROUPS.map(({ title, keys }) => (
            <section aria-label={title} className="flex flex-col gap-1.5" key={title}>
              <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
              <dl className="grid grid-cols-[5rem_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
                {keys.map(([keyCap, what]) => (
                  <Fragment key={what}>
                    <dt className="flex items-center gap-1">{keyCap}</dt>
                    <dd>{what}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The header's way into the key list, where there is a keyboard. */
export function FactoryKeysButton({ onOpen }: { onOpen: () => void }) {
  return (
    <span className="flex pointer-coarse:hidden">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-keyshortcuts="?"
              aria-label="Keyboard shortcuts"
              onClick={onOpen}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <KeyboardIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Keyboard shortcuts <Kbd>?</Kbd>
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * The first stop in the page body: hidden until tabbed to, then a row of the sections shown, so a
 * keyboard reaches the runs list without tabbing through every tile above it.
 */
export function FactorySkipLinks({ onKeys }: { onKeys: () => void }) {
  const [shown, setShown] = useState<ReturnType<typeof sectionsShown>>([]);
  return (
    <nav
      aria-label="Jump to"
      className="sr-only flex flex-wrap items-center gap-2 focus-within:not-sr-only focus-within:rounded-lg focus-within:border focus-within:bg-card focus-within:p-2"
      // The sections shown change with the data; read them when the row is reached.
      onFocus={() => setShown(sectionsShown())}
    >
      <span className="px-1 text-xs font-medium text-muted-foreground">Jump to</span>
      {(shown.length > 0 ? shown : FACTORY_SECTIONS).map(({ id, key, label }) => (
        <Button
          aria-keyshortcuts={key}
          key={id}
          onClick={() => jumpToSection(id)}
          size="xs"
          variant="outline"
        >
          {label} <Kbd aria-hidden>{key}</Kbd>
        </Button>
      ))}
      <Button aria-keyshortcuts="?" onClick={onKeys} size="xs" variant="ghost">
        All keys <Kbd aria-hidden>?</Kbd>
      </Button>
    </nav>
  );
}
