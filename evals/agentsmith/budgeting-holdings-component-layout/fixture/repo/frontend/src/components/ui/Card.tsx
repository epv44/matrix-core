import React from "react";

export function Card({
  title,
  hint,
  children,
  className = "",
  padded = true,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`w-full min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm ${className}`}
    >
      {title && (
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-gradient-to-r from-zinc-50 to-white px-4 py-3">
          <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
          {hint && <span className="ml-auto text-[11px] text-zinc-400">{hint}</span>}
        </div>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </div>
  );
}

export default Card;
