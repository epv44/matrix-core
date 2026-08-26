import { expect, test } from "@playwright/test";

import { stubApi } from "./fixtures/stub";

test("Financial Tools opens Rent vs. Buy and preserves assumptions between tool tabs", async ({
  page,
}) => {
  await stubApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Financial Tools" }).click();
  await expect(page.locator("main h1")).toHaveText("Financial Tools");
  await expect(
    page.locator("#app-sidebar").getByText("Simulations", { exact: true }),
  ).toBeVisible();

  const tools = page.getByRole("tablist", { name: "Financial tool simulations" });
  await expect(tools.getByRole("tab")).toHaveText(["Rent vs. Buy", "Monte Carlo"]);
  await expect(tools.getByRole("tab", { name: "Rent vs. Buy" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("Starting cash: from selected household")).toBeVisible();

  const homePrice = page.getByLabel("Home price");
  await homePrice.fill("625000");
  await tools.getByRole("tab", { name: "Rent vs. Buy" }).press("ArrowRight");
  await expect(tools.getByRole("tab", { name: "Monte Carlo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tools.getByRole("tab", { name: "Rent vs. Buy" }).click();
  await expect(homePrice).toHaveValue("625000");
});

test("both financial simulations submit and display accessible result summaries", async ({
  page,
}) => {
  const requests: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/financial-tools/")) {
      requests.push(request.url());
      payloads.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  await stubApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Financial Tools" }).click();

  const rentDollarFields = [
    "Home price",
    "Down payment",
    "Starting liquid assets",
    "Monthly amount available",
    "Monthly rent",
    "Monthly HOA",
    "Monthly insurance",
    "Monthly maintenance",
    "Monthly PMI",
    "Capital-gain exclusion",
  ];
  for (const label of rentDollarFields) {
    await expect(page.getByLabel(label)).toHaveAttribute("step", "1");
  }
  await expect(page.getByLabel("Home price")).toHaveAttribute("min", "1");
  await expect(page.getByLabel("Analysis horizon")).toHaveAttribute("step", "1");
  await expect(page.getByLabel("Annual available-income growth")).toHaveAttribute("step", "0.01");
  await expect(page.getByLabel("Starting liquid assets")).toHaveValue("250000");
  await page.getByLabel("Starting liquid assets").fill("2128592");
  await page.getByLabel("Monthly rent").fill("2501");
  await page.getByLabel("Capital-gain exclusion").fill("250001");
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByText("30-year fixed advantage")).toBeVisible();
  await expect(
    page.getByRole("img", { name: /projected buying and renting net worth/ }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Monte Carlo" }).click();
  const monteCarloDollarFields = [
    "Starting investments",
    "Starting cash",
    "Monthly investment contribution",
    "Monthly cash contribution",
    "Withdraw from investments",
    "Withdraw from cash",
  ];
  for (const label of monteCarloDollarFields) {
    await expect(page.getByLabel(label)).toHaveAttribute("step", "1");
  }
  await expect(page.getByLabel("Starting investments")).toHaveValue("750001");
  await expect(page.getByLabel("Starting cash")).toHaveValue("250000");
  await expect(page.getByRole("spinbutton", { name: "Simulations runs" })).toHaveAttribute(
    "step",
    "100",
  );
  await expect(page.getByLabel("Annual inflation")).toHaveAttribute("step", "0.1");
  await page.getByLabel("Monthly investment contribution").fill("101");
  await page.getByLabel("Monthly cash contribution").fill("51");
  await page.getByLabel("Withdraw from investments").fill("200001");
  await page.getByLabel("Withdraw from cash").fill("100001");
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.getByText("Withdrawal fully funded")).toBeVisible();
  await expect(page.getByText("94.0%")).toBeVisible();
  await expect(page.getByRole("img", { name: /10th, median, and 90th percentile/ })).toBeVisible();

  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain("rent-to-buy/simulate");
  expect(requests[1]).toContain("monte-carlo/simulate");
  expect(payloads[0]?.starting_cash).toBe(2128592);
  expect(payloads[0]?.monthly_rent).toBe(2501);
  expect(payloads[0]?.capital_gains_exclusion).toBe(250001);
  expect(payloads[1]?.monthly_investment_contribution).toBe(101);
  expect(payloads[1]?.monthly_cash_contribution).toBe(51);
  expect(payloads[1]?.withdrawal_investment).toBe(200001);
  expect(payloads[1]?.withdrawal_cash).toBe(100001);
});
