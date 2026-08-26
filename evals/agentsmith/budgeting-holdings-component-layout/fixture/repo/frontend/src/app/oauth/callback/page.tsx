"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";

import { Button } from "@/components/ui";
import { Env, api, errorMessage } from "@/lib/api";

const OAUTH_STASH_KEY = "budget_plaid_link_stash";

type OAuthStash = {
  link_token: string;
  institution: string;
  relink_id: string | null;
  connection_type: "DEPOSITORY" | "INVESTMENT";
  history_date: string | null;
  env: Env;
};

type PlaidMetadata = {
  institution?: { institution_id?: string | null; name?: string | null } | null;
};

export default function OAuthCallbackPage() {
  const router = useRouter();
  const [stash, setStash] = useState<OAuthStash | null>(null);
  const [error, setError] = useState("");
  const completedRef = useRef(false);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = sessionStorage.getItem(OAUTH_STASH_KEY);
        if (!raw) throw new Error("No pending Plaid Link session found.");
        setStash(JSON.parse(raw) as OAuthStash);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    });
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 text-center shadow-xl">
          <p className="text-sm text-red-700">{error}</p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => router.push("/")}>Return to dashboard</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!stash) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        Resuming Plaid Link…
      </div>
    );
  }

  return (
    <PlaidResume
      token={stash.link_token}
      receivedRedirectUri={
        typeof window !== "undefined" ? window.location.href : undefined
      }
      onSuccess={async (publicToken) => {
        if (completedRef.current) return;
        completedRef.current = true;
        try {
          if (!publicToken) throw new Error("Plaid did not return a public token");
          await api.linkExchange(
            stash.env,
            publicToken,
            stash.institution,
            stash.relink_id || undefined,
            stash.connection_type,
            stash.history_date || undefined,
          );
          sessionStorage.removeItem(OAUTH_STASH_KEY);
          router.push("/");
        } catch (caught) {
          completedRef.current = false;
          setError(errorMessage(caught));
        }
      }}
      onExit={() => {
        sessionStorage.removeItem(OAUTH_STASH_KEY);
        router.push("/");
      }}
    />
  );
}

function PlaidResume({
  token,
  receivedRedirectUri,
  onSuccess,
  onExit,
}: {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string | null, metadata: PlaidMetadata) => Promise<void>;
  onExit: () => void;
}) {
  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri,
    onSuccess,
    onExit,
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  return null;
}
