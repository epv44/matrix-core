"use client";
import { useState, useEffect } from "react";
import { api, Env, TransactionDetail } from "@/lib/api";
import { money } from "@/lib/format";
import { Button, Select, TextInput } from "@/components/ui";

export default function TransactionDetailDialog({
  txnId,
  env,
  onClose,
  onTransactionChanged,
}: {
  txnId: string | null;
  env: Env;
  onClose: () => void;
  onTransactionChanged?: () => void;
}) {
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [newCat, setNewCat] = useState("");
  const [originalCat, setOriginalCat] = useState("");
  const [customCat, setCustomCat] = useState("");
  const [pattern, setPattern] = useState("");
  const [newType, setNewType] = useState("auto");
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    api
      .getCategories(env)
      .then((c) => setCategories(c.categories))
      .catch(() => {});
  }, [env]);
  useEffect(() => {
    if (!txnId) return;
    api
      .getTransaction(txnId, env)
      .then((d) => {
        setLoading(true);
        const category = d.transaction.category || "";
        setDetail(d);
        setNewCat(category);
        setOriginalCat(category);
        setNewType(d.transaction.type_override?.toLowerCase() || "auto");
        setPattern((d.transaction.merchant || d.transaction.raw_description || "").slice(0, 60));
      })
      .catch((e) => alert(e.message))
      .finally(() => setLoading(false));
  }, [txnId, env]);
  if (!txnId) return null;
  const finalCat = customCat.trim() || newCat;
  const initialType = detail?.transaction.type_override?.toLowerCase() || "auto";
  const categoryChanged = Boolean(finalCat) && finalCat !== originalCat;
  const typeChanged = newType !== initialType;
  const saveReclassification = async () => {
    if (!categoryChanged && !typeChanged) {
      alert("Make a category or transaction type change first");
      return;
    }
    await api.reclassify(txnId, env, {
      ...(categoryChanged ? { new_category: finalCat } : {}),
      ...(typeChanged ? { new_type: newType } : {}),
      pattern: pattern || undefined,
      remember,
    });
  };
  const handleSave = async () => {
    try {
      setSubmitting(true);
      await saveReclassification();
      onTransactionChanged?.();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };
  const handleHide = async () => {
    const confirmed = window.confirm(
      "Hide this transaction? It will disappear from transaction lists, totals, reports, and exports. It cannot be restored through the app.",
    );
    if (!confirmed) return;
    try {
      setSubmitting(true);
      await api.hideTransaction(txnId, env);
      onTransactionChanged?.();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-x-hidden overflow-y-auto rounded-2xl border border-zinc-200 bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-zinc-200 bg-white px-6 py-4 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Transaction Detail</h2>
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-3 py-1 text-sm hover:bg-zinc-50"
          >
            ✕
          </button>
        </div>
        <div className="min-w-0 p-6">
          {loading && <div className="text-sm text-zinc-500">Loading...</div>}
          {detail && (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Merchant
                  </div>
                  <div className="mt-1 min-w-0 font-semibold break-words">
                    {detail.transaction.merchant || detail.transaction.raw_description}
                  </div>
                  <div className="mt-3 space-y-1 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Amount</span>
                      <span className="font-mono font-medium break-words">
                        {money(detail.transaction.amount)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Date</span>
                      <span className="break-words">{detail.transaction.date}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Institution</span>
                      <span className="font-medium break-words">
                        {detail.transaction.institution || "unknown"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 bg-white p-4">
                  <div className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Account
                  </div>
                  <div className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Account ID</span>
                      <span className="min-w-0 font-mono text-xs break-words">
                        {detail.transaction.account_id.slice(0, 16)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Type</span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs break-words">
                        {detail.transaction.transaction_type}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Pending</span>
                      <span className="break-words">{String(detail.transaction.pending)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Processor</span>
                      <span className="min-w-0 break-words">
                        {detail.transaction.payment_processor || "-"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 bg-white p-4">
                  <div className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Categorization
                  </div>
                  <div className="mt-2 space-y-1 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Internal</span>
                      <span className="min-w-0 font-medium break-words">
                        {detail.transaction.category || "uncat"}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">PFC</span>
                      <span className="min-w-0 text-xs break-words">
                        {detail.transaction.pfc_primary || "-"} /{" "}
                        {detail.transaction.pfc_detailed || "-"}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Plaid cat</span>
                      <span className="min-w-0 text-xs break-words">
                        {detail.transaction.plaid_category || "-"}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="shrink-0 text-zinc-500">Currency</span>
                      <span className="break-words">{detail.transaction.currency}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-4 min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm break-words">
                <span className="text-zinc-500">Raw:</span> {detail.transaction.raw_description}
              </div>
              <div className="mt-6 min-w-0">
                <div className="text-sm font-semibold">Classification Trace</div>
                <div className="mt-1 text-[11px] text-zinc-500">Classification hierarchy</div>
                <ul className="mt-3 space-y-2">
                  {detail.trace.map((s) => (
                    <li
                      key={s.order}
                      className={`rounded-lg border px-3 py-2 text-[length:clamp(0.625rem,1.2vw,0.8rem)] ${s.matched ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"}`}
                    >
                      <div className="flex flex-wrap items-start gap-2">
                        <span className="whitespace-nowrap">
                          {s.matched ? "✅" : "—"} {s.order}. {s.source}
                        </span>
                        <span className="min-w-0 flex-1 text-xs break-words text-zinc-500">
                          {s.description}
                        </span>
                        <span className="ml-auto shrink-0 font-medium break-words">
                          {s.result || "(none)"}
                        </span>
                      </div>
                      {s.pattern && (
                        <div className="mt-1 text-xs break-words text-zinc-500">
                          pattern: {s.pattern} → {s.category}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              {detail.history.length > 0 && (
                <div className="mt-6 min-w-0">
                  <div className="text-sm font-semibold">Audit history</div>
                  <div className="mt-2 divide-y rounded-lg border border-zinc-200">
                    {detail.history.map((h) => (
                      <div
                        key={h.timestamp}
                        className="flex justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <span className="min-w-0 break-words">
                          {h.old_category} → {h.new_category}
                        </span>
                        <span className="shrink-0 text-zinc-500">{h.timestamp}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-6 border-t border-zinc-200 pt-6">
                <div className="text-sm font-semibold">Reclassify</div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Select value={newCat} onChange={(e) => setNewCat(e.target.value)}>
                    <option value="">Keep existing category</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                  <TextInput
                    value={customCat}
                    onChange={(e) => setCustomCat(e.target.value)}
                    placeholder="Or new e.g. Childcare"
                  />
                </div>
                <TextInput
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="Rule pattern (substring, case-insensitive) — defines similar transactions"
                  className="mt-3 w-full"
                />
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="rounded"
                  />{" "}
                  Apply a rule to matching past and future transactions
                </label>
                <div className="mt-4 border-t border-zinc-100 pt-4">
                  <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
                    Transaction Type
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm">
                    {["auto", "income", "transfer", "expense"].map((t) => (
                      <label key={t} className="flex items-center gap-2 capitalize">
                        <input
                          type="radio"
                          checked={newType === t}
                          onChange={() => setNewType(t)}
                          className="rounded"
                        />{" "}
                        {t === "auto" ? "Auto (classifier)" : t}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="mt-6 flex flex-wrap gap-2">
                  <Button onClick={handleSave} disabled={submitting}>
                    Save Reclassification
                  </Button>
                  <Button variant="secondary" onClick={onClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button variant="danger" onClick={handleHide} disabled={submitting}>
                    {submitting ? "Working…" : "Hide Transaction"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
