import { $api } from "./api";

// Google Identity Services (issue #693): Google's button hands the page an ID
// token, which the backend verifies (`POST /users/login/google`) — no
// redirect, callback route or PKCE state to manage here.
const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";

// The slice of the `google.accounts.id` API the app uses — only `initialize`
// and `renderButton`, which is also all the e2e suite's stand-in for the
// script provides (see web/e2e/fixtures.ts).
type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (response: { credential: string }) => void;
        ux_mode?: "popup";
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: {
          type?: "standard";
          theme?: "outline" | "filled_blue" | "filled_black";
          size?: "large";
          text?: "signin_with" | "continue_with";
          shape?: "pill";
          logo_alignment?: "left";
          width?: number;
        },
      ) => void;
    };
  };
};

let scriptPromise: Promise<GoogleIdentity> | null = null;

// Loads the GIS script once per page. A failure (offline, an ad blocker)
// isn't cached, so a later attempt can try again.
export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  scriptPromise ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const google = (window as unknown as { google?: GoogleIdentity }).google;
      if (google?.accounts?.id) resolve(google);
      else reject(new Error("Google sign-in didn't load"));
    };
    script.onerror = () => reject(new Error("Google sign-in didn't load"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

// The Google OAuth client id the button is initialized with — public, served
// by the backend so it's configured in one place (`GOOGLE_CLIENT_ID`). Null
// when Google sign-in isn't set up on this deployment.
export function useAuthConfig() {
  return $api.useQuery(
    "get",
    "/users/login/config",
    {},
    { staleTime: Infinity },
  );
}

// Where a first Google sign-in's pending token waits while the user picks a
// username on /register (issue #693). sessionStorage, not memory, so a
// reload of the username step doesn't send them back to Google; the token
// itself expires server-side after ten minutes either way.
const PENDING_SIGNUP_KEY = "chat-platform-google-signup";

export function setPendingSignup(pendingToken: string): void {
  try {
    window.sessionStorage.setItem(PENDING_SIGNUP_KEY, pendingToken);
  } catch {
    // Storage unavailable — /register falls back to asking for Google again.
  }
}

export function getPendingSignup(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_SIGNUP_KEY);
  } catch {
    return null;
  }
}

export function clearPendingSignup(): void {
  try {
    window.sessionStorage.removeItem(PENDING_SIGNUP_KEY);
  } catch {
    // Nothing stored, then.
  }
}
