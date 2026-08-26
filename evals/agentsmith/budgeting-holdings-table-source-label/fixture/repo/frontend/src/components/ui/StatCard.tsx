import React from "react";

export default function StatCard({
  label,
  value,
  hint,
  tone,
  extra,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="group relative rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-shadow hover:shadow">
      <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone || "text-zinc-900"}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-zinc-500">{hint}</div>}
      {extra}
    </div>
  );
}
