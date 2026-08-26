"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import MonteCarloTool from "@/components/MonteCarloTool";
import RentToBuyTool from "@/components/RentToBuyTool";
import { Tabs, tabId, tabPanelId } from "@/components/ui";
import { useEnv } from "@/context/EnvContext";
import { useHousehold } from "@/context/HouseholdContext";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";

const TOOL_TABS = [
  { value: "rent-to-buy", label: "Rent vs. Buy" },
  { value: "monte-carlo", label: "Monte Carlo" },
] as const;

export default function FinancialToolsView() {
  const { env } = useEnv();
  const { ownerUserId } = useHousehold();
  const [tab, setTab] = useState<"rent-to-buy" | "monte-carlo">("rent-to-buy");
  const defaultsQuery = useQuery({
    queryKey: queryKeys.financialToolDefaults(env, ownerUserId),
    queryFn: () => api.getFinancialToolDefaults(env, ownerUserId),
  });
  const defaults = defaultsQuery.data;

  return (
    <div>
      <Tabs
        ariaLabel="Financial tool simulations"
        groupId="financial-tools"
        options={TOOL_TABS}
        value={tab}
        onChange={setTab}
      />
      {defaultsQuery.isPending && (
        <div className="text-sm text-zinc-500">Loading simulation defaults…</div>
      )}
      {defaultsQuery.isError && !defaults && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Could not load financial-tool defaults.
        </div>
      )}
      {defaults && (
        <>
          <div
            id={tabPanelId("financial-tools", "rent-to-buy")}
            role="tabpanel"
            aria-labelledby={tabId("financial-tools", "rent-to-buy")}
            hidden={tab !== "rent-to-buy"}
          >
            <RentToBuyTool
              defaults={defaults.rent_to_buy}
              defaultsSource={defaults.sources["rent_to_buy.starting_cash"] || "EXAMPLE"}
            />
          </div>
          <div
            id={tabPanelId("financial-tools", "monte-carlo")}
            role="tabpanel"
            aria-labelledby={tabId("financial-tools", "monte-carlo")}
            hidden={tab !== "monte-carlo"}
          >
            <MonteCarloTool
              defaults={defaults.monte_carlo}
              investmentSource={defaults.sources["monte_carlo.investment_start"] || "EXAMPLE"}
              cashSource={defaults.sources["monte_carlo.cash_start"] || "EXAMPLE"}
            />
          </div>
        </>
      )}
    </div>
  );
}
