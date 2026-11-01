import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FactoryAttentionItem } from "./api";
import { attentionNews, tapOf } from "./shoulderTap";

const env = "env-1" as EnvironmentId;

const item = (over: Partial<FactoryAttentionItem> & { id: string }): FactoryAttentionItem => ({
  kind: "attention",
  repo: null,
  issue: null,
  run: null,
  message: "low disk",
  first_seen: "2026-11-01T00:00:00.000Z",
  ...over,
});

const stuck = item({
  id: "run:acme__web__12__1:stuck",
  kind: "stuck",
  repo: "acme/web",
  issue: 12,
  run: "acme__web__12__1",
  message: "acme/web: the gate failed 3 times",
});

const signedOut = (repo: string | null) =>
  item({
    id: repo === null ? "pass-errors" : `config-not-loaded:${repo}`,
    repo,
    message: `${repo ?? "the pass"}: last error: exited with status 4: please run: gh auth login`,
  });

describe("attentionNews", () => {
  it("takes the first read as what was already there, with no news", () => {
    const { fresh, seen } = attentionNews(undefined, [stuck]);
    expect(fresh).toEqual([]);
    expect([...seen]).toEqual([stuck.id]);
  });

  it("reports only items the last read lacked, and forgets dismissed ones", () => {
    const disk = item({ id: "low-disk" });
    const first = attentionNews(undefined, [disk]);
    const second = attentionNews(first.seen, [disk, stuck]);
    expect(second.fresh).toEqual([stuck]);
    const third = attentionNews(second.seen, [stuck]);
    expect(third.fresh).toEqual([]);
    // Dismissed, then raised again: news again.
    expect(attentionNews(third.seen, [stuck, disk]).fresh).toEqual([disk]);
  });

  it("takes an item brought back from Dismissed as seen, not news", () => {
    const disk = item({ id: "low-disk" });
    const quiet = attentionNews(new Set(), [stuck], [disk]);
    expect(attentionNews(quiet.seen, [stuck, disk]).fresh).toEqual([]);
  });

  it("takes a signed-out gh as news once, not again for each repo it then fails", () => {
    const first = attentionNews(new Set(), [signedOut("acme/web")]);
    expect(first.fresh).toEqual([signedOut("acme/web")]);
    expect(attentionNews(first.seen, [signedOut("acme/web"), signedOut("acme/api")]).fresh).toEqual(
      [],
    );
  });
});

describe("tapOf", () => {
  it("names a stuck or needs-info run and opens its page", () => {
    expect(tapOf(env, null, [stuck])).toEqual({
      title: "acme/web #12 is stuck",
      body: "the gate failed 3 times",
      runId: "acme__web__12__1",
      environmentId: env,
    });
    const info = item({
      id: "run:acme__web__7__2:needs-info",
      kind: "needs-info",
      repo: "acme/web",
      issue: 7,
      run: "acme__web__7__2",
      message: "session asked questions",
    });
    expect(tapOf(env, "Studio Mac", [info])).toMatchObject({
      title: "acme/web #7 needs info",
      body: "session asked questions · Studio Mac",
      runId: "acme__web__7__2",
    });
  });

  it("calls any other item the factory needing you, and opens the Factory page", () => {
    expect(
      tapOf(env, null, [
        item({ id: "c", repo: "acme/api", message: "acme/api: project config not loaded" }),
      ]),
    ).toEqual({
      title: "The factory needs you",
      body: "acme/api: project config not loaded",
      runId: null,
      environmentId: env,
    });
  });

  it("folds a burst into one tap that counts it and names the first two", () => {
    const tap = tapOf(env, null, [
      stuck,
      item({ id: "a", message: "low disk" }),
      item({ id: "b", message: "the pass has failed 3 times" }),
    ]);
    expect(tap).toEqual({
      title: "3 new things need you in the factory",
      body: "acme/web #12 is stuck · low disk · and 1 more",
      runId: null,
      environmentId: env,
    });
  });

  it("tells a signed-out gh as one sign-in, however many items it raised at once", () => {
    expect(
      tapOf(env, null, [signedOut("acme/web"), signedOut("acme/api"), signedOut(null)]),
    ).toEqual({
      title: "The factory's gh is signed out",
      body: "The factory's gh is signed out, so it cannot read any of its 2 repos: web, api.",
      runId: null,
      environmentId: env,
    });
    expect(tapOf(env, null, [stuck, signedOut("acme/web"), signedOut("acme/api")])).toMatchObject({
      title: "2 new things need you in the factory",
      body: "acme/web #12 is stuck · GitHub sign-in",
    });
  });

  it("clips a long message", () => {
    const tap = tapOf(env, null, [item({ id: "x", message: "y".repeat(400) })]);
    expect(tap.body.length).toBeLessThanOrEqual(160);
    expect(tap.body.endsWith("…")).toBe(true);
  });
});
