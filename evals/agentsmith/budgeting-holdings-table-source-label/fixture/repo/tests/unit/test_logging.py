import logging
import pathlib

from finance.config.logging_config import setup_logging


def test_setup_logging_writes_to_file(tmp_path):
    log_file = str(tmp_path / "test.log")
    setup_logging({"log_level": "INFO", "log_file": log_file})
    logging.getLogger("finance.test").info("hello-log")
    root = logging.getLogger()
    for handler in root.handlers:
        handler.flush()
    root.handlers.clear()
    assert "hello-log" in pathlib.Path(log_file).read_text()


def test_setup_logging_is_idempotent(tmp_path):
    config = {"log_level": "INFO", "log_file": str(tmp_path / "a.log")}
    setup_logging(config)
    setup_logging(config)
    root = logging.getLogger()
    file_handlers = [h for h in root.handlers if getattr(h, "baseFilename", None)]
    assert len(file_handlers) == 1
    root.handlers.clear()
