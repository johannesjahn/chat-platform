import { googleSubFor } from "../../src/GoogleTestSigner";
import { expect, test } from "./fixtures";
import { signInWithGoogle, useGoogleAccount } from "./google";
import { goToOwnProfile, logOut, randomUsername } from "./helpers";

// Sign-in is Google for everyone (issue #693); the Google Identity Services
// script is stood in for by e2e/google.ts, so these drive the real /login
// and /register pages against the real endpoints.

test("a first Google sign-in asks for a username, then lands on the feed signed in", async ({
  page,
}) => {
  const username = randomUsername();

  await page.goto("/login");
  await signInWithGoogle(page, googleSubFor(username));

  // No account yet: the username step.
  await expect(page).toHaveURL(/\/register/);
  await expect(
    page.getByRole("heading", { name: "Pick a username" }),
  ).toBeVisible();
  await expect(page.locator("#password")).toHaveCount(0);
  await page.fill("#username", username);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByText(`@${username}`),
  ).toBeVisible();

  // User search is a protected endpoint — it should load (the bearer token
  // is attached) and include the new user. Scoped to the list so it doesn't
  // also match the username in the nav bar.
  await page.goto("/users");
  await page.getByPlaceholder("Search users…").fill(username);
  await expect(page.getByRole("list").getByText(`@${username}`)).toBeVisible();
});

test("the username step shows a taken name inline and accepts another", async ({
  page,
  createUser,
}) => {
  const existing = await createUser();
  const username = randomUsername();

  await page.goto("/login");
  await signInWithGoogle(page, googleSubFor(username));
  await expect(page).toHaveURL(/\/register/);

  await page.fill("#username", existing.username);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toContainText("already taken");

  await page.fill("#username", username);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByText(`@${username}`),
  ).toBeVisible();
});

test("a returning Google sign-in goes straight to the feed; log out and sign back in", async ({
  page,
  createUser,
}) => {
  const user = await createUser();

  await page.goto("/login");
  await signInWithGoogle(page, user.sub);
  await expect(page).toHaveURL("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByText(`@${user.username}`)).toBeVisible();

  await logOut(page);
  await expect(nav.getByText(`@${user.username}`)).toHaveCount(0);

  await page.goto("/login");
  await signInWithGoogle(page, user.sub);
  await expect(page).toHaveURL("/");
  await expect(nav.getByText(`@${user.username}`)).toBeVisible();
});

test("/register without a pending Google sign-in sends you to /login", async ({
  page,
}) => {
  await page.goto("/register");
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
});

test("signing in offers Google, with password sign-in tucked away for admins", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(page.locator("#password")).toHaveCount(0);
  // No way to make a password account.
  await expect(page.getByRole("link", { name: /register/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Admin sign-in" }).click();
  await expect(page).toHaveURL(/method=password/);
  await expect(
    page.getByRole("heading", { name: "Admin sign-in" }),
  ).toBeVisible();

  // It asks password managers for the account's current password, and the
  // show/hide toggle flips the field between masked and plain text.
  const password = page.locator("#password");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");

  await page.getByRole("link", { name: "Sign in with Google instead" }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
});

test("a Google account can't sign in with a password", async ({
  page,
  createUser,
}) => {
  const user = await createUser();

  await page.goto("/login?method=password");
  await page.fill("#username", user.username);
  await page.fill("#password", "any-password-at-all");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid username or password",
  );
  await expect(page).toHaveURL(/\/login/);
});

test("a Google account has no password settings, and deletes itself by signing in with Google again", async ({
  page,
  signUp,
}) => {
  const user = await signUp(page);

  await page.goto("/settings?section=password");
  // There's no password section to land on — the profile shows instead.
  await expect(page.locator("#current-password")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Password" })).toHaveCount(0);

  await page.goto("/settings?section=account");
  await expect(page.locator("#delete-password")).toHaveCount(0);
  await useGoogleAccount(page, user.sub);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete account" })
    .click();

  await expect(page).toHaveURL("/");
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByText(`@${user.username}`),
  ).toHaveCount(0);

  // The Google account is a stranger again: signing in starts over.
  await page.goto("/login");
  await signInWithGoogle(page, user.sub);
  await expect(page).toHaveURL(/\/register/);
});

test("setting a display name replaces the username in the nav, but the profile page still shows both", async ({
  page,
  signUp,
}) => {
  const { username } = await signUp(page);
  const displayName = "Ada Lovelace";

  // The settings page no longer offers a way to change the username itself —
  // it's shown read-only.
  await page.goto("/settings");
  await expect(page.locator("#username")).toHaveCount(0);
  await expect(page.locator("form").getByText(`@${username}`)).toBeVisible();

  await page.fill("#display-name", displayName);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile updated.")).toBeVisible();

  // Everywhere but the profile page (and the settings page's own read-only
  // username field, checked above), the display name now takes over from
  // the raw username — starting with the feed, once navigated there.
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByText(displayName).first()).toBeVisible();
  await expect(nav.getByText(`@${username}`)).not.toBeVisible();

  // The profile page is the one place that still surfaces the actual
  // username, alongside the display name.
  await goToOwnProfile(page);
  await expect(page).toHaveURL(/\/users\/\d+/);
  await expect(page.getByText(`@${username}`)).toBeVisible();
});

// Admin password accounts, made the way an operator makes them — the
// `create-admin` CLI, run before the backend starts (see `admins` in
// fixtures.ts).
test.describe("admin password accounts", () => {
  const admin = { username: "e2e_admin", password: "admin-pw-123" };
  test.use({ admins: [admin] });

  async function adminSignIn(
    page: import("@playwright/test").Page,
    password = admin.password,
  ) {
    await page.goto("/login?method=password");
    await page.fill("#username", admin.username);
    await page.fill("#password", password);
    await page.getByRole("button", { name: "Log in" }).click();
  }

  test("an admin signs in with a password and gets the Admin entry", async ({
    page,
  }) => {
    await adminSignIn(page);
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("link", { name: "Admin", exact: true }),
    ).toBeVisible();
  });

  test("changes password from settings and can log back in with the new one", async ({
    page,
  }) => {
    const newPassword = "admin-new-pw-456";
    await adminSignIn(page);
    await expect(page).toHaveURL("/");

    // The password section — the desktop settings show one at a time.
    await page.goto("/settings?section=password");
    await page.fill("#current-password", admin.password);
    await page.fill("#new-password", newPassword);
    await page.fill("#confirm-password", newPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed.")).toBeVisible();

    // Logging out and back in with the new password proves it actually took
    // effect server-side (and that the old one no longer works).
    await logOut(page);
    await adminSignIn(page);
    await expect(page.getByRole("alert")).toContainText(
      "Invalid username or password",
    );
    await adminSignIn(page, newPassword);
    await expect(page).toHaveURL("/");
    await expect(
      page
        .getByRole("navigation", { name: "Main" })
        .getByText(`@${admin.username}`),
    ).toBeVisible();
  });

  // A wrong *current* password is a 401 `InvalidCredentials` — it must show
  // inline and leave the session alone, not be mistaken for a dead token and
  // sign the user out of every tab (issue #656).
  test("a wrong current password shows an inline error and stays signed in", async ({
    page,
  }) => {
    await adminSignIn(page);
    await expect(page).toHaveURL("/");

    await page.goto("/settings?section=password");
    await page.fill("#current-password", "not-my-password");
    await page.fill("#new-password", "admin-new-pw-456");
    await page.fill("#confirm-password", "admin-new-pw-456");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Incorrect current password")).toBeVisible();

    expect(
      await page.evaluate(() => localStorage.getItem("chat-platform-session")),
    ).not.toBeNull();
    await page.goto("/users");
    await expect(
      page
        .getByRole("navigation", { name: "Main" })
        .getByText(`@${admin.username}`),
    ).toBeVisible();
  });
});
