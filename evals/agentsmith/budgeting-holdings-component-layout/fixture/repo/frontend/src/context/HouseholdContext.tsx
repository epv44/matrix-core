"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { api, AuthUser } from "@/lib/api";

type HouseholdContextValue = {
  members: AuthUser[];
  ownerUserId: string | null;
  setOwnerUserId: (userId: string | null) => void;
};
const HouseholdContext = createContext<HouseholdContextValue | null>(null);

export function HouseholdProvider({ children }: { children: React.ReactNode }) {
  const [members, setMembers] = useState<AuthUser[]>([]);
  const [ownerUserId, updateOwnerUserId] = useState<string | null>(null);
  useEffect(() => {
    api
      .getMembers()
      .then((result) => setMembers(result.members))
      .catch(() => setMembers([]));
  }, []);
  const setOwnerUserId = (userId: string | null) => updateOwnerUserId(userId);
  return (
    <HouseholdContext.Provider value={{ members, ownerUserId, setOwnerUserId }}>
      {children}
    </HouseholdContext.Provider>
  );
}

export function useHousehold(): HouseholdContextValue {
  const value = useContext(HouseholdContext);
  if (!value) throw new Error("useHousehold must be used inside HouseholdProvider");
  return value;
}
