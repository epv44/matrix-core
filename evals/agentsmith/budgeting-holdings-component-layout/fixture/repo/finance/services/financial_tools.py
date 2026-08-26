"""Deterministic financial planning simulations.

The calculations in this module are scenario models, not forecasts or advice. Inputs use
decimal annual rates (for example, ``0.065`` for 6.5%).
"""

from __future__ import annotations

import math
import random
from array import array
from dataclasses import dataclass

from finance.services.portfolio import PortfolioFilters, build_dashboard
from finance.storage.repository import account_ids_for_owner


@dataclass(frozen=True)
class LoanOption:
    id: str
    label: str
    kind: str
    term_years: int
    annual_rate: float
    fixed_period_years: int = 5
    expected_annual_change: float = 0.0
    initial_adjustment_cap: float = 0.02
    periodic_adjustment_cap: float = 0.02
    lifetime_cap: float = 0.05
    rate_floor: float = 0.0


@dataclass(frozen=True)
class RentToBuyInput:
    analysis_years: int
    home_price: float
    down_payment: float
    starting_cash: float
    monthly_available: float
    annual_income_growth: float
    monthly_rent: float
    annual_rent_growth: float
    annual_investment_return: float
    annual_home_appreciation: float
    closing_cost_rate: float
    finance_closing_costs: bool
    selling_cost_rate: float
    capital_gains_exclusion: float
    capital_gains_tax_rate: float
    property_tax_rate: float
    monthly_hoa: float
    monthly_insurance: float
    monthly_maintenance: float
    monthly_pmi: float
    pmi_removal_ltv: float
    loan_options: tuple[LoanOption, ...]


@dataclass(frozen=True)
class MonteCarloInput:
    years: int
    simulations: int
    investment_start: float
    cash_start: float
    withdrawal_year: int
    withdrawal_investment: float
    withdrawal_cash: float
    investment_mean: float
    investment_volatility: float
    cash_mean: float
    cash_volatility: float
    monthly_investment_contribution: float
    monthly_cash_contribution: float
    inflation_rate: float
    seed: int


def financial_tool_defaults(conn, owner_user_id: str | None = None) -> dict:
    """Return editable defaults, using selected-owner balances when available."""
    account_ids = tuple(account_ids_for_owner(conn, owner_user_id))
    if owner_user_id and not account_ids:
        account_ids = ("__NO_AUTHORIZED_ACCOUNT__",)
    dashboard = build_dashboard(
        conn,
        PortfolioFilters(range="1Y", account_ids=account_ids),
    )
    allocation = {
        row["asset_class"]: float(row["value"]) for row in dashboard["allocation"]
    }
    cash = max(0.0, allocation.get("CASH", 0.0))
    financial_assets = max(0.0, float(dashboard["summary"]["total_financial_assets"]))
    investments = max(0.0, financial_assets - cash)
    liquid = max(0.0, float(dashboard["summary"]["liquid_assets"]))
    has_portfolio_data = financial_assets > 0
    source = "HOUSEHOLD" if has_portfolio_data else "EXAMPLE"

    return {
        "rent_to_buy": {
            **_rent_to_buy_defaults(),
            "starting_cash": (
                _nearest_dollar(liquid) if has_portfolio_data else 1_200_000.0
            ),
        },
        "monte_carlo": {
            **_monte_carlo_defaults(),
            "investment_start": (
                _nearest_dollar(investments) if has_portfolio_data else 600_000.0
            ),
            "cash_start": _nearest_dollar(cash) if has_portfolio_data else 600_000.0,
        },
        "sources": {
            "rent_to_buy.starting_cash": source,
            "monte_carlo.investment_start": source,
            "monte_carlo.cash_start": source,
        },
    }


def _nearest_dollar(value: float) -> int:
    return math.floor(value + 0.5)


def _rent_to_buy_defaults() -> dict:
    return {
        "analysis_years": 30,
        "home_price": 1_250_000.0,
        "down_payment": 800_000.0,
        "starting_cash": 1_200_000.0,
        "monthly_available": 6_500.0,
        "annual_income_growth": 0.025,
        "monthly_rent": 6_000.0,
        "annual_rent_growth": 0.017,
        "annual_investment_return": 0.06,
        "annual_home_appreciation": 0.02,
        "closing_cost_rate": 0.025,
        "finance_closing_costs": False,
        "selling_cost_rate": 0.06,
        "capital_gains_exclusion": 250_000.0,
        "capital_gains_tax_rate": 0.20,
        "property_tax_rate": 0.011,
        "monthly_hoa": 0.0,
        "monthly_insurance": 490.0,
        "monthly_maintenance": 200.0,
        "monthly_pmi": 0.0,
        "pmi_removal_ltv": 0.80,
        "loan_options": [
            {
                "id": "fixed-30",
                "label": "30-year fixed",
                "kind": "FIXED",
                "term_years": 30,
                "annual_rate": 0.065,
            },
            {
                "id": "fixed-15",
                "label": "15-year fixed",
                "kind": "FIXED",
                "term_years": 15,
                "annual_rate": 0.0575,
            },
            {
                "id": "arm-5-1",
                "label": "5/1 ARM",
                "kind": "ARM",
                "term_years": 30,
                "annual_rate": 0.0525,
                "fixed_period_years": 5,
                "expected_annual_change": 0.0,
                "initial_adjustment_cap": 0.02,
                "periodic_adjustment_cap": 0.02,
                "lifetime_cap": 0.05,
                "rate_floor": 0.0525,
            },
        ],
    }


def _monte_carlo_defaults() -> dict:
    return {
        "years": 30,
        "simulations": 1_000,
        "investment_start": 600_000.0,
        "cash_start": 600_000.0,
        "withdrawal_year": 5,
        "withdrawal_investment": 200_000.0,
        "withdrawal_cash": 100_000.0,
        "investment_mean": 0.065,
        "investment_volatility": 0.18,
        "cash_mean": 0.03,
        "cash_volatility": 0.005,
        "monthly_investment_contribution": 0.0,
        "monthly_cash_contribution": 0.0,
        "inflation_rate": 0.025,
        "seed": 42,
    }


def run_rent_to_buy(inputs: RentToBuyInput) -> dict:
    results = [_simulate_loan(inputs, loan) for loan in inputs.loan_options]
    return {
        "assumptions": {
            "rates_are_annual_decimals": True,
            "capital_gains_tax_is_simplified": True,
            "monthly_contributions_are_end_of_month": True,
        },
        "loan_results": results,
    }


def _simulate_loan(inputs: RentToBuyInput, loan: LoanOption) -> dict:
    closing_costs = inputs.home_price * inputs.closing_cost_rate
    cash_outlay = inputs.down_payment + (
        0.0 if inputs.finance_closing_costs else closing_costs
    )
    balance = (
        inputs.home_price
        - inputs.down_payment
        + (closing_costs if inputs.finance_closing_costs else 0.0)
    )
    buying_cash = inputs.starting_cash - cash_outlay
    renting_cash = inputs.starting_cash
    home_value = inputs.home_price
    annual_rate = loan.annual_rate
    payment = _loan_payment(balance, annual_rate, loan.term_years * 12)
    monthly_investment_rate = _effective_monthly_rate(inputs.annual_investment_return)
    monthly_home_rate = _effective_monthly_rate(inputs.annual_home_appreciation)
    monthly_income_rate = _effective_monthly_rate(inputs.annual_income_growth)
    rent = inputs.monthly_rent
    cumulative_interest = 0.0
    minimum_cash = buying_cash
    negative_cash_months = 0
    crossover_month = None
    series = []

    for month in range(1, inputs.analysis_years * 12 + 1):
        annual_rate, payment = _adjusted_payment(
            loan, month, annual_rate, payment, balance
        )
        interest, principal = _mortgage_payment_parts(balance, annual_rate, payment)
        balance = max(0.0, balance - principal)
        cumulative_interest += interest
        home_value *= 1 + monthly_home_rate
        available = inputs.monthly_available * (1 + monthly_income_rate) ** (month - 1)
        ownership_cost = _ownership_cost(inputs, home_value, balance, payment)
        buying_cash = (
            buying_cash * (1 + monthly_investment_rate) + available - ownership_cost
        )
        if month > 1 and (month - 1) % 12 == 0:
            rent *= 1 + inputs.annual_rent_growth
        renting_cash = renting_cash * (1 + monthly_investment_rate) + available - rent
        buy_net_worth = buying_cash + _net_home_sale_proceeds(
            inputs, home_value, balance
        )
        rent_net_worth = renting_cash
        if crossover_month is None and buy_net_worth >= rent_net_worth:
            crossover_month = month
        minimum_cash = min(minimum_cash, buying_cash)
        negative_cash_months += int(buying_cash < 0)
        series.append(
            _rent_to_buy_point(
                month,
                buy_net_worth,
                rent_net_worth,
                ownership_cost,
                rent,
                balance,
                cumulative_interest,
                home_value,
                buying_cash,
            )
        )

    final = series[-1]
    return {
        "loan_id": loan.id,
        "label": loan.label,
        "kind": loan.kind,
        "ending_buy_net_worth": final["buy_net_worth"],
        "ending_rent_net_worth": final["rent_net_worth"],
        "ending_advantage": final["buy_net_worth"] - final["rent_net_worth"],
        "crossover_month": crossover_month,
        "cumulative_interest": cumulative_interest,
        "minimum_cash_reserve": minimum_cash,
        "negative_cash_months": negative_cash_months,
        "series": series,
        "warnings": (
            ["Cash reserve becomes negative in this scenario."]
            if negative_cash_months
            else []
        ),
    }


def _adjusted_payment(
    loan: LoanOption,
    month: int,
    annual_rate: float,
    payment: float,
    balance: float,
) -> tuple[float, float]:
    if loan.kind != "ARM" or not _is_arm_adjustment_month(loan, month):
        return annual_rate, payment if balance > 0 else 0.0
    cap = (
        loan.initial_adjustment_cap
        if month == loan.fixed_period_years * 12 + 1
        else loan.periodic_adjustment_cap
    )
    change = max(-cap, min(cap, loan.expected_annual_change))
    maximum_rate = loan.annual_rate + loan.lifetime_cap
    new_rate = max(loan.rate_floor, min(maximum_rate, annual_rate + change))
    months_remaining = max(0, loan.term_years * 12 - month + 1)
    return new_rate, _loan_payment(balance, new_rate, months_remaining)


def _is_arm_adjustment_month(loan: LoanOption, month: int) -> bool:
    first_adjustment = loan.fixed_period_years * 12 + 1
    return month >= first_adjustment and (month - first_adjustment) % 12 == 0


def _loan_payment(principal: float, annual_rate: float, months: int) -> float:
    if principal <= 0 or months <= 0:
        return 0.0
    monthly_rate = annual_rate / 12
    if monthly_rate == 0:
        return principal / months
    factor = (1 + monthly_rate) ** months
    return principal * monthly_rate * factor / (factor - 1)


def _mortgage_payment_parts(
    balance: float, annual_rate: float, payment: float
) -> tuple[float, float]:
    if balance <= 0:
        return 0.0, 0.0
    interest = balance * annual_rate / 12
    principal = min(balance, max(0.0, payment - interest))
    return interest, principal


def _ownership_cost(
    inputs: RentToBuyInput, home_value: float, balance: float, payment: float
) -> float:
    pmi = (
        inputs.monthly_pmi
        if balance > inputs.home_price * inputs.pmi_removal_ltv
        else 0.0
    )
    return (
        payment
        + home_value * inputs.property_tax_rate / 12
        + inputs.monthly_hoa
        + inputs.monthly_insurance
        + inputs.monthly_maintenance
        + pmi
    )


def _net_home_sale_proceeds(
    inputs: RentToBuyInput, home_value: float, balance: float
) -> float:
    selling_costs = home_value * inputs.selling_cost_rate
    gain = max(0.0, home_value - selling_costs - inputs.home_price)
    taxable_gain = max(0.0, gain - inputs.capital_gains_exclusion)
    tax = taxable_gain * inputs.capital_gains_tax_rate
    return home_value - selling_costs - tax - balance


def _rent_to_buy_point(
    month,
    buy_net_worth,
    rent_net_worth,
    ownership_cost,
    rent,
    balance,
    cumulative_interest,
    home_value,
    cash_reserve,
) -> dict:
    return {
        "month": month,
        "year": month / 12,
        "buy_net_worth": buy_net_worth,
        "rent_net_worth": rent_net_worth,
        "ownership_cost": ownership_cost,
        "rental_cost": rent,
        "loan_balance": balance,
        "cumulative_interest": cumulative_interest,
        "home_value": home_value,
        "cash_reserve": cash_reserve,
    }


def _effective_monthly_rate(annual_rate: float) -> float:
    return (1 + annual_rate) ** (1 / 12) - 1


def run_monte_carlo(inputs: MonteCarloInput) -> dict:
    months = inputs.years * 12
    withdrawal_month = inputs.withdrawal_year * 12
    totals = [array("d") for _ in range(months + 1)]
    investments = [array("d") for _ in range(months + 1)]
    cash_values = [array("d") for _ in range(months + 1)]
    funded_count = 0
    rng = random.Random(inputs.seed)

    for _ in range(inputs.simulations):
        investment = inputs.investment_start
        cash = inputs.cash_start
        funded = True
        if withdrawal_month == 0:
            investment, cash, funded = _apply_withdrawal(investment, cash, inputs)
        _append_path_values(totals, investments, cash_values, 0, investment, cash)
        for month in range(1, months + 1):
            investment = _grow_sleeve(
                investment,
                inputs.investment_mean,
                inputs.investment_volatility,
                inputs.monthly_investment_contribution,
                rng,
            )
            cash = _grow_sleeve(
                cash,
                inputs.cash_mean,
                inputs.cash_volatility,
                inputs.monthly_cash_contribution,
                rng,
            )
            if month == withdrawal_month:
                investment, cash, funded = _apply_withdrawal(investment, cash, inputs)
            _append_path_values(
                totals, investments, cash_values, month, investment, cash
            )
        funded_count += int(funded)

    series = _monte_carlo_series(inputs, totals, investments, cash_values)
    final = series[-1]
    return {
        "seed": inputs.seed,
        "simulations": inputs.simulations,
        "withdrawal_success_probability": funded_count / inputs.simulations,
        "final_values": {
            "nominal": {
                "p10": final["nominal_p10"],
                "p50": final["nominal_p50"],
                "p90": final["nominal_p90"],
            },
            "real": {
                "p10": final["real_p10"],
                "p50": final["real_p50"],
                "p90": final["real_p90"],
            },
        },
        "series": series,
        "assumptions": {
            "return_model": "GEOMETRIC_NORMAL",
            "monthly_contributions_are_end_of_month": True,
            "withdrawal_shortfalls_are_not_reallocated_between_sleeves": True,
        },
    }


def _grow_sleeve(
    balance: float,
    annual_mean: float,
    annual_volatility: float,
    contribution: float,
    rng: random.Random,
) -> float:
    drift = (annual_mean - 0.5 * annual_volatility**2) / 12
    shock = annual_volatility / math.sqrt(12) * rng.gauss(0, 1)
    return max(0.0, balance * math.exp(drift + shock) + contribution)


def _apply_withdrawal(
    investment: float, cash: float, inputs: MonteCarloInput
) -> tuple[float, float, bool]:
    funded = (
        investment >= inputs.withdrawal_investment and cash >= inputs.withdrawal_cash
    )
    return (
        max(0.0, investment - inputs.withdrawal_investment),
        max(0.0, cash - inputs.withdrawal_cash),
        funded,
    )


def _append_path_values(
    totals, investments, cash_values, month, investment, cash
) -> None:
    investments[month].append(investment)
    cash_values[month].append(cash)
    totals[month].append(investment + cash)


def _monte_carlo_series(inputs, totals, investments, cash_values) -> list[dict]:
    series = []
    for month, values in enumerate(totals):
        inflation_factor = (1 + inputs.inflation_rate) ** (month / 12)
        p10 = _percentile(values, 0.10)
        p50 = _percentile(values, 0.50)
        p90 = _percentile(values, 0.90)
        series.append(
            {
                "month": month,
                "year": month / 12,
                "nominal_p10": p10,
                "nominal_p50": p50,
                "nominal_p90": p90,
                "real_p10": p10 / inflation_factor,
                "real_p50": p50 / inflation_factor,
                "real_p90": p90 / inflation_factor,
                "median_investment": _percentile(investments[month], 0.50),
                "median_cash": _percentile(cash_values[month], 0.50),
            }
        )
    return series


def _percentile(values, fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight
