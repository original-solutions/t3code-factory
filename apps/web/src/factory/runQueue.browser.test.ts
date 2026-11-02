import { describe, expect, it } from "vite-plus/test";

import { factoryKey, runQueue, stepInQueue } from "./runQueue";

const queue = runQueue({ search: { runs: "attention" }, query: "flaky" }, [
  { environmentId: "env-1", runId: "a", title: "First" },
  { environmentId: "env-2", runId: "a", title: "Same id, other environment" },
  { environmentId: "env-1", runId: "c", title: null },
]);

describe("stepInQueue", () => {
  it("places a run by environment and id, with its neighbours", () => {
    expect(stepInQueue(queue, "env-2", "a")).toEqual({
      position: 2,
      total: 3,
      title: "Same id, other environment",
      previous: queue.runs[0],
      next: queue.runs[2],
    });
    expect(stepInQueue(queue, "env-1", "a")).toMatchObject({ position: 1, previous: null });
    expect(stepInQueue(queue, "env-1", "c")).toMatchObject({ position: 3, next: null });
  });

  it("is null with no queue or a run the queue does not hold", () => {
    expect(stepInQueue(undefined, "env-1", "a")).toBeNull();
    expect(stepInQueue(queue, "env-1", "b")).toBeNull();
  });
});

describe("factoryKey", () => {
  const press = (key: string, over: Partial<Parameters<typeof factoryKey>[0]> = {}) =>
    factoryKey({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      target: document.body,
      ...over,
    });

  it("maps j, k, Escape and /", () => {
    expect([press("j"), press("k"), press("Escape"), press("/"), press("x")]).toEqual([
      "next",
      "previous",
      "back",
      "search",
      null,
    ]);
  });

  it("maps ? to the key list, with or without Shift, and each section's letter to it", () => {
    expect([press("?"), press("?", { shiftKey: true })]).toEqual(["help", "help"]);
    expect(["b", "a", "n", "s", "r"].map((key) => press(key))).toEqual([
      "belt",
      "attention",
      "info",
      "stuck",
      "runs",
    ]);
    expect(press("s", { shiftKey: true })).toBeNull();
  });

  it("leaves arrows to scroll the page", () => {
    expect([press("ArrowDown"), press("ArrowUp")]).toEqual([null, null]);
  });

  it("ignores a key with a modifier, or one something else took", () => {
    expect(press("j", { metaKey: true })).toBeNull();
    expect(press("k", { ctrlKey: true })).toBeNull();
    expect(press("j", { shiftKey: true })).toBeNull();
    expect(press("Escape", { defaultPrevented: true })).toBeNull();
  });

  it("ignores keys typed into a field or pressed inside a popup", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    const option = listbox.appendChild(document.createElement("div"));
    document.body.append(input, editable, listbox);
    try {
      expect(press("j", { target: input })).toBeNull();
      expect(press("/", { target: editable })).toBeNull();
      expect(press("Escape", { target: option })).toBeNull();
    } finally {
      input.remove();
      editable.remove();
      listbox.remove();
    }
  });
});
