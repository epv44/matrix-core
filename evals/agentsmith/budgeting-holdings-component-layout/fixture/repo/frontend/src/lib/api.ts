const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
let csrfToken: string | null = null;
function ownerQuery(path: string, ownerUserId?: string | null): string {
  if (!ownerUserId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}owner_user_id=${encodeURIComponent(ownerUserId)}`;
}

export type Env = "sandbox" | "production";
export const SETTING_KEYS = {
  MONTHLY_BUDGET: "monthly_budget",
  TARGET_US_EQUITY: "target_us_equity",
  TARGET_INTERNATIONAL_EQUITY: "target_international_equity",
  TARGET_BONDS: "target_bonds",
} as const;

export interface Institution {
  connection_id?: string | null;
  name: string;
  institution_name?: string | null;
  plaid_institution_id?: string | null;
  owner_user_id?: string | null;
  last_successful_sync: string | null;
  last_investment_sync?: string | null;
  plaid_item_id?: string | null;
  cursor?: string | null;
  connection_type?: "DEPOSITORY" | "INVESTMENT";
  status?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  household_id: string;
  role: "ADMIN" | "MEMBER";
  is_active: number;
  must_change_password: number;
}
export interface AuthResponse {
  user: AuthUser;
  csrf_token: string;
}

export interface HouseholdInvitation {
  id: string;
  email: string;
  expires_at: string;
  created_at: string;
}

export interface InvitationDetails extends HouseholdInvitation {
  household_name: string;
}
export interface HouseholdAccount {
  id: string;
  display_name: string | null;
  provider_account_ids: string[];
  owner_user_ids: string[];
  authoritative_account_id: string | null;
}
export interface HouseholdConnection {
  connection_id: string | null;
  name: string;
  institution_name: string | null;
  connection_type: "DEPOSITORY" | "INVESTMENT";
  status: string;
  household_account_ids: string[];
}
export interface MergeSuggestion {
  id: number;
  account_id: string;
  candidate_account_id: string;
  reason: string;
  status: string;
}

export interface Account {
  account_id: string;
}
export interface InstitutionsResponse {
  institutions: Institution[];
  accounts: Account[];
}
export interface SyncResult {
  ok: boolean;
  added: number;
  modified: number;
  removed: number;
  error?: string | null;
}
export interface SyncResponse {
  status: "completed" | "fresh" | "in_flight" | "cooldown";
  results: Record<string, SyncResult>;
}
export interface DryRunResponse {
  total: number;
  months: Record<string, number>;
}
export interface SyncHistoryEntry {
  id: number;
  institution: string;
  status: string;
  added: number;
  modified: number;
  removed: number;
  since: string | null;
  backfill: boolean;
  started_at: string;
  error: string | null;
}
export interface DoctorCheck {
  name: string;
  status: boolean;
  detail: string;
}
export interface IncomeData {
  total: number;
  breakdown: { source: string; amount: number; count: number }[];
}
export interface AuditChange {
  transaction_id: string;
  old_category: string | null;
  new_category: string | null;
  reason: string;
  timestamp: string;
}

export interface DashboardData {
  year: number;
  month: number;
  env: Env;
  summary: { total_spent: number; total_made: number; net: number; saved_pct: number };
  stats: {
    uncategorized_count: number;
    uncategorized: { txn_id: string; merchant: string; amount: number }[];
    total_spent: number;
    total_made: number;
    net: number;
    saved_pct: number;
    txn_count: number;
  };
  expenses: Record<string, [string, number][]>;
  income: { txn_id: string; merchant: string; amount: number }[];
  transfers: { txn_id: string; merchant: string; amount: number }[];
  transactions: {
    plaid_transaction_id: string;
    merchant: string | null;
    raw_description: string | null;
    amount: number;
    date: string;
    category: string | null;
    institution: string | null;
    account_id: string;
    transaction_type: string | null;
    type_override: string | null;
    pfc_primary: string | null;
    pfc_detailed: string | null;
  }[];
  detailed: Record<string, DetailedItem[]>;
  sheet_categories: string[];
}
export interface YearlyCategory {
  name: string;
  monthly: number[];
  total: number;
  average: number;
  percentage: number;
  cap: number | null;
}
export interface YearlyData {
  year: number;
  categories: YearlyCategory[];
  annual: {
    expense: number[];
    expense_total: number;
    expense_average: number;
    budget: number[];
    budget_total: number;
    budget_average: number;
    net: number[];
    net_total: number;
    net_average: number;
    income: number[];
    income_total: number;
    income_average: number;
    net_income: number[];
    net_income_total: number;
    net_income_average: number;
  };
}
export interface DetailedItem {
  txn_id: string;
  merchant: string;
  raw_description: string;
  amount: number;
  signed_amount: number;
  date: string;
  institution: string;
  account_id: string;
  category_internal: string;
  category_mapped: string;
  sheet_category: string;
  pfc_primary: string;
  pfc_detailed: string;
  plaid_category: string;
  plaid_subcategory: string;
  payment_processor: string;
  pending: boolean;
  transaction_type: string;
  type_override: string;
  trace: TraceStep[];
}
export interface TraceStep {
  order: number;
  source: string;
  description: string;
  matched: boolean;
  result?: string | null;
  pattern?: string | null;
  category?: string | null;
  pfc_primary?: string | null;
  pfc_detailed?: string | null;
}
export interface TransactionDetail {
  transaction: {
    plaid_transaction_id: string;
    account_id: string;
    institution: string | null;
    date: string;
    amount: number;
    merchant: string | null;
    raw_description: string | null;
    category: string | null;
    transaction_type: string | null;
    type_override: string | null;
    pending: boolean;
    is_ignored: boolean;
    pfc_primary: string | null;
    pfc_detailed: string | null;
    payment_processor: string | null;
    plaid_category: string | null;
    plaid_subcategory: string | null;
    currency: string;
  };
  trace: TraceStep[];
  history: {
    transaction_id: string;
    old_category: string | null;
    new_category: string | null;
    timestamp: string;
  }[];
}
export interface ListedTransaction {
  plaid_transaction_id: string;
  account_id: string;
  institution: string | null;
  date: string;
  amount: number;
  merchant: string | null;
  raw_description: string | null;
  category: string | null;
  transaction_type: string | null;
  pending: boolean;
  is_ignored: boolean;
  pfc_primary: string | null;
  pfc_detailed: string | null;
  payment_processor: string | null;
  plaid_category: string | null;
  plaid_subcategory: string | null;
}
export interface InvestmentTransaction {
  plaid_transaction_id: string;
  account_id: string;
  institution: string | null;
  date: string;
  ticker: string | null;
  security_name: string | null;
  type: string | null;
  subtype: string | null;
  amount: number | null;
  quantity: number | null;
  price: number | null;
  fees: number | null;
  cash_impact: number | null;
  classification: string | null;
}
export type InvestmentView =
  | "ALL_ASSETS"
  | "INVESTMENTS"
  | "TAXABLE"
  | "RETIREMENT"
  | "EDUCATION"
  | "HEALTH_SAVINGS"
  | "LIQUID";
export type InvestmentAccountCategory =
  | "CASH"
  | "BROKERAGE"
  | "RETIREMENT"
  | "EDUCATION"
  | "HEALTH_SAVINGS"
  | "EQUITY_COMPENSATION"
  | "OTHER";
export type InvestmentRange = "1M" | "3M" | "YTD" | "1Y" | "3Y" | "5Y" | "ALL";
export type CashPolicy = "ALL" | "EXCLUDE_EARMARKED" | "EXCLUDE_ALL";
export interface AssetAllocation {
  asset_class: string;
  percent: number;
}
export interface InvestmentFilters {
  range: InvestmentRange;
  view: InvestmentView;
  accountIds: string[];
  include401k: boolean;
  cashPolicy: CashPolicy;
  includeGoalReserved: boolean;
}
export interface InvestmentAccountSetting {
  account_id: string;
  name: string | null;
  type: string | null;
  subtype: string | null;
  tax_status: string;
  account_category: InvestmentAccountCategory;
  category_source: "AUTOMATIC" | "USER";
  liquidity: string;
  is_401k: boolean;
  include_by_default: boolean;
  earmarked: number;
  earmarks: { id: number; account_id: string; name: string; amount: number }[];
}
export interface GoalAllocation {
  id: number;
  goal_id: number;
  source_type: "ACCOUNT" | "HOLDING";
  account_id: string;
  security_id: string | null;
  assigned_amount: number;
  funded_amount: number;
  source_value: number;
  account_name: string | null;
  security_name: string | null;
}
export type GoalScope = "HOUSEHOLD" | "PERSONAL";
export interface FinancialGoal {
  id: number;
  name: string;
  goal_type: string;
  target_amount: number | null;
  target_date: string | null;
  status: "ACTIVE" | "COMPLETED";
  scope: GoalScope;
  owner_user_id: string | null;
  assigned_amount: number;
  funded_amount: number;
  underfunded_amount: number;
  remaining_to_target: number | null;
  allocations: GoalAllocation[];
}
export interface GoalSummary {
  goals: FinancialGoal[];
  assigned_amount: number;
  funded_amount: number;
  underfunded_amount: number;
}

export interface LoanOptionInput {
  id: string;
  label: string;
  kind: "FIXED" | "ARM";
  term_years: number;
  annual_rate: number;
  fixed_period_years?: number;
  expected_annual_change?: number;
  initial_adjustment_cap?: number;
  periodic_adjustment_cap?: number;
  lifetime_cap?: number;
  rate_floor?: number;
}

export interface RentToBuyInput {
  analysis_years: number;
  home_price: number;
  down_payment: number;
  starting_cash: number;
  monthly_available: number;
  annual_income_growth: number;
  monthly_rent: number;
  annual_rent_growth: number;
  annual_investment_return: number;
  annual_home_appreciation: number;
  closing_cost_rate: number;
  finance_closing_costs: boolean;
  selling_cost_rate: number;
  capital_gains_exclusion: number;
  capital_gains_tax_rate: number;
  property_tax_rate: number;
  monthly_hoa: number;
  monthly_insurance: number;
  monthly_maintenance: number;
  monthly_pmi: number;
  pmi_removal_ltv: number;
  loan_options: LoanOptionInput[];
}

export interface MonteCarloInput {
  years: number;
  simulations: number;
  investment_start: number;
  cash_start: number;
  withdrawal_year: number;
  withdrawal_investment: number;
  withdrawal_cash: number;
  investment_mean: number;
  investment_volatility: number;
  cash_mean: number;
  cash_volatility: number;
  monthly_investment_contribution: number;
  monthly_cash_contribution: number;
  inflation_rate: number;
  seed: number;
}

export interface FinancialToolDefaults {
  env: Env;
  rent_to_buy: RentToBuyInput;
  monte_carlo: MonteCarloInput;
  sources: Record<string, "HOUSEHOLD" | "EXAMPLE">;
}

export interface RentToBuyPoint {
  month: number;
  year: number;
  buy_net_worth: number;
  rent_net_worth: number;
  ownership_cost: number;
  rental_cost: number;
  loan_balance: number;
  cumulative_interest: number;
  home_value: number;
  cash_reserve: number;
}

export interface RentToBuyResult {
  env: Env;
  assumptions: Record<string, boolean>;
  loan_results: {
    loan_id: string;
    label: string;
    kind: "FIXED" | "ARM";
    ending_buy_net_worth: number;
    ending_rent_net_worth: number;
    ending_advantage: number;
    crossover_month: number | null;
    cumulative_interest: number;
    minimum_cash_reserve: number;
    negative_cash_months: number;
    warnings: string[];
    series: RentToBuyPoint[];
  }[];
}

export interface MonteCarloPoint {
  month: number;
  year: number;
  nominal_p10: number;
  nominal_p50: number;
  nominal_p90: number;
  real_p10: number;
  real_p50: number;
  real_p90: number;
  median_investment: number;
  median_cash: number;
}

export interface MonteCarloResult {
  env: Env;
  seed: number;
  simulations: number;
  withdrawal_success_probability: number;
  final_values: {
    nominal: { p10: number; p50: number; p90: number };
    real: { p10: number; p50: number; p90: number };
  };
  series: MonteCarloPoint[];
  assumptions: Record<string, string | boolean>;
}
export interface InvestmentDashboard {
  env: Env;
  summary: {
    total_financial_assets: number;
    total_investment_assets: number;
    liquid_assets: number;
    current_portfolio_value: number;
    ytd_return: number | null;
    one_year_return: number | null;
    total_contributions: number;
    total_investment_gains: number | null;
    cost_basis: number | null;
    unrealized_gain_loss: number | null;
  };
  filters: {
    selected: {
      range: InvestmentRange;
      start_date: string | null;
      end_date: string;
      view: InvestmentView;
      account_ids: string[];
      include_401k: boolean;
      cash_policy: CashPolicy;
      include_goal_reserved: boolean;
    };
    accounts: {
      id: string;
      name: string;
      type: string | null;
      subtype: string | null;
      is_401k: boolean;
      tax_status: string;
      account_category: InvestmentAccountCategory;
      category_source: "AUTOMATIC" | "USER";
      liquidity: string;
      earmarked: number;
    }[];
  };
  accounts: {
    id: string;
    label: string;
    value: number;
    percentage: number;
    value_source: "holdings" | "account_balance" | "cash_snapshot";
  }[];
  allocation: { asset_class: string; value: number; percentage: number }[];
  risk_allocation: Record<"growth" | "defensive" | "other", { value: number; percentage: number }>;
  target_allocation: Record<string, number>;
  target_comparison: {
    rows: {
      asset_class: string;
      actual_percent: number;
      target_percent: number;
      drift_percent: number;
      actual_value: number;
      target_value: number;
      drift_value: number;
      status: string;
    }[];
    largest_overweight: string;
    largest_underweight: string;
    overall_deviation: number;
    tolerance: number;
  };
  rebalancing: {
    method: string;
    allocations: { asset_class: string; percentage: number; deficit: number }[];
  };
  performance: {
    available: boolean;
    reason: string | null;
    method: "TWR" | "MODIFIED_DIETZ" | null;
    is_estimate: boolean;
    portfolio_return: number | null;
    twr: number | null;
    benchmark_return: number | null;
    difference: number | null;
    coverage_start: string | null;
    coverage_end: string | null;
    series: { date: string; portfolio: number; benchmark: number | null }[];
  };
  growth_decomposition: {
    available: boolean;
    starting_value: number | null;
    ending_value: number | null;
    contributions: number;
    withdrawals: number;
    dividends: number;
    interest: number;
    market_appreciation: number | null;
    reconciliation_difference: number | null;
  };
  contribution_activity: { month: string; total: number; destinations: Record<string, number> }[];
  contribution_summary: {
    destinations: Record<string, number>;
    invested_this_year: number;
    saved_this_year: number;
    retirement_contributions: number;
    taxable_contributions: number;
    cash_savings: number;
    education_contributions: number;
    education_balance: number;
    category_balances: Partial<Record<InvestmentAccountCategory, number>>;
  };
  wealth_bridge: {
    label: string;
    available: boolean;
    starting_value: number | null;
    earned_income: number;
    spending: number;
    other_external_flows: number;
    dividends: number;
    interest: number;
    market_appreciation: number | null;
    ending_value: number | null;
    budget_surplus: number;
    verified_savings: number;
    budget_surplus_rate: number | null;
    verified_savings_rate: number | null;
    savings_reconciliation_difference: number;
    reconciliation_difference: number | null;
  };
  goals: GoalSummary;
  wealth_allocation: {
    tracked_financial_wealth: number;
    goal_reserved_assets: number;
    long_term_investable_assets: number;
    unallocated_assets: number;
    goal_underfunding: number;
  };
  equity_compensation: {
    gross_income: number;
    withholding: number;
    linked_asset_additions: number;
    unlinked_events: number;
  };
  sync: { last_successful_sync: string | null; is_stale: boolean; selected_account_count: number };
  flows: {
    contributions: number;
    withdrawals: number;
    dividends: number;
    interest: number;
    internal_transfers: number;
  };
  holdings: {
    id: string;
    holding: string;
    security_id: string | null;
    account_id: string;
    account: string;
    account_category: InvestmentAccountCategory;
    category_source: "AUTOMATIC" | "USER";
    asset_class: string;
    asset_allocation: AssetAllocation[];
    classification_source: string;
    instrument_type: string | null;
    instrument_subtype: string | null;
    value_source: string;
    quantity: number | null;
    price: number | null;
    value: number;
    allocation: number;
    cost_basis: number | null;
    unrealized_gain: number | null;
    unrealized_gain_percent: number | null;
  }[];
  snapshots: { date: string; value: number; cost_basis: number; complete: boolean }[];
  data_quality: {
    status: "COMPLETE" | "PARTIAL";
    warnings: { code: string; message: string }[];
    history_start: string | null;
    history_end: string | null;
    benchmark_available: boolean;
    benchmark_label: string;
  };
}

async function fetchJSON<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  authStatus: () => fetchJSON<{ setup_required: boolean }>("/api/auth/status"),
  me: async () => {
    const result = await fetchJSON<AuthResponse>("/api/auth/me");
    csrfToken = result.csrf_token;
    return result;
  },
  login: async (email: string, password: string) => {
    const result = await fetchJSON<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    csrfToken = result.csrf_token;
    return result;
  },
  setup: async (payload: {
    household_name: string;
    username: string;
    email: string;
    password: string;
  }) => {
    const result = await fetchJSON<AuthResponse>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    csrfToken = result.csrf_token;
    return result;
  },
  logout: async () => {
    const result = await fetchJSON<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    csrfToken = null;
    return result;
  },
  getMembers: () => fetchJSON<{ members: AuthUser[] }>("/api/auth/members"),
  getInvitations: () => fetchJSON<{ invitations: HouseholdInvitation[] }>("/api/auth/invitations"),
  createInvitation: (email: string) =>
    fetchJSON<{ invitation: InvitationDetails; token: string }>("/api/auth/invitations", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  revokeInvitation: (invitationId: string) =>
    fetchJSON<{ ok: boolean }>(`/api/auth/invitations/${encodeURIComponent(invitationId)}`, {
      method: "DELETE",
    }),
  inspectInvitation: (token: string) =>
    fetchJSON<{ invitation: InvitationDetails }>("/api/auth/invitations/inspect", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  acceptInvitation: async (token: string, username: string, password: string) => {
    const result = await fetchJSON<AuthResponse>("/api/auth/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, username, password }),
    });
    csrfToken = result.csrf_token;
    return result;
  },
  changePassword: (password: string) =>
    fetchJSON<{ ok: boolean; login_required: boolean }>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ password }),
    }),
  getHouseholdAccounts: (env: Env) =>
    fetchJSON<{
      accounts: HouseholdAccount[];
      connections: HouseholdConnection[];
      suggestions: MergeSuggestion[];
      members: AuthUser[];
    }>(`/api/household/accounts?env=${env}`),
  mergeHouseholdAccounts: (env: Env, primary_account_id: string, secondary_account_id: string) =>
    fetchJSON(`/api/household/accounts/merge?env=${env}`, {
      method: "POST",
      body: JSON.stringify({ primary_account_id, secondary_account_id }),
    }),
  splitHouseholdAccount: (env: Env, accountId: string) =>
    fetchJSON(`/api/household/accounts/${encodeURIComponent(accountId)}/split?env=${env}`, {
      method: "POST",
    }),
  setHouseholdAccountOwners: (env: Env, householdAccountId: string, user_ids: string[]) =>
    fetchJSON(
      `/api/household/accounts/${encodeURIComponent(householdAccountId)}/owners?env=${env}`,
      { method: "PUT", body: JSON.stringify({ user_ids }) },
    ),
  promoteHouseholdAccountSource: (env: Env, householdAccountId: string, account_id: string) =>
    fetchJSON(
      `/api/household/accounts/${encodeURIComponent(householdAccountId)}/authoritative-source?env=${env}`,
      { method: "PUT", body: JSON.stringify({ account_id }) },
    ),
  getMonths: (env: Env) =>
    fetchJSON<{ months: string[]; raw: [number, number][] }>(`/api/months?env=${env}`),
  getDashboard: (year: number, month: number, env: Env, ownerUserId?: string | null) =>
    fetchJSON<DashboardData>(ownerQuery(`/api/dashboard/${year}/${month}?env=${env}`, ownerUserId)),
  getYearlySummary: (year: number, env: Env, ownerUserId?: string | null) =>
    fetchJSON<YearlyData>(ownerQuery(`/api/dashboard/yearly/${year}?env=${env}`, ownerUserId)),
  getSettings: (env: Env) =>
    fetchJSON<{ settings: Record<string, string | null> }>(`/api/settings?env=${env}`),
  setSetting: (env: Env, key: string, value: string) =>
    fetchJSON(`/api/settings?env=${env}`, { method: "PUT", body: JSON.stringify({ key, value }) }),
  getTransaction: (id: string, env: Env) =>
    fetchJSON<TransactionDetail>(`/api/transactions/${id}?env=${env}`),
  reclassify: (
    id: string,
    env: Env,
    body: { new_category?: string; pattern?: string; new_type?: string; remember?: boolean },
  ) =>
    fetchJSON(`/api/transactions/${id}/reclassify?env=${env}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  hideTransaction: (id: string, env: Env) =>
    fetchJSON<{ ok: boolean; ignored: boolean }>(`/api/transactions/${id}/ignore?env=${env}`, {
      method: "POST",
      body: JSON.stringify({ ignored: true }),
    }),
  listTransactions: (
    env: Env,
    params: Record<string, string | number | boolean | undefined>,
    ownerUserId?: string | null,
  ) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    });
    qs.set("env", env);
    if (ownerUserId) qs.set("owner_user_id", ownerUserId);
    return fetchJSON<{ transactions: ListedTransaction[]; count: number; has_more: boolean }>(
      `/api/transactions?${qs.toString()}`,
    );
  },
  getInstitutions: (env: Env) => fetchJSON<InstitutionsResponse>(`/api/institutions?env=${env}`),
  unlinkConnection: (env: Env, connectionId: string) =>
    fetchJSON<{
      ok: boolean;
      connection_id: string;
      remote_status: "removed" | "already_missing";
      keychain_deleted: boolean;
    }>(`/api/connections/${encodeURIComponent(connectionId)}?env=${env}`, { method: "DELETE" }),
  syncAll: (
    env: Env,
    body: {
      institution?: string;
      connection_id?: string;
      since?: string;
      replace?: boolean;
      backfill?: boolean;
      force?: boolean;
    } = {},
  ) =>
    fetchJSON<SyncResponse>(`/api/sync?env=${env}`, { method: "POST", body: JSON.stringify(body) }),
  dryRun: (env: Env, institution: string, since?: string) =>
    fetchJSON<DryRunResponse>(
      `/api/sync/dry-run?env=${env}&institution=${institution}${since ? `&since=${since}` : ""}`,
      { method: "POST" },
    ),
  getSyncHistory: (env: Env, limit = 20, offset = 0) =>
    fetchJSON<{ history: SyncHistoryEntry[]; total: number; limit: number; offset: number }>(
      `/api/sync/history?env=${env}&limit=${limit}&offset=${offset}`,
    ),
  getDoctor: (env: Env) => fetchJSON<{ checks: DoctorCheck[] }>(`/api/doctor?env=${env}`),
  doctorFix: (env: Env) =>
    fetchJSON<{ rekeyed: Record<string, string> }>(`/api/doctor/fix?env=${env}`, {
      method: "POST",
    }),
  setRuleEnabled: (env: Env, id: number, enabled: boolean) =>
    fetchJSON(`/api/category-rules/${id}?env=${env}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  getCategories: (env: Env) => fetchJSON<{ categories: string[] }>(`/api/categories?env=${env}`),
  createCategory: (env: Env, name: string) =>
    fetchJSON(`/api/categories?env=${env}`, { method: "POST", body: JSON.stringify({ name }) }),
  deleteCategory: (env: Env, name: string) =>
    fetchJSON(`/api/categories/${encodeURIComponent(name)}?env=${env}`, { method: "DELETE" }),
  getCategoryCaps: (env: Env) =>
    fetchJSON<{ caps: Record<string, string> }>(`/api/category-caps?env=${env}`),
  setCategoryCap: (env: Env, category: string, cap: string) =>
    fetchJSON(`/api/category-caps?env=${env}`, {
      method: "PUT",
      body: JSON.stringify({ category, cap }),
    }),
  getRules: (env: Env) =>
    fetchJSON<{ rules: { id: number; pattern: string; category: string; created_at: string }[] }>(
      `/api/category-rules?env=${env}`,
    ),
  createRule: (env: Env, pattern: string, category: string) =>
    fetchJSON(`/api/category-rules?env=${env}`, {
      method: "POST",
      body: JSON.stringify({ pattern, category }),
    }),
  deleteRule: (env: Env, id: number) =>
    fetchJSON(`/api/category-rules/${id}?env=${env}`, { method: "DELETE" }),
  getIncome: (
    env: Env,
    groupBy: string,
    from?: string,
    to?: string,
    ownerUserId?: string | null,
  ) => {
    let q = `env=${env}&group_by=${groupBy}`;
    if (from) q += `&from_date=${from}`;
    if (to) q += `&to_date=${to}`;
    if (ownerUserId) q += `&owner_user_id=${encodeURIComponent(ownerUserId)}`;
    return fetchJSON<IncomeData>(`/api/income/breakdown?${q}`);
  },
  getAudit: (env: Env, txnId?: string, offset?: number, limit?: number) => {
    let q = `env=${env}`;
    if (txnId) q += `&txn_id=${txnId}`;
    if (offset !== undefined) q += `&offset=${offset}`;
    if (limit !== undefined) q += `&limit=${limit}`;
    return fetchJSON<{ changes: AuditChange[]; total: number; limit: number; offset: number }>(
      `/api/audit?${q}`,
    );
  },
  linkToken: (
    env: Env,
    institution: string,
    historyDate?: string,
    connectionType: "DEPOSITORY" | "INVESTMENT" = "DEPOSITORY",
  ) =>
    fetchJSON<{ link_token: string }>(
      `/api/link/token?env=${env}&institution=${institution}&connection_type=${connectionType}${historyDate ? `&history_date=${historyDate}` : ""}`,
      { method: "POST" },
    ),
  linkExchange: (
    env: Env,
    public_token: string,
    institution: string,
    relinkId?: string,
    connectionType: "DEPOSITORY" | "INVESTMENT" = "DEPOSITORY",
    historyDate?: string,
    metadata?: { institution?: { institution_id?: string | null; name?: string | null } | null },
  ) =>
    fetchJSON<{ initial_sync: { ok: boolean; status?: string; error?: string } }>(
      `/api/link/exchange?env=${env}`,
      {
        method: "POST",
        body: JSON.stringify({
          public_token,
          institution,
          relink_id: relinkId,
          connection_type: connectionType,
          history_date: historyDate,
          institution_id: metadata?.institution?.institution_id,
          institution_name: metadata?.institution?.name,
        }),
      },
    ),
  relink: (env: Env, connectionId: string, historyDate: string) =>
    fetchJSON<{
      direct?: boolean;
      initial_sync?: { ok: boolean; status?: string; error?: string };
      link_token?: string;
      relink_id?: string;
      institution: string;
      env: string;
    }>(
      `/api/connections/${encodeURIComponent(connectionId)}/relink/start?env=${env}&history_date=${historyDate}`,
      { method: "POST" },
    ),
  getWebhookStatus: (env: Env) =>
    fetchJSON<{ enabled: boolean; url: string | null }>(`/api/webhook/status?env=${env}`),
  listInvestmentTransactions: (
    env: Env,
    params: Record<string, string | number | undefined> = {},
    ownerUserId?: string | null,
  ) => {
    const qs = new URLSearchParams({
      env,
      ...Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
    });
    if (ownerUserId) qs.set("owner_user_id", ownerUserId);
    return fetchJSON<{ transactions: InvestmentTransaction[]; count: number; has_more: boolean }>(
      `/api/transactions/investments?${qs}`,
    );
  },
  addEquityEvent: (env: Env, event: Record<string, unknown>) =>
    fetchJSON<{ ok: boolean; id: number }>(
      `/api/transactions/investments/equity-events?env=${env}`,
      { method: "POST", body: JSON.stringify(event) },
    ),
  getInvestmentDashboard: (env: Env, filters?: InvestmentFilters, ownerUserId?: string | null) => {
    const qs = new URLSearchParams({ env });
    if (ownerUserId) qs.set("owner_user_id", ownerUserId);
    if (filters) {
      qs.set("range", filters.range);
      qs.set("view", filters.view);
      qs.set("include_401k", String(filters.include401k));
      qs.set("cash_policy", filters.cashPolicy);
      qs.set("include_goal_reserved", String(filters.includeGoalReserved));
      filters.accountIds.forEach((id) => qs.append("account_ids", id));
    }
    return fetchJSON<InvestmentDashboard>(`/api/investments/dashboard?${qs}`);
  },
  getInvestmentTarget: (env: Env) =>
    fetchJSON<{ us_stock: number; international_stock: number; bond_market: number }>(
      `/api/settings/investment-target?env=${env}`,
    ),
  setInvestmentTarget: (
    env: Env,
    target: { us_stock: number; international_stock: number; bond_market: number },
  ) =>
    fetchJSON(`/api/settings/investment-target?env=${env}`, {
      method: "PUT",
      body: JSON.stringify(target),
    }),
  getInvestmentAccounts: (env: Env) =>
    fetchJSON<{ accounts: InvestmentAccountSetting[] }>(`/api/investments/accounts?env=${env}`),
  setInvestmentAccountPreferences: (
    env: Env,
    accountId: string,
    body: {
      tax_status: string | null;
      liquidity: string | null;
      include_by_default: boolean;
      is_401k: boolean | null;
      account_category: InvestmentAccountCategory | null;
    },
  ) =>
    fetchJSON(`/api/investments/accounts/${encodeURIComponent(accountId)}/preferences?env=${env}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  setInvestmentAccountAllocations: (env: Env, accountId: string, allocations: AssetAllocation[]) =>
    fetchJSON(`/api/investments/accounts/${encodeURIComponent(accountId)}/allocations?env=${env}`, {
      method: "PUT",
      body: JSON.stringify({ allocations }),
    }),
  resetInvestmentAccountAllocations: (env: Env, accountId: string) =>
    fetchJSON(`/api/investments/accounts/${encodeURIComponent(accountId)}/allocations?env=${env}`, {
      method: "DELETE",
    }),
  addCashEarmark: (env: Env, body: { account_id: string; name: string; amount: number }) =>
    fetchJSON<{ ok: boolean; id: number }>(`/api/investments/earmarks?env=${env}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteCashEarmark: (env: Env, id: number) =>
    fetchJSON(`/api/investments/earmarks/${id}?env=${env}`, { method: "DELETE" }),
  getFinancialGoals: (env: Env, scope: GoalScope = "HOUSEHOLD") =>
    fetchJSON<GoalSummary>(`/api/investments/goals?env=${env}&scope=${scope}`),
  createFinancialGoal: (
    env: Env,
    body: {
      name: string;
      goal_type: string;
      target_amount: number | null;
      target_date: string | null;
      scope: GoalScope;
    },
  ) =>
    fetchJSON<{ ok: boolean; id: number }>(`/api/investments/goals?env=${env}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateFinancialGoal: (
    env: Env,
    id: number,
    body: {
      name: string;
      goal_type: string;
      target_amount: number | null;
      target_date: string | null;
      status: string;
    },
  ) =>
    fetchJSON(`/api/investments/goals/${id}?env=${env}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteFinancialGoal: (env: Env, id: number) =>
    fetchJSON(`/api/investments/goals/${id}?env=${env}`, { method: "DELETE" }),
  addGoalAllocation: (
    env: Env,
    goalId: number,
    body: {
      source_type: "ACCOUNT" | "HOLDING";
      account_id: string;
      security_id: string | null;
      assigned_amount: number;
    },
  ) =>
    fetchJSON<{ ok: boolean; id: number }>(
      `/api/investments/goals/${goalId}/allocations?env=${env}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  deleteGoalAllocation: (env: Env, id: number) =>
    fetchJSON(`/api/investments/goal-allocations/${id}?env=${env}`, { method: "DELETE" }),
  listInvestmentClassifications: (env: Env) =>
    fetchJSON<{
      classifications: {
        security_id: string;
        ticker: string | null;
        name: string | null;
        asset_class: string;
        allocations: AssetAllocation[];
        source: string;
      }[];
    }>(`/api/investments/classifications?env=${env}`),
  setInvestmentClassification: (env: Env, securityId: string, assetClass: string) =>
    fetchJSON(`/api/investments/classifications/${encodeURIComponent(securityId)}?env=${env}`, {
      method: "PUT",
      body: JSON.stringify({ asset_class: assetClass }),
    }),
  setInvestmentAllocations: (env: Env, securityId: string, allocations: AssetAllocation[]) =>
    fetchJSON(`/api/investments/classifications/${encodeURIComponent(securityId)}?env=${env}`, {
      method: "PUT",
      body: JSON.stringify({ allocations }),
    }),
  resetInvestmentAllocations: (env: Env, securityId: string) =>
    fetchJSON(`/api/investments/classifications/${encodeURIComponent(securityId)}?env=${env}`, {
      method: "DELETE",
    }),
  refreshInvestmentBenchmark: (env: Env, force = false) =>
    fetchJSON<{ ok: boolean; count: number; refreshed: boolean }>(
      `/api/investments/benchmark/refresh?env=${env}&force=${force}`,
      { method: "POST" },
    ),
  getFinancialToolDefaults: (env: Env, ownerUserId?: string | null) =>
    fetchJSON<FinancialToolDefaults>(
      ownerQuery(`/api/financial-tools/defaults?env=${env}`, ownerUserId),
    ),
  simulateRentToBuy: (env: Env, body: RentToBuyInput) =>
    fetchJSON<RentToBuyResult>(`/api/financial-tools/rent-to-buy/simulate?env=${env}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  simulateMonteCarlo: (env: Env, body: MonteCarloInput) =>
    fetchJSON<MonteCarloResult>(`/api/financial-tools/monte-carlo/simulate?env=${env}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
