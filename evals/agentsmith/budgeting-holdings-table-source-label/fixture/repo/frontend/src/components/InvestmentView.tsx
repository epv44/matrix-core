"use client";

import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  AssetAllocation,
  CashPolicy,
  InvestmentDashboard,
  InvestmentFilters,
  InvestmentRange,
  InvestmentView as InvestmentViewName,
} from "@/lib/api";
import { useEnv } from "@/context/EnvContext";
import { useHousehold } from "@/context/HouseholdContext";
import { money } from "@/lib/format";
import { Button, Card, HelpTooltip, Select, StatCard, Td, TextInput, Th } from "@/components/ui";
import { queryKeys } from "@/lib/queries";

export const DEFAULT_INVESTMENT_FILTERS: InvestmentFilters = {
  range: "1Y",
  view: "ALL_ASSETS",
  accountIds: [],
  include401k: true,
  cashPolicy: "ALL",
  includeGoalReserved: true,
};

const VIEW_LABELS: [InvestmentViewName, string][] = [
  ["ALL_ASSETS", "All Assets"],
  ["INVESTMENTS", "Investments"],
  ["TAXABLE", "Taxable"],
  ["RETIREMENT", "Retirement"],
  ["EDUCATION", "Education"],
  ["HEALTH_SAVINGS", "HSA"],
  ["LIQUID", "Liquid"],
];
const RANGES: InvestmentRange[] = ["1M", "3M", "YTD", "1Y", "3Y", "5Y", "ALL"];
const ASSET_CLASSES = [
  "US_EQUITY",
  "INTERNATIONAL_EQUITY",
  "BONDS",
  "CASH",
  "REAL_ESTATE",
  "OTHER",
] as const;

const percent = (value: number | null) =>
  value === null ? "Unavailable" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const ASSET_LABELS: Record<string, string> = {
  US_EQUITY: "US Equity",
  INTERNATIONAL_EQUITY: "International Equity",
  BONDS: "Bonds",
  CASH: "Cash",
  REAL_ESTATE: "Real Estate",
  OTHER: "Other",
};
const assetLabel = (value: string) =>
  ASSET_LABELS[value] ||
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const PERFORMANCE_METHOD_HELP: Record<"TWR" | "MODIFIED_DIETZ", string> = {
  MODIFIED_DIETZ:
    "Modified Dietz estimates investment performance between portfolio snapshots. It removes contributions and withdrawals and weights each cash flow by how long it was invested. It is an estimate because the portfolio is not valued at every cash-flow timestamp. Both lines start at 100: 108 means an 8% return and 95 means a 5% loss over the selected period. This measures investment performance, not simple account-balance growth; compare the portfolio with SPY to see relative performance.",
  TWR: "Time-weighted return chains returns between portfolio snapshots while removing the impact of contributions and withdrawals. Both lines start at 100: 108 means an 8% return and 95 means a 5% loss over the selected period. This measures investment performance, not simple account-balance growth; compare the portfolio with SPY to see relative performance.",
};

type InvestmentViewProps = {
  filters: InvestmentFilters;
  onFiltersChange: (filters: InvestmentFilters) => void;
};

export default function InvestmentView({ filters, onFiltersChange }: InvestmentViewProps) {
  const { env } = useEnv();
  const { ownerUserId } = useHousehold();
  const queryClient = useQueryClient();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<InvestmentFilters>(filters);
  const dataQuery = useQuery({
    queryKey: queryKeys.investments(env, ownerUserId, filters),
    queryFn: () => api.getInvestmentDashboard(env, filters, ownerUserId),
    placeholderData: keepPreviousData,
  });
  const data = dataQuery.data;
  const refreshBenchmark = async () => {
    await api.refreshInvestmentBenchmark(env, true);
    await queryClient.invalidateQueries({
      queryKey: [...queryKeys.finance(env), ownerUserId || "household", "investments"],
    });
  };
  const refreshAfterClassification = async () => {
    await queryClient.invalidateQueries({
      queryKey: [...queryKeys.finance(env), ownerUserId || "household", "investments"],
    });
  };
  const activeAdvancedFilters =
    Number(filters.accountIds.length > 0) +
    Number(filters.cashPolicy !== "ALL") +
    Number(!filters.include401k) +
    Number(!filters.includeGoalReserved);

  if (dataQuery.isPending && !data)
    return (
      <Card title="Investments">
        <div className="text-sm text-zinc-500">Loading portfolio…</div>
      </Card>
    );
  if (!data)
    return (
      <Card title="Investments">
        <div className="flex items-center justify-between gap-3 text-sm text-red-600">
          <span>Could not load investment data.</span>
          <Button variant="secondary" onClick={() => void dataQuery.refetch()}>
            Retry
          </Button>
        </div>
      </Card>
    );

  const summary = data.summary;
  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs font-medium tracking-widest text-zinc-500">INVESTMENTS</div>
              <div className="mt-1 text-3xl font-semibold">
                {money(summary.current_portfolio_value)}
              </div>
              <div className="text-sm text-zinc-500">
                {percent(summary.one_year_return)} over 1 year
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {RANGES.map((range) => (
                <button
                  key={range}
                  onClick={() => onFiltersChange({ ...filters, range })}
                  className={`rounded px-2 py-1 text-xs ${filters.range === range ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600"}`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {VIEW_LABELS.map(([view, label]) => (
              <button
                key={view}
                onClick={() => onFiltersChange({ ...filters, view })}
                className={`rounded-lg border px-3 py-1.5 text-xs ${filters.view === view ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-600"}`}
              >
                {label}
              </button>
            ))}
            <Button
              variant="secondary"
              className="ml-auto px-3 py-1.5 text-xs"
              aria-expanded={filtersOpen}
              aria-controls="investment-advanced-filters"
              onClick={() => {
                if (!filtersOpen) setDraftFilters(filters);
                setFiltersOpen((open) => !open);
              }}
            >
              Filters{activeAdvancedFilters ? ` (${activeAdvancedFilters})` : ""}
            </Button>
          </div>
          {filtersOpen && (
            <AdvancedFilters
              accounts={data.filters.accounts}
              draft={draftFilters}
              onDraftChange={setDraftFilters}
              onApply={() => {
                onFiltersChange({
                  ...draftFilters,
                  accountIds: [...draftFilters.accountIds].sort(),
                });
                setFiltersOpen(false);
              }}
              onReset={() => {
                const reset = {
                  ...DEFAULT_INVESTMENT_FILTERS,
                  range: filters.range,
                  view: filters.view,
                };
                setDraftFilters(reset);
                onFiltersChange(reset);
                setFiltersOpen(false);
              }}
            />
          )}
          <AppliedFilterChips filters={filters} accounts={data.filters.accounts} />
          <div className="min-h-4 text-xs text-zinc-500" aria-live="polite">
            {dataQuery.isFetching ? "Updating portfolio…" : ""}
            {dataQuery.isError && data
              ? "Update failed. Showing the last available portfolio."
              : ""}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Financial assets" value={money(summary.total_financial_assets)} />
        <StatCard label="Investment assets" value={money(summary.total_investment_assets)} />
        <StatCard label="Liquid assets" value={money(summary.liquid_assets)} />
        <StatCard label="YTD return" value={percent(summary.ytd_return)} />
        <StatCard label="Contributions" value={money(summary.total_contributions)} />
        <StatCard
          label="Investment gains"
          value={
            summary.total_investment_gains === null
              ? "Unavailable"
              : money(summary.total_investment_gains)
          }
        />
        <StatCard
          label="Cost basis"
          value={summary.cost_basis === null ? "Unavailable" : money(summary.cost_basis)}
        />
        <StatCard
          label="Unrealized gain/loss"
          value={
            summary.unrealized_gain_loss === null
              ? "Unavailable"
              : money(summary.unrealized_gain_loss)
          }
          tone={(summary.unrealized_gain_loss || 0) >= 0 ? "text-emerald-700" : "text-red-700"}
        />
      </div>

      <Card
        title={
          <span className="inline-flex items-center gap-1.5">
            Portfolio vs S&amp;P 500 total-return proxy
            {data.performance.available && data.performance.method && (
              <HelpTooltip
                label={`About ${
                  data.performance.method === "TWR"
                    ? "time-weighted return"
                    : "Modified Dietz estimate"
                }`}
              >
                {PERFORMANCE_METHOD_HELP[data.performance.method]}
              </HelpTooltip>
            )}
          </span>
        }
        hint={
          data.performance.available
            ? `${data.performance.method === "TWR" ? "Time-weighted return" : "Modified Dietz estimate"}, normalized to 100 · SPY adjusted close`
            : data.performance.reason
        }
      >
        {data.performance.available ? (
          <PerformanceChart data={data.performance} onRefresh={refreshBenchmark} />
        ) : (
          <EmptyHistory onRefresh={refreshBenchmark} />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <AllocationCard data={data} />
        <TargetCard data={data} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <GrowthCard data={data} />
        <ContributionCard data={data} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <WealthBridgeCard data={data} />
        <GoalsCard data={data} />
      </div>

      <HoldingsCard
        data={data}
        onSaveAllocation={async (securityId, allocations) => {
          await api.setInvestmentAllocations(env, securityId, allocations);
          await refreshAfterClassification();
        }}
        onResetAllocation={async (securityId) => {
          await api.resetInvestmentAllocations(env, securityId);
          await refreshAfterClassification();
        }}
        onSaveAccountAllocation={async (accountId, allocations) => {
          await api.setInvestmentAccountAllocations(env, accountId, allocations);
          await refreshAfterClassification();
        }}
        onResetAccountAllocation={async (accountId) => {
          await api.resetInvestmentAccountAllocations(env, accountId);
          await refreshAfterClassification();
        }}
      />
      {data.data_quality.warnings.length > 0 && (
        <Card title="Data quality" hint="Values marked unavailable are not estimated">
          <div className="space-y-2">
            {data.data_quality.warnings.map((warning) => (
              <div
                key={warning.code}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                <span className="font-medium">{warning.code.replaceAll("_", " ")}</span> —{" "}
                {warning.message}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

type FilterAccount = InvestmentDashboard["filters"]["accounts"][number];

function AdvancedFilters({
  accounts,
  draft,
  onDraftChange,
  onApply,
  onReset,
}: {
  accounts: FilterAccount[];
  draft: InvestmentFilters;
  onDraftChange: (filters: InvestmentFilters) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  return (
    <div
      id="investment-advanced-filters"
      className="rounded-lg border border-zinc-200 bg-zinc-50 p-4"
    >
      <div className="grid gap-4 md:grid-cols-3">
        <fieldset>
          <legend className="text-sm font-medium">Accounts</legend>
          <p className="mb-2 text-xs text-zinc-500">
            All accounts includes every eligible account in the selected scope.
          </p>
          <div className="max-h-40 space-y-1 overflow-auto">
            {accounts.map((account) => (
              <label key={account.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.accountIds.includes(account.id)}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      accountIds: event.target.checked
                        ? [...draft.accountIds, account.id]
                        : draft.accountIds.filter((id) => id !== account.id),
                    })
                  }
                />
                {account.name}
              </label>
            ))}
            {accounts.length === 0 && (
              <div className="text-xs text-zinc-500">No accounts available.</div>
            )}
          </div>
        </fieldset>
        <label className="text-sm font-medium">
          Cash treatment
          <Select
            className="mt-2 w-full bg-white"
            value={draft.cashPolicy}
            onChange={(event) =>
              onDraftChange({ ...draft, cashPolicy: event.target.value as CashPolicy })
            }
          >
            <option value="ALL">Include all cash</option>
            <option value="EXCLUDE_EARMARKED">Exclude earmarked cash</option>
            <option value="EXCLUDE_ALL">Exclude all cash</option>
          </Select>
        </label>
        <div className="space-y-2">
          <div className="text-sm font-medium">Included assets</div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.include401k}
              onChange={(event) => onDraftChange({ ...draft, include401k: event.target.checked })}
            />
            Include 401(k)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.includeGoalReserved}
              onChange={(event) =>
                onDraftChange({ ...draft, includeGoalReserved: event.target.checked })
              }
            />
            Include goal-reserved assets
          </label>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onReset}>
          Reset filters
        </Button>
        <Button onClick={onApply}>Apply filters</Button>
      </div>
    </div>
  );
}

function AppliedFilterChips({
  filters,
  accounts,
}: {
  filters: InvestmentFilters;
  accounts: FilterAccount[];
}) {
  const accountNames = accounts
    .filter((account) => filters.accountIds.includes(account.id))
    .map((account) => account.name);
  const chips = [
    accountNames.length ? `Accounts: ${accountNames.join(", ")}` : "Accounts: All eligible",
    filters.cashPolicy === "ALL"
      ? null
      : filters.cashPolicy === "EXCLUDE_ALL"
        ? "Cash excluded"
        : "Earmarked cash excluded",
    filters.include401k ? null : "401(k) excluded",
    filters.includeGoalReserved ? null : "Goal-reserved assets excluded",
  ].filter((value): value is string => Boolean(value));
  return (
    <div className="flex flex-wrap gap-2" aria-label="Applied investment filters">
      {chips.map((chip) => (
        <span key={chip} className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">
          {chip}
        </span>
      ))}
    </div>
  );
}

function PerformanceChart({
  data,
  onRefresh,
}: {
  data: InvestmentDashboard["performance"];
  onRefresh: () => Promise<void>;
}) {
  const points = data.series;
  const values = points.flatMap((point) =>
    [point.portfolio, point.benchmark].filter((value): value is number => value !== null),
  );
  const min = Math.min(...values, 100);
  const max = Math.max(...values, 100);
  const spread = Math.max(1, max - min);
  const coordinates = (key: "portfolio" | "benchmark") =>
    points
      .map((point, index) => {
        const value = point[key];
        if (value === null) return null;
        const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 900;
        const y = 250 - ((value - min) / spread) * 220;
        return `${x},${y}`;
      })
      .filter(Boolean)
      .join(" ");
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-5 text-sm">
        <span>
          Portfolio <strong>{percent(data.portfolio_return)}</strong>{" "}
          <span className="text-xs text-zinc-500">
            ({data.method === "TWR" ? "TWR" : "Modified Dietz estimate"})
          </span>
        </span>
        <span>
          SPY proxy <strong>{percent(data.benchmark_return)}</strong>
        </span>
        <span>
          Difference <strong>{percent(data.difference)}</strong>
        </span>
        {data.benchmark_return === null && <BenchmarkRefresh onRefresh={onRefresh} />}
      </div>
      <svg
        viewBox="0 0 900 270"
        className="h-64 w-full"
        role="img"
        aria-label="Portfolio and S&P 500 total-return proxy performance"
      >
        <line
          x1="0"
          x2="900"
          y1={250 - ((100 - min) / spread) * 220}
          y2={250 - ((100 - min) / spread) * 220}
          stroke="#d4d4d8"
          strokeDasharray="4 4"
        />
        <polyline points={coordinates("portfolio")} fill="none" stroke="#18181b" strokeWidth="4" />
        <polyline points={coordinates("benchmark")} fill="none" stroke="#10b981" strokeWidth="3" />
      </svg>
      <div className="flex gap-4 text-xs text-zinc-500">
        <span>● Portfolio</span>
        <span className="text-emerald-700">● SPY adjusted close</span>
        <span className="ml-auto">
          {points[0]?.date} – {points.at(-1)?.date}
        </span>
      </div>
    </div>
  );
}

function BenchmarkRefresh({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Button
      variant="secondary"
      className="ml-auto px-2 py-1 text-xs"
      disabled={refreshing}
      onClick={async () => {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }}
    >
      {refreshing ? "Refreshing…" : "Refresh benchmark"}
    </Button>
  );
}

function EmptyHistory({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-500">
      <span>Performance begins after two complete local portfolio snapshots.</span>
      <Button
        variant="secondary"
        disabled={refreshing}
        onClick={async () => {
          setRefreshing(true);
          try {
            await onRefresh();
          } finally {
            setRefreshing(false);
          }
        }}
      >
        {refreshing ? "Refreshing…" : "Refresh S&P 500 data"}
      </Button>
    </div>
  );
}

function AllocationCard({ data }: { data: InvestmentDashboard }) {
  return (
    <Card
      title="Current allocation"
      hint={`Growth ${data.risk_allocation.growth.percentage.toFixed(1)}% · Defensive ${data.risk_allocation.defensive.percentage.toFixed(1)}%`}
    >
      <div className="space-y-3">
        {data.allocation.map((item) => (
          <div key={item.asset_class}>
            <div className="flex justify-between text-sm">
              <span>{assetLabel(item.asset_class)}</span>
              <span>
                {money(item.value)} · {item.percentage.toFixed(1)}%
              </span>
            </div>
            <div className="mt-1 h-2 rounded bg-zinc-100">
              <div
                className="h-2 rounded bg-zinc-800"
                style={{ width: `${Math.min(100, item.percentage)}%` }}
              />
            </div>
          </div>
        ))}
        {data.allocation.length === 0 && (
          <div className="text-sm text-zinc-500">No assets match these filters.</div>
        )}
      </div>
    </Card>
  );
}

function TargetCard({ data }: { data: InvestmentDashboard }) {
  return (
    <Card
      title="Actual vs target"
      hint={`Overall deviation ${data.target_comparison.overall_deviation.toFixed(1)}%`}
    >
      <div className="mb-4 space-y-3" aria-label="Actual and target allocation chart">
        {data.target_comparison.rows.map((row) => (
          <div key={row.asset_class}>
            <div className="mb-1 flex justify-between text-xs">
              <span className="font-medium">{assetLabel(row.asset_class)}</span>
              <span className="text-zinc-500">
                Actual {row.actual_percent.toFixed(1)}% · Target {row.target_percent.toFixed(1)}%
              </span>
            </div>
            <div className="space-y-1">
              <div className="h-2 rounded bg-zinc-100">
                <div
                  className="h-2 rounded bg-zinc-900"
                  style={{ width: `${Math.min(100, row.actual_percent)}%` }}
                />
              </div>
              <div className="h-1.5 rounded bg-zinc-100">
                <div
                  className="h-1.5 rounded bg-blue-400"
                  style={{ width: `${Math.min(100, row.target_percent)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>Asset</Th>
              <Th className="text-right">Actual</Th>
              <Th className="text-right">Target</Th>
              <Th className="text-right">Drift</Th>
            </tr>
          </thead>
          <tbody>
            {data.target_comparison.rows.map((row) => (
              <tr key={row.asset_class}>
                <Td>{assetLabel(row.asset_class)}</Td>
                <Td className="text-right">{row.actual_percent.toFixed(1)}%</Td>
                <Td className="text-right">{row.target_percent.toFixed(1)}%</Td>
                <Td
                  className={`text-right ${row.drift_percent > 0 ? "text-red-700" : row.drift_percent < 0 ? "text-blue-700" : ""}`}
                >
                  {row.drift_percent >= 0 ? "+" : ""}
                  {row.drift_percent.toFixed(1)}%
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 rounded-lg bg-zinc-50 p-3">
        <div className="text-xs font-medium text-zinc-500">NEXT CONTRIBUTIONS</div>
        <div className="mt-2 flex flex-wrap gap-3">
          {data.rebalancing.allocations.map((row) => (
            <span key={row.asset_class} className="text-sm">
              {assetLabel(row.asset_class)} <strong>{row.percentage.toFixed(0)}%</strong>
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function GrowthCard({ data }: { data: InvestmentDashboard }) {
  const growth = data.growth_decomposition;
  const components = [
    ["Net contributions", growth.contributions - growth.withdrawals, "bg-blue-500"],
    ["Dividends", growth.dividends, "bg-emerald-500"],
    ["Interest", growth.interest, "bg-cyan-500"],
    ["Market appreciation", growth.market_appreciation, "bg-violet-500"],
  ] as const;
  const scale = Math.max(
    1,
    ...components.map(([, value]) => Math.abs(typeof value === "number" ? value : 0)),
  );
  return (
    <Card
      title="Contributions vs investment growth"
      hint={growth.available ? "Reconciled wealth change" : "History incomplete"}
    >
      <div className="mb-4 space-y-2" aria-label="Contributions and investment growth chart">
        {components.map(([label, value, color]) => (
          <div key={label} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2 text-xs">
            <span>{label}</span>
            <div className="h-2 rounded bg-zinc-100">
              <div
                className={`h-2 rounded ${value !== null && value < 0 ? "bg-red-500" : color}`}
                style={{ width: `${(Math.abs(value || 0) / scale) * 100}%` }}
              />
            </div>
            <span className="min-w-20 text-right">{value === null ? "—" : money(value)}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[
          ["Starting value", growth.starting_value],
          ["Contributions", growth.contributions],
          ["Withdrawals", -growth.withdrawals],
          ["Dividends", growth.dividends],
          ["Interest", growth.interest],
          ["Market appreciation", growth.market_appreciation],
          ["Ending value", growth.ending_value],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg bg-zinc-50 p-3">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-1 font-semibold">
              {typeof value === "number" ? money(value) : "Unavailable"}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ContributionCard({ data }: { data: InvestmentDashboard }) {
  const summary = data.contribution_summary;
  return (
    <Card title="Contribution activity">
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded bg-zinc-50 p-2">
          <span className="text-zinc-500">Invested</span>
          <strong className="block">{money(summary.invested_this_year)}</strong>
        </div>
        <div className="rounded bg-zinc-50 p-2">
          <span className="text-zinc-500">Net saved</span>
          <strong className="block">{money(summary.saved_this_year)}</strong>
        </div>
        <div className="rounded bg-zinc-50 p-2">
          <span className="text-zinc-500">Retirement</span>
          <strong className="block">{money(summary.retirement_contributions)}</strong>
        </div>
        <div className="rounded bg-zinc-50 p-2">
          <span className="text-zinc-500">529 balance</span>
          <strong className="block">{money(summary.education_balance)}</strong>
        </div>
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Monthly activity uses imported transactions; account balances are current.
      </p>
      <div className="space-y-2">
        {data.contribution_activity.map((row) => (
          <div key={row.month} className="rounded-lg border border-zinc-100 p-3">
            <div className="flex justify-between text-sm font-medium">
              <span>{row.month}</span>
              <span>{money(row.total)}</span>
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {Object.entries(row.destinations)
                .map(([name, value]) => `${name} ${money(value)}`)
                .join(" · ")}
            </div>
          </div>
        ))}
        {data.contribution_activity.length === 0 && (
          <div className="text-sm text-zinc-500">No contribution activity in this period.</div>
        )}
      </div>
    </Card>
  );
}

function WealthBridgeCard({ data }: { data: InvestmentDashboard }) {
  const bridge = data.wealth_bridge;
  return (
    <Card
      title={bridge.label}
      hint="Income, spending, savings, and market growth reconciled over the selected period"
    >
      <div className="grid grid-cols-2 gap-2 text-sm">
        {[
          ["Starting", bridge.starting_value],
          ["Earned", bridge.earned_income],
          ["Spent", -bridge.spending],
          ["Other external flows", bridge.other_external_flows],
          [
            "Investment return",
            (bridge.market_appreciation ?? 0) + bridge.dividends + bridge.interest,
          ],
          ["Ending", bridge.ending_value],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded bg-zinc-50 p-2">
            <span className="text-xs text-zinc-500">{label}</span>
            <strong className="block">
              {typeof value === "number" ? money(value) : "Unavailable"}
            </strong>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t pt-3 text-xs text-zinc-600">
        <div>
          Budget-surplus savings rate: <strong>{percent(bridge.budget_surplus_rate)}</strong>
        </div>
        <div>
          Verified contribution rate: <strong>{percent(bridge.verified_savings_rate)}</strong>
        </div>
        <div>
          Reconciliation difference:{" "}
          <strong>{money(bridge.savings_reconciliation_difference)}</strong>
        </div>
      </div>
    </Card>
  );
}

function GoalsCard({ data }: { data: InvestmentDashboard }) {
  return (
    <Card
      title="Goals and reserved assets"
      hint={`${money(data.wealth_allocation.long_term_investable_assets)} remains long-term investable`}
    >
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded bg-zinc-50 p-2">
          <span className="text-zinc-500">Goal reserved</span>
          <strong className="block">{money(data.wealth_allocation.goal_reserved_assets)}</strong>
        </div>
        <div className="rounded bg-zinc-50 p-2">
          <span className="text-zinc-500">Underfunded</span>
          <strong className="block">{money(data.goals.underfunded_amount)}</strong>
        </div>
      </div>
      <div className="space-y-2">
        {data.goals.goals
          .filter((goal) => goal.status === "ACTIVE")
          .map((goal) => (
            <div key={goal.id} className="rounded border border-zinc-100 p-3 text-sm">
              <div className="flex justify-between">
                <strong>{goal.name}</strong>
                <span>
                  {money(goal.funded_amount)}
                  {goal.target_amount !== null ? ` / ${money(goal.target_amount)}` : ""}
                </span>
              </div>
              {goal.underfunded_amount > 0 && (
                <div className="mt-1 text-xs text-amber-700">
                  Source value fell below assignments by {money(goal.underfunded_amount)}.
                </div>
              )}
            </div>
          ))}
        {data.goals.goals.length === 0 && (
          <div className="text-sm text-zinc-500">Create and fund goals in Settings.</div>
        )}
      </div>
    </Card>
  );
}

type Holding = InvestmentDashboard["holdings"][number];

function HoldingsCard({
  data,
  onSaveAllocation,
  onResetAllocation,
  onSaveAccountAllocation,
  onResetAccountAllocation,
}: {
  data: InvestmentDashboard;
  onSaveAllocation: (securityId: string, allocations: AssetAllocation[]) => Promise<void>;
  onResetAllocation: (securityId: string) => Promise<void>;
  onSaveAccountAllocation: (accountId: string, allocations: AssetAllocation[]) => Promise<void>;
  onResetAccountAllocation: (accountId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Holding | null>(null);
  const topHoldings = data.holdings.slice(0, 5);
  return (
    <>
      <Card
        title="Holdings and concentration"
        hint={
          data.holdings[0]
            ? `${data.holdings[0].holding} is ${data.holdings[0].allocation.toFixed(1)}% of selected assets`
            : undefined
        }
        padded={false}
      >
        {topHoldings.length > 0 && (
          <div className="space-y-2 border-b border-zinc-200 p-4" aria-label="Top holdings chart">
            {topHoldings.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[minmax(8rem,14rem)_1fr_auto] items-center gap-3 text-xs"
              >
                <span className="truncate font-medium">{row.holding}</span>
                <div className="h-2 rounded bg-zinc-100">
                  <div
                    className="h-2 rounded bg-zinc-800"
                    style={{ width: `${Math.min(100, row.allocation)}%` }}
                  />
                </div>
                <span>{row.allocation.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        )}
        <div className="overflow-auto">
          <table
            aria-label="Holdings"
            className="w-full min-w-[1000px] table-fixed text-xs [&_td]:px-2 [&_th]:px-2"
          >
            <colgroup>
              <col className="w-[14%]" />
              <col className="w-[17%]" />
              <col className="w-[12%]" />
              <col className="w-[13%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
              <col className="w-[7%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
            </colgroup>
            <thead>
              <tr>
                {[
                  "Holding",
                  "Asset class",
                  "Instrument",
                  "Account",
                  "Source",
                  "Value",
                  "Allocation",
                  "Cost basis",
                  "Gain/Loss",
                ].map((label) => (
                  <Th
                    key={label}
                    className={
                      label === "Holding" ||
                      label === "Asset class" ||
                      label === "Instrument" ||
                      label === "Account" ||
                      label === "Source"
                        ? ""
                        : "text-right"
                    }
                  >
                    {label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.holdings.map((row) => {
                const allocation = row.asset_allocation
                  .map((item) => `${assetLabel(item.asset_class)} ${item.percent.toFixed(0)}%`)
                  .join(" · ");
                const instrument = row.instrument_type
                  ? `${assetLabel(row.instrument_type)}${
                      row.instrument_subtype ? ` · ${assetLabel(row.instrument_subtype)}` : ""
                    }`
                  : "—";
                const source = row.value_source === "holdings" ? "Holdings" : "Account balance";
                return (
                  <tr key={row.id}>
                    <Td className="align-top font-medium" title={row.holding}>
                      {row.security_id || row.instrument_type === "investment" ? (
                        <button
                          className="block w-full text-left underline"
                          onClick={() => setSelected(row)}
                        >
                          <span className="line-clamp-2 break-words">{row.holding}</span>
                        </button>
                      ) : (
                        <span className="line-clamp-2 break-words">{row.holding}</span>
                      )}
                    </Td>
                    <Td className="align-top" title={allocation}>
                      <span className="line-clamp-2 break-words">{allocation}</span>
                    </Td>
                    <Td className="align-top" title={instrument}>
                      <span className="line-clamp-2 break-words">{instrument}</span>
                    </Td>
                    <Td className="align-top" title={row.account}>
                      <span className="line-clamp-2 break-words">{row.account}</span>
                    </Td>
                    <Td className="align-top" title={source}>
                      <span className="line-clamp-2 break-words">{source}</span>
                    </Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {money(row.value)}
                    </Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {row.allocation.toFixed(1)}%
                    </Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {row.cost_basis === null ? "—" : money(row.cost_basis)}
                    </Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {row.unrealized_gain === null ? "—" : money(row.unrealized_gain)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.holdings.length === 0 && (
            <div className="p-4 text-sm text-zinc-500">No holdings match these filters.</div>
          )}
        </div>
      </Card>
      {selected && (
        <AllocationEditor
          holding={selected}
          onClose={() => setSelected(null)}
          onSave={async (allocations) => {
            if (selected.security_id) {
              await onSaveAllocation(selected.security_id, allocations);
            } else {
              await onSaveAccountAllocation(selected.account_id, allocations);
            }
            setSelected(null);
          }}
          onReset={async () => {
            if (selected.security_id) {
              await onResetAllocation(selected.security_id);
            } else {
              await onResetAccountAllocation(selected.account_id);
            }
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function AllocationEditor({
  holding,
  onClose,
  onSave,
  onReset,
}: {
  holding: Holding;
  onClose: () => void;
  onSave: (allocations: AssetAllocation[]) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const initial = Object.fromEntries(ASSET_CLASSES.map((assetClass) => [assetClass, "0"]));
  for (const row of holding.asset_allocation) initial[row.asset_class] = String(row.percent);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const total = ASSET_CLASSES.reduce((sum, assetClass) => sum + Number(values[assetClass] || 0), 0);
  const valid =
    Math.abs(total - 100) <= 0.01 &&
    ASSET_CLASSES.every((assetClass) => {
      const rawValue = values[assetClass] || "0";
      const value = Number(rawValue);
      return /^\d{1,3}(\.\d{0,2})?$/.test(rawValue) && value >= 0 && value <= 100;
    });

  const run = async (operation: () => Promise<void>) => {
    setSaving(true);
    setError("");
    try {
      await operation();
    } catch {
      setError("Could not update this holding’s allocation.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="allocation-editor-title"
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-zinc-200 p-4">
          <div>
            <h3 id="allocation-editor-title" className="font-semibold">
              Edit allocation — {holding.holding}
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              {holding.instrument_type ? assetLabel(holding.instrument_type) : "Unknown instrument"}{" "}
              · applies to{" "}
              {holding.security_id ? "this security in all accounts" : "this account balance"}
            </p>
          </div>
          <button aria-label="Close allocation editor" className="text-zinc-500" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="space-y-3 p-4">
          {ASSET_CLASSES.map((assetClass) => (
            <label
              key={assetClass}
              className="grid grid-cols-[1fr_8rem] items-center gap-3 text-sm"
            >
              <span>{assetLabel(assetClass)}</span>
              <span className="flex items-center gap-1">
                <TextInput
                  aria-label={`${assetLabel(assetClass)} percentage`}
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={values[assetClass]}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [assetClass]: event.target.value }))
                  }
                />
                %
              </span>
            </label>
          ))}
          <div className={`text-sm font-medium ${valid ? "text-emerald-700" : "text-red-700"}`}>
            Total: {total.toFixed(2)}%
          </div>
          <div className="text-xs text-zinc-500">
            Source: {holding.classification_source === "USER" ? "User override" : "Automatic"}
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 p-4">
          <Button
            variant="ghost"
            disabled={saving || holding.classification_source !== "USER"}
            onClick={() => void run(onReset)}
          >
            Use automatic classification
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !valid}
            onClick={() =>
              void run(() =>
                onSave(
                  ASSET_CLASSES.map((assetClass) => ({
                    asset_class: assetClass,
                    percent: Number(values[assetClass] || 0),
                  })).filter((row) => row.percent > 0),
                ),
              )
            }
          >
            {saving ? "Saving…" : "Save allocation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
