import { Page } from "@playwright/test";
import {
  auditHistory,
  categories,
  categoryCaps,
  dashboard,
  doctor,
  emptyIncome,
  emptyRules,
  emptyTransactions,
  institutions,
  months,
  syncHistory,
  yearly,
} from "./data";

export async function stubApi(
  page: Page,
  opts: {
    transactions?: unknown;
    transactionDetail?: unknown;
    webhookEnabled?: boolean;
    role?: "ADMIN" | "MEMBER";
    investmentPerformanceMethod?: "TWR" | "MODIFIED_DIETZ";
  } = {},
) {
  const testUser = {
    id: "user-1",
    username: "tester",
    email: "tester@example.com",
    household_id: "household-1",
    role: opts.role ?? "ADMIN",
    is_active: 1,
    must_change_password: 0,
  };
  const unlinkedConnectionIds = new Set<string>();
  let pendingInvitations: { id: string; email: string; expires_at: string; created_at: string }[] =
    [];
  let targetFundAllocations = [{ asset_class: "OTHER", percent: 100 }];
  let educationAllocations = [{ asset_class: "OTHER", percent: 100 }];
  await page.route("**/api/auth/status", (r) => r.fulfill({ json: { setup_required: false } }));
  await page.route("**/api/auth/me", (r) =>
    r.fulfill({ json: { user: testUser, csrf_token: "csrf-test" } }),
  );
  await page.route("**/api/auth/members", (r) => r.fulfill({ json: { members: [testUser] } }));
  await page.route("**/api/auth/invitations**", (r) => {
    const url = new URL(r.request().url());
    if (r.request().method() === "DELETE") {
      const invitationId = url.pathname.split("/").at(-1);
      pendingInvitations = pendingInvitations.filter(
        (invitation) => invitation.id !== invitationId,
      );
      return r.fulfill({ json: { ok: true } });
    }
    if (r.request().method() === "POST") {
      const { email } = r.request().postDataJSON() as { email: string };
      const invitation = {
        id: "invitation-1",
        email,
        household_name: "Our household",
        expires_at: "2030-01-01T00:00:00+00:00",
        created_at: "2026-01-01T00:00:00+00:00",
      };
      pendingInvitations = [invitation];
      return r.fulfill({ json: { invitation, token: "single-use-token" } });
    }
    return r.fulfill({ json: { invitations: pendingInvitations } });
  });
  await page.route("**/api/auth/logout", (r) => r.fulfill({ json: { ok: true } }));
  await page.route("**/api/household/accounts**", (r) =>
    r.fulfill({
      json: {
        accounts: [
          {
            id: "household-bilt",
            display_name: "Bilt Palladium Card",
            provider_account_ids: ["provider-account-secret"],
            owner_user_ids: ["user-1"],
            authoritative_account_id: "provider-account-secret",
          },
        ],
        connections: [
          {
            connection_id: "connection-usaa",
            name: "usaa",
            institution_name: "Bilt",
            connection_type: "DEPOSITORY",
            status: "COMPLETE",
            household_account_ids: ["household-bilt"],
          },
          {
            connection_id: "connection-chase",
            name: "chase",
            institution_name: "Chase",
            connection_type: "DEPOSITORY",
            status: "COMPLETE",
            household_account_ids: [],
          },
        ].filter((connection) => !unlinkedConnectionIds.has(connection.connection_id)),
        suggestions: [],
        members: [testUser],
      },
    }),
  );
  await page.route("**/cdn.plaid.com/**", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `
      window.__plaidLinkScriptLoads = (window.__plaidLinkScriptLoads || 0) + 1;
      window.Plaid = {
        create: function (options) {
          return {
            open: function () { if (options.onLoad) options.onLoad(); },
            exit: function (_options, callback) { if (callback) callback(); },
            destroy: function () {},
            submit: function () {}
          };
        }
      };
    `,
    }),
  );
  await page.route("**/api/months**", (r) => r.fulfill({ json: months }));
  await page.route("**/api/financial-tools/defaults**", (r) =>
    r.fulfill({
      json: {
        env: "sandbox",
        rent_to_buy: {
          analysis_years: 30,
          home_price: 500000,
          down_payment: 100000,
          starting_cash: 250000.49,
          monthly_available: 5000,
          annual_income_growth: 0.02,
          monthly_rent: 2500,
          annual_rent_growth: 0.02,
          annual_investment_return: 0.06,
          annual_home_appreciation: 0.03,
          closing_cost_rate: 0.02,
          finance_closing_costs: false,
          selling_cost_rate: 0.06,
          capital_gains_exclusion: 250000,
          capital_gains_tax_rate: 0.2,
          property_tax_rate: 0.01,
          monthly_hoa: 0,
          monthly_insurance: 200,
          monthly_maintenance: 300,
          monthly_pmi: 0,
          pmi_removal_ltv: 0.8,
          loan_options: [
            {
              id: "fixed-30",
              label: "30-year fixed",
              kind: "FIXED",
              term_years: 30,
              annual_rate: 0.065,
            },
            {
              id: "arm-5-1",
              label: "5/1 ARM",
              kind: "ARM",
              term_years: 30,
              annual_rate: 0.0525,
              fixed_period_years: 5,
              expected_annual_change: 0,
              initial_adjustment_cap: 0.02,
              periodic_adjustment_cap: 0.02,
              lifetime_cap: 0.05,
              rate_floor: 0.0525,
            },
          ],
        },
        monte_carlo: {
          years: 30,
          simulations: 1000,
          investment_start: 750000.93625,
          cash_start: 250000.49375,
          withdrawal_year: 5,
          withdrawal_investment: 200000,
          withdrawal_cash: 100000,
          investment_mean: 0.065,
          investment_volatility: 0.18,
          cash_mean: 0.03,
          cash_volatility: 0.005,
          monthly_investment_contribution: 0,
          monthly_cash_contribution: 0,
          inflation_rate: 0.025,
          seed: 42,
        },
        sources: {
          "rent_to_buy.starting_cash": "HOUSEHOLD",
          "monte_carlo.investment_start": "HOUSEHOLD",
          "monte_carlo.cash_start": "HOUSEHOLD",
        },
      },
    }),
  );
  await page.route("**/api/financial-tools/rent-to-buy/simulate**", (r) =>
    r.fulfill({
      json: {
        env: "sandbox",
        assumptions: {},
        loan_results: [
          {
            loan_id: "fixed-30",
            label: "30-year fixed",
            kind: "FIXED",
            ending_buy_net_worth: 900000,
            ending_rent_net_worth: 800000,
            ending_advantage: 100000,
            crossover_month: 84,
            cumulative_interest: 300000,
            minimum_cash_reserve: 100000,
            negative_cash_months: 0,
            warnings: [],
            series: [
              {
                month: 1,
                year: 1 / 12,
                buy_net_worth: 300000,
                rent_net_worth: 250000,
                ownership_cost: 3500,
                rental_cost: 2500,
                loan_balance: 398000,
                cumulative_interest: 2000,
                home_value: 501000,
                cash_reserve: 148000,
              },
              {
                month: 360,
                year: 30,
                buy_net_worth: 900000,
                rent_net_worth: 800000,
                ownership_cost: 1500,
                rental_cost: 4500,
                loan_balance: 0,
                cumulative_interest: 300000,
                home_value: 1200000,
                cash_reserve: 400000,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/api/financial-tools/monte-carlo/simulate**", (r) =>
    r.fulfill({
      json: {
        env: "sandbox",
        seed: 42,
        simulations: 1000,
        withdrawal_success_probability: 0.94,
        final_values: {
          nominal: { p10: 700000, p50: 1500000, p90: 2800000 },
          real: { p10: 400000, p50: 850000, p90: 1600000 },
        },
        series: [
          {
            month: 0,
            year: 0,
            nominal_p10: 1000000,
            nominal_p50: 1000000,
            nominal_p90: 1000000,
            real_p10: 1000000,
            real_p50: 1000000,
            real_p90: 1000000,
            median_investment: 750000,
            median_cash: 250000,
          },
          {
            month: 360,
            year: 30,
            nominal_p10: 700000,
            nominal_p50: 1500000,
            nominal_p90: 2800000,
            real_p10: 400000,
            real_p50: 850000,
            real_p90: 1600000,
            median_investment: 1200000,
            median_cash: 300000,
          },
        ],
        assumptions: {},
      },
    }),
  );
  await page.route("**/api/dashboard/**", (r) => r.fulfill({ json: dashboard }));
  await page.route(/\/api\/investments\/dashboard\?/, (r) => {
    const allocation = targetFundAllocations.map((row) => ({
      asset_class: row.asset_class,
      value: row.percent * 1000,
      percentage: row.percent,
    }));
    return r.fulfill({
      json: {
        env: "sandbox",
        summary: {
          total_financial_assets: 100000,
          total_investment_assets: 100000,
          liquid_assets: 100000,
          current_portfolio_value: 100000,
          ytd_return: null,
          one_year_return: null,
          total_contributions: 0,
          total_investment_gains: null,
          cost_basis: null,
          unrealized_gain_loss: null,
        },
        filters: {
          selected: {
            range: "1Y",
            start_date: null,
            end_date: "2026-08-12",
            view: "ALL_ASSETS",
            account_ids: [],
            include_401k: true,
            cash_policy: "ALL",
            include_goal_reserved: true,
          },
          accounts: [
            {
              id: "brokerage-1",
              name: "Fidelity Brokerage",
              type: "investment",
              subtype: "brokerage",
              is_401k: false,
              tax_status: "TAXABLE",
              account_category: "BROKERAGE",
              category_source: "AUTOMATIC",
              liquidity: "LIQUID",
              earmarked: 0,
            },
            {
              id: "retirement-1",
              name: "Fidelity 401(k)",
              type: "investment",
              subtype: "401k",
              is_401k: true,
              tax_status: "RETIREMENT",
              account_category: "RETIREMENT",
              category_source: "AUTOMATIC",
              liquidity: "ILLIQUID",
              earmarked: 0,
            },
            {
              id: "education-1",
              name: "Schwab 529 Plan",
              type: "investment",
              subtype: "529",
              is_401k: false,
              tax_status: "EDUCATION",
              account_category: "EDUCATION",
              category_source: "AUTOMATIC",
              liquidity: "ILLIQUID",
              earmarked: 0,
            },
          ],
        },
        accounts: [],
        allocation,
        risk_allocation: {
          growth: { value: 0, percentage: 0 },
          defensive: { value: 0, percentage: 0 },
          other: { value: 0, percentage: 0 },
        },
        target_allocation: {},
        target_comparison: {
          rows: allocation.map((row) => ({
            asset_class: row.asset_class,
            actual_percent: row.percentage,
            target_percent: row.asset_class === "US_EQUITY" ? 60 : 0,
            drift_percent: row.percentage - (row.asset_class === "US_EQUITY" ? 60 : 0),
            actual_value: row.value,
            target_value: row.asset_class === "US_EQUITY" ? 60000 : 0,
            drift_value: row.value - (row.asset_class === "US_EQUITY" ? 60000 : 0),
            status: "ON_TARGET",
          })),
          largest_overweight: "US_EQUITY",
          largest_underweight: "US_EQUITY",
          overall_deviation: 0,
          tolerance: 5,
        },
        rebalancing: { method: "CONTRIBUTIONS_ONLY", allocations: [] },
        performance: opts.investmentPerformanceMethod
          ? {
              available: true,
              reason: null,
              method: opts.investmentPerformanceMethod,
              is_estimate: opts.investmentPerformanceMethod === "MODIFIED_DIETZ",
              portfolio_return: 0.08,
              twr: opts.investmentPerformanceMethod === "TWR" ? 0.08 : null,
              benchmark_return: 0.05,
              difference: 0.03,
              coverage_start: "2025-08-12",
              coverage_end: "2026-08-12",
              series: [
                { date: "2025-08-12", portfolio: 100, benchmark: 100 },
                { date: "2026-08-12", portfolio: 108, benchmark: 105 },
              ],
            }
          : {
              available: false,
              reason: "At least two complete portfolio snapshots are required.",
              method: null,
              is_estimate: false,
              portfolio_return: null,
              twr: null,
              benchmark_return: null,
              difference: null,
              coverage_start: null,
              coverage_end: null,
              series: [],
            },
        growth_decomposition: {
          available: false,
          starting_value: null,
          ending_value: null,
          contributions: 10000,
          withdrawals: 0,
          dividends: 1200,
          interest: 300,
          market_appreciation: 8500,
          reconciliation_difference: null,
        },
        contribution_activity: [],
        contribution_summary: {
          destinations: {},
          invested_this_year: 0,
          saved_this_year: 0,
          retirement_contributions: 0,
          taxable_contributions: 0,
          cash_savings: 0,
          education_contributions: 0,
          education_balance: 11393.4,
          category_balances: { EDUCATION: 11393.4 },
        },
        wealth_bridge: {
          label: "Tracked Financial Wealth",
          available: false,
          starting_value: null,
          earned_income: 0,
          spending: 0,
          other_external_flows: 0,
          dividends: 0,
          interest: 0,
          market_appreciation: null,
          ending_value: null,
          budget_surplus: 0,
          verified_savings: 0,
          budget_surplus_rate: null,
          verified_savings_rate: null,
          savings_reconciliation_difference: 0,
          reconciliation_difference: null,
        },
        goals: { goals: [], assigned_amount: 0, funded_amount: 0, underfunded_amount: 0 },
        wealth_allocation: {
          tracked_financial_wealth: 0,
          goal_reserved_assets: 0,
          long_term_investable_assets: 0,
          unallocated_assets: 0,
          goal_underfunding: 0,
        },
        equity_compensation: {
          gross_income: 0,
          withholding: 0,
          linked_asset_additions: 0,
          unlinked_events: 0,
        },
        sync: { last_successful_sync: null, is_stale: true, selected_account_count: 0 },
        flows: {
          contributions: 0,
          withdrawals: 0,
          dividends: 0,
          interest: 0,
          internal_transfers: 0,
        },
        holdings: [
          {
            id: "security:brokerage-1:target-2060",
            holding: "VANGUARD.TARGET.2060",
            security_id: "target-2060",
            account_id: "brokerage-1",
            account: "Fidelity Brokerage",
            account_category: "BROKERAGE",
            category_source: "AUTOMATIC",
            asset_class: targetFundAllocations.reduce((best, row) =>
              row.percent > best.percent ? row : best,
            ).asset_class,
            asset_allocation: targetFundAllocations,
            classification_source:
              targetFundAllocations[0]?.asset_class === "OTHER" ? "PROVIDER" : "USER",
            instrument_type: "mutual fund",
            instrument_subtype: null,
            value_source: "holdings",
            quantity: 1000,
            price: 100,
            value: 100000,
            allocation: 100,
            cost_basis: 80000,
            unrealized_gain: 20000,
            unrealized_gain_percent: 25,
          },
          {
            id: "account:education-1",
            holding: "Schwab 529 Plan",
            security_id: null,
            account_id: "education-1",
            account: "Schwab 529 Plan",
            account_category: "EDUCATION",
            category_source: "AUTOMATIC",
            asset_class: educationAllocations.reduce((best, row) =>
              row.percent > best.percent ? row : best,
            ).asset_class,
            asset_allocation: educationAllocations,
            classification_source:
              educationAllocations[0]?.asset_class === "OTHER" ? "SYSTEM" : "USER",
            instrument_type: "investment",
            instrument_subtype: "529",
            value_source: "account_balance",
            quantity: null,
            price: null,
            value: 11393.4,
            allocation: 10.2,
            cost_basis: null,
            unrealized_gain: null,
            unrealized_gain_percent: null,
          },
        ],
        snapshots: [],
        data_quality: {
          status: "PARTIAL",
          warnings: [
            {
              code: "INCOMPLETE_HISTORY",
              message: "At least two complete portfolio snapshots are required.",
            },
          ],
          history_start: null,
          history_end: null,
          benchmark_available: false,
          benchmark_label: "S&P 500 total-return proxy (SPY adjusted close)",
        },
      },
    });
  });
  await page.route(/\/api\/dashboard\/yearly\//, (r) => r.fulfill({ json: yearly }));
  await page.route("**/api/institutions**", (r) =>
    r.fulfill({
      json: {
        ...institutions,
        institutions: institutions.institutions.filter(
          (institution) => !unlinkedConnectionIds.has(institution.connection_id),
        ),
      },
    }),
  );
  await page.route(/\/api\/categorize\/recalculate(\?|$)/, (r) =>
    r.fulfill({ json: { recalculated: 1, types_recalculated: 0 } }),
  );
  await page.route(/\/api\/sync\/history(\?|$)/, (r) => {
    const url = new URL(r.request().url());
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 20);
    r.fulfill({
      json: {
        history: syncHistory.history.slice(offset, offset + limit),
        total: syncHistory.history.length,
        limit,
        offset,
      },
    });
  });
  await page.route(/\/api\/sync\/dry-run(\?|$)/, (r) =>
    r.fulfill({ json: { months: { "2026-07": 55 }, total: 55 } }),
  );
  await page.route(/\/api\/sync(\?|$)/, (r) =>
    r.fulfill({ json: { results: { usaa: { ok: true, added: 0, modified: 0, removed: 0 } } } }),
  );
  await page.route("**/api/doctor**", (r) => r.fulfill({ json: doctor }));
  await page.route("**/api/categories**", (r) => r.fulfill({ json: categories }));
  await page.route("**/api/category-caps**", (r) =>
    r.request().method() === "PUT"
      ? r.fulfill({ json: { ok: true } })
      : r.fulfill({ json: categoryCaps }),
  );
  await page.route("**/api/category-rules**", (r) => r.fulfill({ json: emptyRules }));
  await page.route("**/api/webhook/status**", (r) =>
    r.fulfill({
      json: {
        enabled: opts.webhookEnabled ?? true,
        url: (opts.webhookEnabled ?? true) ? "https://test.ngrok-free.app" : null,
      },
    }),
  );
  await page.route("**/api/connections/*/relink/start**", (r) =>
    r.fulfill({
      json: {
        link_token: "relink-token",
        relink_id: "relink-1",
        institution: "usaa",
        env: "production",
      },
    }),
  );
  await page.route(/\/api\/connections\/([^/?]+)(\?|$)/, (r) => {
    const connectionId = decodeURIComponent(
      new URL(r.request().url()).pathname.split("/").pop() || "",
    );
    unlinkedConnectionIds.add(connectionId);
    r.fulfill({
      json: {
        ok: true,
        connection_id: connectionId,
        remote_status: "removed",
        keychain_deleted: true,
      },
    });
  });
  await page.route(/\/api\/audit(\?|$)/, (r) => {
    const url = new URL(r.request().url());
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 25);
    r.fulfill({
      json: {
        ...auditHistory,
        changes: auditHistory.changes.slice(offset, offset + limit),
        offset,
      },
    });
  });
  await page.route(/\/api\/transactions\?/, (r) =>
    r.fulfill({ json: opts.transactions ?? emptyTransactions }),
  );
  await page.route(/\/api\/transactions\/investments\?/, (r) =>
    r.fulfill({ json: { transactions: [], count: 0, has_more: false } }),
  );
  await page.route(/\/api\/transactions\/[^/]+\/reclassify(\?|$)/, (r) =>
    r.fulfill({ json: { ok: true } }),
  );
  await page.route(/\/api\/transactions\/[^/]+\/ignore(\?|$)/, (r) =>
    r.fulfill({ json: { ok: true, ignored: true } }),
  );
  await page.route(/\/api\/transactions\/[^/]+(\?|$)/, (r) =>
    r.fulfill({
      json: opts.transactionDetail ?? { transaction: {}, trace: [], history: [] },
      status: opts.transactionDetail ? 200 : 404,
    }),
  );
  await page.route(/\/api\/income\/breakdown(\?|$)/, (r) => r.fulfill({ json: emptyIncome }));
  await page.route("**/api/settings**", (r) =>
    r.fulfill({ json: { settings: { monthly_budget: "14648" } } }),
  );
  await page.route("**/api/settings/investment-target**", (r) =>
    r.request().method() === "PUT"
      ? r.fulfill({ json: { ok: true } })
      : r.fulfill({ json: { us_stock: 60, international_stock: 10, bond_market: 30 } }),
  );
  await page.route(/\/api\/investments\/accounts\?/, (r) => r.fulfill({ json: { accounts: [] } }));
  await page.route(/\/api\/investments\/accounts\/education-1\/allocations/, async (r) => {
    if (r.request().method() === "PUT") {
      const body = r.request().postDataJSON() as {
        allocations: { asset_class: string; percent: number }[];
      };
      educationAllocations = body.allocations;
      return r.fulfill({ json: { ok: true, account_id: "education-1" } });
    }
    educationAllocations = [{ asset_class: "OTHER", percent: 100 }];
    return r.fulfill({ json: { ok: true, account_id: "education-1" } });
  });
  await page.route("**/api/investments/classifications**", async (r) => {
    if (r.request().method() === "PUT") {
      const body = r.request().postDataJSON() as {
        asset_class?: string;
        allocations?: { asset_class: string; percent: number }[];
      };
      targetFundAllocations = body.allocations ?? [
        { asset_class: body.asset_class || "OTHER", percent: 100 },
      ];
      return r.fulfill({ json: { ok: true, security_id: "target-2060" } });
    }
    if (r.request().method() === "DELETE") {
      targetFundAllocations = [{ asset_class: "OTHER", percent: 100 }];
      return r.fulfill({ json: { ok: true, security_id: "target-2060" } });
    }
    return r.fulfill({ json: { classifications: [] } });
  });
  await page.route("**/api/investments/benchmark/refresh**", (r) =>
    r.fulfill({ json: { ok: true, count: 0, refreshed: false } }),
  );
  await page.route("**/api/investments/goals**", (r) => {
    const url = new URL(r.request().url());
    if (r.request().method() === "POST") {
      return r.fulfill({ json: { ok: true, id: 999 } });
    }
    const scope = url.searchParams.get("scope") || "HOUSEHOLD";
    const goals =
      scope === "PERSONAL"
        ? [
            {
              id: 2,
              name: "My vacation",
              goal_type: "OTHER",
              target_amount: 5000,
              target_date: null,
              status: "ACTIVE",
              scope: "PERSONAL",
              owner_user_id: "user-1",
              assigned_amount: 0,
              funded_amount: 0,
              underfunded_amount: 0,
              remaining_to_target: 5000,
              allocations: [],
            },
          ]
        : [
            {
              id: 1,
              name: "Emergency fund",
              goal_type: "EMERGENCY_FUND",
              target_amount: 10000,
              target_date: null,
              status: "ACTIVE",
              scope: "HOUSEHOLD",
              owner_user_id: null,
              assigned_amount: 0,
              funded_amount: 0,
              underfunded_amount: 0,
              remaining_to_target: 10000,
              allocations: [],
            },
          ];
    return r.fulfill({
      json: { goals, assigned_amount: 0, funded_amount: 0, underfunded_amount: 0 },
    });
  });
}
