import React from "react";

export const TH_CLS =
  "border border-zinc-200 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide bg-zinc-100";
export const TD_CLS = "border border-zinc-200 px-3 py-1.5 text-zinc-800";
export const TD_MONEY_CLS =
  "border border-zinc-200 px-2 py-1.5 text-right tabular-nums min-w-[80px] text-zinc-700";
export const ROW_EVEN = "bg-white hover:bg-zinc-50";
export const ROW_ODD = "bg-zinc-50/50 hover:bg-zinc-100";

export function Th({
  children,
  className = "",
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={`${TH_CLS} ${className}`} {...props}>
      {children}
    </th>
  );
}

export function Td({
  children,
  className = "",
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`${TD_CLS} ${className}`} {...props}>
      {children}
    </td>
  );
}

export function TdMoney({
  children,
  className = "",
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`${TD_MONEY_CLS} ${className}`} {...props}>
      {children}
    </td>
  );
}
