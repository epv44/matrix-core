import json

import openpyxl
import pytest

from finance.categorization.pfc_map import mappings_from_constants
from finance.excel.exporter import export_from_rows
from finance.plaid_client.sync import _map_plaid_transaction, group_transactions


@pytest.fixture
def raw_data():
    with open("tests/fixtures/sandbox_response.json") as f:
        return json.load(f)


@pytest.fixture
def transactions(raw_data):

    mappings = mappings_from_constants()
    return [
        _map_plaid_transaction(t, mappings=mappings, category_rules=[])
        for t in raw_data["added"]
    ]


@pytest.fixture
def monthly(transactions):

    return group_transactions(transactions)


@pytest.fixture
def workbook(monthly, tmp_path):

    output = tmp_path / "output.xlsx"
    export_from_rows(monthly, str(output))
    return openpyxl.load_workbook(str(output))
