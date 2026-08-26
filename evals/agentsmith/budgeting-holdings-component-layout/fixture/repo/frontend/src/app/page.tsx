"use client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Sidebar from "@/components/Sidebar";
import DashboardSpreadsheet from "@/components/DashboardSpreadsheet";
import YearlySummaryView from "@/components/YearlySummaryView";
import InvestmentView, { DEFAULT_INVESTMENT_FILTERS } from "@/components/InvestmentView";
import InvestmentTransactionBrowser from "@/components/InvestmentTransactionBrowser";
import TransactionDetailDialog from "@/components/TransactionDetailDialog";
import TransactionBrowser from "@/components/TransactionBrowser";
import IncomeView from "@/components/IncomeView";
import FinancialToolsView from "@/components/FinancialToolsView";
import LinkSyncView from "@/components/LinkSyncView";
import SettingsView from "@/components/SettingsView";
import { ButtonLink, Select, Tabs, tabId, tabPanelId } from "@/components/ui";
import { useEnv } from "@/context/EnvContext";
import { api, Institution, InvestmentFilters } from "@/lib/api";
import { invalidateFinancialData, queryKeys } from "@/lib/queries";
import { refreshBenchmarkOnce, syncAllOnce } from "@/lib/syncCoordinator";
import { useAuth } from "@/context/AuthContext";
import { useHousehold } from "@/context/HouseholdContext";

const DASHBOARD_TABS = [
  { value: "yearly", label: "Yearly Summary" },
  { value: "monthly", label: "Monthly breakdown" },
  { value: "invest", label: "Investment Tracking" },
] as const;

const HISTORY_TABS = [
  { value: "depository", label: "Depository" },
  { value: "investment", label: "Investment" },
  { value: "income", label: "Income" },
] as const;
const EMPTY_MONTHS: string[] = [];

export default function Home() {
  const [active, setActive] = useState("Dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { user, logout } = useAuth();
  const { members, ownerUserId, setOwnerUserId } = useHousehold();
  const { env } = useEnv();
  const [selectedMonthChoice, setSelectedMonth] = useState<string | null>(null);
  const [selectedTxn, setSelectedTxn] = useState<string | null>(null);
  const [dashTab, setDashTab] = useState<"yearly" | "monthly" | "invest">("yearly");
  const [historyTab, setHistoryTab] = useState<"depository" | "investment" | "income">(
    "depository",
  );
  const [investmentFilters, setInvestmentFilters] = useState<InvestmentFilters>(
    DEFAULT_INVESTMENT_FILTERS,
  );
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [autoSyncNotice, setAutoSyncNotice] = useState("");
  const queryClient = useQueryClient();
  const monthsQuery = useQuery({
    queryKey: queryKeys.months(env),
    queryFn: () => api.getMonths(env),
  });
  const months = monthsQuery.data?.months || EMPTY_MONTHS;
  const selectedMonth =
    selectedMonthChoice && months.includes(selectedMonthChoice)
      ? selectedMonthChoice
      : [...months].sort().at(-1) || null;
  const selectedParts = selectedMonth?.split("-").map(Number);
  const selectedYear = selectedParts?.[0] || 0;
  const selectedMonthNumber = selectedParts?.[1] || 0;
  const dashboardQuery = useQuery({
    queryKey: queryKeys.monthly(env, ownerUserId, selectedYear, selectedMonthNumber),
    queryFn: () => api.getDashboard(selectedYear, selectedMonthNumber, env, ownerUserId),
    enabled: Boolean(selectedMonth),
  });
  const dashboard = dashboardQuery.data || null;
  const isStale = (ts: string | null) => {
    if (!ts) return true;
    const t = new Date(ts);
    if (isNaN(t.getTime())) return true;
    return Date.now() - t.getTime() > 24 * 60 * 60 * 1000;
  };

  useEffect(() => {
    let cancelled = false;
    api
      .getInstitutions(env)
      .then(async (d) => {
        const insts = d.institutions || [];
        if (!insts.length || insts.some((i: Institution) => isStale(i.last_successful_sync))) {
          if (cancelled) return;
          setAutoSyncing(true);
          setAutoSyncNotice("No recent sync found — pulling latest data…");
          try {
            await syncAllOnce(env);
            if (!cancelled) setAutoSyncNotice("Sync complete.");
            if (!cancelled) await invalidateFinancialData(queryClient, env);
          } catch {
            if (!cancelled) setAutoSyncNotice("Auto-sync failed.");
          } finally {
            if (!cancelled) setAutoSyncing(false);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [env, ownerUserId, queryClient]);

  useEffect(() => {
    refreshBenchmarkOnce(env)
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.finance(env), ownerUserId || "household", "investments"],
        }),
      )
      .catch(() => {});
  }, [env, ownerUserId, queryClient]);

  return (
    <div className="flex">
      <Sidebar
        active={active}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
        setActive={setActive}
      />
      <main
        className={`min-h-screen max-w-full min-w-0 flex-1 bg-zinc-50 p-10 transition-[margin] duration-200 ${sidebarCollapsed ? "ml-0" : "ml-0 md:ml-72"}`}
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{active}</h1>
          <select
            aria-label="Account owner"
            value={ownerUserId || ""}
            onChange={(event) => {
              setOwnerUserId(event.target.value || null);
              setInvestmentFilters((current) =>
                current.accountIds.length ? { ...current, accountIds: [] } : current,
              );
            }}
            className="ml-auto rounded border bg-white px-2 py-1 text-sm"
          >
            <option value="">Combined household</option>
            {members
              .filter((member) => member.id === user?.id)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.username}
                </option>
              ))}
          </select>
          <span className="text-xs text-zinc-500">Signed in as {user.username}</span>
          <button className="text-xs underline" onClick={() => void logout()}>
            Sign out
          </button>
        </div>

        {autoSyncNotice && (
          <div
            className={`mb-4 rounded-lg px-3 py-2 text-sm ${autoSyncing ? "border border-blue-200 bg-blue-50 text-blue-700" : "border border-zinc-200 bg-zinc-50 text-zinc-600"}`}
          >
            {autoSyncNotice}
          </div>
        )}

        <div key={ownerUserId || "household"}>
          {active === "Dashboard" && (
            <>
              <Tabs
                ariaLabel="Dashboard views"
                groupId="dashboard"
                options={DASHBOARD_TABS}
                value={dashTab}
                onChange={setDashTab}
              />
              {dashTab === "yearly" && (
                <div
                  id={tabPanelId("dashboard", "yearly")}
                  role="tabpanel"
                  aria-labelledby={tabId("dashboard", "yearly")}
                >
                  <YearlySummaryView />
                </div>
              )}
              {dashTab === "monthly" && (
                <div
                  id={tabPanelId("dashboard", "monthly")}
                  role="tabpanel"
                  aria-labelledby={tabId("dashboard", "monthly")}
                >
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <h2 className="text-xl font-bold">Monthly Overview</h2>
                    {months.length > 0 && (
                      <Select
                        aria-label="Monthly overview month"
                        value={selectedMonth || ""}
                        onChange={(event) => setSelectedMonth(event.target.value)}
                        className="w-auto"
                      >
                        {months.map((month) => (
                          <option key={month} value={month}>
                            {month}
                          </option>
                        ))}
                      </Select>
                    )}
                    {dashboard && selectedMonth && (
                      <div className="flex flex-wrap gap-2 sm:ml-auto">
                        <ButtonLink
                          href={`/api/export/month/${dashboard.year}/${dashboard.month}?env=${env}${ownerUserId ? `&owner_user_id=${ownerUserId}` : ""}`}
                        >
                          Export Excel (this month)
                        </ButtonLink>
                        <ButtonLink
                          href={`/api/export/range?from_month=${selectedMonth}&to_month=${selectedMonth}&env=${env}${ownerUserId ? `&owner_user_id=${ownerUserId}` : ""}`}
                        >
                          Export Range (each month own sheet)
                        </ButtonLink>
                      </div>
                    )}
                  </div>
                  {dashboardQuery.isPending && !dashboard && <div>Loading monthly dashboard…</div>}
                  {dashboardQuery.isError && !dashboard && (
                    <div>No data—Sync Now via sidebar. Env: {env}</div>
                  )}
                  {dashboardQuery.isFetching && dashboard && (
                    <div className="mb-2 text-xs text-zinc-500">Refreshing…</div>
                  )}
                  {dashboard && (
                    <DashboardSpreadsheet data={dashboard} onSelectTxn={setSelectedTxn} />
                  )}
                </div>
              )}
              {dashTab === "invest" && (
                <div
                  id={tabPanelId("dashboard", "invest")}
                  role="tabpanel"
                  aria-labelledby={tabId("dashboard", "invest")}
                >
                  <InvestmentView
                    filters={investmentFilters}
                    onFiltersChange={setInvestmentFilters}
                  />
                </div>
              )}
            </>
          )}
          {active === "History" && (
            <>
              <Tabs
                ariaLabel="History views"
                groupId="history"
                options={HISTORY_TABS}
                value={historyTab}
                onChange={setHistoryTab}
              />
              {historyTab === "depository" && (
                <div
                  id={tabPanelId("history", "depository")}
                  role="tabpanel"
                  aria-labelledby={tabId("history", "depository")}
                >
                  <TransactionBrowser onSelectTxn={setSelectedTxn} />
                </div>
              )}
              {historyTab === "investment" && (
                <div
                  id={tabPanelId("history", "investment")}
                  role="tabpanel"
                  aria-labelledby={tabId("history", "investment")}
                >
                  <InvestmentTransactionBrowser />
                </div>
              )}
              {historyTab === "income" && (
                <div
                  id={tabPanelId("history", "income")}
                  role="tabpanel"
                  aria-labelledby={tabId("history", "income")}
                >
                  <IncomeView />
                </div>
              )}
            </>
          )}
          {active === "Financial Tools" && (
            <FinancialToolsView key={`${env}:${ownerUserId || "household"}`} />
          )}
          {active === "Link / Sync" && <LinkSyncView />}
          {active === "Settings" && <SettingsView />}
        </div>
      </main>
      {selectedTxn && (
        <TransactionDetailDialog
          txnId={selectedTxn}
          env={env}
          onClose={() => setSelectedTxn(null)}
          onTransactionChanged={() => void invalidateFinancialData(queryClient, env)}
        />
      )}
    </div>
  );
}
