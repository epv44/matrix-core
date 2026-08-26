import { QueryClient } from "@tanstack/react-query";

import { Env, InvestmentFilters } from "@/lib/api";

const owner = (ownerUserId: string | null) => ownerUserId || "household";

export const queryKeys = {
  finance: (env: Env) => ["finance", env] as const,
  months: (env: Env) => [...queryKeys.finance(env), "months"] as const,
  monthly: (env: Env, ownerUserId: string | null, year: number, month: number) =>
    [...queryKeys.finance(env), owner(ownerUserId), "monthly", year, month] as const,
  yearly: (env: Env, ownerUserId: string | null, year: number) =>
    [...queryKeys.finance(env), owner(ownerUserId), "yearly", year] as const,
  investments: (env: Env, ownerUserId: string | null, filters: InvestmentFilters) =>
    [
      ...queryKeys.finance(env),
      owner(ownerUserId),
      "investments",
      { ...filters, accountIds: [...filters.accountIds].sort() },
    ] as const,
  income: (
    env: Env,
    ownerUserId: string | null,
    filters: { groupBy: string; from: string; to: string },
  ) => [...queryKeys.finance(env), owner(ownerUserId), "income", filters] as const,
  categories: (env: Env) => [...queryKeys.finance(env), "categories"] as const,
  transactions: (
    env: Env,
    ownerUserId: string | null,
    params: Record<string, string | number | boolean>,
  ) => [...queryKeys.finance(env), owner(ownerUserId), "transactions", params] as const,
  investmentTransactions: (env: Env, ownerUserId: string | null) =>
    [...queryKeys.finance(env), owner(ownerUserId), "investment-transactions"] as const,
  financialToolDefaults: (env: Env, ownerUserId: string | null) =>
    [...queryKeys.finance(env), owner(ownerUserId), "financial-tool-defaults"] as const,
  transaction: (env: Env, id: string) => [...queryKeys.finance(env), "transaction", id] as const,
};

export function invalidateFinancialData(client: QueryClient, env: Env): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.finance(env) });
}
