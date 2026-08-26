"use client";
import { DashboardData } from "@/lib/api";
import { money, fmtMoney } from "@/lib/format";
import { Card, StatCard, Th, Td, TdMoney, ROW_EVEN, ROW_ODD, TONE_TEXT } from "@/components/ui";
import React from "react";

export default function DashboardSpreadsheet({
  data,
  onSelectTxn,
}: {
  data: DashboardData;
  onSelectTxn: (id: string) => void;
}) {
  const cats = data.sheet_categories;
  const expenses = data.expenses;
  const maxRows = Math.max(...cats.map((c) => expenses[c]?.length || 0), 0);

  const rows: Record<string, string | number>[] = [];
  for (let i = 0; i < maxRows; i++) {
    const row: Record<string, string | number> = {};
    for (const cat of cats) {
      const lst = expenses[cat] || [];
      if (i < lst.length) {
        row[cat] = lst[i][0];
        row[`${cat} $`] = lst[i][1];
      } else {
        row[cat] = "";
        row[`${cat} $`] = "";
      }
    }
    rows.push(row);
  }
  const totalRow: Record<string, string | number> = {};
  for (const cat of cats) {
    totalRow[cat] = "Total:";
    const sum = (expenses[cat] || []).reduce((s, [, amt]) => s + (amt as number), 0);
    totalRow[`${cat} $`] = sum ? fmtMoney(sum) : "";
  }
  rows.push(totalRow);

  const detailed = data.detailed;

  const handleCellClick = (cat: string, rowIdx: number) => {
    const lst = expenses[cat];
    if (!lst || rowIdx >= lst.length) return;
    const [merchant, amt] = lst[rowIdx];
    const items = detailed[cat] || [];
    const found =
      items.find((i) => i.merchant === merchant && Math.abs(i.amount - (amt as number)) < 0.01) ||
      items[rowIdx];
    if (found) onSelectTxn(found.txn_id);
  };

  const catColors: Record<string, string> = {
    Transportation: "bg-blue-50 border-blue-200",
    Self: "bg-purple-50 border-purple-200",
    Restaurants: "bg-emerald-50 border-emerald-200",
    Groceries: "bg-lime-50 border-lime-200",
    "MISC.": "bg-zinc-50 border-zinc-200",
    "Living Expenses": "bg-amber-50 border-amber-100",
    Baby: "bg-pink-50 border-pink-200",
    Travel: "bg-sky-50 border-sky-200",
    "Cat Related": "bg-orange-50 border-orange-200",
    "Home Goods": "bg-violet-50 border-violet-200",
  };

  const monthLabel = `${data.year}-${String(data.month).padStart(2, "0")}`;

  return (
    <div className="w-full max-w-full min-w-0 space-y-4 overflow-x-clip">
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          label="Total Spent"
          value={money(data.summary.total_spent)}
          hint="Sum of expenses"
        />
        <StatCard label="Total Made" value={money(data.summary.total_made)} hint="Income" />
        <StatCard
          label="Net P/L"
          value={money(data.summary.net)}
          hint="Income − expenses"
          tone={data.summary.net >= 0 ? TONE_TEXT.positive : TONE_TEXT.negative}
        />
        <StatCard
          label="% Saved"
          value={`${data.summary.saved_pct}%`}
          tone={data.summary.saved_pct >= 20 ? TONE_TEXT.positive : undefined}
        />
        <StatCard
          label="Uncategorized"
          value={`${data.stats.uncategorized_count} / ${data.stats.txn_count}`}
          tone={data.stats.uncategorized_count > 0 ? TONE_TEXT.warn : undefined}
          extra={
            data.stats.uncategorized.length > 0 && (
              <div className="absolute top-full left-0 z-30 mt-2 hidden max-w-xs min-w-[240px] rounded-lg bg-zinc-900 p-2 text-[11px] text-white shadow-xl group-hover:block">
                <div className="px-2 py-1 font-medium tracking-wide text-zinc-400 uppercase">
                  Uncategorized transactions
                </div>
                <div className="max-h-[50vh] overflow-auto">
                  {data.stats.uncategorized.map((t) => (
                    <button
                      key={t.txn_id}
                      onClick={() => onSelectTxn(t.txn_id)}
                      className="flex w-full justify-between gap-3 rounded px-2 py-1 text-left hover:bg-zinc-700"
                    >
                      <span className="truncate">{t.merchant}</span>
                      <span className="text-amber-300 tabular-nums">{money(t.amount)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          }
        />
      </div>

      <Card
        title={`Monthly Breakdown — ${monthLabel}`}
        hint="Click merchant to see detail tooltip + reclassify"
        padded={false}
      >
        <div className="max-h-[68vh] overflow-auto">
          <table className="min-w-full border-collapse text-[12px]">
            <thead className="top-0 z-10">
              <tr>
                {cats.map((cat) => (
                  <Th key={cat} colSpan={2} className={`${catColors[cat] || "bg-zinc-100"}`}>
                    {cat}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const isTotal = ri === rows.length - 1;
                return (
                  <tr
                    key={`row-${ri}`}
                    className={`${ri % 2 === 0 ? ROW_EVEN : ROW_ODD} ${isTotal ? "font-semibold" : ""}`}
                  >
                    {cats.map((cat) => (
                      <React.Fragment key={`frag-${cat}-${ri}`}>
                        <Td
                          className={`max-w-[180px] truncate ${isTotal ? "" : "cursor-pointer transition-colors hover:bg-yellow-50 hover:text-zinc-900"} text-zinc-800`}
                          title={isTotal ? "" : `Click for detail: ${row[cat]}`}
                          onClick={() => {
                            if (!isTotal) handleCellClick(cat, ri);
                          }}
                        >
                          {row[cat]}
                        </Td>
                        <TdMoney>{row[`${cat} $`] !== "" ? `$${row[`${cat} $`]}` : ""}</TdMoney>
                      </React.Fragment>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title={`Income — ${monthLabel}`}
        hint="Click merchant to see detail + reclassify type/category"
        padded={false}
      >
        <div className="max-h-[40vh] overflow-auto">
          <table className="min-w-full border-collapse text-[12px]">
            <thead className="top-0 z-10">
              <tr>
                <Th colSpan={2} className="border-emerald-200 bg-emerald-50">
                  Income Sources
                </Th>
              </tr>
            </thead>
            <tbody>
              {data.income.map((inc, i) => (
                <tr key={inc.txn_id} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                  <Td
                    className="max-w-[180px] cursor-pointer truncate text-zinc-800 transition-colors hover:bg-yellow-50 hover:text-zinc-900"
                    title={`Click for detail: ${inc.merchant}`}
                    onClick={() => onSelectTxn(inc.txn_id)}
                  >
                    {inc.merchant}
                  </Td>
                  <TdMoney className="text-emerald-700">{money(inc.amount)}</TdMoney>
                </tr>
              ))}
              <tr className="font-semibold">
                <Td>Total:</Td>
                <TdMoney>{money(data.summary.total_made)}</TdMoney>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
