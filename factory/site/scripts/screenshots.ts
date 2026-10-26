// Takes the docs screenshots in public/screenshots from a throwaway T3 home seeded with the
// fictional data in demo-data.ts. Run with `npm run screenshots` after `vp i` at the repo root.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { chromium, type Browser, type Locator, type Page } from "playwright";

import { demoRunId, seedDemoHome } from "./demo-data.ts";

const SITE = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = NodePath.resolve(SITE, "../..");
const OUT_DIR = NodePath.join(SITE, "public/screenshots");
/** The page as it was when a shot did not render, kept for the person rerunning; gitignored. */
const FAILURE_PNG = NodePath.join(SITE, "screenshot-failure.png");
const STARTUP_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 15_000;
/** Space kept around a shot of part of a page, in CSS pixels. */
const PART_MARGIN = 24;
/** Where the web client keeps its own settings (apps/web/src/clientPersistenceStorage.ts). */
const CLIENT_SETTINGS_KEY = "t3code:client-settings:v1";

/** The pipeline the pipeline shots show: the Learning loop template, created through the UI. */
const PIPELINE_NAME = "Learning loop";
const PIPELINE_ID = "learning-loop";

interface Shot {
  readonly name: string;
  /** The page's path, given the id of the environment the throwaway server runs. */
  readonly path: (environmentId: string) => string;
  /** Waits for what the shot is of; answers the part of the page to capture, or none for all of it. */
  readonly ready: (page: Page) => Promise<Locator | void>;
}

const SHOTS: ReadonlyArray<Shot> = [
  {
    name: "factory-page",
    path: () => "/factory",
    ready: async (page) => {
      await page.getByText("acme/storefront#57").first().waitFor();
    },
  },
  {
    name: "run-page",
    path: (environmentId) => `/factory/${environmentId}/${demoRunId("pr-open")}`,
    ready: async (page) => {
      await page.getByText("Last gate output").waitFor();
      await page.getByText("pr_opened").first().waitFor();
    },
  },
  {
    name: "run-needs-info",
    path: (environmentId) => `/factory/${environmentId}/${demoRunId("needs-info")}`,
    ready: async (page) => {
      await page.getByText("questions_posted").first().waitFor();
    },
  },
  {
    name: "needs-attention",
    path: () => "/factory",
    ready: async (page) => {
      const list = page.getByRole("region", { name: "Needs attention" });
      await list.getByText("acme/storefront#52").first().waitFor();
      return list;
    },
  },
  {
    name: "settings-factory",
    path: () => "/settings/factory",
    ready: async (page) => {
      await page.getByText("poll", { exact: false }).first().waitFor();
    },
  },
  {
    name: "pipeline-editor",
    path: (environmentId) => `/factory/pipelines/${environmentId}/${PIPELINE_ID}`,
    ready: async (page) => {
      await page.getByRole("button", { name: "Build node" }).click();
      await page.getByLabel("Label", { exact: true }).waitFor();
    },
  },
  {
    name: "pipeline-simulation",
    path: (environmentId) => `/factory/pipelines/${environmentId}/${PIPELINE_ID}`,
    ready: async (page) => {
      await page.getByRole("button", { name: "Build node" }).waitFor();
      await page.getByRole("button", { name: "Simulate" }).click();
      await page.getByRole("button", { name: "Happy path" }).click();
      await page.getByRole("status").getByText("Ended done").waitFor();
    },
  },
];

/** Creates the pipeline the pipeline shots show, from its template, the way a person would. */
const createPipeline = async (page: Page, webOrigin: string): Promise<void> => {
  await page.goto(`${webOrigin}/factory/pipelines`);
  await page.getByRole("button", { name: "New pipeline" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New pipeline" });
  await dialog.getByLabel("Name").fill(PIPELINE_NAME);
  await dialog.getByText(PIPELINE_NAME, { exact: true }).click();
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "Build node" }).waitFor();
};

/** The server's environment: no GitHub credentials reach it, and no baked-in origins. */
const serverEnv = (ghConfigDir: string): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "T3CODE_HOME",
    "T3CODE_PORT",
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "VITE_DEV_SERVER_URL",
  ]) {
    delete env[name];
  }
  env.GH_CONFIG_DIR = ghConfigDir;
  // In web mode the server would otherwise add the repo it runs from as a T3 project, which
  // the factory would then watch, and the sidebar would show.
  env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "0";
  env.T3CODE_NO_BROWSER = "1";
  return env;
};

interface DevServer {
  readonly webOrigin: string;
  readonly pairingUrl: string;
}

/**
 * Starts `vp run dev` on `home`, in its own process group so the stop reaches Vite and the server
 * under it by this pid. Its output goes to `log`.
 */
const spawnDevServer = (
  home: string,
  ghConfigDir: string,
  log: string,
): NodeChildProcess.ChildProcess => {
  const child = NodeChildProcess.spawn("vp", ["run", "dev", "--home-dir", home], {
    cwd: REPO_ROOT,
    env: serverEnv(ghConfigDir),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = NodeFS.openSync(log, "a");
  const write = (chunk: Buffer) => NodeFS.writeSync(output, chunk);
  child.stdout!.on("data", write);
  child.stderr!.on("data", write);
  child.once("close", () => NodeFS.closeSync(output));
  return child;
};

/** Waits for the dev server's web port and pairing URL. */
const devServerReady = (child: NodeChildProcess.ChildProcess, log: string): Promise<DevServer> =>
  new Promise((resolve, reject) => {
    let webPort: string | null = null;
    let pairing: string | null = null;
    let buffer = "";
    const done = () => {
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      child.stderr!.off("data", onData);
      child.off("error", fail);
      child.off("exit", exited);
    };
    const fail = (error: Error) => {
      done();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`the dev server exited (${signal ?? code}) before it was ready; see ${log}`));
    const timer = setTimeout(
      () => fail(new Error(`the dev server did not start in time; see ${log}`)),
      STARTUP_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      // Pretty logs colour their fields; the URL and port are read from the plain text.
      buffer += NodeUtil.stripVTControlCharacters(chunk.toString("utf8"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        webPort ??= /\[dev-runner\].*\bwebPort=(\d+)/.exec(line)?.[1] ?? null;
        pairing ??= /pairingUrl[:=]\s*"?(https?:\/\/[^\s"]+)/.exec(line)?.[1] ?? null;
      }
      if (webPort !== null && pairing !== null) {
        done();
        const webOrigin = `http://localhost:${webPort}`;
        const url = new URL(pairing);
        resolve({ webOrigin, pairingUrl: `${webOrigin}${url.pathname}${url.search}${url.hash}` });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", fail);
    child.once("exit", exited);
  });

/** Whether any process is left in the group `pid` leads. */
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until the group is gone or `ms` pass; answers whether it is gone. */
const groupGone = async (pid: number, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
};

/**
 * Stops the process group the script spawned, by its pid, and waits until every process in it is
 * gone, not just `vp`, so nothing is still writing to the home when it is deleted.
 */
const stopDevServer = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  signalGroup("SIGTERM");
  if (await groupGone(pid, STOP_TIMEOUT_MS)) return;
  signalGroup("SIGKILL");
  if (!(await groupGone(pid, STOP_TIMEOUT_MS))) {
    throw new Error(`the dev server's process group ${pid} would not stop`);
  }
};

/** The id the server gives its environment; the run pages' URLs name it (/factory/<environmentId>/<runId>). */
const fetchEnvironmentId = async (server: DevServer): Promise<string> => {
  const response = await fetch(`${server.webOrigin}/.well-known/t3/environment`);
  if (!response.ok) throw new Error(`the environment descriptor answered ${response.status}`);
  const descriptor = (await response.json()) as { readonly environmentId?: unknown };
  if (typeof descriptor.environmentId !== "string" || descriptor.environmentId === "") {
    throw new Error("the environment descriptor has no environmentId");
  }
  return descriptor.environmentId;
};

const capture = async (browser: Browser, server: DevServer): Promise<void> => {
  const environmentId = await fetchEnvironmentId(server);
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  // One context for both themes: the pairing URL's token works once.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  // A browser that has finished T3's first-run wizard, as anyone reading the docs has: with no
  // projects seeded, the app would otherwise open the wizard over every page.
  await context.addInitScript((key) => {
    if (window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(
        key,
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() }),
      );
    }
  }, CLIENT_SETTINGS_KEY);
  const page = await context.newPage();
  await page.goto(server.pairingUrl);
  await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
  await createPipeline(page, server.webOrigin);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const shot of SHOTS) {
      await page.goto(`${server.webOrigin}${shot.path(environmentId)}`);
      const part = await shot.ready(page).catch(async (error: unknown) => {
        await page.screenshot({ path: FAILURE_PNG }).catch(() => undefined);
        throw new Error(`${shot.name} (${theme}) did not render; the page is in ${FAILURE_PNG}`, {
          cause: error,
        });
      });
      // Let the last fetch and the fonts settle so no shot catches a loading state.
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      const file = NodePath.join(OUT_DIR, `${shot.name}-${theme}.png`);
      const box = part ? await part.boundingBox() : null;
      await page.screenshot({
        path: file,
        ...(box === null
          ? {}
          : {
              clip: {
                x: Math.max(0, box.x - PART_MARGIN),
                y: Math.max(0, box.y - PART_MARGIN),
                width: box.width + 2 * PART_MARGIN,
                height: box.height + 2 * PART_MARGIN,
              },
            }),
      });
      console.log(`wrote ${NodePath.relative(SITE, file)}`);
    }
  }
  await context.close();
};

const main = async (): Promise<void> => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-screenshots-"));
  const ghConfigDir = NodePath.join(home, "gh");
  NodeFS.mkdirSync(ghConfigDir);
  const log = NodePath.join(home, "dev-server.log");
  let child: NodeChildProcess.ChildProcess | null = null;
  let browser: Browser | null = null;
  let cleaning: Promise<void> | null = null;
  const cleanUp = () =>
    (cleaning ??= (async () => {
      await browser?.close().catch(() => undefined);
      if (child !== null) await stopDevServer(child);
      NodeFS.rmSync(home, { recursive: true, force: true });
    })());
  // Repeat signals while the stop runs are ignored, so a second Ctrl-C cannot skip it.
  const interrupted = () => {
    void cleanUp().finally(() => process.exit(130));
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    seedDemoHome(home, Date.now());
    child = spawnDevServer(home, ghConfigDir, log);
    const server = await devServerReady(child, log);
    browser = await chromium.launch();
    await capture(browser, server);
  } catch (error) {
    if (NodeFS.existsSync(log)) {
      // The startup pairing URL's token is dead once the server stops, but keep it off screen.
      const tail = NodeFS.readFileSync(log, "utf8").slice(-4000);
      console.error(`--- dev server output ---\n${tail.replace(/token=[^\s&"]+/g, "token=…")}`);
    }
    throw error;
  } finally {
    await cleanUp();
  }
};

await main();
