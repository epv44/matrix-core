import { test, expect } from "@playwright/test";
import { stubApi } from "./fixtures/stub";

const tabs = ["Dashboard", "History", "Financial Tools", "Link / Sync", "Settings"];
const sidebarSubheaders = [
  "View finances",
  "Transactions & Income",
  "Simulations",
  "Add & update accounts",
  "Goals & accounts",
];

test("each sidebar tab renders its view without crashing", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");

  for (const tab of tabs) {
    await page.getByRole("button", { name: tab }).click();
    await expect(page.locator("main h1")).toHaveText(tab);
  }
});

test("History combines depository, investment, and income views", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");

  const sidebar = page.locator("#app-sidebar");
  await sidebar.getByRole("button", { name: "History" }).click();
  await expect(sidebar.getByRole("button", { name: "Transactions", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Income", exact: true })).toHaveCount(0);

  const historyTabs = page.getByRole("tablist", { name: "History views" });
  await expect(historyTabs.getByRole("tab")).toHaveText(["Depository", "Investment", "Income"]);
  await expect(page.getByText("Transaction Browser", { exact: true })).toBeVisible();

  await historyTabs.getByRole("tab", { name: "Investment" }).click();
  await expect(page.getByText("Investment Transactions", { exact: true })).toBeVisible();

  await historyTabs.getByRole("tab", { name: "Income" }).click();
  await expect(page.getByText("Income Breakdown", { exact: true })).toBeVisible();
});

test("sidebar branding and collapse controls refine the desktop shell", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");

  const sidebar = page.locator("#app-sidebar");
  await expect(sidebar.getByRole("heading", { name: "Chaz" })).toBeVisible();
  await expect(sidebar.getByText("Welcome to your AI powered financial consultant.")).toBeVisible();
  await expect(
    sidebar.getByText("Backed by Plaid. Not professional financial advice."),
  ).toBeVisible();
  for (const subheader of sidebarSubheaders) {
    await expect(sidebar.getByText(subheader, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await expect(sidebar).toHaveAttribute("aria-hidden", "false");
});

test("sidebar behaves as a dismissible drawer on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto("/");

  const sidebar = page.locator("#app-sidebar");
  await expect(page.getByRole("button", { name: "Close sidebar backdrop" })).toBeVisible();
  await page.getByRole("button", { name: "Close sidebar backdrop" }).click();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar).toHaveAttribute("aria-hidden", "false");
  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
});
