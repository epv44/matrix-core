import { test, expect } from "@playwright/test";
import { stubApi } from "./fixtures/stub";

test("Settings categories match the canonical set", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  const card = page
    .locator("div.rounded-xl", { has: page.getByText("Categories", { exact: true }) })
    .first();
  const names = (await card.locator("div.grid span").allTextContents()).map((s) => s.trim());
  const canonical = [
    "Transportation",
    "Restaurants",
    "Groceries",
    "Living Expenses",
    "Travel",
    "Cat Related",
    "MISC.",
    "Baby",
    "Self",
    "Home Goods",
  ];
  expect(names.sort()).toEqual([...canonical].sort());
});

test("Settings shows per-category cap inputs", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  const card = page
    .locator("div.rounded-xl", { has: page.getByText("Categories", { exact: true }) })
    .first();
  await expect(card.locator("input[value='$680.00']")).toBeVisible();
  await expect(card.locator("input[value='$1,200.00']")).toBeVisible();
});

test("Settings cap validation sanitizes and shows inline errors", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  const card = page
    .locator("div.rounded-xl", { has: page.getByText("Categories", { exact: true }) })
    .first();
  const row = card.locator("div.rounded-lg", { hasText: "Transportation" }).first();
  const input = row.locator("input").first();
  await input.click();
  await input.fill("3,200");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.locator("input")).toHaveValue("$3,200.00");
  await expect(page.getByText(/Invalid cap/)).toHaveCount(0);
  await input.click();
  await input.fill("abc");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Invalid cap/)).toBeVisible();
});

test("Category Rules section is removed", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByText("Category Rules")).toHaveCount(0);
});

test("Settings groups controls into Goals and Account Settings tabs", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByRole("tab", { name: "Goals" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Financial goals", { exact: true })).toBeVisible();
  await expect(page.getByText("Categories", { exact: true })).toBeVisible();
  await expect(page.getByText("Household members", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Audit History", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Security classifications", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Account Settings" }).click();
  await expect(page.getByText("Household members", { exact: true })).toBeVisible();
  await expect(page.getByText("Accounts & ownership", { exact: true })).toBeVisible();
  await expect(page.getByText("Investment account settings", { exact: true })).toBeVisible();
  await expect(page.getByText("Financial goals", { exact: true })).toHaveCount(0);
});

test("settings goals toggle between household and personal via the account dropdown", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  const householdGoals = page.waitForResponse(
    (r) =>
      r.url().includes("/api/investments/goals") &&
      r.request().method() === "GET" &&
      !r.url().includes("scope=PERSONAL"),
  );
  await page.getByRole("button", { name: "Settings" }).click();
  await householdGoals;

  const goalCard = (name: string) => page.locator("strong", { hasText: name });

  await expect(goalCard("Emergency fund")).toBeVisible();
  await expect(goalCard("My vacation")).toHaveCount(0);
  await expect(page.getByText(/Household goals — shared/)).toBeVisible();

  const personalGoals = page.waitForResponse(
    (r) =>
      r.url().includes("/api/investments/goals") &&
      r.request().method() === "GET" &&
      r.url().includes("scope=PERSONAL"),
  );
  await page.getByLabel("Account owner").selectOption("user-1");
  await personalGoals;

  await expect(goalCard("My vacation")).toBeVisible();
  await expect(goalCard("Emergency fund")).toHaveCount(0);
  await expect(page.getByText(/Personal goals — visible only to you/)).toBeVisible();
});

test("administrator creates and revokes a household invitation", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Account Settings" }).click();

  await page.getByPlaceholder("Member email").fill("partner@example.com");
  await page.getByRole("button", { name: "Invite member" }).click();

  await expect(page.getByLabel("Invitation link")).toHaveValue(
    `${new URL(page.url()).origin}/invite/single-use-token`,
  );
  await expect(page.getByText("partner@example.com", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("partner@example.com", { exact: true })).toHaveCount(0);
});

test("admin can permanently unlink an institution with exact-name confirmation", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Account Settings" }).click();

  const institution = page.locator("div.rounded-lg", { hasText: "Bilt Palladium Card" }).first();
  await expect(institution.getByText("DEPOSITORY · COMPLETE")).toBeVisible();
  await institution.getByRole("button", { name: "Unlink" }).click();
  const dialog = page.getByRole("dialog", { name: "Permanently unlink Bilt Palladium Card" });
  const confirm = dialog.getByRole("button", { name: "Permanently unlink" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Connection name confirmation").fill("Bilt Palladium");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Connection name confirmation").fill("Bilt Palladium Card");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Bilt Palladium Card")).toHaveCount(0);
  await expect(page.getByText("Chase", { exact: true })).toBeVisible();
});

test("Account Settings hides provider identifiers and keeps accountless connections", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Account Settings" }).click();

  await expect(page.getByText("Bilt Palladium Card", { exact: true })).toBeVisible();
  await expect(page.getByText("Chase", { exact: true })).toBeVisible();
  await expect(page.getByText("No imported accounts.")).toBeVisible();
  await expect(page.getByText("provider-account-secret")).toHaveCount(0);
  await expect(page.getByText(/Sources:/)).toHaveCount(0);
  await expect(page.getByText(/Accounts seen:/)).toHaveCount(0);
  await expect(page.getByText("Possible duplicates", { exact: true })).toHaveCount(0);
});

test("member cannot see institution unlink controls", async ({ page }) => {
  await stubApi(page, { role: "MEMBER" });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Account Settings" }).click();

  await expect(page.getByText("Bilt Palladium Card", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlink" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "tester" })).toBeDisabled();
});
