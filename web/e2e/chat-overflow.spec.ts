import { expect, test } from "./fixtures";

// A phone-width viewport: a long unbroken string or URL in a message must wrap
// inside its bubble instead of widening the thread into a horizontal scroll.
test.use({
  viewport: { width: 375, height: 667 },
  hasTouch: true,
  isMobile: true,
});

test("chat thread never scrolls horizontally on a phone", async ({
  page,
  apiUrl,
  signUp,
  createUser,
}) => {
  const me = await signUp(page);
  const other = await createUser();
  const headers = (token: string) => ({
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  });

  const chat = (await (
    await fetch(`${apiUrl}/chats/direct`, {
      method: "POST",
      headers: headers(me.session.accessToken),
      body: JSON.stringify({ userId: other.session.user.id }),
    })
  ).json()) as { id: number };

  const send = async (token: string, content: string) => {
    const response = await fetch(`${apiUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ contentType: "text", content }),
    });
    expect(response.ok).toBe(true);
  };
  await send(me.session.accessToken, "hello there");
  await send(other.session.accessToken, "c".repeat(150));
  await send(
    other.session.accessToken,
    `https://example.com/${"a".repeat(120)}`,
  );
  await send(me.session.accessToken, `https://example.com/${"b".repeat(120)}`);

  await page.goto(`/chats/${chat.id}`);
  const scroller = page.getByTestId("chat-scroll");
  await expect(scroller).toBeVisible();
  await expect(page.getByRole("main").getByText("hello there")).toBeVisible();

  const { scrollWidth, clientWidth } = await scroller.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});
