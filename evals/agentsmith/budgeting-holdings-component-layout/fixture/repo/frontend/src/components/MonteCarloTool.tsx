"use client";

import { FormEvent, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import SimulationChart from "@/components/SimulationChart";
import { Button, Card, StatCard, TextInput } from "@/components/ui";
import { useEnv } from "@/context/EnvContext";
import { api, errorMessage, MonteCarloInput, MonteCarloResult } from "@/lib/api";
import { money } from "@/lib/format";

type Props = {
  defaults: MonteCarloInput;
  investmentSource: "HOUSEHOLD" | "EXAMPLE";
  cashSource: "HOUSEHOLD" | "EXAMPLE";
};

function Field({
  label,
  value,
  onChange,
  unit = "$",
  step = 1,
  min,
  max,
  help,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  help?: string;
}) {
  return (
    <label className="space-y-1 text-xs font-medium text-zinc-700">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <TextInput
          type="number"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1"
        />
        {unit && <span className="w-8 text-zinc-500">{unit}</span>}
      </div>
      {help && <span className="block font-normal text-zinc-500">{help}</span>}
    </label>
  );
}

function PercentField({
  label,
  value,
  onChange,
  min = -99,
  max = 100,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <Field
      label={label}
      value={Math.round(value * 10_000) / 100}
      onChange={(next) => onChange(next / 100)}
      unit="%"
      step={0.1}
      min={min}
      max={max}
    />
  );
}

function roundedStartingBalances(defaults: MonteCarloInput): MonteCarloInput {
  return {
    ...structuredClone(defaults),
    investment_start: Math.round(defaults.investment_start),
    cash_start: Math.round(defaults.cash_start),
  };
}

export default function MonteCarloTool({ defaults, investmentSource, cashSource }: Props) {
  const { env } = useEnv();
  const [inputs, setInputs] = useState<MonteCarloInput>(() => roundedStartingBalances(defaults));
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const simulation = useMutation({
    mutationFn: (payload: MonteCarloInput) => api.simulateMonteCarlo(env, payload),
    onSuccess: setResult,
  });
  const patch = (values: Partial<MonteCarloInput>) =>
    setInputs((current) => ({ ...current, ...values }));
  const reset = () => {
    setInputs(roundedStartingBalances(defaults));
    setResult(null);
    simulation.reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    simulation.mutate(inputs);
  };
  const chartRows =
    result?.series.filter((point) => point.month === 0 || point.month % 12 === 0) || [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Monte Carlo</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Explore a range of portfolio outcomes using geometric investment and cash return paths.
        </p>
      </div>

      <form className="space-y-4" onSubmit={submit}>
        <div className="grid gap-4 xl:grid-cols-3">
          <Card title="Starting balances and contributions">
            <div className="space-y-3">
              <Field
                label="Starting investments"
                value={inputs.investment_start}
                onChange={(investment_start) => patch({ investment_start })}
                min={0}
                step={1}
                help={
                  investmentSource === "HOUSEHOLD"
                    ? "Prefilled from the selected household."
                    : "Example value; replace with your scenario."
                }
              />
              <Field
                label="Starting cash"
                value={inputs.cash_start}
                onChange={(cash_start) => patch({ cash_start })}
                min={0}
                step={1}
                help={
                  cashSource === "HOUSEHOLD"
                    ? "Prefilled from the selected household."
                    : "Example value; replace with your scenario."
                }
              />
              <Field
                label="Monthly investment contribution"
                value={inputs.monthly_investment_contribution}
                onChange={(monthly_investment_contribution) =>
                  patch({ monthly_investment_contribution })
                }
                min={0}
              />
              <Field
                label="Monthly cash contribution"
                value={inputs.monthly_cash_contribution}
                onChange={(monthly_cash_contribution) => patch({ monthly_cash_contribution })}
                min={0}
              />
            </div>
          </Card>

          <Card title="Timed withdrawal">
            <div className="space-y-3">
              <Field
                label="Withdrawal year"
                value={inputs.withdrawal_year}
                onChange={(withdrawal_year) => patch({ withdrawal_year })}
                unit="yr"
                min={0}
                max={inputs.years}
                step={1}
                help="Year 0 applies the withdrawal before the first simulated month."
              />
              <Field
                label="Withdraw from investments"
                value={inputs.withdrawal_investment}
                onChange={(withdrawal_investment) => patch({ withdrawal_investment })}
                min={0}
              />
              <Field
                label="Withdraw from cash"
                value={inputs.withdrawal_cash}
                onChange={(withdrawal_cash) => patch({ withdrawal_cash })}
                min={0}
              />
              <p className="text-xs text-zinc-500">
                A path counts as funded only when each requested sleeve can cover its assigned
                withdrawal.
              </p>
            </div>
          </Card>

          <Card title="Simulation controls">
            <div className="space-y-3">
              <Field
                label="Horizon"
                value={inputs.years}
                onChange={(years) =>
                  patch({ years, withdrawal_year: Math.min(inputs.withdrawal_year, years) })
                }
                unit="yr"
                min={1}
                max={50}
                step={1}
              />
              <Field
                label="Simulations"
                value={inputs.simulations}
                onChange={(simulations) => patch({ simulations })}
                unit="runs"
                min={100}
                max={5_000}
                step={100}
              />
              <PercentField
                label="Annual inflation"
                value={inputs.inflation_rate}
                onChange={(inflation_rate) => patch({ inflation_rate })}
                min={-50}
                max={100}
              />
              <Field
                label="Random seed"
                value={inputs.seed}
                onChange={(seed) => patch({ seed })}
                unit=""
                min={0}
                max={2_147_483_647}
                step={1}
                help="Use the same seed to reproduce the same paths."
              />
            </div>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Investment return assumptions">
            <div className="grid gap-3 sm:grid-cols-2">
              <PercentField
                label="Expected annual return"
                value={inputs.investment_mean}
                onChange={(investment_mean) => patch({ investment_mean })}
              />
              <PercentField
                label="Annual volatility"
                value={inputs.investment_volatility}
                onChange={(investment_volatility) => patch({ investment_volatility })}
                min={0}
                max={200}
              />
            </div>
          </Card>
          <Card title="Cash return assumptions">
            <div className="grid gap-3 sm:grid-cols-2">
              <PercentField
                label="Expected annual return"
                value={inputs.cash_mean}
                onChange={(cash_mean) => patch({ cash_mean })}
              />
              <PercentField
                label="Annual volatility"
                value={inputs.cash_volatility}
                onChange={(cash_volatility) => patch({ cash_volatility })}
                min={0}
                max={200}
              />
            </div>
          </Card>
        </div>

        {simulation.isError && (
          <p className="text-sm text-red-600">{errorMessage(simulation.error)}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={simulation.isPending}>
            {simulation.isPending ? "Running simulation…" : "Run simulation"}
          </Button>
          <Button type="button" variant="secondary" onClick={reset}>
            Reset assumptions
          </Button>
          {simulation.isPending && result && (
            <span className="self-center text-xs text-zinc-500">Updating results…</span>
          )}
        </div>
      </form>

      {result && (
        <div className="space-y-4" aria-live="polite">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Median final value"
              value={money(result.final_values.nominal.p50)}
              hint="Nominal future dollars"
            />
            <StatCard
              label="Median in today’s dollars"
              value={money(result.final_values.real.p50)}
              hint="Inflation adjusted"
            />
            <StatCard
              label="10th–90th percentile"
              value={`${money(result.final_values.nominal.p10)} – ${money(result.final_values.nominal.p90)}`}
              hint="Nominal range"
            />
            <StatCard
              label="Withdrawal fully funded"
              value={`${(result.withdrawal_success_probability * 100).toFixed(1)}%`}
              hint={`${result.simulations.toLocaleString()} simulated paths`}
              tone={
                result.withdrawal_success_probability >= 0.9 ? "text-emerald-700" : "text-amber-700"
              }
            />
          </div>

          <Card title="Simulated portfolio range" hint="Nominal future dollars">
            <div className="overflow-x-auto">
              <SimulationChart
                ariaLabel="Monte Carlo 10th, median, and 90th percentile portfolio values"
                data={chartRows as unknown as Record<string, number>[]}
                band={{
                  lowerKey: "nominal_p10",
                  upperKey: "nominal_p90",
                  label: "10th–90th percentile",
                  color: "#a1a1aa",
                }}
                lines={[{ key: "nominal_p50", label: "Median", color: "#18181b" }]}
              />
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Median portfolio composition">
              <div className="overflow-x-auto">
                <SimulationChart
                  ariaLabel="Median investment and cash balances"
                  data={chartRows as unknown as Record<string, number>[]}
                  lines={[
                    { key: "median_investment", label: "Investments", color: "#18181b" },
                    { key: "median_cash", label: "Cash", color: "#10b981", dashed: true },
                  ]}
                />
              </div>
            </Card>
            <Card title="Final value percentiles">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left">
                      <th className="py-2">Percentile</th>
                      <th className="py-2 text-right">Nominal</th>
                      <th className="py-2 text-right">Today’s dollars</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["p10", "p50", "p90"] as const).map((key) => (
                      <tr key={key} className="border-b border-zinc-100">
                        <td className="py-2 uppercase">{key}</td>
                        <td className="py-2 text-right tabular-nums">
                          {money(result.final_values.nominal[key])}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {money(result.final_values.real[key])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
          <p className="text-xs text-zinc-500">
            Simulation—not a forecast or professional financial advice. Results depend entirely on
            the assumptions entered.
          </p>
        </div>
      )}
    </div>
  );
}
