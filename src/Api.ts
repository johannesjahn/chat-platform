import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { Authentication } from "./Auth.ts";

// "admin" can edit/delete any post; "user" can only edit/delete their own.
// Registration always creates a "user" — admins are promoted out-of-band.
export const UserRole = Schema.Literal("user", "admin").annotations({
  identifier: "UserRole",
});
export type UserRole = typeof UserRole.Type;

// Public representation of a user — never exposes the password hash.
// `identifier` annotations surface these as named schemas in the OpenAPI spec.
export const User = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
  role: UserRole,
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

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

// Content types a post's body can hold. Extend this union (and the handler's
// per-type validation, if any is ever needed) to support new post kinds.
export const PostContentType = Schema.Literal("text", "image_url").annotations({
  identifier: "PostContentType",
});
export type PostContentType = typeof PostContentType.Type;

// Generous but bounded — prevents unbounded payloads while comfortably
// fitting a long-form text post or an image URL.
const MAX_POST_CONTENT_LENGTH = 10_000;

const PostContent = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_POST_CONTENT_LENGTH),
);

export const Post = Schema.Struct({
  id: Schema.Number,
  authorId: Schema.Number,
  contentType: PostContentType,
  content: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotations({ identifier: "Post" });
export type Post = typeof Post.Type;

export const CreatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
}).annotations({ identifier: "CreatePostBody" });

export const UpdatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
}).annotations({ identifier: "UpdatePostBody" });

export const DEFAULT_POSTS_PAGE_SIZE = 20;
export const MAX_POSTS_PAGE_SIZE = 100;

// `page`/`pageSize` are left plain-optional (rather than `optionalWith` +
// `default`) because a schema default only fills in on *decode* — an
// HttpApiClient caller encoding a request would otherwise be forced to pass
// both every time. Defaults are instead applied by the handler.
export const PostsPageQuery = Schema.Struct({
  page: Schema.optional(
    Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ),
  pageSize: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_POSTS_PAGE_SIZE),
    ),
  ),
}).annotations({ identifier: "PostsPageQuery" });

export const PostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  page: Schema.Number,
  pageSize: Schema.Number,
  total: Schema.Number,
}).annotations({ identifier: "PostsPage" });

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

const PostsGroup = HttpApiGroup.make("posts")
  .add(
    HttpApiEndpoint.get("listPosts", "/posts").addSuccess(Schema.Array(Post)),
  )
  .add(
    HttpApiEndpoint.get("getPost", "/posts/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Post)
      .addError(NotFound, { status: 404 }),
  )
  .add(
    // Authenticated, paginated view over all posts — distinct from the
    // public, unpaginated `listPosts`.
    HttpApiEndpoint.get("listAllPosts", "/posts/all")
      .setUrlParams(PostsPageQuery)
      .addSuccess(PostsPage)
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createPost", "/posts")
      .setPayload(CreatePostBody)
      .addSuccess(Post, { status: 201 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.put("updatePost", "/posts/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdatePostBody)
      .addSuccess(Post)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.del("deletePost", "/posts/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  );

export class ChatApi extends HttpApi.make("chat-platform")
  .add(UsersGroup)
  .add(PostsGroup) {}
