"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ListedTransaction } from "@/lib/api";
import { useEnv } from "@/context/EnvContext";
import { useHousehold } from "@/context/HouseholdContext";
import { queryKeys } from "@/lib/queries";
import { money } from "@/lib/format";
import {
  Card,
  Button,
  Select,
  TextInput,
  Th,
  Td,
  TdMoney,
  ROW_EVEN,
  ROW_ODD,
} from "@/components/ui";

type Filters = {
  uncategorized_only: boolean;
  search: string;
  category: string;
  transaction_type: string;
  institution: string;
  account_id: string;
  pending_only: boolean;
  from_date: string;
  to_date: string;
  limit: number;
};

const DEFAULT_FILTERS: Filters = {
  uncategorized_only: false,
  search: "",
  category: "",
  transaction_type: "",
  institution: "",
  account_id: "",
  pending_only: false,
  from_date: "",
  to_date: "",
  limit: 200,
};

function buildParams(f: Filters, offset: number): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = { limit: f.limit, offset };
  if (f.uncategorized_only) params.uncategorized_only = true;
  if (f.category) params.category = f.category;
  if (f.transaction_type) params.transaction_type = f.transaction_type;
  if (f.institution) params.institution = f.institution;
  if (f.account_id) params.account_id = f.account_id;
  if (f.search) params.search = f.search;
  if (f.from_date) params.from_date = f.from_date;
  if (f.to_date) params.to_date = f.to_date;
  if (f.pending_only) params.pending_only = true;
  return params;
}

export default function TransactionBrowser({ onSelectTxn }: { onSelectTxn: (id: string) => void }) {
  const { env } = useEnv();
  const { ownerUserId } = useHousehold();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const categoriesQuery = useQuery({
    queryKey: queryKeys.categories(env),
    queryFn: () => api.getCategories(env),
  });
  const params = buildParams(appliedFilters, page * appliedFilters.limit);
  const transactionsQuery = useQuery({
    queryKey: queryKeys.transactions(env, ownerUserId, params),
    queryFn: () => api.listTransactions(env, params, ownerUserId),
    placeholderData: (previous) => previous,
  });
  const categories = categoriesQuery.data?.categories || [];
  const txns: ListedTransaction[] = transactionsQuery.data?.transactions || [];
  const total = transactionsQuery.data?.count || 0;
  const hasMore = transactionsQuery.data?.has_more || false;

  const setFilter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const pageCount = Math.max(1, Math.ceil(total / appliedFilters.limit));

  return (
    <Card title="Transaction Browser">
      <div className="grid grid-cols-4 gap-2 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={filters.uncategorized_only}
            onChange={(e) => setFilter({ uncategorized_only: e.target.checked })}
          />{" "}
          Uncategorized Only
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={filters.pending_only}
            onChange={(e) => setFilter({ pending_only: e.target.checked })}
          />{" "}
          Pending only
        </label>
        <TextInput
          placeholder="Search merchant/desc"
          value={filters.search}
          onChange={(e) => setFilter({ search: e.target.value })}
        />
        <TextInput
          placeholder="From YYYY-MM-DD"
          value={filters.from_date}
          onChange={(e) => setFilter({ from_date: e.target.value })}
        />
        <TextInput
          placeholder="To YYYY-MM-DD"
          value={filters.to_date}
          onChange={(e) => setFilter({ to_date: e.target.value })}
        />
        <Select value={filters.category} onChange={(e) => setFilter({ category: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select
          value={filters.transaction_type}
          onChange={(e) => setFilter({ transaction_type: e.target.value })}
        >
          <option value="">All types</option>
          <option value="transfer">Transfer</option>
          <option value="income">Income</option>
          <option value="expense">Expense</option>
        </Select>
        <TextInput
          placeholder="Institution"
          value={filters.institution}
          onChange={(e) => setFilter({ institution: e.target.value })}
        />
        <TextInput
          placeholder="Account ID"
          value={filters.account_id}
          onChange={(e) => setFilter({ account_id: e.target.value })}
        />
      </div>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => {
          setPage(0);
          setAppliedFilters(filters);
        }}
      >
        Apply Filters
      </Button>
      {transactionsQuery.isFetching && (
        <div className="mt-2 text-xs text-zinc-500">Refreshing…</div>
      )}
      <div className="mt-4 text-sm text-zinc-600">Found {total}</div>
      <div className="mt-2 max-h-[60vh] overflow-auto">
        <table className="w-full min-w-[900px] border-collapse text-[12px]">
          <thead>
            <tr>
              {[
                "Date",
                "Description",
                "Merchant",
                "Amount",
                "Account",
                "Inst",
                "Category",
                "Action",
              ].map((h) => (
                <Th key={h} className={h === "Amount" ? "text-right" : "text-left"}>
                  {h}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {txns.map((t, i) => (
              <tr key={t.plaid_transaction_id} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                <Td>{t.date}</Td>
                <Td className="max-w-[200px] truncate">{t.raw_description}</Td>
                <Td>
                  <button
                    onClick={() => onSelectTxn(t.plaid_transaction_id)}
                    className="rounded text-left underline hover:bg-yellow-100"
                  >
                    {t.merchant}
                  </button>
                </Td>
                <TdMoney>{money(t.amount)}</TdMoney>
                <Td>{t.account_id.slice(0, 12)}</Td>
                <Td>{t.institution || "-"}</Td>
                <Td>{t.category || "(uncat)"}</Td>
                <Td>
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5 text-xs"
                    onClick={() => onSelectTxn(t.plaid_transaction_id)}
                  >
                    Detail
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > appliedFilters.limit && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          <Button variant="secondary" onClick={() => setPage(page - 1)} disabled={page === 0}>
            Prev
          </Button>
          <span className="text-zinc-600">
            Page {page + 1} of {pageCount} · {total} total
          </span>
          <Button variant="secondary" onClick={() => setPage(page + 1)} disabled={!hasMore}>
            Next
          </Button>
        </div>
      )}
    </Card>
  );
}
