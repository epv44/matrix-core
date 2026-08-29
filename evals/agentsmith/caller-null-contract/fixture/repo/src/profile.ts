export interface Profile {
  name: string;
}

export function loadProfile(id: string): Profile | null {
  return id === "known" ? { name: "Ada" } : null;
}
