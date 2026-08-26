"use client";

import { FormEvent, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import SimulationChart from "@/components/SimulationChart";
import { Button, Card, Select, StatCard, TextInput } from "@/components/ui";
import { api, errorMessage, LoanOptionInput, RentToBuyInput, RentToBuyResult } from "@/lib/api";
import { money } from "@/lib/format";
import { useEnv } from "@/context/EnvContext";

type Props = {
  defaults: RentToBuyInput;
  defaultsSource: "HOUSEHOLD" | "EXAMPLE";
};

type NumberFieldProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  help?: string;
};

function NumberField({
  label,
  value,
  onChange,
  unit = "$",
  step = 1,
  min,
  max,
  help,
}: NumberFieldProps) {
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

function PercentField(
  props: Omit<NumberFieldProps, "value" | "onChange" | "unit"> & {
    value: number;
    onChange: (value: number) => void;
  },
) {
  return (
    <NumberField
      {...props}
      value={Math.round(props.value * 10_000) / 100}
      onChange={(value) => props.onChange(value / 100)}
      unit="%"
      step={props.step ?? 0.01}
    />
  );
}

function roundedStartingCash(defaults: RentToBuyInput): RentToBuyInput {
  return {
    ...structuredClone(defaults),
    starting_cash: Math.round(defaults.starting_cash),
  };
}

export default function RentToBuyTool({ defaults, defaultsSource }: Props) {
  const { env } = useEnv();
  const [inputs, setInputs] = useState<RentToBuyInput>(() => roundedStartingCash(defaults));
  const [includedLoans, setIncludedLoans] = useState(() =>
    defaults.loan_options.map((loan) => loan.id),
  );
  const [result, setResult] = useState<RentToBuyResult | null>(null);
  const [selectedLoanId, setSelectedLoanId] = useState(defaults.loan_options[0]?.id || "");
  const simulation = useMutation({
    mutationFn: (payload: RentToBuyInput) => api.simulateRentToBuy(env, payload),
    onSuccess: (next) => {
      setResult(next);
      setSelectedLoanId(next.loan_results[0]?.loan_id || "");
    },
  });
  const patch = (values: Partial<RentToBuyInput>) =>
    setInputs((current) => ({ ...current, ...values }));
  const patchLoan = (id: string, values: Partial<LoanOptionInput>) =>
    setInputs((current) => ({
      ...current,
      loan_options: current.loan_options.map((loan) =>
        loan.id === id ? { ...loan, ...values } : loan,
      ),
    }));
  const reset = () => {
    setInputs(roundedStartingCash(defaults));
    setIncludedLoans(defaults.loan_options.map((loan) => loan.id));
    setResult(null);
    simulation.reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const loanOptions = inputs.loan_options.filter((loan) => includedLoans.includes(loan.id));
    if (!loanOptions.length) return;
    simulation.mutate({ ...inputs, loan_options: loanOptions });
  };
  const selected =
    result?.loan_results.find((loan) => loan.loan_id === selectedLoanId) || result?.loan_results[0];
  const chartRows =
    selected?.series.filter((point) => point.month === 1 || point.month % 12 === 0) || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h2 className="text-xl font-bold">Rent vs. Buy</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Compare projected net worth after housing costs, investing, financing, and a
            hypothetical sale.
          </p>
        </div>
        <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600 sm:ml-auto">
          Starting cash:{" "}
          {defaultsSource === "HOUSEHOLD" ? "from selected household" : "example value"}
        </span>
      </div>

      <form className="space-y-4" onSubmit={submit}>
        <div className="grid gap-4 xl:grid-cols-3">
          <Card title="Purchase and cash flow">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <NumberField
                label="Home price"
                value={inputs.home_price}
                onChange={(home_price) => patch({ home_price })}
                min={1}
                step={1}
              />
              <NumberField
                label="Down payment"
                value={inputs.down_payment}
                onChange={(down_payment) => patch({ down_payment })}
                min={0}
                step={1}
              />
              <NumberField
                label="Starting liquid assets"
                value={inputs.starting_cash}
                onChange={(starting_cash) => patch({ starting_cash })}
                min={0}
                step={1}
              />
              <NumberField
                label="Monthly amount available"
                value={inputs.monthly_available}
                onChange={(monthly_available) => patch({ monthly_available })}
                help="After-tax income less non-housing expenses. Housing is deducted by each path once."
              />
              <NumberField
                label="Analysis horizon"
                value={inputs.analysis_years}
                onChange={(analysis_years) => patch({ analysis_years })}
                unit="yr"
                min={1}
                max={50}
                step={1}
              />
              <PercentField
                label="Annual available-income growth"
                value={inputs.annual_income_growth}
                onChange={(annual_income_growth) => patch({ annual_income_growth })}
                min={-99}
                max={100}
              />
            </div>
          </Card>

          <Card title="Rent and market assumptions">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <NumberField
                label="Monthly rent"
                value={inputs.monthly_rent}
                onChange={(monthly_rent) => patch({ monthly_rent })}
                min={0}
              />
              <PercentField
                label="Annual rent growth"
                value={inputs.annual_rent_growth}
                onChange={(annual_rent_growth) => patch({ annual_rent_growth })}
                min={-99}
                max={100}
              />
              <PercentField
                label="Annual investment return"
                value={inputs.annual_investment_return}
                onChange={(annual_investment_return) => patch({ annual_investment_return })}
                min={-99}
                max={100}
              />
              <PercentField
                label="Annual home appreciation"
                value={inputs.annual_home_appreciation}
                onChange={(annual_home_appreciation) => patch({ annual_home_appreciation })}
                min={-99}
                max={100}
              />
            </div>
          </Card>

          <Card title="Ownership costs">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <PercentField
                label="Property tax"
                value={inputs.property_tax_rate}
                onChange={(property_tax_rate) => patch({ property_tax_rate })}
                min={0}
                max={100}
              />
              <NumberField
                label="Monthly HOA"
                value={inputs.monthly_hoa}
                onChange={(monthly_hoa) => patch({ monthly_hoa })}
                min={0}
              />
              <NumberField
                label="Monthly insurance"
                value={inputs.monthly_insurance}
                onChange={(monthly_insurance) => patch({ monthly_insurance })}
                min={0}
              />
              <NumberField
                label="Monthly maintenance"
                value={inputs.monthly_maintenance}
                onChange={(monthly_maintenance) => patch({ monthly_maintenance })}
                min={0}
              />
              <NumberField
                label="Monthly PMI"
                value={inputs.monthly_pmi}
                onChange={(monthly_pmi) => patch({ monthly_pmi })}
                min={0}
              />
              <PercentField
                label="PMI removal LTV"
                value={inputs.pmi_removal_ltv}
                onChange={(pmi_removal_ltv) => patch({ pmi_removal_ltv })}
                min={1}
                max={100}
              />
            </div>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Purchase, sale, and simplified tax">
            <div className="grid gap-3 sm:grid-cols-2">
              <PercentField
                label="Buyer closing costs"
                value={inputs.closing_cost_rate}
                onChange={(closing_cost_rate) => patch({ closing_cost_rate })}
                min={0}
                max={100}
              />
              <PercentField
                label="Selling costs"
                value={inputs.selling_cost_rate}
                onChange={(selling_cost_rate) => patch({ selling_cost_rate })}
                min={0}
                max={100}
              />
              <NumberField
                label="Capital-gain exclusion"
                value={inputs.capital_gains_exclusion}
                onChange={(capital_gains_exclusion) => patch({ capital_gains_exclusion })}
                min={0}
              />
              <PercentField
                label="Effective capital-gains tax"
                value={inputs.capital_gains_tax_rate}
                onChange={(capital_gains_tax_rate) => patch({ capital_gains_tax_rate })}
                min={0}
                max={100}
              />
              <label className="flex items-center gap-2 text-sm text-zinc-700 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={inputs.finance_closing_costs}
                  onChange={(event) => patch({ finance_closing_costs: event.target.checked })}
                />
                Finance closing costs into the mortgage
              </label>
            </div>
          </Card>

          <Card title="Loan comparisons" hint="Select at least one">
            <div className="space-y-4">
              {inputs.loan_options.map((loan) => (
                <div key={loan.id} className="rounded-lg border border-zinc-200 p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input
                      type="checkbox"
                      checked={includedLoans.includes(loan.id)}
                      onChange={(event) =>
                        setIncludedLoans((current) =>
                          event.target.checked
                            ? [...current, loan.id]
                            : current.filter((id) => id !== loan.id),
                        )
                      }
                    />
                    {loan.label}
                  </label>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <PercentField
                      label="Starting APR"
                      value={loan.annual_rate}
                      onChange={(annual_rate) => patchLoan(loan.id, { annual_rate })}
                      min={0}
                      max={100}
                    />
                    <NumberField
                      label="Loan term"
                      value={loan.term_years}
                      onChange={(term_years) => patchLoan(loan.id, { term_years })}
                      unit="yr"
                      min={1}
                      max={50}
                      step={1}
                    />
                    {loan.kind === "ARM" && (
                      <>
                        <NumberField
                          label="Fixed period"
                          value={loan.fixed_period_years ?? 5}
                          onChange={(fixed_period_years) =>
                            patchLoan(loan.id, { fixed_period_years })
                          }
                          unit="yr"
                          min={1}
                          max={20}
                          step={1}
                        />
                        <PercentField
                          label="Expected annual rate change"
                          value={loan.expected_annual_change ?? 0}
                          onChange={(expected_annual_change) =>
                            patchLoan(loan.id, { expected_annual_change })
                          }
                          min={-25}
                          max={25}
                        />
                        <PercentField
                          label="Initial adjustment cap"
                          value={loan.initial_adjustment_cap ?? 0.02}
                          onChange={(initial_adjustment_cap) =>
                            patchLoan(loan.id, { initial_adjustment_cap })
                          }
                          min={0}
                          max={25}
                        />
                        <PercentField
                          label="Annual adjustment cap"
                          value={loan.periodic_adjustment_cap ?? 0.02}
                          onChange={(periodic_adjustment_cap) =>
                            patchLoan(loan.id, { periodic_adjustment_cap })
                          }
                          min={0}
                          max={25}
                        />
                        <PercentField
                          label="Lifetime increase cap"
                          value={loan.lifetime_cap ?? 0.05}
                          onChange={(lifetime_cap) => patchLoan(loan.id, { lifetime_cap })}
                          min={0}
                          max={50}
                        />
                        <PercentField
                          label="Rate floor"
                          value={loan.rate_floor ?? loan.annual_rate}
                          onChange={(rate_floor) => patchLoan(loan.id, { rate_floor })}
                          min={0}
                          max={100}
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {!includedLoans.length && (
          <p className="text-sm text-red-600">Select at least one loan option.</p>
        )}
        {simulation.isError && (
          <p className="text-sm text-red-600">{errorMessage(simulation.error)}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={simulation.isPending || !includedLoans.length}>
            {simulation.isPending ? "Running comparison…" : "Run comparison"}
          </Button>
          <Button type="button" variant="secondary" onClick={reset}>
            Reset assumptions
          </Button>
          {simulation.isPending && result && (
            <span className="self-center text-xs text-zinc-500">Updating results…</span>
          )}
        </div>
      </form>

      {result && selected && (
        <div className="space-y-4" aria-live="polite">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {result.loan_results.map((loan) => (
              <StatCard
                key={loan.loan_id}
                label={`${loan.label} advantage`}
                value={money(loan.ending_advantage)}
                hint={
                  loan.ending_advantage >= 0
                    ? "Buying leads at horizon"
                    : "Renting leads at horizon"
                }
                tone={loan.ending_advantage >= 0 ? "text-emerald-700" : "text-amber-700"}
              />
            ))}
          </div>

          <Card title="Projected net worth" hint="Assumes a sale at each point">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium text-zinc-700" htmlFor="rent-buy-loan">
                Loan option
              </label>
              <Select
                id="rent-buy-loan"
                value={selected.loan_id}
                onChange={(event) => setSelectedLoanId(event.target.value)}
                className="w-auto"
              >
                {result.loan_results.map((loan) => (
                  <option key={loan.loan_id} value={loan.loan_id}>
                    {loan.label}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-zinc-500 sm:ml-auto">
                First crossover:{" "}
                {selected.crossover_month ? `month ${selected.crossover_month}` : "none in horizon"}
              </span>
            </div>
            <div className="overflow-x-auto">
              <SimulationChart
                ariaLabel={`${selected.label} projected buying and renting net worth`}
                data={chartRows as unknown as Record<string, number>[]}
                lines={[
                  { key: "buy_net_worth", label: "Buy after sale", color: "#18181b" },
                  {
                    key: "rent_net_worth",
                    label: "Rent and invest",
                    color: "#10b981",
                    dashed: true,
                  },
                ]}
              />
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Monthly housing cost">
              <div className="overflow-x-auto">
                <SimulationChart
                  ariaLabel={`${selected.label} monthly owning and renting costs`}
                  data={chartRows as unknown as Record<string, number>[]}
                  lines={[
                    { key: "ownership_cost", label: "Own", color: "#18181b" },
                    { key: "rental_cost", label: "Rent", color: "#f59e0b", dashed: true },
                  ]}
                />
              </div>
            </Card>
            <Card title="Loan details">
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Ending buy net worth</dt>
                  <dd className="font-semibold">{money(selected.ending_buy_net_worth)}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Ending rent net worth</dt>
                  <dd className="font-semibold">{money(selected.ending_rent_net_worth)}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Cumulative interest</dt>
                  <dd className="font-semibold">{money(selected.cumulative_interest)}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Minimum cash reserve</dt>
                  <dd className="font-semibold">{money(selected.minimum_cash_reserve)}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Negative-cash months</dt>
                  <dd className="font-semibold">{selected.negative_cash_months}</dd>
                </div>
              </dl>
              {selected.warnings.map((warning) => (
                <p key={warning} className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  {warning}
                </p>
              ))}
            </Card>
          </div>
          <p className="text-xs text-zinc-500">
            Simplified scenario model—not tax, mortgage, or financial advice. Actual costs, tax
            treatment, returns, and rates vary.
          </p>
        </div>
      )}
    </div>
  );
}
