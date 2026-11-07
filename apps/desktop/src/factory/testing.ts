// Test layers shared by the factory server tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Scope from "effect/Scope";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopLegacyLocalStorage from "../app/DesktopLegacyLocalStorage.ts";
import * as DesktopAppActivation from "../app/DesktopAppActivation.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const layerDesktopEnvironment = (baseDir: string, isPackaged: boolean) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

/** Stores `encrypted:<value>` so a test can tell the file apart from the plaintext. */
export const layerSafeStorageWith = (options: { readonly encryptionAvailable: boolean }) =>
  Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(options.encryptionAvailable),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      return decoded.startsWith("encrypted:")
        ? Effect.succeed(decoded.slice("encrypted:".length))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: new Error("not encrypted"),
            }),
          );
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

export const layerSafeStorage = layerSafeStorageWith({ encryptionAvailable: true });

/** What the token endpoint answers for an accepted pairing credential. */
export const accessTokenBody = (accessToken: string) => ({
  access_token: accessToken,
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "environment:connect",
});

/** An HTTP client that answers every request with a successful pairing exchange. */
export const layerHttpPairing = (accessToken: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(request, Response.json(accessTokenBody(accessToken))),
      ),
    ),
  );

/** A window that records the URL it was told the backend is ready at. */
export const layerWindow = (readyUrls: Array<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window create"),
    ensureMain: Effect.die("unexpected window ensure"),
    revealOrCreateMain: Effect.die("unexpected window reveal"),
    activate: Effect.die("unexpected window activate"),
    createMainIfBackendReady: Effect.die("unexpected window create"),
    showConnectingSplash: Effect.die("unexpected connecting splash"),
    handleBackendReady: (url) =>
      Effect.sync(() => {
        readyUrls.push(url.href);
      }),
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.die("unexpected menu action"),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.die("unexpected zoom"),
    runMainContentsCommand: () => Effect.die("unexpected main contents command"),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

/** An app-control socket that only counts how often it was started. */
export const layerAppActivation = (starts: { count: number }) =>
  Layer.succeed(DesktopAppActivation.DesktopAppActivation, {
    start: Effect.sync(() => {
      starts.count += 1;
    }) satisfies Effect.Effect<void, never, Scope.Scope>,
    setRendererReady: () => Effect.void,
    complete: () => Effect.void,
  } satisfies DesktopAppActivation.DesktopAppActivation["Service"]);

/** An IPC registry that records the channel of every invoke and sync handler installed. */
export const layerRecordingIpc = (channels: Array<string>) =>
  Layer.succeed(DesktopIpc.DesktopIpc, {
    handle: ({ channel }) =>
      Effect.sync(() => {
        channels.push(channel);
      }),
    handleSync: ({ channel }) =>
      Effect.sync(() => {
        channels.push(channel);
      }),
  } satisfies DesktopIpc.DesktopIpc["Service"]);

/**
 * What `installDesktopIpcHandlers` reads while it installs: the app, the platform, the window
 * list and the preview manager's subscriptions. The window and preview services are stubs
 * with only what install touches; their real shapes are too large to rebuild here. The test
 * file must `vi.mock("electron")` so the real ElectronApp and the badge cleanup have an API.
 */
export const layerIpcInstallDependencies = Layer.mergeAll(
  ElectronApp.layer,
  DesktopManagedPolicy.layerTest(),
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(ElectronWindow.ElectronWindow, {
    sendAll: () => Effect.void,
  } as unknown as ElectronWindow.ElectronWindow["Service"]),
  Layer.succeed(PreviewManager.PreviewManager, {
    subscribeStateChanges: () => Effect.void,
    subscribeRecordingFrames: () => Effect.void,
    subscribeRecordingInputs: () => Effect.void,
    subscribePointerEvents: () => Effect.void,
    subscribeOpenLinks: () => Effect.void,
  } as unknown as PreviewManager.PreviewManager["Service"]),
);

/**
 * The services bootstrap calls before it reaches the factory hook, each answering nothing.
 * Partial stubs: these services are large and bootstrap uses one method of each.
 */
export const layerBootstrapStubs = Layer.mergeAll(
  Layer.succeed(ElectronProtocol.ElectronProtocol, {
    registerDesktopProtocol: () => Effect.void,
  } as unknown as ElectronProtocol.ElectronProtocol["Service"]),
  Layer.succeed(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
    load: () => Effect.void,
  } as unknown as DesktopLegacyLocalStorage.DesktopLegacyLocalStorage["Service"]),
  Layer.succeed(DesktopAppIdentity.DesktopAppIdentity, {
    resolveUserDataPath: Effect.succeed("/tmp/t3-factory-user-data"),
  } as unknown as DesktopAppIdentity.DesktopAppIdentity["Service"]),
  Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
    initialize: Effect.void,
  } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
);
