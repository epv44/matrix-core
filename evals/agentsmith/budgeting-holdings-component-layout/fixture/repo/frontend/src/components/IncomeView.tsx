"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, IncomeData } from "@/lib/api";
import { useEnv } from "@/context/EnvContext";
import { useHousehold } from "@/context/HouseholdContext";
import { queryKeys } from "@/lib/queries";
import { money } from "@/lib/format";
import { Card, Button, Select, TextInput, Th, Td, ROW_EVEN, ROW_ODD } from "@/components/ui";

export default function IncomeView() {
  const { env } = useEnv();
  const { ownerUserId } = useHousehold();
  const [groupBy, setGroupBy] = useState("merchant");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState({ groupBy: "merchant", from: "", to: "" });
  const dataQuery = useQuery<IncomeData>({
    queryKey: queryKeys.income(env, ownerUserId, applied),
    queryFn: () =>
      api.getIncome(
        env,
        applied.groupBy,
        applied.from || undefined,
        applied.to || undefined,
        ownerUserId,
      ),
    placeholderData: (previous) => previous,
  });
  const data = dataQuery.data;
  return (
    <Card title="Income Breakdown">
      <div className="flex flex-wrap gap-2 text-sm">
        <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="w-auto">
          <option value="merchant">Merchant</option>
          <option value="account">Account</option>
          <option value="institution">Institution</option>
          <option value="payment_processor">Payment Processor</option>
        </Select>
        <TextInput
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="From YYYY-MM-DD"
          className="w-40"
        />
        <TextInput
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="To YYYY-MM-DD"
          className="w-40"
        />
        <Button variant="secondary" onClick={() => setApplied({ groupBy, from, to })}>
          Apply
        </Button>
      </div>
      {dataQuery.isFetching && <div className="mt-3 text-xs text-zinc-500">Refreshing…</div>}
      {dataQuery.isError && !data && (
        <div className="mt-3 text-sm text-red-600">Could not load income data.</div>
      )}
      {data && (
        <>
          <div className="mt-4 font-semibold">Total Income: {money(data.total)}</div>
          <div className="mt-2 overflow-auto">
            <table className="w-full min-w-[400px] border-collapse text-[12px]">
              <thead>
                <tr>
                  {["Source", "Amount", "Count"].map((h) => (
                    <Th key={h} className={h === "Source" ? "text-left" : "text-right"}>
                      {h}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.breakdown.map((r, i) => (
                  <tr key={r.source} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                    <Td>{r.source}</Td>
                    <Td className="text-right tabular-nums">{money(r.amount)}</Td>
                    <Td className="text-right tabular-nums">{r.count}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
