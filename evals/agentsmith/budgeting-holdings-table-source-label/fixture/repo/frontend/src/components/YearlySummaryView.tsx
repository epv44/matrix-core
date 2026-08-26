"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, YearlyData } from "@/lib/api";
import { useEnv } from "@/context/EnvContext";
import { useHousehold } from "@/context/HouseholdContext";
import { queryKeys } from "@/lib/queries";
import { money } from "@/lib/format";
import {
  Card,
  StatCard,
  Select,
  Th,
  Td,
  TdMoney,
  ROW_EVEN,
  ROW_ODD,
  TONE_TEXT,
} from "@/components/ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CAP_GREEN = "#b7e1cd";
const CAP_RED = "#f4c7c3";
const CAP_YELLOW = "#fff2cc";

type AnnualRow = {
  label: string;
  monthly: number[];
  total: number;
  average: number;
  tone: string;
  cellBg?: (v: number, i: number) => string | undefined;
  totalBg?: string;
  averageBg?: string;
};

export default function YearlySummaryView() {
  const { env } = useEnv();
  const { ownerUserId } = useHousehold();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const monthsQuery = useQuery({
    queryKey: queryKeys.months(env),
    queryFn: () => api.getMonths(env),
  });
  const dataQuery = useQuery<YearlyData>({
    queryKey: queryKeys.yearly(env, ownerUserId, year),
    queryFn: () => api.getYearlySummary(year, env, ownerUserId),
  });
  const years = Array.from(
    new Set([new Date().getFullYear(), ...(monthsQuery.data?.raw.map(([value]) => value) || [])]),
  ).sort((a, b) => b - a);
  const data = dataQuery.data;

  if (!data && dataQuery.isPending) {
    return <div className="text-sm text-zinc-500">Loading yearly summary…</div>;
  }
  if (!data) return <div className="text-sm text-red-600">Could not load yearly summary.</div>;

  const annual = data.annual;
  const netTone = annual.net_total >= 0 ? TONE_TEXT.positive : TONE_TEXT.negative;
  const budgetPct =
    annual.budget_total > 0 ? Math.round((annual.expense_total / annual.budget_total) * 100) : 0;

  const annualRows: AnnualRow[] = [
    {
      label: "Expense",
      monthly: annual.expense,
      total: annual.expense_total,
      average: annual.expense_average,
      tone: "text-zinc-800",
      cellBg: (v, i) => (v > annual.budget[i] ? CAP_YELLOW : undefined),
      totalBg: annual.expense_total > annual.budget_total ? CAP_YELLOW : undefined,
      averageBg: annual.expense_average > annual.budget_average ? CAP_YELLOW : undefined,
    },
    {
      label: "Budget",
      monthly: annual.budget,
      total: annual.budget_total,
      average: annual.budget_average,
      tone: "text-zinc-800",
    },
    {
      label: "Income",
      monthly: annual.income,
      total: annual.income_total,
      average: annual.income_average,
      tone: "text-zinc-800",
    },
    {
      label: "Net Income",
      monthly: annual.net_income,
      total: annual.net_income_total,
      average: annual.net_income_average,
      tone: "text-zinc-800",
      cellBg: (v) => (v < 0 ? CAP_RED : CAP_GREEN),
      totalBg: annual.net_income_total < 0 ? CAP_RED : CAP_GREEN,
      averageBg: annual.net_income_average < 0 ? CAP_RED : CAP_GREEN,
    },
  ];

  return (
    <div className="w-full max-w-full min-w-0 space-y-4 overflow-x-clip">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold">Yearly Overview</h2>
        <Select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="w-auto px-2 py-1"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
      </div>

      {dataQuery.isFetching && <div className="text-xs text-zinc-500">Refreshing…</div>}

      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Total Expense" value={money(annual.expense_total)} hint="Year to date" />
        <StatCard
          label="Total Budget"
          value={money(annual.budget_total)}
          hint="Monthly budget × 12"
        />
        <StatCard
          label="Net P/L"
          value={money(annual.net_total)}
          tone={netTone}
          hint="Budget − Expense"
        />
        <StatCard
          label="Avg Monthly Expense"
          value={money(annual.expense_average)}
          hint="12-month average"
        />
        <StatCard
          label="% of Budget Spent"
          value={`${budgetPct}%`}
          tone={budgetPct > 100 ? TONE_TEXT.negative : TONE_TEXT.positive}
        />
      </div>

      <Card title={`Annual Summary — ${year}`} hint="Net Income = Income − Expense" padded={false}>
        <div className="max-h-[50vh] overflow-auto">
          <table className="min-w-full border-collapse text-[12px]">
            <thead className="top-0 z-10">
              <tr>
                <Th className="text-center">Category</Th>
                {MONTHS.map((m) => (
                  <Th key={m} className="text-center">
                    {m}
                  </Th>
                ))}
                <Th className="text-center">Total</Th>
                <Th className="text-center">Average</Th>
              </tr>
            </thead>
            <tbody>
              {annualRows.map((row, ri) => (
                <tr key={row.label} className={ri % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                  <Td className="font-medium">{row.label}</Td>
                  {row.monthly.map((v, i) => (
                    <TdMoney
                      key={i}
                      className={row.tone}
                      style={row.cellBg ? { backgroundColor: row.cellBg(v, i) } : undefined}
                    >
                      {money(v)}
                    </TdMoney>
                  ))}
                  <TdMoney
                    className={`font-semibold ${row.tone}`}
                    style={row.totalBg ? { backgroundColor: row.totalBg } : undefined}
                  >
                    {money(row.total)}
                  </TdMoney>
                  <TdMoney
                    className={row.tone}
                    style={row.averageBg ? { backgroundColor: row.averageBg } : undefined}
                  >
                    {money(row.average)}
                  </TdMoney>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title={`Expenses by Category — ${year}`}
        hint="Share of total expense — green under cap, red at/over cap"
        padded={false}
      >
        <div className="max-h-[60vh] overflow-auto">
          <table className="min-w-full border-collapse text-[12px]">
            <thead className="top-0 z-10">
              <tr>
                <Th className="text-center">Category</Th>
                {MONTHS.map((m) => (
                  <Th key={m} className="text-center">
                    {m}
                  </Th>
                ))}
                <Th className="text-center">Total</Th>
                <Th className="text-center">Average</Th>
                <Th className="text-center">Percentage</Th>
                <Th className="text-center">Category Cap</Th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c, ri) => (
                <tr key={c.name} className={ri % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                  <Td className="font-medium">{c.name}</Td>
                  {c.monthly.map((v, i) => {
                    const bg = v && c.cap != null ? (v < c.cap ? CAP_GREEN : CAP_RED) : undefined;
                    return (
                      <TdMoney key={i} style={bg ? { backgroundColor: bg } : undefined}>
                        {v ? money(v) : ""}
                      </TdMoney>
                    );
                  })}
                  <TdMoney className="font-semibold text-zinc-800">{money(c.total)}</TdMoney>
                  <TdMoney>{money(c.average)}</TdMoney>
                  <TdMoney>{c.percentage.toFixed(2)}%</TdMoney>
                  <TdMoney className="text-zinc-400">{c.cap != null ? money(c.cap) : "—"}</TdMoney>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
