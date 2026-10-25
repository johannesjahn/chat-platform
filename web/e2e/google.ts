import type { BrowserContext, Page } from "@playwright/test";
import { mintGoogleIdToken } from "../../src/GoogleTestSigner";

// Google Identity Services, stood in for (issue #693). Every context that
// goes through `injectApiUrl` (fixtures.ts) is served this instead of the real
// https://accounts.google.com/gsi/client, so the app code runs unchanged —
// no test mode in it. The stand-in implements just what the app calls:
// `initialize({ callback })` and `renderButton(el)`, which renders a plain
// button. Clicking it hands the callback whatever ID token the test chose
// with `useGoogleAccount` (minted with the test key the e2e backend
// trusts), or does nothing if it chose none.
export const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

const GIS_STAND_IN = `(() => {
  let config = null;
  window.google = {
    accounts: {
      id: {
        initialize(next) {
          config = next;
        },
        renderButton(parent, options) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent =
            options && options.text === "signin_with"
              ? "Sign in with Google"
              : "Continue with Google";
          button.addEventListener("click", () => {
            const credential = window.__E2E_GOOGLE_CREDENTIAL__;
            if (config && credential) config.callback({ credential });
          });
          parent.replaceChildren(button);
        },
      },
    },
  };
})();`;

export async function routeGoogleIdentity(
  context: BrowserContext,
): Promise<void> {
  await context.route(GIS_SCRIPT_URL, (route) =>
    route.fulfill({ contentType: "text/javascript", body: GIS_STAND_IN }),
  );
}

declare global {
  interface Window {
    __E2E_GOOGLE_CREDENTIAL__?: string;
  }
}

// Picks the Google account the stand-in's button signs `page` in as, from
// now on: a fresh ID token for `sub`, for this document and every later one
// in the context.
export async function useGoogleAccount(page: Page, sub: string): Promise<void> {
  const credential = await mintGoogleIdToken({ sub });
  await page.context().addInitScript((token) => {
    window.__E2E_GOOGLE_CREDENTIAL__ = token;
  }, credential);
  if (page.url() !== "about:blank") {
    await page.evaluate((token) => {
      window.__E2E_GOOGLE_CREDENTIAL__ = token;
    }, credential);
  }
}

// Signs in on the page's current /login as `sub`'s Google account — what a
// user does by clicking Google's button and picking their account.
export async function signInWithGoogle(page: Page, sub: string): Promise<void> {
  await useGoogleAccount(page, sub);
  await page.getByRole("button", { name: "Continue with Google" }).click();
}
