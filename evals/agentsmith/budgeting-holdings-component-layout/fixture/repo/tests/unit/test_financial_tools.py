from dataclasses import replace

import pytest
from pydantic import ValidationError

from finance.api.routers.financial_tools import (
    MonteCarloRequest,
    RentToBuyRequest,
    get_financial_tool_defaults,
    simulate_monte_carlo,
    simulate_rent_to_buy,
)
from finance.models.dataclasses import Institution
from finance.services.financial_tools import (
    LoanOption,
    MonteCarloInput,
    RentToBuyInput,
    run_monte_carlo,
    run_rent_to_buy,
)
from finance.storage.connection import get_connection
from finance.storage.repository import upsert_cash_accounts, upsert_institution
from finance.storage.schema import run_migrations


def _fixed_loan(**overrides):
    return replace(
        LoanOption(
            id="fixed",
            label="Fixed",
            kind="FIXED",
            term_years=30,
            annual_rate=0.0,
        ),
        **overrides,
    )


def _rent_inputs(**overrides):
    return replace(
        RentToBuyInput(
            analysis_years=2,
            home_price=100_000.0,
            down_payment=100_000.0,
            starting_cash=150_000.0,
            monthly_available=1_000.0,
            annual_income_growth=0.0,
            monthly_rent=1_000.0,
            annual_rent_growth=0.0,
            annual_investment_return=0.0,
            annual_home_appreciation=0.0,
            closing_cost_rate=0.0,
            finance_closing_costs=False,
            selling_cost_rate=0.0,
            capital_gains_exclusion=250_000.0,
            capital_gains_tax_rate=0.2,
            property_tax_rate=0.0,
            monthly_hoa=0.0,
            monthly_insurance=0.0,
            monthly_maintenance=0.0,
            monthly_pmi=0.0,
            pmi_removal_ltv=0.8,
            loan_options=(_fixed_loan(),),
        ),
        **overrides,
    )


def _monte_inputs(**overrides):
    return replace(
        MonteCarloInput(
            years=1,
            simulations=100,
            investment_start=1_000.0,
            cash_start=500.0,
            withdrawal_year=0,
            withdrawal_investment=0.0,
            withdrawal_cash=0.0,
            investment_mean=0.0,
            investment_volatility=0.0,
            cash_mean=0.0,
            cash_volatility=0.0,
            monthly_investment_contribution=0.0,
            monthly_cash_contribution=0.0,
            inflation_rate=0.0,
            seed=42,
        ),
        **overrides,
    )


def test_rent_to_buy_deducts_each_housing_path_once():
    result = run_rent_to_buy(_rent_inputs(analysis_years=1))["loan_results"][0]

    assert result["ending_buy_net_worth"] == pytest.approx(162_000)
    assert result["ending_rent_net_worth"] == pytest.approx(150_000)
    assert result["minimum_cash_reserve"] == pytest.approx(50_000)


def test_rent_increase_begins_after_twelve_completed_months():
    result = run_rent_to_buy(_rent_inputs(annual_rent_growth=0.10))["loan_results"][0]

    assert result["series"][11]["rental_cost"] == pytest.approx(1_000)
    assert result["series"][12]["rental_cost"] == pytest.approx(1_100)


def test_financed_closing_costs_increase_loan_without_reducing_cash():
    result = run_rent_to_buy(
        _rent_inputs(
            analysis_years=1,
            down_payment=20_000,
            closing_cost_rate=0.10,
            finance_closing_costs=True,
            monthly_available=0,
            monthly_rent=0,
            loan_options=(_fixed_loan(term_years=1),),
        )
    )["loan_results"][0]

    assert result["series"][0]["loan_balance"] == pytest.approx(82_500)
    assert result["series"][0]["cash_reserve"] == pytest.approx(122_500)


def test_pmi_stops_after_original_price_ltv_threshold():
    result = run_rent_to_buy(
        _rent_inputs(
            analysis_years=1,
            down_payment=10_000,
            monthly_available=0,
            monthly_rent=0,
            monthly_pmi=100,
            loan_options=(_fixed_loan(term_years=1),),
        )
    )["loan_results"][0]

    assert result["series"][0]["ownership_cost"] == pytest.approx(7_600)
    assert result["series"][1]["ownership_cost"] == pytest.approx(7_500)


def test_arm_uses_expected_rate_change_and_caps():
    arm = LoanOption(
        id="arm",
        label="ARM",
        kind="ARM",
        term_years=3,
        annual_rate=0.03,
        fixed_period_years=1,
        expected_annual_change=0.05,
        initial_adjustment_cap=0.02,
        periodic_adjustment_cap=0.01,
        lifetime_cap=0.025,
        rate_floor=0.03,
    )
    result = run_rent_to_buy(
        _rent_inputs(
            analysis_years=3,
            down_payment=0,
            monthly_available=0,
            monthly_rent=0,
            loan_options=(arm,),
        )
    )["loan_results"][0]

    payment_before = result["series"][11]["ownership_cost"]
    payment_after_initial = result["series"][12]["ownership_cost"]
    payment_after_periodic = result["series"][24]["ownership_cost"]
    assert payment_after_initial > payment_before
    assert payment_after_periodic > payment_after_initial


def test_sale_tax_applies_only_after_costs_and_exclusion():
    exempt = run_rent_to_buy(
        _rent_inputs(
            analysis_years=1,
            annual_home_appreciation=0.10,
            capital_gains_exclusion=20_000,
        )
    )["loan_results"][0]
    taxable = run_rent_to_buy(
        _rent_inputs(
            analysis_years=1,
            annual_home_appreciation=0.10,
            capital_gains_exclusion=0,
        )
    )["loan_results"][0]

    difference = exempt["ending_buy_net_worth"] - taxable["ending_buy_net_worth"]
    assert difference == pytest.approx(2_000)


def test_monte_carlo_supports_year_zero_withdrawal():
    result = run_monte_carlo(
        _monte_inputs(withdrawal_investment=200, withdrawal_cash=100)
    )

    assert result["series"][0]["nominal_p50"] == pytest.approx(1_200)
    assert result["final_values"]["nominal"]["p50"] == pytest.approx(1_200)
    assert result["withdrawal_success_probability"] == 1


def test_monte_carlo_applies_final_year_withdrawal_and_contributions():
    result = run_monte_carlo(
        _monte_inputs(
            investment_start=100,
            cash_start=0,
            monthly_investment_contribution=100,
            withdrawal_year=1,
            withdrawal_investment=500,
        )
    )

    assert result["final_values"]["nominal"]["p50"] == pytest.approx(800)


def test_monte_carlo_reports_unfunded_withdrawal_without_negative_balances():
    result = run_monte_carlo(
        _monte_inputs(withdrawal_investment=2_000, withdrawal_cash=600)
    )

    assert result["withdrawal_success_probability"] == 0
    assert result["series"][0]["nominal_p50"] == 0


def test_monte_carlo_reports_nominal_and_real_values():
    result = run_monte_carlo(
        _monte_inputs(investment_start=1_100, cash_start=0, inflation_rate=0.10)
    )

    assert result["final_values"]["nominal"]["p50"] == pytest.approx(1_100)
    assert result["final_values"]["real"]["p50"] == pytest.approx(1_000)


def test_monte_carlo_seed_is_reproducible_and_percentiles_are_ordered():
    inputs = _monte_inputs(investment_volatility=0.18, cash_volatility=0.01)
    first = run_monte_carlo(inputs)
    second = run_monte_carlo(inputs)

    assert first == second
    final = first["final_values"]["nominal"]
    assert final["p10"] <= final["p50"] <= final["p90"]


def test_api_models_reject_invalid_cross_field_values():
    rent_payload = {
        **_rent_inputs().__dict__,
        "down_payment": 110_000,
        "loan_options": [_fixed_loan().__dict__],
    }
    with pytest.raises(ValidationError, match="Down payment"):
        RentToBuyRequest.model_validate(rent_payload)

    monte_payload = {**_monte_inputs().__dict__, "withdrawal_year": 2}
    with pytest.raises(ValidationError, match="Withdrawal year"):
        MonteCarloRequest.model_validate(monte_payload)


def test_defaults_are_scoped_to_selected_account_owner(tmp_path):
    conn = get_connection(str(tmp_path / "financial-tools.db"))
    run_migrations(conn)
    cash_institution = upsert_institution(
        conn, Institution(name="cash-one", owner_user_id="owner-one")
    )
    investment_institution = upsert_institution(
        conn, Institution(name="invest-one", owner_user_id="owner-one")
    )
    other_institution = upsert_institution(
        conn, Institution(name="cash-two", owner_user_id="owner-two")
    )
    upsert_cash_accounts(
        conn,
        cash_institution,
        [
            {
                "account_id": "cash-one",
                "name": "Cash One",
                "type": "depository",
                "subtype": "savings",
                "balances": {"current": 300.49},
            }
        ],
        "2026-08-16",
    )
    upsert_cash_accounts(
        conn,
        investment_institution,
        [
            {
                "account_id": "investment-one",
                "name": "Investment One",
                "type": "investment",
                "subtype": "brokerage",
                "balances": {"current": 700.6},
            }
        ],
        "2026-08-16",
    )
    upsert_cash_accounts(
        conn,
        other_institution,
        [
            {
                "account_id": "cash-two",
                "name": "Cash Two",
                "type": "depository",
                "subtype": "savings",
                "balances": {"current": 500},
            }
        ],
        "2026-08-16",
    )
    conn.execute(
        """INSERT INTO investment_securities (security_id, ticker, name, type)
        VALUES ('fund-one', 'VTI', 'VTI', 'equity')"""
    )
    conn.execute(
        """INSERT INTO investment_holdings
        (account_id, security_id, quantity, price, value, raw_payload)
        VALUES ('investment-one', 'fund-one', 1, 700.6, 700.6, '{}')"""
    )
    conn.commit()

    first = get_financial_tool_defaults("sandbox", (conn, {}), "owner-one")
    second = get_financial_tool_defaults("sandbox", (conn, {}), "owner-two")

    assert first["rent_to_buy"]["starting_cash"] == 1_001
    assert second["rent_to_buy"]["starting_cash"] == 500
    assert first["monte_carlo"]["investment_start"] == 701
    assert first["monte_carlo"]["cash_start"] == 300
    assert second["monte_carlo"]["investment_start"] == 0
    assert second["monte_carlo"]["cash_start"] == 500
    assert first["sources"]["monte_carlo.investment_start"] == "HOUSEHOLD"
    conn.close()


def test_simulation_api_contracts_return_environment():
    rent_payload = RentToBuyRequest.model_validate(
        {
            **_rent_inputs(analysis_years=1).__dict__,
            "loan_options": [_fixed_loan().__dict__],
        }
    )
    monte_payload = MonteCarloRequest.model_validate(_monte_inputs().__dict__)

    rent = simulate_rent_to_buy(rent_payload, "production")
    monte = simulate_monte_carlo(monte_payload, "production")

    assert rent["env"] == "production"
    assert rent["loan_results"][0]["series"]
    assert monte["env"] == "production"
    assert monte["series"][0]["month"] == 0
