import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { ChatApi } from "./Api.ts";

export const VersionHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "meta",
  (handlers) =>
    handlers.handle("getVersion", () =>
      Effect.succeed({ version: packageJson.version }),
    ),
);
