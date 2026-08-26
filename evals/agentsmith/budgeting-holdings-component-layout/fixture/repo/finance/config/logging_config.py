import logging
import os
import sys
from logging.handlers import RotatingFileHandler


def setup_logging(config: dict) -> None:
    log_level = getattr(logging, config.get("log_level", "INFO").upper(), logging.INFO)
    log_file = config.get("log_file") or os.path.join(
        os.getcwd(), "logs", "finance.log"
    )
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers.clear()
    file_handler = RotatingFileHandler(
        log_file, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setLevel(log_level)
    file_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root_logger.addHandler(file_handler)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(log_level)
    console_handler.setFormatter(logging.Formatter("%(message)s"))
    root_logger.addHandler(console_handler)
