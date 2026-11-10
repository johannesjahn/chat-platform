import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenApi } from "effect/http-api";
import {
  ChatApi,
  MAX_COMMENT_CONTENT_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_SEARCH_QUERY_LENGTH,
  MIN_USERNAME_LENGTH,
  SearchAllQuery,
  SearchQuery,
} from "./Api.ts";

// Regression guard for a real footgun in effect's OpenApi generator:
// giving a `params`/`query`/`headers` struct an `identifier`
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

  const groups = Object.values(ChatApi.groups) as unknown as ReadonlyArray<{
    endpoints: Record<string, HttpApiEndpointLike>;
  }>;

  for (const group of groups) {
    for (const endpoint of Object.values(group.endpoints)) {
      const expectedKinds = (
        [
          ["path", endpoint.params],
          ["query", endpoint.query],
          ["header", endpoint.headers],
        ] as const
      )
        .filter(([, schema]) => schema !== undefined)
        .map(([kind]) => kind);
      if (expectedKinds.length === 0) continue;

      const path = endpoint.path.replace(/:(\w+)\??/g, "{$1}");
      const method = endpoint.method.toLowerCase();
      const parameters = spec.paths[path]?.[method]?.parameters ?? [];

      for (const kind of expectedKinds) {
        const matching = parameters.filter((p) => p.in === kind);
        expect(
          matching.length,
          `${method.toUpperCase()} ${path} declares a ${kind} schema but produced no OpenAPI "${kind}" parameters — check for an .annotate({ identifier }) on that schema (see CLAUDE.md).`,
        ).toBeGreaterThan(0);
      }
    }
  }
});

type HttpApiEndpointLike = {
  readonly path: string;
  readonly method: string;
  readonly params: unknown;
  readonly query: unknown;
  readonly headers: unknown;
};

// Issue #761: effect's `Schema.isMinLength(n)` documents a string as
// `minLength: Math.ceil(n / 2)` (a code-point-safe approximation of a UTF-16
// check), so openapi.json advertised half of every floor. Api.ts routes every
// min-length check through its own `isMinLength`, which documents the
// enforced bound; these hold the spec to the constants.
type JsonSchemaLike = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly properties?: Record<string, JsonSchemaLike>;
};

test("openapi.json reports the length bounds Api.ts enforces", () => {
  const spec = OpenApi.fromApi(ChatApi) as unknown as {
    components: { schemas: Record<string, JsonSchemaLike> };
  };
  const field = (component: string, property: string) => {
    const schema = spec.components.schemas[component]?.properties?.[property];
    expect(schema, `${component}.${property} missing from spec`).toBeDefined();
    return { minLength: schema?.minLength, maxLength: schema?.maxLength };
  };

  expect(field("RegisterBody", "username")).toEqual({
    minLength: MIN_USERNAME_LENGTH,
    maxLength: MAX_USERNAME_LENGTH,
  });
  expect(field("RegisterBody", "password")).toEqual({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
  });
  expect(field("ChangePasswordBody", "newPassword")).toEqual({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
  });
  // Login and `currentPassword` deliberately skip the floors (accounts that
  // predate them must still sign in), so they only require non-empty.
  expect(field("LoginBody", "username")).toEqual({
    minLength: 1,
    maxLength: MAX_USERNAME_LENGTH,
  });
  expect(field("ChangePasswordBody", "currentPassword")).toEqual({
    minLength: 1,
    maxLength: MAX_PASSWORD_LENGTH,
  });
  expect(field("CreateCommentBody", "content")).toEqual({
    minLength: 1,
    maxLength: MAX_COMMENT_CONTENT_LENGTH,
  });
  expect(field("CreateMessageBody", "content")).toEqual({
    minLength: 1,
    maxLength: MAX_MESSAGE_CONTENT_LENGTH,
  });
});

test("search query length bounds are documented as enforced", () => {
  // `q` is a `Schema.Trim` transformation, so the query parameter's encoded
  // side carries no bounds; check the decoded side's JSON Schema instead.
  for (const schema of [SearchQuery, SearchAllQuery]) {
    const document = Schema.toJsonSchemaDocument(Schema.toType(schema));
    const q = (document.schema as JsonSchemaLike).properties?.q;
    expect({ minLength: q?.minLength, maxLength: q?.maxLength }).toEqual({
      minLength: MIN_SEARCH_QUERY_LENGTH,
      maxLength: MAX_SEARCH_QUERY_LENGTH,
    });
  }
});

test("Api.ts never uses effect's halving length checks directly", async () => {
  const source = await Bun.file(new URL("./Api.ts", import.meta.url)).text();
  // The one allowed call is inside Api.ts's own `isMinLength` wrapper.
  const minLengthCalls = source.match(/\bSchema\.isMinLength\(/g) ?? [];
  expect(
    minLengthCalls.length,
    "use Api.ts's isMinLength, not Schema.isMinLength (issue #761)",
  ).toBe(1);
  // `isBetweenLength` halves its minimum the same way.
  expect(source).not.toMatch(/\bSchema\.isBetweenLength\(/);
});
