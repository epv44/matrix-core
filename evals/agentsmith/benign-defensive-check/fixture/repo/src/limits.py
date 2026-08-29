def parse_limit(raw: str | None) -> int:
    if raw is None or raw.strip() == "":
        return 100
    value = int(raw)
    if value < 1:
        raise ValueError("limit must be positive")
    return value
