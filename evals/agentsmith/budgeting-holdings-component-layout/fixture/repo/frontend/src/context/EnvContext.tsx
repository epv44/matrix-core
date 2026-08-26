"use client";
import React, { createContext, useContext, useSyncExternalStore } from "react";
import { Env } from "@/lib/api";
type Ctx = { env: Env };
const EnvContext = createContext<Ctx>({ env: "production" });
function getUrlEnv(): Env {
  if (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("sandbox") === "true"
  ) {
    return "sandbox";
  }
  return "production";
}
export function EnvProvider({ children }: { children: React.ReactNode }) {
  const env = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("popstate", onChange);
      return () => window.removeEventListener("popstate", onChange);
    },
    getUrlEnv,
    (): Env => "production",
  );
  return <EnvContext.Provider value={{ env }}>{children}</EnvContext.Provider>;
}
export const useEnv = () => useContext(EnvContext);
