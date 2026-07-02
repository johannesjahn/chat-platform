import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { Authentication } from "./Auth.ts";

// Public representation of a user — never exposes the password hash.
// `identifier` annotations surface these as named schemas in the OpenAPI spec.
export const User = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
}).annotations({ identifier: "User" });
export type User = typeof User.Type;

export const RegisterBody = Schema.Struct({
  username: Schema.NonEmptyTrimmedString,
  password: Schema.NonEmptyString,
}).annotations({ identifier: "RegisterBody" });

export const LoginBody = Schema.Struct({
  username: Schema.NonEmptyTrimmedString,
  password: Schema.NonEmptyString,
}).annotations({ identifier: "LoginBody" });

export const LoginResponse = Schema.Struct({
  user: User,
  accessToken: Schema.String,
  refreshToken: Schema.String,
}).annotations({ identifier: "LoginResponse" });
export type LoginResponse = typeof LoginResponse.Type;

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()(
  "UsernameTaken",
  { message: Schema.String },
) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { message: Schema.String },
) {}

const UsersGroup = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("listUsers", "/users")
      .addSuccess(Schema.Array(User))
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/users/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(User)
      .addError(NotFound, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.post("register", "/users/register")
      .setPayload(RegisterBody)
      .addSuccess(User, { status: 201 })
      .addError(UsernameTaken, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.post("login", "/users/login")
      .setPayload(LoginBody)
      .addSuccess(LoginResponse)
      .addError(InvalidCredentials, { status: 401 }),
  );

export class ChatApi extends HttpApi.make("chat-platform").add(UsersGroup) {}
