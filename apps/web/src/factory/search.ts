import { isRunBucket, type RunBucketFilter } from "./runLedger";

/** The Factory page's filters, kept in its URL so a reload or a shared link opens filtered. */
export interface FactorySearch {
  /** An environment id: only that environment's status, items and runs. */
  readonly environment?: string;
  /** `owner/name`: only that repo's runs and items, compared without regard to case. */
  readonly repo?: string;
  /** One state chip of the runs ledger: only those runs. */
  readonly runs?: RunBucketFilter;
  /** The weekly trends, or the ready queue, instead of the belt and the runs list. */
  readonly view?: "trends" | "queue";
}

/** The `/factory` route's search: each filter that is a non-empty string, and nothing else. */
export const validateFactorySearch = (raw: Record<string, unknown>): FactorySearch => ({
  ...(typeof raw.environment === "string" && raw.environment
    ? { environment: raw.environment }
    : {}),
  ...(typeof raw.repo === "string" && raw.repo ? { repo: raw.repo } : {}),
  ...(isRunBucket(raw.runs) ? { runs: raw.runs } : {}),
  ...(raw.view === "trends" || raw.view === "queue" ? { view: raw.view } : {}),
});
