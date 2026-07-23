import { expect, test } from "./fixtures";
import { makeSolidPng, registerViaUi } from "./helpers";

test("uploads and crops an avatar from settings, replacing the initials everywhere it's shown", async ({
  page,
}) => {
  await registerViaUi(page);

  await page.goto("/settings");
  // Before uploading, the avatar preview falls back to initials — no <img>.
  await expect(page.locator("form img")).toHaveCount(0);

  const png = makeSolidPng(300, 300, [200, 60, 60]);
  await page.setInputFiles('input[type="file"]', {
    name: "avatar.png",
    mimeType: "image/png",
    buffer: png,
  });

  // The crop dialog opens with a live preview of the uploaded image.
  await expect(page.getByRole("dialog", { name: "Crop avatar" })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Crop avatar" }).locator("img"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save avatar" }).click();

  // The dialog closes and the profile form now shows the uploaded avatar
  // (a data: URL <img>) instead of the initials placeholder.
  await expect(page.getByRole("dialog", { name: "Crop avatar" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Profile updated.")).toBeVisible();
  const preview = page.locator("form img");
  await expect(preview).toHaveCount(1);
  await expect(preview).toHaveAttribute("src", /^data:image\/webp;base64,/);

  // Reflected on the user's own profile page too, on a fresh navigation —
  // proves it round-tripped through the backend, not just local form state.
  await page.getByRole("link", { name: /^@/ }).click();
  await expect(page).toHaveURL(/\/users\/\d+/);
  await expect(page.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/webp;base64,/,
  );
});

test("removes an uploaded avatar back to the initials placeholder", async ({
  page,
}) => {
  await registerViaUi(page);
  await page.goto("/settings");

  const png = makeSolidPng(300, 300, [60, 140, 220]);
  await page.setInputFiles('input[type="file"]', {
    name: "avatar.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByRole("dialog", { name: "Crop avatar" })).toBeVisible();
  await page.getByRole("button", { name: "Save avatar" }).click();
  await expect(page.locator("form img")).toHaveCount(1);

  await page.getByRole("button", { name: "Remove photo" }).click();

  await expect(page.getByText("Profile updated.")).toBeVisible();
  await expect(page.locator("form img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove photo" })).toHaveCount(
    0,
  );

  // Reflected on the user's own profile page too, on a fresh navigation.
  await page.getByRole("link", { name: /^@/ }).click();
  await expect(page).toHaveURL(/\/users\/\d+/);
  await expect(page.locator("img")).toHaveCount(0);
});

test("uploadAvatar rejects an image smaller than the minimum dimensions, before any upload", async ({
  page,
}) => {
  await registerViaUi(page);
  await page.goto("/settings");

  const tinyPng = makeSolidPng(100, 100, [10, 200, 10]);
  await page.setInputFiles('input[type="file"]', {
    name: "tiny.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });

  await expect(page.getByRole("dialog", { name: "Crop avatar" })).toBeVisible();
  await expect(page.getByText(/at least 256×256px/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save avatar" }),
  ).toBeDisabled();
});
