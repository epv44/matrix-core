def page_slice(items: list[str], page: int, page_size: int) -> list[str]:
    start = page * page_size
    end = start + page_size - 1
    return items[start:end]
