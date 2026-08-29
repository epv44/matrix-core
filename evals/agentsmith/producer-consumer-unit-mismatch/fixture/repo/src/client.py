import time

from .settings import load_timeout_ms


def wait_before_retry(config: dict[str, int]) -> None:
    time.sleep(load_timeout_ms(config))
