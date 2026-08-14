import { expect, test } from "./fixtures";
import { registerViaUi } from "./helpers";

test("a profile page shows the user's recent posts and post count, and Message starts a direct chat", async ({
  browser,
  injectApiUrl,
  request,
  apiUrl,
}) => {
  const contextA = await browser.newContext();
  await injectApiUrl(contextA);
  const pageA = await contextA.newPage();
  const { username: usernameA } = await registerViaUi(pageA);

  const sessionA = await pageA.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );
  const seeded = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${sessionA.accessToken}` },
    data: { contentType: "text", content: "Hello from A's profile" },
  });
  expect(seeded.ok()).toBe(true);
  const { authorId } = await seeded.json();

  const contextB = await browser.newContext();
  await injectApiUrl(contextB);
  const pageB = await contextB.newPage();
  await registerViaUi(pageB);

  await pageB.goto(`/users/${authorId}`);
  await expect(
    pageB.getByRole("heading", { name: "Recent posts" }),
  ).toBeVisible();
  await expect(pageB.getByText("Hello from A's profile")).toBeVisible();
  await expect(pageB.getByText("1 post", { exact: true })).toBeVisible();

  await pageB.getByRole("button", { name: "Message" }).click();
  await expect(pageB).toHaveURL(/\/chats\/\d+/);

  await contextA.close();
  await contextB.close();
});

test("a user's own profile shows 'Your posts' with no Message button", async ({
  page,
  request,
  apiUrl,
}) => {
  await registerViaUi(page);
  const session = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chat-platform-session") ?? "null"),
  );

  const seeded = await request.post(`${apiUrl}/posts`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    data: { contentType: "text", content: "My own post" },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto(`/users/${session.user.id}`);
  await expect(page.getByRole("heading", { name: "Your posts" })).toBeVisible();
  await expect(page.getByText("My own post")).toBeVisible();
  await expect(page.getByRole("button", { name: "Message" })).toHaveCount(0);
});
