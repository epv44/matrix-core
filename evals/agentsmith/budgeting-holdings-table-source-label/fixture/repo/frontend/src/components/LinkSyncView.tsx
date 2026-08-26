"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Script from "next/script";
import { usePlaidLink } from "react-plaid-link";

import { useEnv } from "@/context/EnvContext";
import {
  api,
  DoctorCheck,
  DryRunResponse,
  errorMessage,
  Institution,
  SyncHistoryEntry,
  SyncResult,
} from "@/lib/api";
import { Button, Card, ROW_EVEN, ROW_ODD, Td, TextInput, Th, TONE_TEXT } from "@/components/ui";
import { invalidateFinancialData } from "@/lib/queries";

type LinkModal = null | { mode: "history" | "no-webhook"; name: string; days: number };
type SingleBackfill = {
  name: string;
  connectionId: string | null;
  connectionType: "DEPOSITORY" | "INVESTMENT";
};
type BackfillStatus = "waiting" | "connecting" | "processing" | "complete" | "canceled" | "failed";
type BackfillJob = {
  name: string;
  connectionId: string | null;
  connectionType?: "DEPOSITORY" | "INVESTMENT";
  status: BackfillStatus;
  error?: string;
};
type PlaidLinkLauncherProps = {
  token: string | null;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string | null, metadata: PlaidSuccessMetadata) => Promise<void>;
  onExit: () => void;
};
type PlaidSuccessMetadata = {
  institution?: { institution_id?: string | null; name?: string | null } | null;
};

const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const SYNC_HISTORY_PAGE_SIZE = 20;
const OAUTH_STASH_KEY = "budget_plaid_link_stash";

export default function LinkSyncView() {
  const { env } = useEnv();
  const queryClient = useQueryClient();
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [history, setHistory] = useState<SyncHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [results, setResults] = useState<Record<string, SyncResult> | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [dryRunFor, setDryRunFor] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [newInst, setNewInst] = useState("");
  const [connectionType, setConnectionType] = useState<"DEPOSITORY" | "INVESTMENT">("DEPOSITORY");
  const [linking, setLinking] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [plaidScriptReady, setPlaidScriptReady] = useState(false);
  const [plaidScriptFailed, setPlaidScriptFailed] = useState(false);
  const [linkInstitution, setLinkInstitution] = useState("");
  const [relinkId, setRelinkId] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const [fixing, setFixing] = useState(false);
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [linkModal, setLinkModal] = useState<LinkModal>(null);
  const [backgroundMsg, setBackgroundMsg] = useState("");
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [backfillJobs, setBackfillJobs] = useState<BackfillJob[]>([]);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillRunDate, setBackfillRunDate] = useState("");

  const today = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const minDate = iso(new Date(today.getTime() - 730 * 86400000));
  const maxDate = iso(today);
  const defaultDate = iso(new Date(today.getTime() - 30 * 86400000));
  const [backfillDate, setBackfillDate] = useState(defaultDate);
  const [linkHistoryDate, setLinkHistoryDate] = useState(defaultDate);
  const [singleBackfill, setSingleBackfill] = useState<SingleBackfill | null>(null);
  const [singleBackfillDate, setSingleBackfillDate] = useState(defaultDate);
  const [singleBackfillRunning, setSingleBackfillRunning] = useState(false);

  const activeBackfillRef = useRef<string | null>(null);
  const activeBackfillTypeRef = useRef<"DEPOSITORY" | "INVESTMENT">("DEPOSITORY");
  const activeSingleBackfillRef = useRef(false);
  const plaidSucceededRef = useRef(false);

  const load = useCallback(async () => {
    const [inst, syncHistory] = await Promise.all([
      api.getInstitutions(env),
      api.getSyncHistory(env, SYNC_HISTORY_PAGE_SIZE, 0),
    ]);
    setInstitutions(inst.institutions || []);
    setHistory(syncHistory.history || []);
    setHistoryTotal(syncHistory.total);
    setHistoryPage(1);
    await invalidateFinancialData(queryClient, env);
  }, [env, queryClient]);

  const loadHistoryPage = useCallback(
    async (page: number) => {
      setHistoryLoading(true);
      setError("");
      try {
        const syncHistory = await api.getSyncHistory(
          env,
          SYNC_HISTORY_PAGE_SIZE,
          (page - 1) * SYNC_HISTORY_PAGE_SIZE,
        );
        setHistory(syncHistory.history || []);
        setHistoryTotal(syncHistory.total);
        setHistoryPage(page);
      } catch (caught: unknown) {
        setError(errorMessage(caught));
      } finally {
        setHistoryLoading(false);
      }
    },
    [env],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getInstitutions(env), api.getSyncHistory(env, SYNC_HISTORY_PAGE_SIZE, 0)])
      .then(([inst, syncHistory]) => {
        if (!cancelled) {
          setInstitutions(inst.institutions || []);
          setHistory(syncHistory.history || []);
          setHistoryTotal(syncHistory.total);
          setHistoryPage(1);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [env]);

  const historyPageCount = Math.max(1, Math.ceil(historyTotal / SYNC_HISTORY_PAGE_SIZE));

  useEffect(() => {
    api
      .getWebhookStatus(env)
      .then((status) => setWebhookEnabled(!!status.enabled))
      .catch(() => setWebhookEnabled(false));
  }, [env]);

  const updateBackfillJob = useCallback(
    (name: string, status: BackfillStatus, jobError?: string) => {
      setBackfillJobs((jobs) =>
        jobs.map((job) =>
          job.name === name ? { ...job, status, ...(jobError ? { error: jobError } : {}) } : job,
        ),
      );
    },
    [],
  );

  const stashLinkContext = useCallback(
    (
      token: string,
      name: string,
      relink: string | null | undefined,
      connType: "DEPOSITORY" | "INVESTMENT",
      historyDate: string | null | undefined,
    ) => {
      sessionStorage.setItem(
        OAUTH_STASH_KEY,
        JSON.stringify({
          link_token: token,
          institution: name,
          relink_id: relink || null,
          connection_type: connType,
          history_date: historyDate || null,
          env,
        }),
      );
    },
    [env],
  );

  const handlePlaidSuccess = async (publicToken: string | null, metadata: PlaidSuccessMetadata) => {
    plaidSucceededRef.current = true;
    const backfillName = activeBackfillRef.current;
    try {
      if (!publicToken) throw new Error("Plaid did not return a public token");
      const isBackfill = Boolean(backfillName);
      const exchange = await api.linkExchange(
        env,
        publicToken,
        linkInstitution,
        relinkId || undefined,
        isBackfill ? activeBackfillTypeRef.current : connectionType,
        isBackfill ? backfillRunDate : linkHistoryDate || undefined,
        metadata,
      );
      if (!exchange.initial_sync.ok) {
        throw new Error(exchange.initial_sync.error || "Initial sync failed");
      }
      if (backfillName) {
        const days = daysBetween(backfillRunDate, maxDate);
        updateBackfillJob(backfillName, days > 30 ? "processing" : "complete");
        if (days > 30) {
          setBackgroundMsg(
            "Connections updated. Plaid may continue delivering older transactions through the webhook.",
          );
        }
      } else if (daysBetween(linkHistoryDate, maxDate) > 30 && webhookEnabled) {
        setBackgroundMsg(`History for ${linkInstitution} is processing in the background.`);
      }
      await load();
    } catch (caught: unknown) {
      const message = errorMessage(caught);
      if (backfillName && activeSingleBackfillRef.current) setError(`Backfill failed: ${message}`);
      else if (backfillName) updateBackfillJob(backfillName, "failed", message);
      else setError(`Link failed: ${message}`);
    } finally {
      activeBackfillRef.current = null;
      setLinkToken(null);
      setRelinkId(null);
      setLinking(false);
      sessionStorage.removeItem(OAUTH_STASH_KEY);
      if (activeSingleBackfillRef.current) {
        activeSingleBackfillRef.current = false;
        setSingleBackfillRunning(false);
      }
    }
  };

  const handlePlaidExit = () => {
    const backfillName = activeBackfillRef.current;
    if (backfillName && !plaidSucceededRef.current) {
      if (activeSingleBackfillRef.current)
        setError("Backfill canceled: Plaid connection was canceled");
      else updateBackfillJob(backfillName, "canceled", "Plaid connection was canceled");
    }
    activeBackfillRef.current = null;
    activeSingleBackfillRef.current = false;
    setLinking(false);
    setSingleBackfillRunning(false);
    setLinkToken(null);
    setRelinkId(null);
    sessionStorage.removeItem(OAUTH_STASH_KEY);
  };

  const handlePlaidScriptError = () => {
    const message = "Plaid Link failed to load. Check your network connection and try again.";
    const backfillName = activeBackfillRef.current;
    if (backfillName && activeSingleBackfillRef.current) setError(`Backfill failed: ${message}`);
    else if (backfillName) updateBackfillJob(backfillName, "failed", message);
    else setError(message);
    activeBackfillRef.current = null;
    activeSingleBackfillRef.current = false;
    setPlaidScriptReady(false);
    setPlaidScriptFailed(true);
    setLinking(false);
    setSingleBackfillRunning(false);
    setLinkToken(null);
    setRelinkId(null);
  };

  useEffect(() => {
    if (!backfillRunning || linking || linkToken) return;
    const next = backfillJobs.find((job) => job.status === "waiting");
    if (!next) {
      queueMicrotask(() => setBackfillRunning(false));
      return;
    }

    queueMicrotask(() => {
      setLinking(true);
      plaidSucceededRef.current = false;
      activeBackfillRef.current = next.name;
      activeBackfillTypeRef.current = next.connectionType || "DEPOSITORY";
      activeSingleBackfillRef.current = false;
      updateBackfillJob(next.name, "connecting");
      if (!next.connectionId) {
        updateBackfillJob(next.name, "failed", "Connection identifier is missing");
        activeBackfillRef.current = null;
        setLinking(false);
        return;
      }
      api
        .relink(env, next.connectionId, backfillRunDate)
        .then(({ direct, initial_sync, link_token, relink_id }) => {
          if (direct) {
            if (!initial_sync?.ok)
              throw new Error(initial_sync?.error || "Investment backfill failed");
            updateBackfillJob(next.name, "complete");
            activeBackfillRef.current = null;
            setLinking(false);
            void load();
            return;
          }
          if (!link_token || !relink_id) throw new Error("Backfill authorization was not created");
          setLinkInstitution(next.name);
          setRelinkId(relink_id);
          setLinkToken(link_token);
          stashLinkContext(
            link_token,
            next.name,
            relink_id,
            next.connectionType || "DEPOSITORY",
            backfillRunDate,
          );
        })
        .catch((caught: unknown) => {
          updateBackfillJob(next.name, "failed", errorMessage(caught));
          activeBackfillRef.current = null;
          setLinking(false);
        });
    });
  }, [
    backfillJobs,
    backfillRunDate,
    backfillRunning,
    env,
    linkToken,
    linking,
    load,
    stashLinkContext,
    updateBackfillJob,
  ]);

  const loadDoctor = async () => {
    setError("");
    try {
      const response = await api.getDoctor(env);
      setDoctor(response.checks || []);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    }
  };

  useEffect(() => {
    let cancelled = false;
    api
      .getDoctor(env)
      .then((response) => {
        if (!cancelled) setDoctor(response.checks || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [env]);

  const runFix = async () => {
    setFixing(true);
    setError("");
    try {
      const response = await api.doctorFix(env);
      const keys = Object.keys(response.rekeyed || {});
      if (keys.length) alert(`Re-keyed: ${keys.join(", ")}`);
      await loadDoctor();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setFixing(false);
    }
  };

  const doLink = async (name: string) => {
    if (!plaidScriptReady) {
      setError(
        plaidScriptFailed
          ? "Plaid Link failed to load. Reload the page and try again."
          : "Plaid Link is still loading. Try again in a moment.",
      );
      return;
    }
    setLinking(true);
    setError("");
    activeBackfillRef.current = null;
    activeSingleBackfillRef.current = false;
    plaidSucceededRef.current = false;
    try {
      const { link_token } = await api.linkToken(
        env,
        name,
        linkHistoryDate || undefined,
        connectionType,
      );
      setLinkInstitution(name);
      setLinkToken(link_token);
      stashLinkContext(link_token, name, relinkId, connectionType, linkHistoryDate);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
      setLinking(false);
    }
  };

  const handleLink = () => {
    const name = newInst.trim().toLowerCase();
    if (!name) return;
    const days = daysBetween(linkHistoryDate, maxDate);
    if (days > 30) setLinkModal({ mode: webhookEnabled ? "history" : "no-webhook", name, days });
    else void doLink(name);
  };

  const syncAll = async () => {
    setSyncing(true);
    setError("");
    setBackgroundMsg("");
    try {
      const response = await api.syncAll(env, { force: true });
      setResults(response.results);
      if (response.status === "in_flight") setBackgroundMsg("A sync is already running.");
      else if (response.status === "cooldown")
        setBackgroundMsg("A sync just finished — try again in a moment.");
      else if (response.status === "fresh") setBackgroundMsg("Accounts are already up to date.");
      await load();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setSyncing(false);
    }
  };

  const syncInstitution = async (institution: Institution) => {
    setError("");
    setBackgroundMsg("");
    try {
      const response = await api.syncAll(env, {
        force: true,
        connection_id: institution.connection_id || undefined,
        institution: institution.connection_id ? undefined : institution.name,
      });
      setResults(response.results);
      if (response.status === "in_flight") setBackgroundMsg("A sync is already running.");
      else if (response.status === "cooldown")
        setBackgroundMsg("A sync just finished — try again in a moment.");
      await load();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    }
  };

  const runPreview = async (name: string) => {
    setError("");
    setDryRun(null);
    setDryRunFor(null);
    try {
      setDryRun(await api.dryRun(env, name));
      setDryRunFor(name);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    }
  };

  const openSingleBackfill = (institution: Institution) => {
    setError("");
    setSingleBackfill({
      name: institution.name,
      connectionId: institution.connection_id || null,
      connectionType: institution.connection_type || "DEPOSITORY",
    });
    setSingleBackfillDate(defaultDate);
  };

  const startSingleBackfill = async () => {
    if (!singleBackfill || !singleBackfillDate) return;
    const target = singleBackfill;
    setSingleBackfill(null);
    setError("");
    setBackgroundMsg("");
    if (env === "sandbox") {
      setSingleBackfillRunning(true);
      try {
        const response = await api.syncAll(env, {
          connection_id: target.connectionId || undefined,
          institution: target.connectionId ? undefined : target.name,
          since: singleBackfillDate,
          backfill: true,
        });
        setResults(response.results);
        await load();
      } catch (caught: unknown) {
        setError(errorMessage(caught));
      } finally {
        setSingleBackfillRunning(false);
      }
      return;
    }
    if (
      target.connectionType === "DEPOSITORY" &&
      daysBetween(singleBackfillDate, maxDate) > 30 &&
      !webhookEnabled
    ) {
      setError(
        "Backfills beyond 30 days require a working webhook. Start the webhook tunnel and try again.",
      );
      return;
    }
    setSingleBackfillRunning(true);
    setLinking(true);
    plaidSucceededRef.current = false;
    activeBackfillRef.current = target.name;
    activeBackfillTypeRef.current = target.connectionType;
    activeSingleBackfillRef.current = true;
    setBackfillRunDate(singleBackfillDate);
    try {
      if (!target.connectionId) throw new Error("Connection identifier is missing");
      const response = await api.relink(env, target.connectionId, singleBackfillDate);
      if (response.direct) {
        if (!response.initial_sync?.ok) {
          throw new Error(response.initial_sync?.error || "Backfill failed");
        }
        setBackgroundMsg(`${target.name} backfill complete.`);
        activeBackfillRef.current = null;
        activeSingleBackfillRef.current = false;
        setLinking(false);
        setSingleBackfillRunning(false);
        await load();
        return;
      }
      if (!response.link_token || !response.relink_id) {
        throw new Error("Backfill authorization was not created");
      }
      setLinkInstitution(target.name);
      setRelinkId(response.relink_id);
      setLinkToken(response.link_token);
      stashLinkContext(
        response.link_token,
        target.name,
        response.relink_id,
        target.connectionType,
        singleBackfillDate,
      );
    } catch (caught: unknown) {
      activeBackfillRef.current = null;
      activeSingleBackfillRef.current = false;
      setLinking(false);
      setSingleBackfillRunning(false);
      setError(errorMessage(caught));
    }
  };

  const requestBackfill = async () => {
    if (!backfillDate || institutions.length === 0) return;
    setError("");
    setBackgroundMsg("");
    if (env === "sandbox") {
      setSyncing(true);
      try {
        const response = await api.syncAll(env, { since: backfillDate, backfill: true });
        setResults(response.results);
        await load();
      } catch (caught: unknown) {
        setError(errorMessage(caught));
      } finally {
        setSyncing(false);
      }
      return;
    }
    if (daysBetween(backfillDate, maxDate) > 30 && !webhookEnabled) {
      setError(
        "Backfills beyond 30 days require a working webhook. Start the webhook tunnel and try again.",
      );
      return;
    }
    setConfirmBackfill(true);
  };

  const startBackfill = () => {
    setConfirmBackfill(false);
    setBackfillRunDate(backfillDate);
    setBackfillJobs(
      institutions.map(({ name, connection_id, connection_type }) => ({
        name,
        connectionId: connection_id || null,
        connectionType: connection_type,
        status: "waiting",
      })),
    );
    setBackfillRunning(true);
  };

  const retryBackfill = () => {
    setBackfillJobs((jobs) =>
      jobs.map((job) =>
        job.status === "failed" || job.status === "canceled"
          ? { ...job, status: "waiting", error: undefined }
          : job,
      ),
    );
    setBackfillRunning(true);
  };

  const lastSyncLabel = (timestamp: string | null) =>
    timestamp ? timestamp.slice(0, 16).replace("T", " ") : "never";
  const resultLine = (result: SyncResult) =>
    result.ok
      ? `${result.added} added, ${result.modified} modified, ${result.removed} removed`
      : `FAILED - ${result.error}`;
  const incomplete = backfillJobs.some(
    (job) => job.status === "failed" || job.status === "canceled",
  );
  const activeIndex = backfillJobs.findIndex((job) => job.status === "connecting");

  return (
    <div className="w-full max-w-full min-w-0 space-y-4 overflow-x-clip">
      <Script
        id="plaid-link-sdk"
        src={PLAID_LINK_SCRIPT}
        strategy="afterInteractive"
        onReady={() => {
          setPlaidScriptReady(true);
          setPlaidScriptFailed(false);
        }}
        onError={handlePlaidScriptError}
      />
      {plaidScriptReady && (
        <PlaidLinkLauncher
          token={linkToken}
          onSuccess={handlePlaidSuccess}
          onExit={handlePlaidExit}
        />
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {backgroundMsg && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          {backgroundMsg}
        </div>
      )}

      <Card title="Link Institution">
        <p className="mb-3 text-xs text-zinc-500">
          Plaid may ask to verify a phone number. The person linking the account should enter their
          own number; Budget App does not store it.
        </p>
        <div className="mt-1 flex gap-2">
          <TextInput
            value={newInst}
            onChange={(event) => setNewInst(event.target.value)}
            placeholder="usaa, chase, bilt"
            className="flex-1"
          />
          <Button onClick={handleLink} disabled={linking || !plaidScriptReady || !newInst.trim()}>
            {linking ? "Linking..." : "Link"}
          </Button>
        </div>
        <div className="mt-3 flex gap-2" role="group" aria-label="Connection type">
          {(["DEPOSITORY", "INVESTMENT"] as const).map((type) => (
            <Button
              key={type}
              variant={connectionType === type ? "primary" : "secondary"}
              onClick={() => setConnectionType(type)}
            >
              {type === "DEPOSITORY" ? "Depository" : "Investment"}
            </Button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Get history back to:</span>
          <input
            aria-label="New institution history start date"
            type="date"
            value={linkHistoryDate}
            onChange={(event) => setLinkHistoryDate(event.target.value)}
            min={minDate}
            max={maxDate}
            className="rounded-lg border border-zinc-200 px-2 py-1 text-sm"
          />
          <span>(max 24 months)</span>
        </div>
      </Card>

      <Card title="Sync" hint="Pull recent transactions for all linked accounts">
        <Button onClick={syncAll} disabled={syncing || backfillRunning}>
          {syncing ? "Syncing..." : "Sync Now"}
        </Button>
        {results && (
          <div className="mt-3 space-y-1 text-sm">
            {Object.entries(results).map(([name, result]) => (
              <div key={name} className={result.ok ? TONE_TEXT.positive : TONE_TEXT.negative}>
                {name}: {resultLine(result)}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Backfill Data"
        hint="Retrieve transactions for every linked account back to the selected date"
      >
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <label htmlFor="backfill-date" className="text-sm text-zinc-600">
            Start date:
          </label>
          <input
            id="backfill-date"
            type="date"
            value={backfillDate}
            onChange={(event) => setBackfillDate(event.target.value)}
            min={minDate}
            max={maxDate}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
          />
          <Button
            onClick={() => void requestBackfill()}
            disabled={syncing || backfillRunning || institutions.length === 0}
          >
            {backfillRunning ? "Backfill in progress..." : "Backfill All Accounts"}
          </Button>
        </div>
        {backfillJobs.length > 0 && (
          <div
            className="mt-3 rounded-lg border border-zinc-200 p-3"
            aria-label="Backfill progress"
          >
            {backfillRunning && activeIndex >= 0 && (
              <div className="mb-2 text-sm font-medium">
                Connecting {activeIndex + 1} of {backfillJobs.length}:{" "}
                {backfillJobs[activeIndex].name}
              </div>
            )}
            <div className="space-y-1 text-sm">
              {backfillJobs.map((job) => (
                <div key={job.name} className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{job.name}</span>
                  <span
                    className={
                      job.status === "failed" || job.status === "canceled"
                        ? TONE_TEXT.negative
                        : job.status === "complete"
                          ? TONE_TEXT.positive
                          : "text-zinc-600"
                    }
                  >
                    {statusLabel(job)}
                  </span>
                </div>
              ))}
            </div>
            {!backfillRunning && incomplete && (
              <Button className="mt-3" variant="secondary" onClick={retryBackfill}>
                Retry Incomplete
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card title="Institutions">
        {institutions.length === 0 && (
          <div className="mt-1 text-xs text-zinc-500">
            No institutions linked. Use the Link Institution box above.
          </div>
        )}
        {institutions.map((institution) => (
          <div
            key={institution.name}
            className="mt-2 rounded-lg border border-zinc-200 p-2 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{institution.name}</span>
              <span className="text-xs text-zinc-500">
                {institution.connection_type === "INVESTMENT"
                  ? "last investment sync"
                  : "last synced"}{" "}
                {lastSyncLabel(
                  institution.connection_type === "INVESTMENT"
                    ? institution.last_investment_sync || null
                    : institution.last_successful_sync,
                )}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                onClick={() => void syncInstitution(institution)}
                disabled={singleBackfillRunning || backfillRunning}
              >
                Sync
              </Button>
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                onClick={() => void runPreview(institution.name)}
                disabled={singleBackfillRunning || backfillRunning}
              >
                Preview
              </Button>
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                onClick={() => openSingleBackfill(institution)}
                disabled={singleBackfillRunning || backfillRunning}
              >
                Backfill
              </Button>
            </div>
            {results?.[institution.name] && (
              <div
                className={`mt-1 text-xs ${results[institution.name].ok ? TONE_TEXT.positive : TONE_TEXT.negative}`}
              >
                {resultLine(results[institution.name])}
              </div>
            )}
            {dryRunFor === institution.name && dryRun && (
              <div className="mt-1 text-xs text-zinc-500">
                Preview — would pull {dryRun.total} transactions without changing data:{" "}
                {JSON.stringify(dryRun.months)}
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title="Sync History" hint="Recorded synchronization results" padded={false}>
        <div className="overflow-auto">
          <table className="w-full min-w-[760px] border-collapse text-[12px]">
            <thead>
              <tr>
                {["ID", "Inst", "Status", "+/-/rm", "Since", "Backfill", "Started", "Error"].map(
                  (heading) => (
                    <Th key={heading}>{heading}</Th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {history.map((entry, index) => (
                <tr key={entry.id} className={index % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                  <Td>{entry.id}</Td>
                  <Td>{entry.institution}</Td>
                  <Td className={entry.status === "ok" ? TONE_TEXT.positive : TONE_TEXT.negative}>
                    {entry.status}
                  </Td>
                  <Td>
                    {entry.added}/{entry.modified}/{entry.removed}
                  </Td>
                  <Td>{entry.since || ""}</Td>
                  <Td>{entry.backfill ? "yes" : ""}</Td>
                  <Td>{entry.started_at}</Td>
                  <Td className={TONE_TEXT.negative}>{entry.error || ""}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {historyTotal > 0 && (
          <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-3 py-2">
            <Button
              variant="secondary"
              onClick={() => void loadHistoryPage(historyPage - 1)}
              disabled={historyPage === 1 || historyLoading}
            >
              Previous
            </Button>
            <span className="text-xs text-zinc-600">
              Page {historyPage} of {historyPageCount}
            </span>
            <Button
              variant="secondary"
              onClick={() => void loadHistoryPage(historyPage + 1)}
              disabled={historyPage === historyPageCount || historyLoading}
            >
              Next
            </Button>
          </div>
        )}
      </Card>

      <Card title="Diagnostics (Doctor)">
        <div className="mt-1 flex gap-2">
          <Button variant="secondary" onClick={() => void loadDoctor()}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={() => void runFix()} disabled={fixing}>
            {fixing ? "Fixing..." : "Fix Keychain"}
          </Button>
        </div>
        <div className="mt-2 space-y-1">
          {doctor?.map((check) => (
            <div key={check.name} className="text-sm">
              <span
                className={`${check.status ? TONE_TEXT.positive : TONE_TEXT.negative} font-medium`}
              >
                [{check.status ? "PASS" : "FAIL"}]
              </span>{" "}
              {check.name}: {check.detail}
            </div>
          ))}
        </div>
      </Card>

      {confirmBackfill && (
        <Modal
          title={`Backfill all accounts to ${backfillDate}?`}
          onCancel={() => setConfirmBackfill(false)}
          onContinue={startBackfill}
        >
          Depository connections will be re-authorized one at a time. Investment connections will be
          synced in place using their existing Plaid Item; their investment history, snapshots, and
          audit records are preserved. No investment connection is removed or replaced.
        </Modal>
      )}

      {singleBackfill && (
        <Modal
          title={`Backfill ${singleBackfill.name}?`}
          onCancel={() => setSingleBackfill(null)}
          onContinue={() => void startSingleBackfill()}
          continueDisabled={!singleBackfillDate || singleBackfillRunning}
        >
          <div className="space-y-2">
            <label htmlFor="single-backfill-date" className="block text-sm text-zinc-600">
              Backfill start date:
            </label>
            <input
              id="single-backfill-date"
              aria-label="Single backfill start date"
              type="date"
              value={singleBackfillDate}
              onChange={(event) => setSingleBackfillDate(event.target.value)}
              min={minDate}
              max={maxDate}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
            />
            <p>
              {singleBackfill.connectionType === "INVESTMENT"
                ? "Investment data will be synced using the existing Plaid connection; investment history is preserved."
                : "Depository history older than 30 days requires the configured webhook and may require Plaid reauthorization."}
            </p>
          </div>
        </Modal>
      )}

      {linkModal && (
        <Modal
          title={
            linkModal.mode === "history"
              ? `Request ~${linkModal.days} days of history?`
              : "30-day history limit"
          }
          onCancel={() => setLinkModal(null)}
          onContinue={() => {
            const current = linkModal;
            setLinkModal(null);
            void doLink(current.name);
          }}
        >
          {linkModal.mode === "history"
            ? "Plaid may deliver older transactions in the background after the institution is linked."
            : "Webhooks are not enabled, so only the most recent 30 days can be requested."}
        </Modal>
      )}
    </div>
  );
}

function PlaidLinkLauncher({
  token,
  receivedRedirectUri,
  onSuccess,
  onExit,
}: PlaidLinkLauncherProps) {
  const { open, ready } = usePlaidLink({ token, receivedRedirectUri, onSuccess, onExit });

  useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  return null;
}

function daysBetween(start: string, end: string): number {
  return Math.max(1, Math.ceil((Date.parse(end) - Date.parse(start)) / 86400000));
}

function statusLabel(job: BackfillJob): string {
  if (job.status === "waiting") return "Waiting";
  if (job.status === "connecting") return "Waiting for Plaid";
  if (job.status === "processing") return "Authorized — history processing";
  if (job.status === "complete") return "Complete";
  if (job.status === "canceled") return "Canceled — retry available";
  return `Failed — ${job.error || "retry available"}`;
}

function Modal({
  title,
  children,
  onCancel,
  onContinue,
  continueDisabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onContinue: () => void;
  continueDisabled?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="text-base font-semibold">{title}</div>
        <div className="mt-2 text-sm text-zinc-600">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onContinue} disabled={continueDisabled}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
