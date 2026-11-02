import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "~/components/ui/toast";

import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import {
  __resetStopDeskForTests,
  onStopAnswered,
  requestStop,
  STOP_GRACE_MS,
  stopNews,
  undoStop,
} from "./stopDesk";

const env = "env-1" as EnvironmentId;
const RUN = "acme__web__12__1";

const desk = (stopRun: FactoryApi["stopRun"]) => {
  vi.useFakeTimers();
  __setFactoryApiForTests({ stopRun } as unknown as FactoryApi);
  const add = vi.spyOn(toastManager, "add");
  const answered = vi.fn();
  const off = onStopAnswered(answered);
  return {
    add,
    answered,
    titles: () => add.mock.calls.map(([options]) => options.title),
    [Symbol.dispose]: () => {
      off();
      add.mockRestore();
      __resetStopDeskForTests();
      __setFactoryApiForTests();
      vi.useRealTimers();
    },
  };
};

describe("the stop desk", () => {
  it("sends a stop only once its grace is over, then says so and reads the environment again", async () => {
    const stopRun = vi.fn(async () => ({
      stopped: RUN,
      already: false,
      message: "stop requested",
    }));
    using d = desk(stopRun);
    requestStop(env, RUN);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(stopRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopRun).toHaveBeenCalledWith(env, RUN);
    expect(d.answered).toHaveBeenCalledWith(env);
    expect(d.titles()).toEqual(["Stopping web #12", "Stop sent for web #12"]);
    requestStop(env, RUN);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(stopRun).toHaveBeenCalledTimes(1);
  });

  it("never sends a stop taken back in its grace", async () => {
    const stopRun = vi.fn(async () => ({ stopped: RUN, already: false, message: "" }));
    using d = desk(stopRun);
    requestStop(env, RUN);
    undoStop(env, RUN);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS * 2);
    expect(stopRun).not.toHaveBeenCalled();
    expect(d.answered).not.toHaveBeenCalled();
    expect(d.titles()).toEqual(["Stopping web #12", "web #12 keeps building"]);
  });

  it("sends one stop for a run asked twice", async () => {
    const stopRun = vi.fn(async () => ({ stopped: RUN, already: false, message: "" }));
    using _d = desk(stopRun);
    requestStop(env, RUN);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS / 2);
    requestStop(env, RUN);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(stopRun).toHaveBeenCalledTimes(1);
  });

  it("says why a refused stop was not made, and keeps that toast until it is closed", async () => {
    using d = desk(async () => {
      throw new FactoryApiError(409, "not_building", "run is not building");
    });
    requestStop(env, RUN);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(d.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        title: "web #12 was not stopped",
        description: "run is not building",
        timeout: 0,
      }),
    );
    expect(d.answered).toHaveBeenCalledWith(env);
  });
});

describe("stopNews", () => {
  it("says what a stop will do before it is sent, and how to build again after", () => {
    expect(stopNews(RUN, { kind: "pending" }).description).toContain("set to factory:stuck");
    expect(
      stopNews(RUN, {
        kind: "answered",
        result: { stopped: RUN, already: true, message: "" },
      }),
    ).toMatchObject({
      title: "web #12 was already stopping",
      description: expect.stringContaining("set factory:ready on the issue"),
    });
  });
});
