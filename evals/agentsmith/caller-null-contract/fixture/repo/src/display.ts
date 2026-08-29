import { loadProfile } from "./profile.js";

export function displayName(id: string): string {
  return loadProfile(id).name;
}
