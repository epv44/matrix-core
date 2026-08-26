export const months = {
  months: ["2026-07", "2026-06"],
  raw: [
    [2026, 7],
    [2026, 6],
  ],
};

export const institutions = {
  institutions: [
    {
      id: 1,
      connection_id: "connection-usaa",
      name: "usaa",
      plaid_item_id: null,
      cursor: null,
      last_successful_sync: new Date().toISOString(),
    },
    {
      id: 2,
      connection_id: "connection-chase",
      name: "chase",
      plaid_item_id: null,
      cursor: null,
      last_successful_sync: new Date().toISOString(),
    },
  ],
  accounts: [],
};

export const syncHistory = {
  history: Array.from({ length: 45 }, (_, index) => {
    const id = 45 - index;
    return {
      id,
      env: "production",
      institution: id % 2 === 0 ? "chase" : "usaa",
      since: null,
      replace: 0,
      status: "ok",
      added: 12,
      modified: 2,
      removed: 1,
      error: null,
      started_at: `2026-08-${String((id % 28) + 1).padStart(2, "0")} 20:00:00`,
      finished_at: `2026-08-${String((id % 28) + 1).padStart(2, "0")} 20:00:05`,
    };
  }),
};

export const doctor = {
  checks: [
    { name: "keychain-token-usaa", status: true, detail: "token found" },
    { name: "keychain-token-chase", status: false, detail: "missing token" },
  ],
};

export const categories = {
  categories: [
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
  ],
};

export const categoryCaps = {
  caps: {
    Restaurants: "680",
    Transportation: "468",
    Groceries: "1200",
    "MISC.": "350",
    "Living Expenses": "6000",
  },
};

export const emptyRules = { rules: [] };
export const emptyAudit = { changes: [], total: 0, limit: 25, offset: 0 };
export const auditHistory = {
  changes: Array.from({ length: 30 }, (_, i) => ({
    transaction_id: `txn-${i}`,
    old_category: i % 2 ? "Restaurants" : "Groceries",
    new_category: i % 2 ? "Groceries" : "Restaurants",
    reason: "MANUAL",
    timestamp: `2026-08-${String((i % 28) + 1).padStart(2, "0")} 12:00:00`,
  })),
  total: 30,
  limit: 25,
  offset: 0,
};
export const emptyTransactions = { transactions: [], count: 0, has_more: false };
export const emptyIncome = { total: 0, breakdown: [] };

const sheetCategories = [
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

export const dashboard = {
  year: 2026,
  month: 7,
  env: "production",
  summary: { total_spent: 3636.49, total_made: 17803.96, net: 14167.47, saved_pct: 79.57 },
  stats: {
    uncategorized_count: 1,
    uncategorized: [{ txn_id: "t-ring", merchant: "Ring", amount: 4.99 }],
    total_spent: 3636.49,
    total_made: 17803.96,
    net: 14167.47,
    saved_pct: 79.57,
    txn_count: 55,
  },
  expenses: {
    Transportation: [["Uber", 30]],
    Self: [],
    Restaurants: [["Chipotle", 18.5]],
    Groceries: [],
    "MISC.": [["Ring", 4.99]],
    "Living Expenses": [],
    Baby: [],
    Travel: [],
    "Cat Related": [],
    "Home Goods": [],
  },
  income: [
    { txn_id: "t-pay", merchant: "META PAYROLL", amount: 4552.9 },
    { txn_id: "t-dep", merchant: "DEPOSIT@MOBILE", amount: 516 },
  ],
  transfers: [],
  transactions: [],
  detailed: {},
  sheet_categories: sheetCategories,
};
export const yearly = {
  year: 2026,
  categories: [
    {
      name: "Restaurants",
      monthly: [0, 0, 0, 0, 0, 0, 548.09, 263.16, 0, 0, 0, 0],
      total: 811.25,
      average: 67.6,
      percentage: 12.3,
      cap: 680,
    },
    {
      name: "Transportation",
      monthly: [0, 0, 0, 0, 0, 0, 220.2, 16.2, 0, 0, 0, 0],
      total: 236.4,
      average: 19.7,
      percentage: 3.59,
      cap: 468,
    },
    {
      name: "Groceries",
      monthly: [0, 0, 0, 0, 0, 0, 970.05, 61.48, 0, 0, 0, 0],
      total: 1031.53,
      average: 85.96,
      percentage: 15.65,
      cap: 1200,
    },
    {
      name: "MISC.",
      monthly: [0, 0, 0, 0, 0, 0, 59.7, 100, 0, 0, 0, 0],
      total: 159.7,
      average: 13.31,
      percentage: 2.42,
      cap: 350,
    },
    {
      name: "Living Expenses",
      monthly: [0, 0, 0, 0, 0, 0, 6511.71, 157.48, 0, 0, 0, 0],
      total: 6669.19,
      average: 555.77,
      percentage: 101.15,
      cap: 6000,
    },
  ],
  annual: {
    expense: [0, 0, 0, 0, 0, 0, 8309.75, 12000, 15000, 0, 0, 0],
    expense_total: 35309.75,
    expense_average: 2942.48,
    budget: [14648, 14648, 14648, 14648, 14648, 14648, 14648, 14648, 14648, 14648, 14648, 14648],
    budget_total: 175776,
    budget_average: 14648,
    net: [14648, 14648, 14648, 14648, 14648, 14648, 6338.25, 2648, -352, 14648, 14648, 14648],
    net_total: 140466.25,
    net_average: 11705.52,
    income: [14648, 14648, 14648, 14648, 14648, 14648, 17803.96, 8000, 12000, 14648, 14648, 14648],
    income_total: 169635.96,
    income_average: 14136.33,
    net_income: [
      14648, 14648, 14648, 14648, 14648, 14648, 9494.21, -4000, -3000, 14648, 14648, 14648,
    ],
    net_income_total: 134326.21,
    net_income_average: 11193.85,
  },
};
