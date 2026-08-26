"""Transaction-specific persistence operations."""


def get_transaction_ids_for_institution(conn, institution_id: int) -> set[str]:
    rows = conn.execute(
        """
        SELECT plaid_transaction_id
        FROM transactions
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    return {row["plaid_transaction_id"] for row in rows}
