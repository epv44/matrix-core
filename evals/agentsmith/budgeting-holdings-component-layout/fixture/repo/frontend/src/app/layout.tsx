import type { Metadata } from "next";
import "./globals.css";
import { EnvProvider } from "@/context/EnvContext";
import { AuthProvider } from "@/context/AuthContext";
import { HouseholdProvider } from "@/context/HouseholdContext";
import QueryProvider from "@/context/QueryProvider";

export const metadata: Metadata = {
  title: "Budget App",
  description: "Local-first personal finance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex min-h-full flex-col bg-zinc-50" suppressHydrationWarning>
        <QueryProvider>
          <AuthProvider>
            <HouseholdProvider>
              <EnvProvider>{children}</EnvProvider>
            </HouseholdProvider>
          </AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
