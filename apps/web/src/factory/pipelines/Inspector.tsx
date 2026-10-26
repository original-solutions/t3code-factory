import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import type { Selection } from "./editorState";
import { kindLabel, nodeName } from "./model";
import type {
  Check,
  KindInfo,
  Pipeline,
  PipelineEdge,
  PipelineNode,
  Problem,
  SkillInfo,
} from "./types";

type Mode = "none" | "skill" | "brief" | "commands";

const modeOf = (value: Check | undefined): Mode =>
  value === undefined
    ? "none"
    : "skill" in value
      ? "skill"
      : "brief" in value
        ? "brief"
        : "commands";

const MODE_LABEL: Record<Mode, string> = {
  none: "None",
  skill: "Skill",
  brief: "Brief",
  commands: "Commands",
};

function SkillPicker({
  skills,
  value,
  onChange,
}: {
  skills: ReadonlyArray<SkillInfo>;
  value: string;
  onChange: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = skills.filter(
    (skill) =>
      needle === "" ||
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle),
  );
  const names = skills.map((skill) => skill.name);
  const selected = skills.find((skill) => skill.name === value);
  return (
    <div className="flex flex-col gap-1.5">
      <Combobox
        filteredItems={shown.map((skill) => skill.name)}
        items={names}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
        value={value === "" ? null : value}
      >
        <ComboboxTrigger
          aria-label="Pick a skill"
          className="w-full justify-between"
          render={<Button size="sm" variant="outline" />}
        >
          <span className="min-w-0 truncate">{value === "" ? "Choose a skill" : value}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          className="w-80 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
        >
          <ComboboxSearchInput
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills..."
            value={query}
          />
          <ComboboxEmpty>No skill matches.</ComboboxEmpty>
          <ComboboxList className="max-h-72 min-w-0 overflow-x-hidden">
            {shown.map((skill) => (
              <ComboboxItem className="w-full min-w-0" key={skill.name} value={skill.name}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{skill.name}</span>
                  {skill.description ? (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {skill.description}
                    </span>
                  ) : null}
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {selected?.description ? (
        <p className="text-xs text-muted-foreground">{selected.description}</p>
      ) : value !== "" && selected === undefined ? (
        <p className="text-xs text-warning-foreground">This machine has no skill named {value}.</p>
      ) : null}
    </div>
  );
}

/**
 * A skill, a brief, commands, or (for a transition) nothing. Switching modes keeps what was typed
 * in the others, so a person who peeks at Skill does not lose a brief.
 */
function InstructionsEditor({
  label,
  modes,
  value,
  skills,
  onChange,
}: {
  label: string;
  modes: ReadonlyArray<Mode>;
  value: Check | undefined;
  skills: ReadonlyArray<SkillInfo>;
  onChange: (value: Check | undefined) => void;
}) {
  const mode = modeOf(value);
  const [kept, setKept] = useState(() => ({
    skill: value !== undefined && "skill" in value ? value.skill : "",
    brief: value !== undefined && "brief" in value ? value.brief : "",
    commands: value !== undefined && "commands" in value ? value.commands.join("\n") : "",
  }));
  const commandsOf = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const valueFor = (next: Mode, memory: typeof kept): Check | undefined =>
    next === "none"
      ? undefined
      : next === "skill"
        ? { skill: memory.skill }
        : next === "brief"
          ? { brief: memory.brief }
          : { commands: commandsOf(memory.commands) };
  const update = (patch: Partial<typeof kept>) => {
    const memory = { ...kept, ...patch };
    setKept(memory);
    onChange(valueFor(mode, memory));
  };
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <ToggleGroup
        aria-label={label}
        onValueChange={(values) => {
          const next = values[0] as Mode | undefined;
          if (next !== undefined && next !== mode) onChange(valueFor(next, kept));
        }}
        value={[mode]}
      >
        {modes.map((option) => (
          <Toggle key={option} value={option}>
            {MODE_LABEL[option]}
          </Toggle>
        ))}
      </ToggleGroup>
      {mode === "skill" ? (
        <SkillPicker onChange={(skill) => update({ skill })} skills={skills} value={kept.skill} />
      ) : mode === "brief" ? (
        <Textarea
          aria-label={`${label}: brief`}
          onChange={(event) => update({ brief: event.target.value })}
          placeholder="What the agent should do"
          rows={5}
          size="sm"
          value={kept.brief}
        />
      ) : mode === "commands" ? (
        <Textarea
          aria-label={`${label}: commands`}
          onChange={(event) => update({ commands: event.target.value })}
          placeholder="One command per line"
          rows={4}
          size="sm"
          value={kept.commands}
        />
      ) : (
        <p className="text-xs text-muted-foreground">The node's own instructions are sent again.</p>
      )}
    </div>
  );
}

function ProblemList({ problems }: { problems: ReadonlyArray<Problem> }) {
  if (problems.length === 0) return null;
  return (
    <ul aria-label="Problems" className="flex flex-col gap-1.5">
      {problems.map((problem) => (
        <li
          className="flex items-start gap-2 text-xs"
          key={`${problem.level} ${problem.node ?? ""} ${problem.edge ?? ""} ${problem.message}`}
        >
          <span
            aria-hidden="true"
            className={
              problem.level === "error"
                ? "mt-1 size-2 shrink-0 rounded-full bg-destructive"
                : "mt-1 size-2 shrink-0 rounded-full bg-warning"
            }
          />
          <span className="min-w-0 break-words">{problem.message}</span>
        </li>
      ))}
    </ul>
  );
}

const withLabel = (node: PipelineNode, label: string): PipelineNode => {
  const { label: _, ...rest } = node;
  return (label === "" ? rest : { ...rest, label }) as PipelineNode;
};

function NodeFields({
  node,
  kinds,
  skills,
  onChange,
}: {
  node: PipelineNode;
  kinds: ReadonlyArray<KindInfo>;
  skills: ReadonlyArray<SkillInfo>;
  /** `field` names what changed, so typing in one field is one undo step. */
  onChange: (node: PipelineNode, field: string) => void;
}) {
  const info = kinds.find((kind) => kind.kind === node.kind);
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{kindLabel(kinds, node.kind)}</span>
        {info ? <p className="text-xs text-muted-foreground">{info.description}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pipeline-node-label">Label</Label>
        <Input
          id="pipeline-node-label"
          onChange={(event) => onChange(withLabel(node, event.target.value), "label")}
          placeholder={kindLabel(kinds, node.kind)}
          size="sm"
          value={node.label ?? ""}
        />
      </div>
      {node.kind === "agent" ? (
        <>
          <InstructionsEditor
            label="Instructions"
            modes={["skill", "brief"]}
            onChange={(value) => {
              if (value !== undefined && !("commands" in value))
                onChange({ ...node, instructions: value }, "instructions");
            }}
            skills={skills}
            value={node.instructions}
          />
        </>
      ) : null}
      {node.kind === "learn" ? (
        <InstructionsEditor
          label="Instructions"
          modes={["skill", "brief"]}
          onChange={(value) => {
            if (value !== undefined && !("commands" in value))
              onChange({ ...node, instructions: value }, "instructions");
          }}
          skills={skills}
          value={node.instructions}
        />
      ) : null}
      {node.kind === "verify" ? (
        <InstructionsEditor
          label="Check"
          modes={["commands", "skill", "brief"]}
          onChange={(value) => {
            if (value !== undefined) onChange({ ...node, check: value }, "check");
          }}
          skills={skills}
          value={node.check}
        />
      ) : null}
      {node.kind === "end" ? (
        <div className="flex flex-col gap-2">
          <Label>Result</Label>
          <Select
            items={[
              { value: "done", label: "Done" },
              { value: "stuck", label: "Stuck" },
            ]}
            onValueChange={(result) => {
              if (result === "done" || result === "stuck") onChange({ ...node, result }, "result");
            }}
            value={node.result}
          >
            <SelectTrigger aria-label="Result" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="done">Done</SelectItem>
              <SelectItem value="stuck">Stuck</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      ) : null}
    </>
  );
}

function EdgeFields({
  edge,
  pipeline,
  kinds,
  skills,
  onChange,
}: {
  edge: PipelineEdge;
  pipeline: Pipeline;
  kinds: ReadonlyArray<KindInfo>;
  skills: ReadonlyArray<SkillInfo>;
  onChange: (edge: PipelineEdge, field: string) => void;
}) {
  const nameOf = (id: string) => {
    const node = pipeline.nodes.find((candidate) => candidate.id === id);
    return node === undefined ? id : nodeName(kinds, node);
  };
  const { max: _max, instructions: _instructions, ...base } = edge;
  return (
    <>
      <p className="text-sm">
        From {nameOf(edge.from)} · {edge.port} → {nameOf(edge.to)}
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pipeline-edge-max">Loop limit</Label>
        <NumberField
          id="pipeline-edge-max"
          min={1}
          onValueChange={(value) =>
            onChange(
              value === null
                ? { ...base, ...(edge.instructions ? { instructions: edge.instructions } : {}) }
                : { ...edge, max: Math.max(1, Math.round(value)) },
              "max",
            )
          }
          size="sm"
          value={edge.max ?? null}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput aria-label="Loop limit" placeholder="No limit" />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
        <p className="text-xs text-muted-foreground">
          How many times a run may take this transition. Empty means no limit.
        </p>
      </div>
      <InstructionsEditor
        label="What to tell the agent when this transition is taken"
        modes={["none", "skill", "brief"]}
        onChange={(value) =>
          onChange(
            value === undefined || "commands" in value
              ? { ...base, ...(edge.max === undefined ? {} : { max: edge.max }) }
              : { ...edge, instructions: value },
            "instructions",
          )
        }
        skills={skills}
        value={edge.instructions}
      />
    </>
  );
}

/** The right panel's editing body for the selected node or transition. */
export function Inspector({
  pipeline,
  kinds,
  skills,
  selection,
  problems,
  onNodeChange,
  onEdgeChange,
  onDelete,
}: {
  pipeline: Pipeline;
  kinds: ReadonlyArray<KindInfo>;
  skills: ReadonlyArray<SkillInfo>;
  selection: Selection;
  problems: ReadonlyArray<Problem>;
  onNodeChange: (node: PipelineNode, field: string) => void;
  onEdgeChange: (edge: PipelineEdge, field: string) => void;
  onDelete: () => void;
}) {
  const node =
    selection?.kind === "node" ? pipeline.nodes.find((n) => n.id === selection.id) : undefined;
  const edge =
    selection?.kind === "edge" ? pipeline.edges.find((e) => e.id === selection.id) : undefined;
  if (node === undefined && edge === undefined) {
    const general = problems.filter((problem) => !problem.node && !problem.edge);
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Select a node or a transition to edit it. Drag from a port to another node to connect
          them.
        </p>
        <ProblemList problems={general} />
      </div>
    );
  }
  const own = problems.filter((problem) =>
    node ? problem.node === node.id : problem.edge === edge!.id,
  );
  return (
    <div className="flex flex-col gap-4">
      {node ? (
        <NodeFields kinds={kinds} node={node} onChange={onNodeChange} skills={skills} />
      ) : (
        <EdgeFields
          edge={edge!}
          kinds={kinds}
          onChange={onEdgeChange}
          pipeline={pipeline}
          skills={skills}
        />
      )}
      <ProblemList problems={own} />
      <div>
        <Button onClick={onDelete} size="sm" variant="destructive-outline">
          <Trash2Icon />
          {node ? "Delete node" : "Delete transition"}
        </Button>
      </div>
    </div>
  );
}
