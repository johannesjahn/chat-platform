import { expect, test } from "./fixtures";
import { persistedQueryCache } from "./helpers";

// Issue #501: the persister used to write queries to storage while they were
// still in flight, so every feed load whose request was later cancelled
// logged "A query that was dehydrated as pending ended up rejecting". Only
// queries that have data (never a pending one) may be persisted.
test("loading the feed persists only settled queries and logs no dehydration errors", async ({
  page,
  signUp,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await signUp(page);
  await page.goto("/");
  await expect(page.getByText("No posts yet")).toBeVisible();
  await expect.poll(() => persistedQueryCache(page)).toContain('"posts"');
  // Reload against the warm persisted cache too — the restore-then-refetch
  // path — and give the throttled persister (1s) time to flush again.
  await page.reload();
  await expect(page.getByText("No posts yet")).toBeVisible();
  await page.waitForTimeout(1500);

  const snapshot = JSON.parse(await persistedQueryCache(page)) as {
    clientState: { queries: { state: { status: string } }[] };
  };
  expect(snapshot.clientState.queries.length).toBeGreaterThan(0);
  for (const query of snapshot.clientState.queries)
    expect(query.state.status).not.toBe("pending");
  expect(
    consoleErrors.filter((text) => text.includes("dehydrated as pending")),
  ).toEqual([]);
});
