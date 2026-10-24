import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useProjects } from "~/state/entities";

import { messageOf } from "../format";
import { pipelineApi, runProblemsOf } from "./api";
import type { Problem, RunSummary } from "./types";

const rememberedKey = (environmentId: EnvironmentId) =>
  `t3code:factory:pipeline-run-project:${environmentId}`;

/** The project last run on in this environment, so a second run is one click. Storage may be off. */
const readRemembered = (environmentId: EnvironmentId): string | null => {
  try {
    return window.localStorage.getItem(rememberedKey(environmentId));
  } catch {
    return null;
  }
};

const remember = (environmentId: EnvironmentId, projectRoot: string) => {
  try {
    window.localStorage.setItem(rememberedKey(environmentId), projectRoot);
  } catch {
    // A browser that refuses storage just asks again next time.
  }
};

/** Starts a run of the saved pipeline on one of the environment's projects, optionally on an issue. */
export function RunDialog({
  environmentId,
  pipelineId,
  open,
  dirty,
  onOpenChange,
  onStarted,
}: {
  environmentId: EnvironmentId;
  pipelineId: string;
  open: boolean;
  /** The editor has unsaved changes, which the run will not see. */
  dirty: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (run: RunSummary) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const [chosen, setChosen] = useState<string | null>(() => readRemembered(environmentId));
  // A remembered project this environment no longer has is no choice at all.
  const projectRoot = projects.some((project) => project.workspaceRoot === chosen) ? chosen : null;
  const choose = (root: string | null) => {
    setChosen(root);
    if (root !== null) remember(environmentId, root);
  };
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ReadonlyArray<Problem>>([]);
  const issueNumber = issue.trim() === "" ? undefined : Number(issue.trim());
  const issueValid =
    issueNumber === undefined || (Number.isInteger(issueNumber) && issueNumber > 0);

  // Closing clears what the last attempt left, so the next open starts clean; the project stays.
  const changeOpen = (next: boolean) => {
    if (!next) {
      setIssue("");
      setError(null);
      setProblems([]);
    }
    onOpenChange(next);
  };

  const start = async () => {
    if (projectRoot === null || !issueValid) return;
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const { run } = await pipelineApi.run(environmentId, pipelineId, {
        projectRoot,
        ...(issueNumber === undefined ? {} : { issue: issueNumber }),
      });
      onStarted(run);
      changeOpen(false);
    } catch (cause) {
      const refused = runProblemsOf(cause);
      if (refused !== null) {
        setError("The saved pipeline has errors, so it cannot run.");
        setProblems(refused.filter((problem) => problem.level === "error"));
      } else setError(messageOf(cause));
    }
    setBusy(false);
  };

  const items = projects.map((project) => ({
    value: project.workspaceRoot,
    label: project.title,
  }));

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Run pipeline</DialogTitle>
          <DialogDescription>
            The run works in the project's workspace and follows the pipeline as last saved.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {dirty ? (
            <p className="text-sm text-warning-foreground">
              You have unsaved changes. Save first if the run should use them.
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label>Project</Label>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">This environment has no projects.</p>
            ) : (
              <Select items={items} onValueChange={choose} value={projectRoot}>
                <SelectTrigger aria-label="Project">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.workspaceRoot}>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{project.title}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pipeline-run-issue">Issue (optional)</Label>
            <Input
              aria-invalid={!issueValid || undefined}
              id="pipeline-run-issue"
              inputMode="numeric"
              onChange={(event) => setIssue(event.target.value)}
              placeholder="e.g. 42"
              value={issue}
            />
            <p className="text-xs text-muted-foreground">
              Ask and pull request nodes need an issue on a repo the factory watches.
            </p>
          </div>
          {error ? (
            <div className="flex flex-col gap-1" role="alert">
              <p className="text-sm text-destructive-foreground">{error}</p>
              {problems.map((problem) => (
                <p
                  className="text-xs text-muted-foreground"
                  key={`${problem.node ?? ""} ${problem.edge ?? ""} ${problem.message}`}
                >
                  {problem.message}
                </p>
              ))}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={() => changeOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={busy || projectRoot === null || !issueValid}
            onClick={() => void start()}
          >
            Start run
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
