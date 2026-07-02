import { expect, test } from "bun:test";
import { OpenApi } from "@effect/platform";
import { Option } from "effect";
import { ChatApi } from "./Api.ts";

// Regression guard for a real footgun in @effect/platform's OpenApi generator:
// giving a `setPath`/`setUrlParams`/`setHeaders` struct an `identifier`
// annotation turns its JSON Schema into a `$ref`, which the generator's
// parameter-extraction pass silently ignores (it only inlines `properties`).
// The endpoint still works at runtime, but the generated openapi.json (and
// therefore the typed frontend client generated from it) ends up with zero
// documented/typed parameters for that location — no error, just silently
// missing. See PostsPageQuery in Api.ts, and the note in CLAUDE.md.
//
// This walks every endpoint in ChatApi and checks that any endpoint
// declaring a path/query/header schema actually produced matching
// parameters in the generated spec, so a future endpoint that reintroduces
// this mistake fails loudly here instead of shipping a silently broken
// typed client.
test("every endpoint with path/query/header params produces matching OpenAPI parameters", () => {
  const spec = OpenApi.fromApi(ChatApi) as unknown as {
    paths: Record<
      string,
      Record<string, { parameters?: ReadonlyArray<{ in: string }> }>
    >;
  };

  const groups = Object.values(ChatApi.groups) as ReadonlyArray<{
    endpoints: Record<string, HttpApiEndpointLike>;
  }>;

  for (const group of groups) {
    for (const endpoint of Object.values(group.endpoints)) {
      const expectedKinds = (
        [
          ["path", endpoint.pathSchema],
          ["query", endpoint.urlParamsSchema],
          ["header", endpoint.headersSchema],
        ] as const
      )
        .filter(([, schema]) => Option.isSome(schema))
        .map(([kind]) => kind);
      if (expectedKinds.length === 0) continue;

      const path = endpoint.path.replace(/:(\w+)\??/g, "{$1}");
      const method = endpoint.method.toLowerCase();
      const parameters = spec.paths[path]?.[method]?.parameters ?? [];

      for (const kind of expectedKinds) {
        const matching = parameters.filter((p) => p.in === kind);
        expect(
          matching.length,
          `${method.toUpperCase()} ${path} declares a ${kind} schema but produced no OpenAPI "${kind}" parameters — check for an .annotations({ identifier }) on that schema (see CLAUDE.md).`,
        ).toBeGreaterThan(0);
      }
    }
  }
});

type HttpApiEndpointLike = {
  readonly path: string;
  readonly method: string;
  readonly pathSchema: Option.Option<unknown>;
  readonly urlParamsSchema: Option.Option<unknown>;
  readonly headersSchema: Option.Option<unknown>;
};
