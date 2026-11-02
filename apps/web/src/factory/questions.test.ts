import { describe, expect, it } from "vite-plus/test";

import { composeReply, splitQuestions } from "./questions";

describe("splitQuestions", () => {
  it("takes the numbered list under a Questions heading, with each item's indented lines", () => {
    const text = [
      "I've built it but stopped.",
      "",
      "**What's on the branch:**",
      "1. `3790b6a4` test: written first.",
      "2. `f55a13d9` feat: the config.",
      "",
      "**Questions:**",
      "1. The issue says **demote**. Keep the narrower rule, or demote on every failure?",
      "2. Retry every 5xx,",
      "   or only 500, 502, 503 and 504?",
      "   - the test needs a 500",
      "",
      "## Lessons",
      "- none",
    ].join("\n");
    expect(splitQuestions(text)).toEqual([
      "The issue says demote. Keep the narrower rule, or demote on every failure?",
      "Retry every 5xx,\nor only 500, 502, 503 and 504?\n- the test needs a 500",
    ]);
  });

  it("finds one question under a singular heading", () => {
    const text =
      "Draft PR open.\n\n**Question**\n\n1. **For a past day, which employer?** It differs.";
    expect(splitQuestions(text)).toEqual(["For a past day, which employer? It differs."]);
  });

  it("without a heading, takes the last numbered list whose every item asks something", () => {
    const text = [
      "Stopping.",
      "",
      "1. Where does the select get its list? No endpoint returns it.",
      "",
      "2. Which roles can see it?",
      "",
      "Nothing was committed.",
    ].join("\n");
    expect(splitQuestions(text)).toEqual([
      "Where does the select get its list? No endpoint returns it.",
      "Which roles can see it?",
    ]);
  });

  it("finds nothing in a post with no numbered questions", () => {
    expect(splitQuestions("The issue cannot be built: what should the port cut be?")).toEqual([]);
    expect(splitQuestions("Found:\n1. a file is missing.\n2. another one.")).toEqual([]);
  });
});

describe("composeReply", () => {
  it("quotes each answered question above its answer and leaves unanswered ones out", () => {
    expect(
      composeReply(["Keep it,\nor not?", "Which 5xx?", "Third?"], ["Keep it.", "", "  All.  "]),
    ).toBe("> **1.** Keep it,\n> or not?\n\nKeep it.\n\n> **3.** Third?\n\nAll.\n");
  });

  it("answers the whole post when it had no numbered questions", () => {
    expect(composeReply([], ["Use the second reading."])).toBe("Use the second reading.\n");
    expect(composeReply([], ["  "])).toBe("");
  });
});
