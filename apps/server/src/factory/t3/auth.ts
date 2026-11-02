import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentScopeRequiredError,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";

/**
 * The factory's routes behind T3's authentication: T3 parses tokens and cookies with the call its
 * HTTP API middleware makes (`EnvironmentAuth.authenticateHttpRequest`), so paired, relay and
 * tunnel sessions fare exactly as there. That middleware cannot wrap a plain route, so this follows
 * upstream's OTLP proxy route. Contract errors render themselves as 401, 403 or 500 JSON.
 */

const encodeScopeRequired = Schema.encodeSync(EnvironmentScopeRequiredError);

/**
 * Runs `handler` for an authenticated request whose session holds `scope`. A request without a
 * session fails 401 and one without the scope fails 403, whose body also carries the error's
 * `message` (a getter upstream, so its own JSON lacks it) for clients that show the server's words.
 * The handler may read `EnvironmentAuthenticatedPrincipal`.
 */
const withScope = Effect.fn("FactoryAuth.withScope")(function* <E, R>(
  scope: AuthEnvironmentScope,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      AuthHttp.failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      AuthHttp.failEnvironmentInternal("internal_error", error),
    ),
  );
  return yield* Effect.andThen(AuthHttp.requireEnvironmentScope(scope), handler).pipe(
    Effect.catchIf(Schema.is(EnvironmentScopeRequiredError), (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { ...encodeScopeRequired(error), message: error.message },
          { status: 403 },
        ),
      ),
    ),
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      ...session,
      scopes: new Set(session.scopes),
    }),
  );
});

/** A route on T3's router that needs a session holding `scope`. */
export const route = <E, R>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: `/${string}`,
  scope: AuthEnvironmentScope,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => HttpRouter.add(method, path, withScope(scope, handler));
