import { test, expect } from "@playwright/test";
import { stubApi } from "./fixtures/stub";

const listResp = {
  transactions: [
    {
      plaid_transaction_id: "t1",
      account_id: "a1",
      institution: "usaa",
      date: "2026-07-01",
      amount: 30,
      merchant: "Uber",
      raw_description: "Uber",
      category: "Food",
      transaction_type: "EXPENSE",
      pending: false,
      is_ignored: false,
      pfc_primary: null,
      pfc_detailed: null,
      payment_processor: null,
      plaid_category: null,
      plaid_subcategory: null,
    },
  ],
  count: 1,
  has_more: false,
};

const detailResp = {
  transaction: {
    plaid_transaction_id: "t1",
    account_id: "a1",
    institution: "usaa",
    date: "2026-07-01",
    amount: 30,
    merchant: "APRESS MEDIA LLC ACH/CRED *********** THE LAST FIVE DIGITS 12345",
    raw_description:
      "APRESS MEDIA LLC ACH/CRED *********** THE LAST FIVE DIGITS 12345 POS 23.99 07/01 10:15:22",
    category: "Restaurants",
    transaction_type: "EXPENSE",
    type_override: null,
    pending: false,
    is_ignored: false,
    pfc_primary: "GENERAL_SERVICES",
    pfc_detailed: "OTHER_GENERAL_SERVICES",
    payment_processor: "PayPal",
    plaid_category: "Shops",
    plaid_subcategory: "Wholesale",
    currency: "USD",
  },
  trace: [
    {
      order: 1,
      source: "category_rules DB",
      description:
        "User Remember rule substring upper match against the full merchant and raw description haystack",
      matched: false,
      pattern: null,
      category: null,
      result: null,
    },
    {
      order: 2,
      source: "MERCHANT_CATEGORY_OVERRIDES",
      description: "CHEWY->Cat Related, DAYCARE->Baby, 1POINT3ACRE->MISC. override substring match",
      matched: true,
      result: "MISC.",
    },
    {
      order: 3,
      source: "stored transactions.category",
      description:
        "User override stored on the transaction row during a previous reclassify session",
      matched: false,
      result: null,
    },
    {
      order: 4,
      source: "PFC",
      description:
        "GENERAL_SERVICES/OTHER_GENERAL_SERVICES mapped through the personal finance category map",
      matched: false,
      result: null,
      pfc_primary: "GENERAL_SERVICES",
      pfc_detailed: "OTHER_GENERAL_SERVICES",
    },
    {
      order: 5,
      source: "legacy",
      description: "plaid_category=Shops mapped through the legacy Plaid category map",
      matched: true,
      result: "MISC.",
    },
    {
      order: 6,
      source: "fallback MISC.",
      description: "Final fallback to the Miscellaneous sheet column when nothing else matched",
      matched: true,
      result: "MISC.",
    },
  ],
  history: [
    {
      transaction_id: "t1",
      old_category: "Restaurants",
      new_category: "MISC.",
      timestamp: "2026-08-03 20:00:00",
    },
  ],
};

test("Save reclassifies current transaction without a global recalc", async ({ page }) => {
  const reclassifyPosts: unknown[] = [];
  let recalcPosts = 0;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (req.url().includes("/api/transactions/") && req.url().includes("/reclassify"))
      reclassifyPosts.push(req.postDataJSON());
    if (req.url().includes("/api/categorize/recalculate")) recalcPosts++;
  });

  await stubApi(page, { transactions: listResp, transactionDetail: detailResp });

  await page.goto("/");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Detail" }).click();
  await expect(page.getByRole("button", { name: "Save Reclassification" })).toBeVisible();

  await page.locator("div.rounded-2xl select").selectOption({ label: "Transportation" });
  await page.getByRole("button", { name: "Save Reclassification" }).click();
  await expect(page.getByRole("button", { name: "Save Reclassification" })).not.toBeVisible();

  expect(reclassifyPosts).toHaveLength(1);
  expect(recalcPosts).toBe(0);
});

test("Hide Transaction confirms and hides only after approval", async ({ page }) => {
  const ignorePosts: Record<string, unknown>[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/ignore")) {
      ignorePosts.push(req.postDataJSON() as Record<string, unknown>);
    }
  });
  await stubApi(page, { transactions: listResp, transactionDetail: detailResp });

  await page.goto("/");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Detail" }).click();
  await expect(page.getByRole("button", { name: "Save Reclassification" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide Transaction" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Hide Transaction" }).click();
  await expect(page.getByRole("heading", { name: "Transaction Detail" })).toBeVisible();
  expect(ignorePosts).toHaveLength(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Hide Transaction" }).click();
  await expect(page.getByRole("heading", { name: "Transaction Detail" })).not.toBeVisible();
  expect(ignorePosts).toEqual([{ ignored: true }]);
});

test("Save with a type-only change does not submit a category", async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/transactions/") &&
      req.url().includes("/reclassify")
    )
      body = req.postDataJSON() as Record<string, unknown>;
  });

  await stubApi(page, { transactions: listResp, transactionDetail: detailResp });

  await page.goto("/");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Detail" }).click();
  await expect(page.getByRole("button", { name: "Save Reclassification" })).toBeVisible();

  await page.getByText("transfer", { exact: true }).click();
  await page.getByRole("button", { name: "Save Reclassification" }).click();
  await expect(page.getByRole("button", { name: "Save Reclassification" })).not.toBeVisible();

  expect(body).not.toBeNull();
  const b = body as unknown as Record<string, unknown>;
  expect(b.new_type).toBe("transfer");
  expect(b.new_category).toBeUndefined();
});

test("dialog layout: no horizontal overflow, opaque header, clamped trace font", async ({
  page,
}) => {
  await stubApi(page, { transactions: listResp, transactionDetail: detailResp });

  await page.goto("/");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Detail" }).click();
  await expect(page.getByRole("heading", { name: "Transaction Detail" })).toBeVisible();

  const modal = page.locator("div.rounded-2xl").first();

  const noHOverflow = await modal.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(noHOverflow).toBe(true);

  const header = modal.locator("div.sticky.top-0").first();
  expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(255, 255, 255)",
  );

  const traceRow = page.locator("ul li").first();
  const traceWraps = await traceRow.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(traceWraps).toBe(true);
  const fontPx = await traceRow.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontPx).toBeGreaterThanOrEqual(10);
  expect(fontPx).toBeLessThanOrEqual(12.8);

  await modal.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(header).toBeVisible();
  expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(255, 255, 255)",
  );
});

test("reclassify dropdown lists only the canonical categories", async ({ page }) => {
  await stubApi(page, { transactions: listResp, transactionDetail: detailResp });

  await page.goto("/");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Detail" }).click();
  await expect(page.getByRole("button", { name: "Save Reclassification" })).toBeVisible();

  const options = (
    await page.locator("div.rounded-2xl select").locator("option").allTextContents()
  ).map((s) => s.trim());
  const canonical = [
    "Keep existing category",
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
  expect(options).toEqual(canonical);
});
