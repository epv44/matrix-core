"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, InvestmentTransaction } from "@/lib/api";
import { useEnv } from "@/context/EnvContext";
import { useHousehold } from "@/context/HouseholdContext";
import { invalidateFinancialData, queryKeys } from "@/lib/queries";
import { Card, Button, TextInput } from "@/components/ui";

export default function InvestmentTransactionBrowser() {
  const { env } = useEnv();
  const { ownerUserId } = useHousehold();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [eventType, setEventType] = useState("RSU_VEST");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [gross, setGross] = useState("");
  const [withholding, setWithholding] = useState("");
  const transactionsQuery = useQuery({
    queryKey: queryKeys.investmentTransactions(env, ownerUserId),
    queryFn: () => api.listInvestmentTransactions(env, {}, ownerUserId),
  });
  const rows: InvestmentTransaction[] = transactionsQuery.data?.transactions || [];
  const addEventMutation = useMutation({
    mutationFn: () =>
      api.addEquityEvent(env, {
        event_type: eventType,
        event_date: date,
        gross_income: Number(gross) || 0,
        withholding: Number(withholding) || 0,
        source: "manual",
      }),
    onSuccess: async () => {
      setShowForm(false);
      await invalidateFinancialData(queryClient, env);
    },
  });
  return (
    <Card
      title="Investment Transactions"
      hint="Raw Plaid activity and normalized investment ledger"
    >
      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
          Add equity compensation event
        </Button>
      </div>
      {showForm && (
        <div className="mt-3 grid grid-cols-4 gap-2 rounded border p-3 text-sm">
          <select
            className="rounded border px-2"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
          >
            <option>RSU_VEST</option>
            <option>RSU_WITHHOLDING</option>
            <option>OPTION_EXERCISE</option>
            <option>OPTION_WITHHOLDING</option>
            <option>EMPLOYER_STOCK_PURCHASE</option>
            <option>MANUAL_CORRECTION</option>
          </select>
          <input
            className="rounded border px-2"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <TextInput
            placeholder="Gross income"
            value={gross}
            onChange={(e) => setGross(e.target.value)}
          />
          <TextInput
            placeholder="Withholding"
            value={withholding}
            onChange={(e) => setWithholding(e.target.value)}
          />
          <Button disabled={addEventMutation.isPending} onClick={() => addEventMutation.mutate()}>
            Save append-only event
          </Button>
        </div>
      )}
      {transactionsQuery.isFetching && (
        <div className="mt-3 text-xs text-zinc-500">Refreshing…</div>
      )}
      <div className="mt-4 overflow-auto">
        <table className="w-full min-w-[900px] text-xs">
          <thead>
            <tr>
              {[
                "Date",
                "Account",
                "Security",
                "Action",
                "Quantity",
                "Price",
                "Gross amount",
                "Fees",
                "Cash impact",
                "Classification",
                "Source",
              ].map((h) => (
                <th className="border-b p-2 text-left" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.plaid_transaction_id} className="border-b">
                <td className="p-2">{r.date}</td>
                <td className="p-2">{r.account_id}</td>
                <td className="p-2">{r.ticker || r.security_name || "Cash"}</td>
                <td className="p-2">
                  {r.type} / {r.subtype}
                </td>
                <td className="p-2">{r.quantity ?? "-"}</td>
                <td className="p-2">{r.price ?? "-"}</td>
                <td className="p-2">{r.amount ?? "-"}</td>
                <td className="p-2">{r.fees ?? "-"}</td>
                <td className="p-2">{r.cash_impact ?? "-"}</td>
                <td className="p-2">{r.classification || "Unclassified"}</td>
                <td className="p-2">Plaid · audit retained</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="p-4 text-sm text-zinc-500">
            No investment transactions yet. Link an Investment connection or add an equity
            compensation event.
          </div>
        )}
      </div>
    </Card>
  );
}
