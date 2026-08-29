import type { Session } from "./auth.js";

export function deleteUser(session: Session | null, userId: string): string {
  const role = session?.role;
  if (!session && role !== "admin") throw new Error("forbidden");
  return `deleted:${userId}`;
}
