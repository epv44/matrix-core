"""Financial planning simulation API boundary."""

from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator

from finance.api.deps import DbDep, EnvDep
from finance.services.financial_tools import (
    LoanOption,
    MonteCarloInput,
    RentToBuyInput,
    financial_tool_defaults,
    run_monte_carlo,
    run_rent_to_buy,
)

router = APIRouter(prefix="/api/financial-tools", tags=["financial-tools"])

Rate = Annotated[float, Field(ge=-0.99, le=1.0)]
NonnegativeRate = Annotated[float, Field(ge=0.0, le=1.0)]
Money = Annotated[float, Field(ge=0.0, le=1_000_000_000_000.0)]


class LoanOptionRequest(BaseModel):
    id: str = Field(min_length=1, max_length=50)
    label: str = Field(min_length=1, max_length=80)
    kind: Literal["FIXED", "ARM"]
    term_years: int = Field(ge=1, le=50)
    annual_rate: NonnegativeRate
    fixed_period_years: int = Field(default=5, ge=1, le=20)
    expected_annual_change: float = Field(default=0.0, ge=-0.25, le=0.25)
    initial_adjustment_cap: float = Field(default=0.02, ge=0.0, le=0.25)
    periodic_adjustment_cap: float = Field(default=0.02, ge=0.0, le=0.25)
    lifetime_cap: float = Field(default=0.05, ge=0.0, le=0.5)
    rate_floor: NonnegativeRate = 0.0

    @model_validator(mode="after")
    def validate_arm(self):
        if self.kind == "ARM" and self.fixed_period_years >= self.term_years:
            raise ValueError("ARM fixed period must be shorter than the loan term")
        if self.rate_floor > self.annual_rate + self.lifetime_cap:
            raise ValueError("ARM rate floor cannot exceed its lifetime maximum")
        return self

    def to_service(self) -> LoanOption:
        return LoanOption(**self.model_dump())


class RentToBuyRequest(BaseModel):
    analysis_years: int = Field(ge=1, le=50)
    home_price: Money
    down_payment: Money
    starting_cash: Money
    monthly_available: float = Field(ge=-10_000_000.0, le=10_000_000.0)
    annual_income_growth: Rate
    monthly_rent: Money
    annual_rent_growth: Rate
    annual_investment_return: Rate
    annual_home_appreciation: Rate
    closing_cost_rate: NonnegativeRate
    finance_closing_costs: bool
    selling_cost_rate: NonnegativeRate
    capital_gains_exclusion: Money
    capital_gains_tax_rate: NonnegativeRate
    property_tax_rate: NonnegativeRate
    monthly_hoa: Money
    monthly_insurance: Money
    monthly_maintenance: Money
    monthly_pmi: Money
    pmi_removal_ltv: float = Field(gt=0.0, le=1.0)
    loan_options: list[LoanOptionRequest] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def validate_scenario(self):
        if self.home_price <= 0:
            raise ValueError("Home price must be greater than zero")
        if self.down_payment > self.home_price:
            raise ValueError("Down payment cannot exceed home price")
        loan_ids = [loan.id for loan in self.loan_options]
        if len(set(loan_ids)) != len(loan_ids):
            raise ValueError("Loan option IDs must be unique")
        return self

    def to_service(self) -> RentToBuyInput:
        values = self.model_dump(exclude={"loan_options"})
        return RentToBuyInput(
            **values,
            loan_options=tuple(loan.to_service() for loan in self.loan_options),
        )


class MonteCarloRequest(BaseModel):
    years: int = Field(ge=1, le=50)
    simulations: int = Field(ge=100, le=5_000)
    investment_start: Money
    cash_start: Money
    withdrawal_year: int = Field(ge=0, le=50)
    withdrawal_investment: Money
    withdrawal_cash: Money
    investment_mean: Rate
    investment_volatility: float = Field(ge=0.0, le=2.0)
    cash_mean: Rate
    cash_volatility: float = Field(ge=0.0, le=2.0)
    monthly_investment_contribution: float = Field(ge=0.0, le=10_000_000.0)
    monthly_cash_contribution: float = Field(ge=0.0, le=10_000_000.0)
    inflation_rate: float = Field(ge=-0.5, le=1.0)
    seed: int = Field(ge=0, le=2_147_483_647)

    @model_validator(mode="after")
    def validate_withdrawal_year(self):
        if self.withdrawal_year > self.years:
            raise ValueError("Withdrawal year cannot exceed the simulation horizon")
        return self

    def to_service(self) -> MonteCarloInput:
        return MonteCarloInput(**self.model_dump())


@router.get("/defaults")
def get_financial_tool_defaults(
    env: EnvDep, db: DbDep, owner_user_id: str | None = None
):
    conn, _ = db
    return {"env": env, **financial_tool_defaults(conn, owner_user_id)}


@router.post("/rent-to-buy/simulate")
def simulate_rent_to_buy(payload: RentToBuyRequest, env: EnvDep):
    return {"env": env, **run_rent_to_buy(payload.to_service())}


@router.post("/monte-carlo/simulate")
def simulate_monte_carlo(payload: MonteCarloRequest, env: EnvDep):
    return {"env": env, **run_monte_carlo(payload.to_service())}
