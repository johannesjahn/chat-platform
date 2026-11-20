/// <reference types="bun" />
import { mock } from "bun:test";
import { resolve } from "node:path";

// One stand-in for `src/lib/auth.ts` (which needs a browser), installed by
// bunfig.toml's preload before any test file loads. `mock.module` can't
// re-bind a module that something already imported, so a per-file mock only
// worked if that file happened to run before any other file that loads
// `api.ts` — and file order differs between machines. Tests drive the shared
// `authStub` instead of mocking `./auth` themselves.
export const authStub: {
  session: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cleared: number;
} = { session: null, cleared: 0 };

mock.module(resolve(import.meta.dir, "../src/lib/auth"), () => ({
  getSession: () => authStub.session,
  setSession: (next: unknown) => {
    authStub.session = next;
  },
  clearSession: () => {
    authStub.session = null;
    authStub.cleared++;
  },
  subscribeSession: () => () => {},
  useSession: () => authStub.session,
}));
