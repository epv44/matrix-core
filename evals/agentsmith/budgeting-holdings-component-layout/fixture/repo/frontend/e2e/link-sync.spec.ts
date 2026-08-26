import { test, expect } from "@playwright/test";
import { stubApi } from "./fixtures/stub";

test("Plaid Link SDK is embedded only once across view remounts", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Link / Sync" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __plaidLinkScriptLoads?: number }).__plaidLinkScriptLoads,
      ),
    )
    .toBe(1);
  await expect(
    page.locator('script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]'),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __plaidLinkScriptLoads?: number }).__plaidLinkScriptLoads,
      ),
    )
    .toBe(1);
  await expect(
    page.locator('script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]'),
  ).toHaveCount(1);
});

test("Link / Sync renders the unified backfill workflow", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await expect(page.getByRole("heading", { name: "Link Institution" })).toBeVisible();
  await expect(
    page.getByText(/person linking the account should enter their own number/i),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sync", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Backfill Data" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Institutions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sync History" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Diagnostics (Doctor)" })).toBeVisible();

  await expect(page.getByRole("button", { name: "Sync Now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Backfill", exact: true }).first()).toBeVisible();
  await expect(page.getByText("Start date:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Backfill All Accounts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-link for More History" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview Backfill" })).toHaveCount(0);

  await expect(page.getByRole("cell", { name: "usaa" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "ok" }).first()).toBeVisible();
  await expect(page.getByText("keychain-token-usaa")).toBeVisible();
});

test("sync history paginates 20 results at a time and resets after sync", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  const historyCard = page.getByRole("heading", { name: "Sync History" }).locator("../..");
  await expect(historyCard.locator("tbody tr")).toHaveCount(20);
  await expect(historyCard.getByText("Page 1 of 3")).toBeVisible();
  await expect(historyCard.getByRole("button", { name: "Previous" })).toBeDisabled();

  await historyCard.getByRole("button", { name: "Next" }).click();
  await expect(historyCard.locator("tbody tr")).toHaveCount(20);
  await expect(historyCard.getByText("Page 2 of 3")).toBeVisible();

  await historyCard.getByRole("button", { name: "Next" }).click();
  await expect(historyCard.locator("tbody tr")).toHaveCount(5);
  await expect(historyCard.getByText("Page 3 of 3")).toBeVisible();
  await expect(historyCard.getByRole("button", { name: "Next" })).toBeDisabled();

  await page.getByRole("button", { name: "Sync Now" }).click();
  await expect(historyCard.getByText("Page 1 of 3")).toBeVisible();
  await expect(historyCard.locator("tbody tr")).toHaveCount(20);
});

test("link shows backfill modal when history exceeds 30 days", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await page.getByPlaceholder("usaa, chase, bilt").fill("chase");
  await page.getByLabel("New institution history start date").fill("2026-01-01");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(
    page.getByText(/Plaid may deliver older transactions in the background/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByText(/Plaid may deliver older transactions in the background/),
  ).toHaveCount(0);
});

test("link warns only 30 days when webhook is disabled", async ({ page }) => {
  await stubApi(page, { webhookEnabled: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await page.getByPlaceholder("usaa, chase, bilt").fill("chase");
  await page.getByLabel("New institution history start date").fill("2026-01-01");
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await expect(
    page.getByText(/Webhooks are not enabled, so only the most recent 30 days/),
  ).toBeVisible();
});

test("production backfill starts Plaid authorization with the selected date", async ({ page }) => {
  await stubApi(page);
  const syncRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/sync(?:\?|$)/.test(request.url()) && request.method() === "POST") {
      syncRequests.push(request.url());
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await page.getByLabel("Start date:").fill("2026-01-15");
  await page.getByRole("button", { name: "Backfill All Accounts" }).click();
  await expect(
    page.getByRole("dialog", { name: "Backfill all accounts to 2026-01-15?" }),
  ).toBeVisible();

  const relinkRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/api/connections/connection-usaa/relink/start"),
  );
  await page.getByRole("button", { name: "Continue" }).click();
  const request = await relinkRequest;
  expect(new URL(request.url()).searchParams.get("history_date")).toBe("2026-01-15");
  expect(syncRequests).toEqual([]);
});

test("single institution backfill opens a date modal and targets only that institution", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await page.getByRole("button", { name: "Backfill", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Backfill usaa?" })).toBeVisible();
  await page.getByLabel("Single backfill start date").fill("2026-02-01");

  const relinkRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/api/connections/connection-usaa/relink/start"),
  );
  await page
    .getByRole("dialog", { name: "Backfill usaa?" })
    .getByRole("button", { name: "Continue" })
    .click();
  const request = await relinkRequest;
  expect(new URL(request.url()).searchParams.get("history_date")).toBe("2026-02-01");
});

test("production backfill continues after an institution setup failure", async ({ page }) => {
  await stubApi(page);
  const attempted: string[] = [];
  await page.route("**/api/connections/*/relink/start**", (route) => {
    const match = route
      .request()
      .url()
      .match(/connections\/([^/]+)\/relink/);
    const connectionId = decodeURIComponent(match?.[1] || "");
    attempted.push(connectionId);
    if (connectionId === "connection-usaa")
      return route.fulfill({ status: 500, json: { detail: "setup failed" } });
    return route.fulfill({
      json: {
        link_token: "relink-token",
        relink_id: "relink-2",
        institution: "chase",
        env: "production",
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Link / Sync" }).click();

  await page.getByRole("button", { name: "Backfill All Accounts" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect.poll(() => attempted).toEqual(["connection-usaa", "connection-chase"]);
  await expect(page.getByText(/Failed — 500/)).toBeVisible();
  await expect(page.getByText("Waiting for Plaid")).toBeVisible();
});
