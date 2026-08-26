def find_transaction_amount(ws, merchant_name):
    for row in ws.iter_rows(min_row=5, max_row=ws.max_row):
        for cell in row:
            if cell.value == merchant_name:
                return ws.cell(row=cell.row, column=cell.column + 1).value
    return None


class TestLayout:
    def test_sheet_names(self, workbook):
        expected = {"2026-04", "2026-05", "2026-06", "2026-07"}
        assert set(workbook.sheetnames) == expected

    def test_column_headers(self, workbook):
        ws = workbook["2026-07"]
        assert ws.cell(row=4, column=1).value == "Transportation"
        assert ws.cell(row=4, column=4).value == "Self"
        assert ws.cell(row=4, column=7).value == "Restaurants"
        assert ws.cell(row=4, column=10).value == "Groceries"
        assert ws.cell(row=4, column=13).value == "MISC."
        assert ws.cell(row=4, column=16).value == "Living Expenses"
        assert ws.cell(row=4, column=19).value == "Baby"
        assert ws.cell(row=4, column=22).value == "Travel"
        assert ws.cell(row=4, column=25).value == "Cat Related"
        assert ws.cell(row=4, column=28).value == "Home Goods"


class TestSummary:
    def test_totals_positive(self, workbook):
        for name in workbook.sheetnames:
            ws = workbook[name]
            spent = ws.cell(row=1, column=2).value
            made = ws.cell(row=1, column=4).value
            assert spent is not None and spent > 0, f"{name}: spent={spent}"
            assert made is not None, f"{name}: made={made}"

    def test_transfers_excluded_from_all_sheets(self, workbook):
        for name in workbook.sheetnames:
            ws = workbook[name]
            assert find_transaction_amount(ws, "CREDIT CARD 3333 PAYMENT *//") is None
            assert find_transaction_amount(ws, "CD DEPOSIT .INITIAL.") is None
            assert find_transaction_amount(ws, "AUTOMATIC PAYMENT - THANK") is None


class TestCategoryColumns:
    def test_uber_in_all_sheets(self, workbook):
        for name in workbook.sheetnames:
            ws = workbook[name]
            assert find_transaction_amount(ws, "Uber") is not None, (
                f"{name}: Uber missing"
            )

    def test_kfc_in_some_sheets(self, workbook):
        found = 0
        for name in workbook.sheetnames:
            ws = workbook[name]
            if find_transaction_amount(ws, "KFC") is not None:
                found += 1
        assert found > 0, "KFC not found in any sheet"
