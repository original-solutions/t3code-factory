import { describe, expect, it } from "vite-plus/test";

import { readResult } from "./resultLine.ts";

describe("readResult", () => {
  it("reads FACTORY-DONE with a pull request URL on any repo", () => {
    expect(
      readResult("Built it.\n\nFACTORY-DONE: https://github.com/acme/widgets/pull/42\n"),
    ).toEqual({ kind: "done", text: "https://github.com/acme/widgets/pull/42", pr: 42 });
  });

  it("finds the pull request inside a summary and ignores trailing punctuation", () => {
    expect(readResult("FACTORY-DONE: opened https://github.com/a/b/pull/7.")).toEqual({
      kind: "done",
      text: "opened https://github.com/a/b/pull/7.",
      pr: 7,
    });
  });

  it("reads FACTORY-DONE with a summary and no pull request, or bare", () => {
    expect(readResult("FACTORY-DONE: wrote the skill")).toEqual({
      kind: "done",
      text: "wrote the skill",
      pr: null,
    });
    expect(readResult("Looks good.\nFACTORY-DONE")).toEqual({ kind: "done", text: "", pr: null });
  });

  it("does not take an issue URL as a pull request", () => {
    expect(readResult("FACTORY-DONE: see https://github.com/a/b/issues/7")).toMatchObject({
      pr: null,
    });
  });

  it("reads the questions before FACTORY-STOP: needs-info", () => {
    expect(readResult("1. Which base?\n2. Which name?\n\nFACTORY-STOP: needs-info")).toEqual({
      kind: "questions",
      questions: "1. Which base?\n2. Which name?",
    });
  });

  it("stops when needs-info has no questions", () => {
    expect(readResult("FACTORY-STOP: needs-info")).toMatchObject({ kind: "stop" });
  });

  it("reads FACTORY-STOP: stuck with the reasons before it", () => {
    expect(readResult("The tests cannot run here.\nFACTORY-STOP: stuck")).toEqual({
      kind: "stop",
      text: "The tests cannot run here.",
    });
  });

  it("answers none for no message, a blank one, or no marker on the last line", () => {
    expect(readResult(null)).toEqual({ kind: "none" });
    expect(readResult("  \n")).toEqual({ kind: "none" });
    expect(readResult("FACTORY-DONE: x\nand then some more")).toEqual({ kind: "none" });
    expect(readResult("FACTORY-DONEish")).toEqual({ kind: "none" });
  });
});
