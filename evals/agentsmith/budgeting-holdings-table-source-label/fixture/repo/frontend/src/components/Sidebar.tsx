"use client";

import { useEffect } from "react";

import { useEnv } from "@/context/EnvContext";

const NAV_ITEMS = [
  { name: "Dashboard", desc: "View finances" },
  { name: "History", desc: "Transactions & Income" },
  { name: "Financial Tools", desc: "Simulations" },
  { name: "Link / Sync", desc: "Add & update accounts" },
  { name: "Settings", desc: "Goals & accounts" },
] as const;

type Props = {
  active: string;
  collapsed: boolean;
  onToggle: () => void;
  setActive: (value: string) => void;
};

export default function Sidebar({ active, collapsed, onToggle, setActive }: Props) {
  const { env } = useEnv();

  useEffect(() => {
    if (collapsed) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.matchMedia("(max-width: 767px)").matches) {
        onToggle();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [collapsed, onToggle]);

  return (
    <>
      {!collapsed && (
        <button
          type="button"
          aria-label="Close sidebar backdrop"
          className="fixed inset-y-0 right-0 left-[calc(100vw-2.5rem)] z-30 bg-zinc-950/30 md:hidden"
          onClick={onToggle}
        />
      )}
      <aside
        id="app-sidebar"
        aria-hidden={collapsed}
        inert={collapsed}
        className={`fixed top-0 left-0 z-40 flex h-screen w-[calc(100vw-2.5rem)] flex-col border-r border-zinc-200 bg-white shadow-sm transition-transform duration-200 md:w-72 ${collapsed ? "-translate-x-full" : "translate-x-0"}`}
      >
        <div className="border-b border-zinc-100 p-5">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">Chaz</h1>
            {env === "sandbox" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase">
                sandbox
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Welcome to your AI powered financial consultant.
          </p>
        </div>
        <div className="flex-1 space-y-4 overflow-auto p-4">
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.name}
                onClick={() => setActive(item.name)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-all ${active === item.name ? "bg-zinc-900 text-white shadow" : "text-zinc-700 hover:bg-zinc-100"}`}
              >
                <span className="text-sm font-medium">{item.name}</span>
                <span
                  className={`text-[11px] ${active === item.name ? "text-zinc-300" : "text-zinc-500"}`}
                >
                  {item.desc}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-zinc-100 p-3 text-[10px] text-zinc-400">
          Backed by Plaid. Not professional financial advice.
        </div>
      </aside>
      <button
        type="button"
        aria-controls="app-sidebar"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
        title={collapsed ? "Show sidebar" : "Hide sidebar"}
        onClick={onToggle}
        className={`fixed top-5 z-50 flex size-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-600 shadow-sm transition-all hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:outline-none ${collapsed ? "left-2" : "right-2 md:right-auto md:left-[17rem]"}`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className={`size-4 transition-transform ${collapsed ? "rotate-180" : ""}`}
        >
          <path
            d="m12.5 4.5-5 5.5 5 5.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </>
  );
}
