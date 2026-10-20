import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";

import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { EmptyState } from "../components/ui/EmptyState";
import { ListRow } from "../components/ui/ListRow";
import { ListSection } from "../components/ui/ListSection";
import type { SavedRemoteConnection } from "../lib/connection";
import { useSavedRemoteConnections } from "../state/use-remote-environment-registry";
import {
  FACTORY_NO_ENVIRONMENT_MESSAGE,
  FACTORY_RELAY_ONLY_MESSAGE,
  factoryEnvironmentChoice,
} from "./factoryEnvironments";
import {
  factoryLinkAction,
  mintAndInject,
  parseFactoryMessage,
  nextSignIn,
  probeFactory,
  type SignInState,
} from "./factorySignIn";
import { FACTORY_BEFORE_CONTENT_LOADED_SCRIPT } from "./factoryWebViewScripts";

function Message(props: {
  readonly title: string;
  readonly detail: string;
  readonly onRetry?: () => void;
}) {
  return (
    <View className="flex-1 justify-center bg-screen">
      <EmptyState
        variant="plain"
        title={props.title}
        detail={props.detail}
        {...(props.onRetry ? { actionLabel: "Retry", onAction: props.onRetry } : {})}
      />
    </View>
  );
}

export function FactoryScreen() {
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const [pickedId, setPickedId] = useState<string | null>(null);

  if (isLoadingSavedConnection) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <AppActivityIndicator />
      </View>
    );
  }

  const choice = factoryEnvironmentChoice(Object.values(savedConnectionsById));
  switch (choice.kind) {
    case "none":
      return <Message title="Factory" detail={FACTORY_NO_ENVIRONMENT_MESSAGE} />;
    case "relay-only":
      return <Message title="Factory" detail={FACTORY_RELAY_ONLY_MESSAGE} />;
    case "one":
      return (
        <FactoryWebView key={choice.connection.environmentId} connection={choice.connection} />
      );
    case "several": {
      const picked = choice.options.find(
        (option) => option.openable && option.connection.environmentId === pickedId,
      );
      if (picked) {
        return (
          <FactoryWebView key={picked.connection.environmentId} connection={picked.connection} />
        );
      }
      const anyRelay = choice.options.some((option) => !option.openable);
      return (
        <View className="flex-1 bg-screen px-5 pt-4">
          <ListSection
            title="Environment"
            {...(anyRelay ? { footer: FACTORY_RELAY_ONLY_MESSAGE } : {})}
          >
            {choice.options.map(({ connection, openable }) => (
              <ListRow
                key={connection.environmentId}
                icon="desktopcomputer"
                label={connection.environmentLabel}
                {...(openable ? {} : { detail: "Relay", disabled: true })}
                onPress={() => {
                  if (openable) setPickedId(connection.environmentId);
                }}
              />
            ))}
          </ListSection>
        </View>
      );
    }
  }
}

type Phase =
  | { readonly kind: "probing" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "ready" };

function FactoryWebView(props: { readonly connection: SavedRemoteConnection }) {
  const { httpBaseUrl, bearerToken } = props.connection;
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [attempt, setAttempt] = useState(0);
  const webViewRef = useRef<WebView<object>>(null);
  const signInRef = useRef<SignInState>("idle");
  // Bumped on every open and on unmount, so a mint that outlives its open is dropped.
  const generationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const generation = ++generationRef.current;
    signInRef.current = "idle";
    setPhase({ kind: "probing" });
    void probeFactory({ httpBaseUrl, bearerToken }, fetch).then((result) => {
      if (!cancelled)
        setPhase(result.ok ? { kind: "ready" } : { kind: "error", reason: result.reason });
    });
    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [httpBaseUrl, bearerToken, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const message = parseFactoryMessage(event.nativeEvent.data);
      if (message === null) return;
      const next = nextSignIn(signInRef.current, message, event.nativeEvent.url, httpBaseUrl);
      signInRef.current = next.state;
      if (next.action === "exchange-failed") {
        setPhase({ kind: "error", reason: "Signing in to the Factory pages failed." });
      } else if (next.action === "rejected") {
        setPhase({ kind: "error", reason: "The server did not accept the sign-in." });
      } else if (next.action === "mint") {
        const generation = generationRef.current;
        await mintAndInject({
          server: { httpBaseUrl, bearerToken },
          fetchFn: fetch,
          isCurrent: () => generation === generationRef.current,
          onMinted: () => {
            signInRef.current = nextSignIn(
              signInRef.current,
              { type: "minted" },
              event.nativeEvent.url,
              httpBaseUrl,
            ).state;
          },
          inject: (script) => webViewRef.current?.injectJavaScript(script),
          onFailure: (reason) => setPhase({ kind: "error", reason }),
        });
      }
    },
    [httpBaseUrl, bearerToken],
  );

  if (phase.kind === "error") {
    return <Message title="Factory unavailable" detail={phase.reason} onRetry={retry} />;
  }
  if (phase.kind === "probing") {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <WebView<object>
      ref={webViewRef}
      source={{ uri: environmentEndpointUrl(httpBaseUrl, "/factory") }}
      originWhitelist={["*"]}
      sharedCookiesEnabled
      injectedJavaScriptBeforeContentLoaded={FACTORY_BEFORE_CONTENT_LOADED_SCRIPT}
      onMessage={(event) => void onMessage(event)}
      onShouldStartLoadWithRequest={(request) => {
        if (request.isTopFrame === false) return true;
        if (factoryLinkAction(request.url, httpBaseUrl) === "webview") return true;
        void Linking.openURL(request.url).catch(() => undefined);
        return false;
      }}
      onError={() => setPhase({ kind: "error", reason: "The server is unreachable." })}
      onHttpError={(event) =>
        setPhase({
          kind: "error",
          reason: `The server returned an error (${event.nativeEvent.statusCode}).`,
        })
      }
    />
  );
}
