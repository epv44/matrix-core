import { test, expect, Page } from "@playwright/test";
import { stubApi } from "./fixtures/stub";

async function openMonthly(page: Page) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Monthly breakdown" }).click();
}

test("yearly summary is the default tab and renders annual summary + category matrix", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Yearly Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Annual Summary —/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Expenses by Category —/ })).toBeVisible();
  await expect(page.getByText("Total Expense").first()).toBeVisible();
  await expect(page.getByText("Restaurants").first()).toBeVisible();

  const annualSummary = page.getByRole("heading", { name: /Annual Summary —/ }).locator("../..");
  await expect(annualSummary.getByRole("cell", { name: "Net", exact: true })).toHaveCount(0);
  await expect(annualSummary.getByRole("cell", { name: "Net Income", exact: true })).toBeVisible();
  await expect(page.getByText("Net P/L", { exact: true })).toBeVisible();
});

test("monthly controls live in the monthly tab header", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");

  const globalHeader = page.locator("main > div").first();
  await expect(globalHeader.getByRole("link", { name: /Export/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Monthly Overview" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Monthly breakdown" }).click();
  const monthlyPanel = page.getByRole("tabpanel", { name: "Monthly breakdown" });
  await expect(monthlyPanel.getByRole("heading", { name: "Monthly Overview" })).toBeVisible();
  await expect(monthlyPanel.getByLabel("Monthly overview month")).toHaveValue("2026-07");

  const monthExport = monthlyPanel.getByRole("link", { name: "Export Excel (this month)" });
  const rangeExport = monthlyPanel.getByRole("link", {
    name: "Export Range (each month own sheet)",
  });
  await expect(monthExport).toHaveAttribute("href", "/api/export/month/2026/7?env=production");
  await expect(rangeExport).toHaveAttribute(
    "href",
    "/api/export/range?from_month=2026-07&to_month=2026-07&env=production",
  );

  await page.getByLabel("Account owner").selectOption("user-1");
  await expect(monthExport).toHaveAttribute("href", /owner_user_id=user-1/);
  await expect(rangeExport).toHaveAttribute("href", /owner_user_id=user-1/);
  await expect(globalHeader.getByRole("link", { name: /Export/ })).toHaveCount(0);
});

test("dashboard tabs show a hover state", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  const tab = page.getByRole("tab", { name: "Monthly breakdown" });
  expect(await tab.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  const before = await tab.evaluate((el) => getComputedStyle(el).backgroundColor);
  await tab.hover();
  await expect
    .poll(async () => tab.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(before);
});

test("dashboard tabs support keyboard navigation", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");

  const yearly = page.getByRole("tab", { name: "Yearly Summary" });
  const monthly = page.getByRole("tab", { name: "Monthly breakdown" });
  await yearly.focus();
  await yearly.press("ArrowRight");

  await expect(monthly).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "dashboard-monthly-tab",
  );
});

test("yearly summary formats currency and shows category caps", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Expenses by Category —/ })).toBeVisible();
  await expect(page.getByText("$548.09").first()).toBeVisible();
  await expect(page.getByText("$680.00").first()).toBeVisible();
  await expect(page.getByText("$1,200.00").first()).toBeVisible();
  await expect(page.getByText("Net Income", { exact: true })).toBeVisible();
  await expect(page.getByText("Column 1")).toHaveCount(0);
  await expect(page.getByText("Total Caps")).toHaveCount(0);
});

test("yearly summary colors caps, budget overrun, and net income", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Expenses by Category —/ })).toBeVisible();
  await expect(page.locator("td").filter({ hasText: "$548.09" })).toHaveCSS(
    "background-color",
    "rgb(183, 225, 205)",
  );
  await expect(page.locator("td").filter({ hasText: "$6,511.71" })).toHaveCSS(
    "background-color",
    "rgb(244, 199, 195)",
  );
  await expect(page.locator("td").filter({ hasText: "$15,000.00" })).toHaveCSS(
    "background-color",
    "rgb(255, 242, 204)",
  );
  await expect(page.locator("td").filter({ hasText: "$9,494.21" })).toHaveCSS(
    "background-color",
    "rgb(183, 225, 205)",
  );
  await expect(page.locator("td").filter({ hasText: "-$4,000.00" })).toHaveCSS(
    "background-color",
    "rgb(244, 199, 195)",
  );
});

test("investment tracking tab shows the portfolio dashboard", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await expect(page.getByText("INVESTMENTS", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Portfolio vs S&P 500 total-return proxy", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Actual and target allocation chart")).toBeVisible();
  await expect(page.getByLabel("Contributions and investment growth chart")).toBeVisible();
  await expect(page.getByLabel("Top holdings chart")).toBeVisible();
});

test("holdings table fits a laptop viewport with compact two-line text", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();

  const table = page.getByRole("table", { name: "Holdings" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveCount(9);

  const fitsWithoutScrolling = await table.evaluate((element) => {
    const scrollContainer = element.parentElement;
    return Boolean(
      scrollContainer && scrollContainer.scrollWidth <= scrollContainer.clientWidth + 1,
    );
  });
  expect(fitsWithoutScrolling).toBe(true);

  const compactText = table.locator("tbody td:nth-child(-n+5) .line-clamp-2");
  await expect(compactText).toHaveCount(10);
  for (const text of await compactText.all()) {
    const staysWithinTwoLines = await text.evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height <= lineHeight * 2 + 1;
    });
    expect(staysWithinTwoLines).toBe(true);
  }
});

test("investment performance help explains Modified Dietz and normalized values", async ({
  page,
}) => {
  await stubApi(page, { investmentPerformanceMethod: "MODIFIED_DIETZ" });
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.setViewportSize({ width: 375, height: 812 });

  const help = page.getByRole("button", { name: "About Modified Dietz estimate" });
  await help.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("weights each cash flow by how long it was invested");
  await expect(tooltip).toContainText("108 means an 8% return and 95 means a 5% loss");

  await help.focus();
  await expect(tooltip).toBeVisible();
  await help.press("Escape");
  await expect(tooltip).toBeHidden();

  await help.click();
  await expect(tooltip).toBeVisible();
  const tooltipBox = await tooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(375);
});

test("investment performance help explains time-weighted return when active", async ({ page }) => {
  await stubApi(page, { investmentPerformanceMethod: "TWR" });
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();

  await page.getByRole("button", { name: "About time-weighted return" }).hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Time-weighted return chains returns");
  await expect(tooltip).not.toContainText("Modified Dietz");
});

test("investment data stays cached across dashboard tab changes", async ({ page }) => {
  await stubApi(page);
  let dashboardRequests = 0;
  let benchmarkRequests = 0;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/investments/dashboard?")) dashboardRequests += 1;
    if (url.includes("/api/investments/benchmark/refresh")) benchmarkRequests += 1;
  });
  await page.goto("/");

  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await expect(page.getByText("INVESTMENTS", { exact: true })).toBeVisible();
  await expect.poll(() => dashboardRequests).toBe(1);

  await page.getByRole("tab", { name: "Monthly breakdown" }).click();
  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await expect(page.getByText("INVESTMENTS", { exact: true })).toBeVisible();
  expect(dashboardRequests).toBe(1);
  expect(benchmarkRequests).toBe(1);
});

test("investment filters apply once, retain data while updating, and survive tab changes", async ({
  page,
}) => {
  await stubApi(page);
  let dashboardRequests = 0;
  let delayNextDashboard = false;
  let releaseDashboard = () => {};
  page.on("request", (request) => {
    if (request.url().includes("/api/investments/dashboard?")) dashboardRequests += 1;
  });
  await page.route(/\/api\/investments\/dashboard\?/, async (route) => {
    if (delayNextDashboard) {
      delayNextDashboard = false;
      await new Promise<void>((resolve) => {
        releaseDashboard = resolve;
      });
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await expect(page.getByRole("button", { name: "VANGUARD.TARGET.2060" })).toBeVisible();
  await expect.poll(() => dashboardRequests).toBe(1);

  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Include 401(k)").uncheck();
  expect(dashboardRequests).toBe(1);

  delayNextDashboard = true;
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => dashboardRequests).toBe(2);
  await expect(page.getByText("Updating portfolio…")).toBeVisible();
  await expect(page.getByRole("button", { name: "VANGUARD.TARGET.2060" })).toBeVisible();
  releaseDashboard();
  await expect(page.getByText("Updating portfolio…")).toBeHidden();
  await expect(page.getByText("401(k) excluded", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Monthly breakdown" }).click();
  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await expect(page.getByText("401(k) excluded", { exact: true })).toBeVisible();
  expect(dashboardRequests).toBe(2);

  await page.getByRole("button", { name: "Filters (1)" }).click();
  await page.getByLabel("Include 401(k)").check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("401(k) excluded", { exact: true })).toBeHidden();
  expect(dashboardRequests).toBe(2);

  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Include 401(k)").uncheck();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("401(k) excluded", { exact: true })).toBeVisible();
  expect(dashboardRequests).toBe(2);
});

test("holding allocation editor validates, saves mixed exposure, and restores automatic classification", async ({
  page,
}) => {
  await stubApi(page);
  let savedBody: unknown = null;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/investments/classifications/target-2060")
    ) {
      savedBody = request.postDataJSON();
    }
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();
  await page.getByRole("button", { name: "VANGUARD.TARGET.2060" }).click();

  const save = page.getByRole("button", { name: "Save allocation" });
  await page.getByLabel("US Equity percentage").fill("54");
  await expect(save).toBeDisabled();
  await page.getByLabel("International Equity percentage").fill("36");
  await page.getByLabel("Bonds percentage").fill("10");
  await page.getByLabel("Other percentage").fill("0");
  await expect(page.getByText("Total: 100.00%", { exact: true })).toBeVisible();
  await save.click();

  await expect(page.getByRole("dialog")).toBeHidden();
  expect(savedBody).toEqual({
    allocations: [
      { asset_class: "US_EQUITY", percent: 54 },
      { asset_class: "INTERNATIONAL_EQUITY", percent: 36 },
      { asset_class: "BONDS", percent: 10 },
    ],
  });
  await expect(
    page.getByText("US Equity 54% · International Equity 36% · Bonds 10%", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "VANGUARD.TARGET.2060" }).click();
  await expect(page.getByText("Source: User override", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use automatic classification" }).click();
  await expect(page.getByText("Other 100%", { exact: true })).toBeVisible();
});

test("balance-only 529 shows its balance and supports account allocation", async ({ page }) => {
  await stubApi(page);
  let savedBody: unknown = null;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/investments/accounts/education-1/allocations")
    ) {
      savedBody = request.postDataJSON();
    }
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Investment Tracking" }).click();

  await expect(page.getByText("529 balance", { exact: true })).toBeVisible();
  await expect(page.getByText("$11,393.40", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Investment · 529", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Schwab 529 Plan" }).click();
  await expect(page.getByText("applies to this account balance", { exact: false })).toBeVisible();

  await page.getByLabel("US Equity percentage").fill("70");
  await page.getByLabel("Bonds percentage").fill("30");
  await page.getByLabel("Other percentage").fill("0");
  await page.getByRole("button", { name: "Save allocation" }).click();

  expect(savedBody).toEqual({
    allocations: [
      { asset_class: "US_EQUITY", percent: 70 },
      { asset_class: "BONDS", percent: 30 },
    ],
  });
  await expect(page.getByText("US Equity 70% · Bonds 30%", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Education", exact: true }).click();
  await expect(page.getByText("Schwab 529 Plan", { exact: true }).first()).toBeVisible();
});

test("dashboard renders stats, monthly breakdown, and income sections", async ({ page }) => {
  await stubApi(page);
  await openMonthly(page);

  await expect(page.getByRole("heading", { name: "Monthly Breakdown — 2026-07" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Income — 2026-07" })).toBeVisible();

  for (const label of ["Total Spent", "Total Made", "Net P/L", "% Saved", "Uncategorized"]) {
    await expect(page.locator(`text=${label}`).first()).toBeVisible();
  }

  await expect(page.getByText("META PAYROLL")).toBeVisible();
  await expect(page.getByText("DEPOSIT@MOBILE")).toBeVisible();
  await expect(page.getByText("$17,803.96").first()).toBeVisible();
});

test("uncategorized card tooltip shows merchant names on hover", async ({ page }) => {
  await stubApi(page);
  await openMonthly(page);

  await page.locator("text=Uncategorized").first().hover();
  await expect(page.getByText("Uncategorized transactions").last()).toBeVisible();
  await expect(page.getByRole("button", { name: /Ring/ }).first()).toBeVisible();
});

test("dashboard shows exactly the canonical category columns in order", async ({ page }) => {
  await stubApi(page);
  await openMonthly(page);
  await expect(page.getByRole("heading", { name: "Monthly Breakdown — 2026-07" })).toBeVisible();

  const expected = [
    "Transportation",
    "Self",
    "Restaurants",
    "Groceries",
    "MISC.",
    "Living Expenses",
    "Baby",
    "Travel",
    "Cat Related",
    "Home Goods",
  ];
  const headers = (await page.locator("table").first().locator("thead th").allTextContents()).map(
    (s) => s.trim(),
  );
  expect(headers).toEqual(expected);
  for (const stale of ["Food", "Miscellaneous", "Living"]) {
    expect(headers).not.toContain(stale);
  }
});

test("sandbox badge shows with ?sandbox=true", async ({ page }) => {
  await stubApi(page);
  await page.goto("/?sandbox=true");
  await expect(page.getByText("sandbox", { exact: true }).first()).toBeVisible();
});
