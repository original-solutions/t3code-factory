import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import type { FactoryEntry } from "./api";

/** Pairs each item with a key unique within the list, though two rows may read the same. */
function keyed<T>(items: ReadonlyArray<T>, base: (item: T) => string): Array<[string, T]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const name = base(item);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return [`${name}#${n}`, item];
  });
}

/** The run's ledger as written: a table, or a list on a phone. */
export function RunLedger({
  entries,
  truncated,
  skipped,
}: {
  entries: ReadonlyArray<FactoryEntry>;
  truncated: boolean;
  skipped: number;
}) {
  const stacked = useMediaQuery("max-sm");
  const rows = keyed(entries, (entry) => `${entry.ts} ${entry.event}`);
  return (
    <section aria-label="Raw ledger" className="flex flex-col gap-2">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ledger entries</p>
      ) : stacked ? (
        <ul className="flex flex-col gap-2" data-layout="list">
          {rows.map(([key, entry]) => (
            <li
              className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-sm"
              key={key}
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 break-words font-medium">{entry.event}</span>
                <span className="font-mono text-xs text-muted-foreground">{entry.ts}</span>
              </span>
              <span className="line-clamp-2 break-all font-mono text-xs">
                {JSON.stringify(entry.data)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([key, entry]) => (
              <TableRow key={key}>
                <TableCell className="whitespace-nowrap">
                  <span className="font-mono text-xs">{entry.ts}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{entry.event}</TableCell>
                <TableCell className="max-w-md">
                  <span className="block line-clamp-2 break-all font-mono text-xs">
                    {JSON.stringify(entry.data)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          The last line of the ledger was unreadable and was dropped.
        </p>
      ) : null}
      {skipped > 0 ? (
        <p className="text-xs text-muted-foreground">{skipped} unreadable lines skipped.</p>
      ) : null}
    </section>
  );
}
