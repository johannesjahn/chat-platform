import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { loadGoogleIdentity, useAuthConfig } from "@/lib/googleSignIn";
import { useTheme } from "@/lib/theme";

type GoogleSignInButtonProps = {
  // Called with the ID token once the user has picked their Google account.
  onCredential: (idToken: string) => void;
  text?: "signin_with" | "continue_with";
  // Width of Google's button, in px (its own API caps it at 400).
  width?: number;
};

// Google's own "Continue with Google" button (Google Identity Services).
// Google renders it — in an iframe — so its look and wording follow Google's
// branding rules rather than the app's Button. Shows a placeholder while the
// script loads, and says so if Google sign-in is unavailable.
export function GoogleSignInButton({
  onCredential,
  text = "continue_with",
  width = 280,
}: GoogleSignInButtonProps) {
  const config = useAuthConfig();
  const clientId = config.data?.googleClientId ?? null;
  const { resolved: theme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  // GIS keeps one callback per page, set by the last `initialize` — read the
  // latest `onCredential` through a ref so re-renders needn't re-initialize.
  const onCredentialRef = useRef(onCredential);
  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadGoogleIdentity().then(
      (google) => {
        const parent = container.current;
        if (cancelled || !parent) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: ({ credential }) => onCredentialRef.current(credential),
          ux_mode: "popup",
          auto_select: false,
        });
        parent.replaceChildren();
        google.accounts.id.renderButton(parent, {
          type: "standard",
          theme: theme === "dark" ? "filled_black" : "outline",
          size: "large",
          text,
          shape: "pill",
          logo_alignment: "left",
          width,
        });
        setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [clientId, theme, text, width]);

  const unavailable =
    config.isError || (config.isSuccess && !clientId) || status === "failed";

  return (
    <div className="flex min-h-11 w-full flex-col items-center justify-center">
      {unavailable ? (
        <p role="alert" className="text-center text-sm text-muted-foreground">
          {config.isSuccess && !clientId
            ? "Google sign-in isn't set up on this server."
            : "Couldn't load Google sign-in. Check your connection and try again."}
        </p>
      ) : (
        status === "loading" && (
          <Loader2
            aria-label="Loading Google sign-in"
            className="size-5 animate-spin text-muted-foreground"
          />
        )
      )}
      <div ref={container} hidden={status !== "ready" || unavailable} />
    </div>
  );
}
