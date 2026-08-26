"use client";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  AuthUser,
  errorMessage,
  FinancialGoal,
  HouseholdAccount,
  HouseholdConnection,
  InvestmentAccountSetting,
  InvestmentAccountCategory,
  InvestmentDashboard,
} from "@/lib/api";
import { SETTING_KEYS } from "@/lib/api";
import { useEnv } from "@/context/EnvContext";
import { money } from "@/lib/format";
import {
  Card,
  Button,
  Select,
  Tabs,
  TextInput,
  Th,
  Td,
  TONE_TEXT,
  tabId,
  tabPanelId,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useHousehold } from "@/context/HouseholdContext";
import { GoalScope } from "@/lib/api";
import { invalidateFinancialData } from "@/lib/queries";

const SETTINGS_TABS = [
  { value: "goals", label: "Goals" },
  { value: "accounts", label: "Account Settings" },
] as const;

export default function SettingsView() {
  const { env } = useEnv();
  const { user } = useAuth();
  const { ownerUserId } = useHousehold();
  const goalsScope: GoalScope = ownerUserId ? "PERSONAL" : "HOUSEHOLD";
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"goals" | "accounts">("goals");
  const [members, setMembers] = useState<AuthUser[]>([]);
  const [householdAccounts, setHouseholdAccounts] = useState<HouseholdAccount[]>([]);
  const [connections, setConnections] = useState<HouseholdConnection[]>([]);
  const [invitationEmail, setInvitationEmail] = useState("");
  const [invitationLink, setInvitationLink] = useState("");
  const [invitationWorking, setInvitationWorking] = useState(false);
  const [householdError, setHouseholdError] = useState("");
  const [unlinkTarget, setUnlinkTarget] = useState<{
    connection: HouseholdConnection;
    displayName: string;
  } | null>(null);
  const [unlinkConfirmation, setUnlinkConfirmation] = useState("");
  const [unlinking, setUnlinking] = useState(false);
  const [institutionError, setInstitutionError] = useState("");
  const [cats, setCats] = useState<string[]>([]);
  const [newCat, setNewCat] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetSaved, setBudgetSaved] = useState(false);
  const [target, setTarget] = useState({
    us_stock: "60",
    international_stock: "10",
    bond_market: "30",
  });
  const [targetSaved, setTargetSaved] = useState(false);
  const [targetError, setTargetError] = useState("");
  const [investmentAccounts, setInvestmentAccounts] = useState<InvestmentAccountSetting[]>([]);
  const [earmarkAccount, setEarmarkAccount] = useState("");
  const [earmarkName, setEarmarkName] = useState("");
  const [earmarkAmount, setEarmarkAmount] = useState("");
  const [investmentError, setInvestmentError] = useState("");
  const [financialGoals, setFinancialGoals] = useState<FinancialGoal[]>([]);
  const [goalAssets, setGoalAssets] = useState<InvestmentDashboard | null>(null);
  const [goalName, setGoalName] = useState("");
  const [goalType, setGoalType] = useState("OTHER");
  const [goalTarget, setGoalTarget] = useState("");
  const [allocationGoal, setAllocationGoal] = useState("");
  const [allocationSource, setAllocationSource] = useState("");
  const [allocationAmount, setAllocationAmount] = useState("");
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [capSaved, setCapSaved] = useState<Record<string, boolean>>({});
  const [capError, setCapError] = useState<Record<string, string>>({});
  const [capFocused, setCapFocused] = useState<Record<string, boolean>>({});
  const invitationsQuery = useQuery({
    queryKey: ["household-invitations"],
    queryFn: api.getInvitations,
    enabled: user.role === "ADMIN",
  });
  const load = async () => {
    const c = await api.getCategories(env);
    setCats(c.categories);
    const st = await api.getSettings(env);
    setBudget(st.settings[SETTING_KEYS.MONTHLY_BUDGET] || "");
    const it = await api.getInvestmentTarget(env);
    setTarget({
      us_stock: String(it.us_stock),
      international_stock: String(it.international_stock),
      bond_market: String(it.bond_market),
    });
    const cc = await api.getCategoryCaps(env);
    setCaps(cc.caps);
    await invalidateFinancialData(queryClient, env);
  };
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getCategories(env),
      api.getSettings(env),
      api.getCategoryCaps(env),
      api.getInvestmentTarget(env),
    ])
      .then(([c, st, cc, it]) => {
        if (cancelled) return;
        setCats(c.categories);
        setBudget(st.settings[SETTING_KEYS.MONTHLY_BUDGET] || "");
        setCaps(cc.caps);
        setTarget({
          us_stock: String(it.us_stock),
          international_stock: String(it.international_stock),
          bond_market: String(it.bond_market),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [env]);
  const loadHousehold = async () => {
    const result = await api.getHouseholdAccounts(env);
    setMembers(result.members);
    setHouseholdAccounts(result.accounts);
    setConnections(result.connections);
    await invalidateFinancialData(queryClient, env);
  };
  useEffect(() => {
    let cancelled = false;
    api
      .getHouseholdAccounts(env)
      .then((result) => {
        if (!cancelled) {
          setMembers(result.members);
          setHouseholdAccounts(result.accounts);
          setConnections(result.connections);
        }
      })
      .catch(() => {
        if (!cancelled) setHouseholdError("Could not load household accounts.");
      });
    return () => {
      cancelled = true;
    };
  }, [env]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getInvestmentAccounts(env),
      api.getFinancialGoals(env, goalsScope),
      api.getInvestmentDashboard(env),
    ])
      .then(([accountResult, goalResult, dashboardResult]) => {
        if (cancelled) return;
        setInvestmentAccounts(accountResult.accounts);
        setFinancialGoals(goalResult.goals);
        setGoalAssets(dashboardResult);
        const firstCash = accountResult.accounts.find((account) => account.type === "depository");
        setEarmarkAccount((current) => current || firstCash?.account_id || "");
      })
      .catch(() => {
        if (!cancelled) setInvestmentError("Could not load investment settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [env, goalsScope]);
  const parseCap = (raw: string): string | null => {
    const cleaned = raw.replace(/[$,]/g, "").replace(/\s/g, "");
    if (cleaned === "") return "";
    return /^\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
  };
  const capDisplay = (cat: string) => {
    const v = caps[cat] ?? "";
    if (capFocused[cat] || v === "") return v;
    const n = Number(v);
    return Number.isFinite(n) ? money(n) : v;
  };
  const saveCap = async (cat: string) => {
    const cleaned = parseCap(caps[cat] || "");
    if (cleaned === null) {
      setCapError((prev) => ({
        ...prev,
        [cat]: (caps[cat] || "").trim().startsWith("-")
          ? "Cap must be non-negative"
          : "Invalid cap — use numbers like 3200 or 3200.50",
      }));
      return;
    }
    try {
      await api.setCategoryCap(env, cat, cleaned);
      setCaps((prev) => ({ ...prev, [cat]: cleaned }));
      setCapError((prev) => ({ ...prev, [cat]: "" }));
      setCapSaved((prev) => ({ ...prev, [cat]: true }));
      setTimeout(() => setCapSaved((prev) => ({ ...prev, [cat]: false })), 2000);
    } catch {
      setCapError((prev) => ({ ...prev, [cat]: "Could not save cap — please check the value" }));
    }
  };
  const saveBudget = async () => {
    await api.setSetting(env, SETTING_KEYS.MONTHLY_BUDGET, budget.trim());
    setBudgetSaved(true);
    setTimeout(() => setBudgetSaved(false), 2000);
  };
  const saveTarget = async () => {
    const values = Object.values(target).map(Number);
    if (
      values.some((v) => !Number.isFinite(v) || v < 0) ||
      Math.abs(values.reduce((a, b) => a + b, 0) - 100) > 0.0001
    ) {
      setTargetError("Target percentages must be non-negative and total 100%.");
      return;
    }
    try {
      await api.setInvestmentTarget(env, {
        us_stock: values[0],
        international_stock: values[1],
        bond_market: values[2],
      });
      setTargetError("");
      setTargetSaved(true);
      setTimeout(() => setTargetSaved(false), 2000);
    } catch {
      setTargetError("Could not save target allocation.");
    }
  };
  const reloadInvestmentSettings = async () => {
    const [accountResult, goalResult, dashboardResult] = await Promise.all([
      api.getInvestmentAccounts(env),
      api.getFinancialGoals(env, goalsScope),
      api.getInvestmentDashboard(env),
    ]);
    setInvestmentAccounts(accountResult.accounts);
    setFinancialGoals(goalResult.goals);
    setGoalAssets(dashboardResult);
    await invalidateFinancialData(queryClient, env);
  };
  const unlinkInstitution = async () => {
    if (!unlinkTarget?.connection.connection_id || unlinkConfirmation !== unlinkTarget.displayName)
      return;
    setUnlinking(true);
    setInstitutionError("");
    try {
      await api.unlinkConnection(env, unlinkTarget.connection.connection_id);
      setUnlinkTarget(null);
      setUnlinkConfirmation("");
      await Promise.all([loadHousehold(), reloadInvestmentSettings()]);
    } catch (caught: unknown) {
      setInstitutionError(errorMessage(caught));
    } finally {
      setUnlinking(false);
    }
  };
  const saveAccountPreference = async (
    account: InvestmentAccountSetting,
    patch: Omit<Partial<InvestmentAccountSetting>, "account_category"> & {
      account_category?: InvestmentAccountCategory | null;
    },
  ) => {
    const next = { ...account, ...patch };
    await api.setInvestmentAccountPreferences(env, account.account_id, {
      tax_status: null,
      liquidity: next.liquidity,
      include_by_default: next.include_by_default,
      is_401k: next.is_401k,
      account_category: patch.account_category === null ? null : next.account_category,
    });
    await reloadInvestmentSettings();
  };
  const addEarmark = async () => {
    const amount = Number(earmarkAmount);
    if (!earmarkAccount || !earmarkName.trim() || !Number.isFinite(amount) || amount < 0) {
      setInvestmentError("Choose a cash account and enter a valid goal name and amount.");
      return;
    }
    try {
      await api.addCashEarmark(env, {
        account_id: earmarkAccount,
        name: earmarkName.trim(),
        amount,
      });
      setEarmarkName("");
      setEarmarkAmount("");
      setInvestmentError("");
      await reloadInvestmentSettings();
    } catch {
      setInvestmentError("Could not save cash goal.");
    }
  };
  const createFinancialGoal = async () => {
    const targetAmount = goalTarget.trim() ? Number(goalTarget) : null;
    if (
      !goalName.trim() ||
      (targetAmount !== null && (!Number.isFinite(targetAmount) || targetAmount < 0))
    ) {
      setInvestmentError("Enter a goal name and an optional non-negative target.");
      return;
    }
    try {
      await api.createFinancialGoal(env, {
        name: goalName.trim(),
        goal_type: goalType,
        target_amount: targetAmount,
        target_date: null,
        scope: goalsScope,
      });
      setGoalName("");
      setGoalTarget("");
      setInvestmentError("");
      await reloadInvestmentSettings();
    } catch {
      setInvestmentError("Could not create the financial goal.");
    }
  };
  const addGoalAllocation = async () => {
    const amount = Number(allocationAmount);
    const goalId = Number(allocationGoal);
    const [sourceType, accountId, securityId = ""] = allocationSource.split("|");
    if (!goalId || !accountId || !Number.isFinite(amount) || amount <= 0) {
      setInvestmentError("Choose a goal and source, then enter an amount greater than zero.");
      return;
    }
    try {
      await api.addGoalAllocation(env, goalId, {
        source_type: sourceType as "ACCOUNT" | "HOLDING",
        account_id: accountId,
        security_id: securityId || null,
        assigned_amount: amount,
      });
      setAllocationAmount("");
      setInvestmentError("");
      await reloadInvestmentSettings();
    } catch {
      setInvestmentError(
        "Could not assign that amount. Existing assignments may already use the source value.",
      );
    }
  };
  const holdingAccountIds = new Set(
    (goalAssets?.holdings || [])
      .filter((holding) => holding.security_id)
      .map((holding) => holding.account_id),
  );
  const accountsById = new Map(householdAccounts.map((account) => [account.id, account]));
  const accountsForConnection = (connection: HouseholdConnection) =>
    connection.household_account_ids
      .map((accountId) => accountsById.get(accountId))
      .filter((account): account is HouseholdAccount => Boolean(account));
  const connectionTitle = (connection: HouseholdConnection) => {
    const linkedAccounts = accountsForConnection(connection);
    return linkedAccounts.length === 1
      ? linkedAccounts[0].display_name || "Unnamed account"
      : connection.institution_name || connection.name;
  };
  return (
    <div className="w-full max-w-full min-w-0 overflow-x-clip">
      <Tabs
        ariaLabel="Settings sections"
        groupId="settings"
        options={SETTINGS_TABS}
        value={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === "accounts" && (
        <div
          id={tabPanelId("settings", "accounts")}
          role="tabpanel"
          aria-labelledby={tabId("settings", "accounts")}
          className="space-y-4"
        >
          <Card
            title="Household members"
            hint="Everyone shares this budget; administrators manage logins."
          >
            <div className="space-y-1 text-sm">
              {members.map((member) => (
                <div key={member.id}>
                  {member.username}{" "}
                  <span className="text-xs text-zinc-500">
                    {member.email} · {member.role}
                  </span>
                </div>
              ))}
            </div>
            {user.role === "ADMIN" && (
              <div className="mt-3 space-y-3">
                <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                  <TextInput
                    type="email"
                    value={invitationEmail}
                    onChange={(event) => setInvitationEmail(event.target.value)}
                    placeholder="Member email"
                  />
                  <Button
                    disabled={invitationWorking || !invitationEmail}
                    onClick={async () => {
                      setInvitationWorking(true);
                      try {
                        const result = await api.createInvitation(invitationEmail);
                        setInvitationLink(
                          `${window.location.origin}/invite/${encodeURIComponent(result.token)}`,
                        );
                        setInvitationEmail("");
                        await invitationsQuery.refetch();
                        setHouseholdError("");
                      } catch (caught) {
                        setHouseholdError(errorMessage(caught));
                      } finally {
                        setInvitationWorking(false);
                      }
                    }}
                  >
                    {invitationWorking ? "Creating…" : "Invite member"}
                  </Button>
                </div>
                {invitationLink && (
                  <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <div className="text-xs text-emerald-800">
                      This link is shown once and expires in 48 hours. Send it to the invited
                      member.
                    </div>
                    <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                      <TextInput value={invitationLink} readOnly aria-label="Invitation link" />
                      <Button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(invitationLink);
                            setHouseholdError("");
                          } catch {
                            setHouseholdError(
                              "Could not copy the link. Select and copy it manually.",
                            );
                          }
                        }}
                      >
                        Copy link
                      </Button>
                    </div>
                  </div>
                )}
                {(invitationsQuery.data?.invitations.length || 0) > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-zinc-700">Pending invitations</div>
                    {invitationsQuery.data?.invitations.map((invitation) => (
                      <div
                        key={invitation.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-2 text-sm"
                      >
                        <span>{invitation.email}</span>
                        <Button
                          variant="secondary"
                          onClick={async () => {
                            try {
                              await api.revokeInvitation(invitation.id);
                              await invitationsQuery.refetch();
                              setHouseholdError("");
                            } catch (caught) {
                              setHouseholdError(errorMessage(caught));
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {householdError && <div className="mt-2 text-xs text-red-600">{householdError}</div>}
          </Card>

          <Card
            title="Accounts & ownership"
            hint="Manage account owners and linked Plaid connections."
          >
            <div className="space-y-3">
              {connections.map((connection) => {
                const linkedAccounts = accountsForConnection(connection);
                const displayName = connectionTitle(connection);
                return (
                  <div
                    key={connection.connection_id || connection.name}
                    className="rounded-lg border border-zinc-200 p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{displayName}</div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {connection.connection_type} · {connection.status}
                        </div>
                      </div>
                      {user.role === "ADMIN" && (
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          disabled={!connection.connection_id}
                          onClick={() => {
                            setUnlinkTarget({ connection, displayName });
                            setUnlinkConfirmation("");
                            setInstitutionError("");
                          }}
                        >
                          Unlink
                        </Button>
                      )}
                    </div>
                    {linkedAccounts.length === 0 && (
                      <div className="mt-3 text-xs text-zinc-500">No imported accounts.</div>
                    )}
                    <div className="mt-3 space-y-3">
                      {linkedAccounts.map((account) => (
                        <div key={account.id}>
                          {linkedAccounts.length > 1 && (
                            <div className="mb-1 text-xs font-medium text-zinc-700">
                              {account.display_name || "Unnamed account"}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-3">
                            {members.map((member) => (
                              <label key={member.id} className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={account.owner_user_ids.includes(member.id)}
                                  disabled={user.role !== "ADMIN"}
                                  onChange={async (event) => {
                                    const owners = event.target.checked
                                      ? [...account.owner_user_ids, member.id]
                                      : account.owner_user_ids.filter((id) => id !== member.id);
                                    if (!owners.length) return;
                                    await api.setHouseholdAccountOwners(env, account.id, owners);
                                    await loadHousehold();
                                  }}
                                />
                                {member.username}
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {institutionError && (
              <div className="mt-2 text-xs text-red-600">{institutionError}</div>
            )}
          </Card>

          <Card
            title="Investment account settings"
            hint="Controls Taxable, Retirement, Liquid, and 401(k) dashboard filters"
          >
            <div className="overflow-auto">
              <table className="w-full min-w-[850px] text-xs">
                <thead>
                  <tr>
                    {[
                      "Account",
                      "Provider type",
                      "Category",
                      "Liquidity",
                      "401(k)",
                      "Included",
                    ].map((label) => (
                      <Th key={label}>{label}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {investmentAccounts.map((account) => (
                    <tr key={account.account_id}>
                      <Td>{account.name || "Unnamed account"}</Td>
                      <Td>
                        {account.type} / {account.subtype}
                      </Td>
                      <Td>
                        <Select
                          className="py-1 text-xs"
                          value={
                            account.category_source === "USER"
                              ? account.account_category
                              : "AUTOMATIC"
                          }
                          onChange={(event) =>
                            saveAccountPreference(account, {
                              account_category:
                                event.target.value === "AUTOMATIC"
                                  ? null
                                  : (event.target.value as InvestmentAccountCategory),
                            })
                          }
                        >
                          <option value="AUTOMATIC">
                            Automatic ({account.account_category.replaceAll("_", " ")})
                          </option>
                          <option value="CASH">Cash</option>
                          <option value="BROKERAGE">Brokerage</option>
                          <option value="RETIREMENT">Retirement</option>
                          <option value="EDUCATION">Education</option>
                          <option value="HEALTH_SAVINGS">Health Savings</option>
                          <option value="EQUITY_COMPENSATION">Equity Compensation</option>
                          <option value="OTHER">Other</option>
                        </Select>
                      </Td>
                      <Td>
                        <Select
                          className="py-1 text-xs"
                          value={account.liquidity}
                          onChange={(event) =>
                            saveAccountPreference(account, { liquidity: event.target.value })
                          }
                        >
                          <option value="LIQUID">Liquid</option>
                          <option value="ILLIQUID">Illiquid</option>
                        </Select>
                      </Td>
                      <Td>
                        <input
                          type="checkbox"
                          checked={account.is_401k}
                          onChange={(event) =>
                            saveAccountPreference(account, { is_401k: event.target.checked })
                          }
                        />
                      </Td>
                      <Td>
                        <input
                          type="checkbox"
                          checked={account.include_by_default}
                          onChange={(event) =>
                            saveAccountPreference(account, {
                              include_by_default: event.target.checked,
                            })
                          }
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {unlinkTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label={`Permanently unlink ${unlinkTarget.displayName}`}
          >
            <div className="text-base font-semibold">
              Permanently unlink {unlinkTarget.displayName}?
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              This revokes Plaid access and permanently deletes every imported transaction,
              investment, snapshot, audit record, and account belonging to this connection in {env}.
              This cannot be undone.
            </p>
            <label className="mt-4 block text-sm text-zinc-600">
              Type <strong>{unlinkTarget.displayName}</strong> to confirm
              <TextInput
                className="mt-1 w-full"
                value={unlinkConfirmation}
                onChange={(event) => setUnlinkConfirmation(event.target.value)}
                aria-label="Connection name confirmation"
              />
            </label>
            {institutionError && (
              <div className="mt-2 text-xs text-red-600">{institutionError}</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={unlinking}
                onClick={() => {
                  setUnlinkTarget(null);
                  setUnlinkConfirmation("");
                  setInstitutionError("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={unlinking || unlinkConfirmation !== unlinkTarget.displayName}
                onClick={() => void unlinkInstitution()}
              >
                {unlinking ? "Unlinking..." : "Permanently unlink"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "goals" && (
        <div
          id={tabPanelId("settings", "goals")}
          role="tabpanel"
          aria-labelledby={tabId("settings", "goals")}
          className="space-y-4"
        >
          <Card
            title="Budget"
            hint="Monthly budget used by the Yearly Summary (Net = Budget − Expense)"
          >
            <div className="mt-1 flex items-center gap-2">
              <TextInput
                value={budget}
                onChange={(e) => {
                  setBudget(e.target.value);
                  setBudgetSaved(false);
                }}
                placeholder="e.g. 14648.00"
                className="w-48"
              />
              <Button onClick={saveBudget}>Save Budget</Button>
              {budgetSaved && <span className={`text-xs ${TONE_TEXT.positive}`}>Saved</span>}
            </div>
          </Card>

          <Card
            title="Default investment goal"
            hint="Set the target mix used by the Investment dashboard. Percentages must total 100%."
          >
            <div className="grid gap-2 md:grid-cols-3">
              {(
                [
                  ["us_stock", "US Stock"],
                  ["international_stock", "International Stock"],
                  ["bond_market", "Bond Market"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-sm text-zinc-600">
                  {label}
                  <TextInput
                    type="number"
                    min="0"
                    step="0.1"
                    value={target[key]}
                    onChange={(e) => {
                      setTarget((prev) => ({ ...prev, [key]: e.target.value }));
                      setTargetError("");
                    }}
                    className="mt-1 w-full"
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button onClick={saveTarget}>Save target</Button>
              {targetSaved && <span className={`text-xs ${TONE_TEXT.positive}`}>Saved</span>}
              {targetError && <span className="text-xs text-red-600">{targetError}</span>}
            </div>
          </Card>

          <Card
            title="Cash goals"
            hint="Earmarked cash can be removed from long-term allocation without hiding the account"
          >
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_180px_auto]">
              <Select
                value={earmarkAccount}
                onChange={(event) => setEarmarkAccount(event.target.value)}
              >
                <option value="">Select cash account</option>
                {investmentAccounts
                  .filter((account) => account.type === "depository")
                  .map((account) => (
                    <option key={account.account_id} value={account.account_id}>
                      {account.name || "Unnamed account"}
                    </option>
                  ))}
              </Select>
              <TextInput
                value={earmarkName}
                onChange={(event) => setEarmarkName(event.target.value)}
                placeholder="Emergency fund"
              />
              <TextInput
                type="number"
                min="0"
                value={earmarkAmount}
                onChange={(event) => setEarmarkAmount(event.target.value)}
                placeholder="Amount"
              />
              <Button onClick={addEarmark}>Add goal</Button>
            </div>
            <div className="mt-3 space-y-2">
              {investmentAccounts.flatMap((account) =>
                account.earmarks.map((earmark) => (
                  <div
                    key={earmark.id}
                    className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                  >
                    <span>
                      {earmark.name} · {account.name || "Unnamed account"}
                    </span>
                    <span className="flex items-center gap-3">
                      <strong>{money(earmark.amount)}</strong>
                      <button
                        className="text-xs text-red-600"
                        onClick={async () => {
                          await api.deleteCashEarmark(env, earmark.id);
                          await reloadInvestmentSettings();
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                )),
              )}
            </div>
            {investmentError && <div className="mt-2 text-xs text-red-600">{investmentError}</div>}
          </Card>

          <Card
            title="Financial goals"
            hint={`${goalsScope === "PERSONAL" ? "Personal goals — visible only to you" : "Household goals — shared with everyone in the household"}. Reserve part of a cash balance or holding for 529, retirement, a house, an emergency fund, or another goal.`}
          >
            <div className="grid gap-2 md:grid-cols-[1fr_180px_180px_auto]">
              <TextInput
                value={goalName}
                onChange={(event) => setGoalName(event.target.value)}
                placeholder="Goal name"
              />
              <Select value={goalType} onChange={(event) => setGoalType(event.target.value)}>
                {[
                  ["EMERGENCY_FUND", "Emergency fund"],
                  ["HOUSE_DOWN_PAYMENT", "House"],
                  ["UPCOMING_TAXES", "Taxes"],
                  ["RETIREMENT", "Retirement"],
                  ["529", "529"],
                  ["OTHER", "Other"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
              <TextInput
                type="number"
                min="0"
                value={goalTarget}
                onChange={(event) => setGoalTarget(event.target.value)}
                placeholder="Target (optional)"
              />
              <Button onClick={createFinancialGoal}>Create</Button>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-[1fr_2fr_180px_auto]">
              <Select
                value={allocationGoal}
                onChange={(event) => setAllocationGoal(event.target.value)}
              >
                <option value="">Choose active goal</option>
                {financialGoals
                  .filter((goal) => goal.status === "ACTIVE")
                  .map((goal) => (
                    <option key={goal.id} value={goal.id}>
                      {goal.name}
                    </option>
                  ))}
              </Select>
              <Select
                value={allocationSource}
                onChange={(event) => setAllocationSource(event.target.value)}
              >
                <option value="">Choose account or holding</option>
                {investmentAccounts
                  .filter(
                    (account) =>
                      account.type === "depository" || !holdingAccountIds.has(account.account_id),
                  )
                  .map((account) => (
                    <option
                      key={`account-${account.account_id}`}
                      value={`ACCOUNT|${account.account_id}|`}
                    >
                      {account.name || "Unnamed account"} balance
                    </option>
                  ))}
                {(goalAssets?.holdings || [])
                  .filter((holding) => holding.security_id)
                  .map((holding) => (
                    <option
                      key={holding.id}
                      value={`HOLDING|${holding.account_id}|${holding.security_id}`}
                    >
                      {holding.holding} · {holding.account}
                    </option>
                  ))}
              </Select>
              <TextInput
                type="number"
                min="0"
                value={allocationAmount}
                onChange={(event) => setAllocationAmount(event.target.value)}
                placeholder="Assigned amount"
              />
              <Button onClick={addGoalAllocation}>Assign</Button>
            </div>
            <div className="mt-4 space-y-2">
              {financialGoals.map((goal) => (
                <div key={goal.id} className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <strong>{goal.name}</strong>{" "}
                      <span className="text-xs text-zinc-500">
                        {goal.goal_type.replaceAll("_", " ")} · {goal.status}
                      </span>
                    </span>
                    <span>
                      {money(goal.funded_amount)} funded
                      {goal.target_amount !== null ? ` / ${money(goal.target_amount)}` : ""}
                    </span>
                  </div>
                  {goal.underfunded_amount > 0 && (
                    <div className="mt-1 text-xs text-amber-700">
                      Underfunded by {money(goal.underfunded_amount)} after source values changed.
                    </div>
                  )}
                  <div className="mt-2 space-y-1">
                    {goal.allocations.map((allocation) => (
                      <div
                        key={allocation.id}
                        className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1 text-xs"
                      >
                        <span>
                          {allocation.security_name ||
                            allocation.account_name ||
                            allocation.account_id}
                          : {money(allocation.funded_amount)} of {money(allocation.assigned_amount)}
                        </span>
                        <button
                          className="text-red-600"
                          onClick={async () => {
                            await api.deleteGoalAllocation(env, allocation.id);
                            await reloadInvestmentSettings();
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-3 text-xs">
                    <button
                      className="text-zinc-600 underline"
                      onClick={async () => {
                        await api.updateFinancialGoal(env, goal.id, {
                          name: goal.name,
                          goal_type: goal.goal_type,
                          target_amount: goal.target_amount,
                          target_date: goal.target_date,
                          status: goal.status === "ACTIVE" ? "COMPLETED" : "ACTIVE",
                        });
                        await reloadInvestmentSettings();
                      }}
                    >
                      {goal.status === "ACTIVE" ? "Mark complete" : "Reactivate"}
                    </button>
                    <button
                      className="text-red-600 underline"
                      onClick={async () => {
                        await api.deleteFinancialGoal(env, goal.id);
                        await reloadInvestmentSettings();
                      }}
                    >
                      Delete goal
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Categories"
            hint="Add a category, set its monthly cap, or delete — caps appear as the Category Cap column in Yearly Overview"
          >
            <div className="mt-1 flex gap-2">
              <TextInput
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                placeholder="New category e.g. Childcare"
                className="w-64"
              />
              <Button
                variant="secondary"
                onClick={async () => {
                  if (newCat.trim()) {
                    await api.createCategory(env, newCat.trim());
                    setNewCat("");
                    load();
                  }
                }}
              >
                Add
              </Button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {cats.map((c) => (
                <div key={c} className="rounded-lg border border-zinc-200 px-2 py-1 text-sm">
                  <div className="flex items-center gap-1">
                    <span className="flex-1">{c}</span>
                    <TextInput
                      value={capDisplay(c)}
                      onChange={(e) => {
                        setCaps((prev) => ({ ...prev, [c]: e.target.value }));
                        setCapSaved((prev) => ({ ...prev, [c]: false }));
                        setCapError((prev) => ({ ...prev, [c]: "" }));
                      }}
                      onFocus={() => setCapFocused((prev) => ({ ...prev, [c]: true }))}
                      onBlur={() => setCapFocused((prev) => ({ ...prev, [c]: false }))}
                      placeholder="Cap e.g. 1200.00"
                      className="w-36"
                    />
                    <Button
                      variant="secondary"
                      className="px-2 py-0 text-xs"
                      onClick={() => saveCap(c)}
                    >
                      Save
                    </Button>
                    <button
                      onClick={async () => {
                        await api.deleteCategory(env, c);
                        load();
                      }}
                      className="text-xs text-zinc-500 hover:text-red-600"
                    >
                      Delete
                    </button>
                    {capSaved[c] && <span className={`text-xs ${TONE_TEXT.positive}`}>Saved</span>}
                  </div>
                  {capError[c] && (
                    <div className="mt-0.5 text-[11px] text-red-600">{capError[c]}</div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
