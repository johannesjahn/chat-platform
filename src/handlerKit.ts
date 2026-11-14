import type {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import type { ChatApi } from "./Api.ts";

type ApiGroups =
  typeof ChatApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;

type GroupEndpoints<Group extends string> = HttpApiBuilder.Handlers.FromGroup<
  HttpApiGroup.WithIdentifier<ApiGroups, Group>
>["~EndpointsByIdentifier"];

// What a group's area module returns: some of that group's handlers, keyed by
// endpoint name (issue #811). Use it with `satisfies`, so the handlers'
// request parameters stay contextually typed and their requirements stay
// inferred for the group's `handlers.handleAll(...)`, which fails to
// typecheck if an endpoint is left unhandled.
type GroupEndpoint<Group extends string, Name> = GroupEndpoints<Group>[Name &
  keyof GroupEndpoints<Group>] extends infer E extends
  HttpApiEndpoint.Constraint
  ? E
  : never;

export type GroupHandlers<Group extends string> = {
  readonly [Name in keyof GroupEndpoints<Group>]?: HttpApiEndpoint.Handler<
    GroupEndpoint<Group, Name>,
    HttpApiEndpoint.MiddlewareError<GroupEndpoint<Group, Name>>,
    unknown
  >;
};
