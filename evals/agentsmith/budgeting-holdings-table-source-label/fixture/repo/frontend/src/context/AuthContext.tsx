"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";

import { api, AuthUser, errorMessage, InvitationDetails } from "@/lib/api";
import { Button, Card, TextInput } from "@/components/ui";

type AuthContextValue = { user: AuthUser; logout: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .authStatus()
      .then(async (status) => {
        setSetupRequired(status.setup_required);
        if (!status.setup_required) {
          try {
            setUser((await api.me()).user);
          } catch {
            setUser(null);
          }
        }
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  const invitationToken = pathname.startsWith("/invite/") ? pathname.slice("/invite/".length) : "";
  if (invitationToken)
    return (
      <InvitationForm
        key={invitationToken}
        token={invitationToken}
        onAuthenticated={(authenticated) => {
          setUser(authenticated);
          setSetupRequired(false);
          setError("");
          router.replace("/");
        }}
      />
    );
  if (setupRequired === null)
    return <div className="p-10 text-sm text-zinc-500">Loading household…</div>;
  if (!user)
    return (
      <AuthForm
        setup={setupRequired}
        error={error}
        onAuthenticated={(authenticated) => {
          setUser(authenticated);
          setSetupRequired(false);
          setError("");
        }}
        onError={setError}
      />
    );
  if (user.must_change_password) return <PasswordChangeForm onComplete={() => setUser(null)} />;

  return (
    <AuthContext.Provider
      value={{
        user,
        logout: async () => {
          await api.logout();
          queryClient.clear();
          setUser(null);
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function InvitationForm({
  token,
  onAuthenticated,
}: {
  token: string;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .inspectInvitation(token)
      .then((result) => {
        if (!cancelled) setInvitation(result.invitation);
      })
      .catch(() => {
        if (!cancelled) setError("This invitation is invalid, expired, or already used.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center p-6">
      <Card
        title="Join your household"
        hint={
          invitation
            ? `Create your account for ${invitation.household_name}.`
            : "Checking your invitation…"
        }
      >
        {invitation && (
          <div className="mt-3 space-y-3">
            <div className="text-sm text-zinc-600">Invited as {invitation.email}</div>
            <TextInput
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username"
            />
            <TextInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password (12+ characters)"
            />
            <TextInput
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="Confirm password"
            />
            <Button
              disabled={
                working || username.length < 3 || password.length < 12 || password !== confirmation
              }
              onClick={async () => {
                setWorking(true);
                setError("");
                try {
                  const result = await api.acceptInvitation(token, username, password);
                  onAuthenticated(result.user);
                } catch (caught) {
                  setError(errorMessage(caught));
                } finally {
                  setWorking(false);
                }
              }}
            >
              {working ? "Creating account…" : "Create account"}
            </Button>
          </div>
        )}
        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
      </Card>
    </main>
  );
}

function PasswordChangeForm({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-6">
      <Card
        title="Choose a new password"
        hint="Your administrator-created temporary password must be replaced before continuing."
      >
        <div className="mt-3 space-y-3">
          <TextInput
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="New password (12+ characters)"
          />
          {error && <div className="text-sm text-red-600">{error}</div>}
          <Button
            disabled={password.length < 12}
            onClick={async () => {
              try {
                await api.changePassword(password);
                onComplete();
              } catch (caught) {
                setError(errorMessage(caught));
              }
            }}
          >
            Change password
          </Button>
        </div>
      </Card>
    </main>
  );
}

function AuthForm({
  setup,
  error,
  onAuthenticated,
  onError,
}: {
  setup: boolean;
  error: string;
  onAuthenticated: (user: AuthUser) => void;
  onError: (error: string) => void;
}) {
  const [household, setHousehold] = useState("Our household");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async () => {
    setWorking(true);
    onError("");
    try {
      const result = setup
        ? await api.setup({ household_name: household, username, email, password })
        : await api.login(email, password);
      onAuthenticated(result.user);
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-6">
      <Card
        title={setup ? "Create your household" : "Sign in"}
        hint={
          setup
            ? "Create the first administrator for this local dashboard."
            : "Use your household Budget App account."
        }
      >
        <div className="mt-3 space-y-3">
          {setup && (
            <>
              <TextInput
                value={household}
                onChange={(event) => setHousehold(event.target.value)}
                placeholder="Household name"
              />
              <TextInput
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username"
              />
            </>
          )}
          <TextInput
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
          />
          <TextInput
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password (12+ characters)"
          />
          {error && <div className="text-sm text-red-600">{error}</div>}
          <Button
            onClick={() => void submit()}
            disabled={working || !email || !password || (setup && (!household || !username))}
          >
            {working ? "Working…" : setup ? "Create household" : "Sign in"}
          </Button>
        </div>
      </Card>
    </main>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
