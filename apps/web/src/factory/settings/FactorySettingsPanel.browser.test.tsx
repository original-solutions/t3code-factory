import {
  AuthSettingsWriteScope,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act } from "../../../test/render";
import { renderAt } from "../testing";
import type { FactoryConfigResult, MachineConfigReport } from "./api";

const mocks = vi.hoisted(() => ({
  canWrite: true,
  environmentId: "env-1" as string | null,
  prepared: { httpBaseUrl: "http://t3.test", httpAuthorization: null },
  fetchFactoryConfig: vi.fn(),
  saveFactoryConfig: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<typeof import("@tanstack/react-router")>()),
    Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
      createElement("a", { ...rest, "data-to": to }, children),
  };
});
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (_id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    scope === AuthSettingsWriteScope && mocks.canWrite,
  usePreparedConnection: () => Option.some(mocks.prepared),
}));
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: mocks.environmentId === null ? null : { environmentId: mocks.environmentId },
  }),
}));
vi.mock("./api", () => ({
  fetchFactoryConfig: mocks.fetchFactoryConfig,
  saveFactoryConfig: mocks.saveFactoryConfig,
}));
// A DOM input drops `size="touch"`, which is not a number, so the size is kept where a test can read it.
vi.mock("../../components/ui/input", async () => {
  const { createElement } = await import("react");
  return {
    Input: ({ size, ...props }: { size?: string }) =>
      createElement("input", { ...props, "data-size": size }),
  };
});
vi.mock("../../components/ui/button", async () => {
  const { cloneElement } = await import("react");
  return {
    Button: "button",
    buttonVariants: () => "",
    InlineButton: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
      cloneElement(render, undefined, children),
  };
});
vi.mock("../../components/settings/settingsLayout", async () => {
  const { createElement } = await import("react");
  return {
    SettingsPageContainer: (props: { children: ReactNode }) =>
      createElement("div", null, props.children),
    SettingsSection: (props: { title: string; headerAction?: ReactNode; children: ReactNode }) =>
      createElement(
        "section",
        null,
        createElement("h2", null, props.title),
        props.headerAction,
        props.children,
      ),
    SettingsRow: (props: {
      title: string;
      description?: ReactNode;
      control?: ReactNode;
      children?: ReactNode;
    }) =>
      createElement(
        "div",
        null,
        createElement("h3", null, props.title),
        props.description,
        props.control,
        props.children,
      ),
  };
});

import { FactorySettingsPanel } from "./FactorySettingsPanel";

const FILE = "/home/t3/factory/config.yml";

const defaultsConfig = {
  gh_config_dir: "",
  poll_seconds: 60,
  max_concurrent_runs: 1,
  max_concurrent_gates: 2,
  feedback_seconds: 600,
};

const report = (overrides: Partial<MachineConfigReport> = {}): MachineConfigReport => ({
  file: FILE,
  exists: true,
  config: defaultsConfig,
  defaults: defaultsConfig,
  errors: [],
  repos: [],
  unresolved: [],
  watch_error: null,
  ...overrides,
});

const populated = report({
  config: {
    gh_config_dir: "/home/t3/gh",
    poll_seconds: 45,
    max_concurrent_runs: 3,
    max_concurrent_gates: 2,
    feedback_seconds: 300,
  },
  repos: [
    {
      repo: "acme/alpha",
      path: "/work/alpha",
      title: "Alpha",
      factory: {
        instructors: ["tom"],
        base: "develop",
        provision: ["vp i"],
        gate: ["vp test"],
        required_checks: ["ci"],
        limits: {
          minutes: 90,
          gate_retries: 1,
          checks_minutes: 30,
          interruption_resumes: 2,
        },
        autonomy: "pr",
      },
      errors: null,
    },
    {
      repo: "acme/beta",
      path: "/work/beta",
      title: "Beta",
      factory: null,
      errors: [{ file: "/work/beta/.dw/config.yml", message: "factory.gate must be a list" }],
    },
    { repo: "acme/gamma", path: "/work/gamma", title: "Gamma", factory: null, errors: null },
  ],
});

const ok = (value: MachineConfigReport): FactoryConfigResult => ({ kind: "ok", report: value });

/** The text under `node`, its text nodes joined by a space, so one node's text never runs into the next. */
const textOf = (node: Node): string =>
  Array.from(node.childNodes)
    .map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : textOf(child)))
    .join(" ");

describe("FactorySettingsPanel", () => {
  const resetMocks = () => {
    mocks.canWrite = true;
    mocks.environmentId = "env-1";
    mocks.fetchFactoryConfig.mockReset();
    mocks.saveFactoryConfig.mockReset();
  };

  const open = (widthPx = 1280) => renderAt(widthPx, <FactorySettingsPanel />);

  const input = (root: HTMLElement, label: string) => {
    const found = Array.from(root.querySelectorAll("input")).filter(
      (node) => node.getAttribute("aria-label") === label,
    );
    expect(found, `input "${label}"`).toHaveLength(1);
    return found[0]!;
  };
  const button = (root: HTMLElement, label: string) => {
    const found = Array.from(root.querySelectorAll("button")).filter(
      (node) => node.getAttribute("aria-label") === label || textOf(node).trim() === label,
    );
    expect(found, `button "${label}"`).toHaveLength(1);
    return found[0]!;
  };
  const type = async (node: HTMLInputElement, value: string) => {
    await act(async () => {
      // React tracks the value it last set, so the change has to go through the native setter.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (node: HTMLElement) => {
    await act(async () => {
      node.click();
    });
  };
  const field = (root: HTMLElement, name: string) =>
    root.querySelector<HTMLElement>(`div[data-field="${name}"]`) ?? undefined;
  const repoRows = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-repo]"));
  const openRepo = async (row: HTMLElement) => click(row.querySelector("button")!);

  const SAVED_KEYS = {
    gh_config_dir: "",
    poll_seconds: 60,
    max_concurrent_runs: 1,
    max_concurrent_gates: 2,
    feedback_seconds: 600,
  };

  // #93: the model is picked in T3 (the project's default, else Settings), not on this page.
  it("has no model rows: the page edits no model_instance or model", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue(ok(populated));
    await using panel = await open();
    const root = panel.container;

    expect(root.querySelectorAll('[aria-label="Model instance"]')).toHaveLength(0);
    expect(root.querySelectorAll('[aria-label="Model"]')).toHaveLength(0);
    expect(textOf(root)).not.toContain("Model");

    await click(button(root, "Save"));
    const sent = mocks.saveFactoryConfig.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "feedback_seconds",
      "gh_config_dir",
      "max_concurrent_gates",
      "max_concurrent_runs",
      "poll_seconds",
    ]);
  });

  it("shows the reported feedback seconds and saves an edited value", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue(ok(populated));
    await using panel = await open();
    const root = panel.container;

    expect(input(root, "Feedback seconds").value).toBe("300");
    expect(textOf(root)).toContain(
      "How often the factory looks for comments and reviews on a ready pull request. 0 reads on every pass.",
    );

    await type(input(root, "Feedback seconds"), "0");
    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      gh_config_dir: "/home/t3/gh",
      poll_seconds: 45,
      max_concurrent_runs: 3,
      max_concurrent_gates: 2,
      feedback_seconds: 0,
    });
  });

  it("shows an error on feedback_seconds beside its input, not at the top", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, field: "feedback_seconds", message: "must be an integer of at least 0" },
      ],
    });
    await using panel = await open();
    const root = panel.container;

    await click(button(root, "Save"));

    expect(textOf(field(root, "feedback_seconds")!)).toContain("must be an integer of at least 0");
    expect(root.querySelector('[data-testid="form-errors"]')).toBeNull();
  });

  it("shows the defaults when there is no file yet, and saving creates it", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report({ exists: false })));
    mocks.saveFactoryConfig.mockResolvedValue(ok(report({ exists: true })));
    await using panel = await open();
    const root = panel.container;

    expect(textOf(root)).toContain("No config file exists at");
    expect(textOf(root)).toContain(FILE);
    expect(input(root, "Poll seconds").value).toBe("60");
    expect(input(root, "Max concurrent gates").value).toBe("2");

    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, SAVED_KEYS);
    expect(textOf(root)).toContain("Saved");
    expect(textOf(root)).not.toContain("No config file exists");
  });

  it("shows a loading state while the config is in flight", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockReturnValue(new Promise(() => {}));
    await using panel = await open();
    const root = panel.container;

    expect(textOf(root)).toContain("Loading");
    expect(root.querySelectorAll("input")).toHaveLength(0);
  });

  it("shows a load error with a Retry that loads again", async () => {
    resetMocks();
    mocks.fetchFactoryConfig
      .mockResolvedValueOnce({ kind: "error", message: "the factory is unreachable" })
      .mockResolvedValueOnce(ok(populated));
    await using panel = await open();
    const root = panel.container;

    expect(textOf(root)).toContain("the factory is unreachable");
    expect(root.querySelectorAll("input")).toHaveLength(0);

    await click(button(root, "Retry"));

    expect(mocks.fetchFactoryConfig).toHaveBeenCalledTimes(2);
    expect(textOf(root)).not.toContain("the factory is unreachable");
    expect(input(root, "Poll seconds").value).toBe("45");
  });

  it("lists the errors of an invalid file and still lets the form be fixed", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(
        report({
          config: null,
          errors: [
            { file: FILE, message: "not valid YAML: unexpected end of stream" },
            { file: FILE, field: "poll_seconds", message: "must be a positive integer" },
          ],
        }),
      ),
    );
    mocks.saveFactoryConfig.mockResolvedValue(ok(report()));
    await using panel = await open();
    const root = panel.container;

    expect(textOf(root)).toContain("not valid YAML: unexpected end of stream");
    expect(textOf(root)).toContain("must be a positive integer");
    expect(textOf(field(root, "poll_seconds")!)).toContain("must be a positive integer");

    await type(input(root, "Poll seconds"), "30");
    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      poll_seconds: 30,
    });
    expect(textOf(root)).not.toContain("not valid YAML");
  });

  it("fills the form of an invalid file from its draft so only the bad field is fixed", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(
        report({
          config: null,
          draft: {
            gh_config_dir: "/home/t3/gh",
            poll_seconds: 45,
            max_concurrent_gates: "two" as unknown as number,
          },
          errors: [{ file: FILE, field: "max_concurrent_gates", message: "must be an integer" }],
        }),
      ),
    );
    mocks.saveFactoryConfig.mockResolvedValue(ok(report()));
    await using panel = await open();
    const root = panel.container;

    expect(input(root, "GitHub config directory").value).toBe("/home/t3/gh");
    expect(input(root, "Poll seconds").value).toBe("45");
    expect(input(root, "Max concurrent runs").value).toBe("1");
    expect(textOf(field(root, "max_concurrent_gates")!)).toContain("must be an integer");

    await type(input(root, "Max concurrent gates"), "3");
    await click(button(root, "Save"));

    expect(mocks.saveFactoryConfig).toHaveBeenCalledWith(mocks.prepared, {
      ...SAVED_KEYS,
      gh_config_dir: "/home/t3/gh",
      poll_seconds: 45,
      max_concurrent_gates: 3,
    });
  });

  it("lists every save error that names no input at the top", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, field: "gh_config_dir", message: "gh dir is bad" },
        { file: FILE, field: "notify", message: "must be true or false" },
        { file: FILE, message: "file level" },
      ],
    });
    await using panel = await open();
    const root = panel.container;

    await click(button(root, "Save"));

    const top = textOf(root.querySelector<HTMLElement>('[data-testid="form-errors"]')!);
    expect(top).toContain("must be true or false");
    expect(top).toContain("file level");
    expect(top).not.toContain("gh dir is bad");
    expect(textOf(field(root, "gh_config_dir")!)).toContain("gh dir is bad");
  });

  it("fills the form from the file", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    await using panel = await open();
    const root = panel.container;

    expect(input(root, "GitHub config directory").value).toBe("/home/t3/gh");
    expect(input(root, "Poll seconds").value).toBe("45");
    expect(input(root, "Max concurrent runs").value).toBe("3");
    expect(input(root, "Max concurrent gates").value).toBe("2");
  });

  it("lists two projects that name one repo as two blocks, with no duplicate key", async () => {
    resetMocks();
    const message =
      "2 T3 projects have this repo as their origin (/a, /b); the factory watches none";
    const twice = report({
      repos: [
        {
          repo: "acme/alpha",
          path: "/a",
          title: "Alpha",
          factory: null,
          errors: [{ file: ".dw/config.yml", message }],
        },
        {
          repo: "acme/alpha",
          path: "/b",
          title: "Alpha copy",
          factory: null,
          errors: [{ file: ".dw/config.yml", message }],
        },
      ],
    });
    mocks.fetchFactoryConfig.mockResolvedValue(ok(twice));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await using panel = await open();
      const root = panel.container;
      const text = textOf(root);
      expect(repoRows(root).map((row) => row.getAttribute("data-repo"))).toEqual([
        "acme/alpha",
        "acme/alpha",
      ]);
      expect(text).toContain("Alpha copy");
      expect(repoRows(root).map((row) => textOf(row).split(message).length)).toEqual([2, 2]);
      const duplicateKey = consoleError.mock.calls.filter((call) =>
        String(call[0]).includes("same key"),
      );
      expect(duplicateKey).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("lists the watched projects the API returns as a roster, errors first, read-only", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    await using panel = await open();
    const root = panel.container;

    const rows = repoRows(root);
    expect(
      rows.map((row) => [row.getAttribute("data-repo"), row.getAttribute("data-health")]),
    ).toEqual([
      ["acme/beta", "error"],
      ["acme/gamma", "unread"],
      ["acme/alpha", "ready"],
    ]);
    expect(textOf(root.querySelector('[data-testid="repo-summary"]')!)).toBe(
      "3 watched · 1 with errors · 1 not read yet",
    );
    // A closed row still says what is wrong.
    expect(textOf(rows[0]!)).toContain("factory.gate must be a list");
    expect(textOf(rows[2]!)).toContain("develop · 1 gate command");
    expect(textOf(root)).not.toContain("/work/alpha");

    for (const row of rows) await openRepo(row);
    const text = textOf(root);
    expect(text).toContain("acme/alpha");
    expect(text).toContain("/work/alpha");
    expect(text).toContain("/work/gamma");
    expect(text).toContain("tom");
    expect(text).toContain("develop");
    expect(text).toContain("vp test");
    expect(text).toContain("factory.gate must be a list");
    expect(text).toContain("Not read yet");

    const links = Array.from(root.querySelectorAll("a")).filter((node) =>
      textOf(node).includes("View .dw/config.yml on GitHub"),
    );
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/beta/blob/HEAD/.dw/config.yml",
      "https://github.com/acme/gamma/blob/HEAD/.dw/config.yml",
      "https://github.com/acme/alpha/blob/develop/.dw/config.yml",
    ]);

    // The hint is there, and the page can neither add nor remove a repo.
    expect(text).toContain("added as T3 projects");
    expect(text).not.toContain("No T3 project on this environment has one yet");
    expect(root.querySelectorAll("input")).toHaveLength(5);
    // The errors sit in a paragraph: they are spans, never a list.
    expect(root.querySelectorAll("ul, li")).toHaveLength(0);
  });

  it("marks a repo running on the machine's default and shows the block it resolved to", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(
        report({
          repos: [
            {
              repo: "rawphp/agent-doctor",
              path: "/work/agent-doctor",
              title: "Agent doctor",
              default_config: true,
              factory: {
                instructors: ["tomkaczocha", "rawphp"],
                base: "main",
                provision: ["npm ci"],
                gate: ["npm run build", "npm run test", "npm run format:check"],
                required_checks: [],
                limits: {
                  minutes: 180,
                  gate_retries: 2,
                  checks_minutes: 30,
                  interruption_resumes: 2,
                },
                autonomy: "pr",
              },
              errors: null,
            },
          ],
        }),
      ),
    );
    await using panel = await open();
    const root = panel.container;

    // A lone repo opens by itself.
    const text = textOf(root);
    expect(repoRows(root)[0]!.getAttribute("data-health")).toBe("default");
    expect(text).toContain("Defaults");
    expect(text).toContain("Default config");
    expect(text).toContain("npm run build, npm run test, npm run format:check");
    expect(text).toContain("npm ci");
    expect(text).toContain("tomkaczocha, rawphp");
    // There is no .dw/config.yml to link to.
    expect(text).not.toContain("View .dw/config.yml on GitHub");
  });

  it("shows the one-line hint when no T3 project is watched", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report()));
    await using panel = await open();
    const root = panel.container;

    const text = textOf(root);
    expect(text).toContain("Repos are added as T3 projects");
    expect(text).toContain("No T3 project on this environment has one yet.");
    expect(repoRows(root)).toHaveLength(0);
  });

  it("names the checkouts the factory could not settle instead of saying none is watched", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(report({ unresolved: ["/work/slow"] })));
    await using panel = await open();
    const root = panel.container;

    const text = textOf(root);
    expect(text).toContain("Not settled on the last read");
    expect(text).toContain("/work/slow");
    expect(text).toContain("Nothing is dropped for them");
    expect(text).not.toContain("No T3 project on this environment has one yet");
    const lists = Array.from(root.querySelectorAll("ul, li"));
    expect(lists.filter((node) => node.closest("[data-factory-setup]") === null)).toHaveLength(0);
  });

  it("shows why the T3 projects could not be listed instead of saying none is watched", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(
      ok(report({ watch_error: "cannot list the T3 projects: store down" })),
    );
    await using panel = await open();
    const root = panel.container;

    const text = textOf(root);
    expect(text).toContain("T3 projects not listed");
    expect(text).toContain("cannot list the T3 projects: store down");
    expect(text).not.toContain("No T3 project on this environment has one yet");
    expect(repoRows(root)).toHaveLength(0);
  });

  it("shows save errors next to the field they name and file errors at the top", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    mocks.saveFactoryConfig.mockResolvedValue({
      kind: "invalid",
      errors: [
        { file: FILE, message: "unknown key: colour" },
        { file: FILE, field: "max_concurrent_runs", message: "must be at least 1" },
        { file: FILE, field: "poll_seconds", message: "must be at least 10" },
      ],
    });
    await using panel = await open();
    const root = panel.container;

    await click(button(root, "Save"));

    const top = root.querySelector<HTMLElement>('[data-testid="form-errors"]')!;
    expect(textOf(top)).toContain("unknown key: colour");
    expect(textOf(top)).not.toContain("must be at least");
    expect(textOf(field(root, "max_concurrent_runs")!)).toContain("must be at least 1");
    expect(textOf(field(root, "poll_seconds")!)).toContain("must be at least 10");
    expect(textOf(field(root, "max_concurrent_runs")!)).not.toContain("at least 10");
    expect(textOf(root)).not.toContain("Saved");
  });

  it("disables Save for a session that cannot write settings", async () => {
    resetMocks();
    mocks.canWrite = false;
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    await using panel = await open();
    const root = panel.container;

    expect(button(root, "Save").disabled).toBe(true);
    expect(textOf(root)).toContain("read-only");
  });
  it("gives machine config fields twice the old width", async () => {
    resetMocks();
    mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
    await using panel = await open();
    const root = panel.container;

    for (const name of ["gh_config_dir", "poll_seconds"]) {
      const className = field(root, name)!.className;
      expect(className).toContain("sm:w-144");
      expect(className).not.toContain("sm:w-72");
      expect(className).toContain("min-w-0");
    }
  });

  describe.each([375, 1280])("at %i px", (width) => {
    it("lets a long config path break instead of overflowing", async () => {
      resetMocks();
      const long = `/Users/someone/${"deeply/".repeat(12)}.t3/factory/config.yml`;
      mocks.fetchFactoryConfig.mockResolvedValue(ok(report({ exists: false, file: long })));
      await using panel = await open(width);
      const root = panel.container;
      const holder = Array.from(root.querySelectorAll("*")).filter((node) =>
        Array.from(node.childNodes).some(
          (child) => child.nodeType === Node.TEXT_NODE && child.textContent === long,
        ),
      );
      expect(holder.length).toBeGreaterThan(0);
      for (const node of holder) expect(node.className).toContain("break-all");
    });

    it("asks for touch-sized inputs, with Save present", async () => {
      resetMocks();
      mocks.fetchFactoryConfig.mockResolvedValue(ok(populated));
      await using panel = await open(width);
      const root = panel.container;
      const inputs = Array.from(root.querySelectorAll("input"));
      // The five machine fields: the watched projects have no inputs.
      expect(inputs).toHaveLength(5);
      expect(inputs.map((node) => node.getAttribute("data-size"))).toEqual(
        inputs.map(() => "touch"),
      );
      expect(button(root, "Save")).toBeDefined();
    });
  });
});
