from __future__ import annotations

import argparse
from pathlib import Path


def synchronize(root: Path, *, write: bool) -> bool:
    source = root / ".agentignore"
    target = root / ".clineignore"
    expected = source.read_text()
    if write:
        target.write_text(expected)
        return True
    return target.exists() and target.read_text() == expected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if synchronize(root, write=args.write):
        print("Agent ignore adapters are synchronized")
        return 0
    print(".clineignore differs from .agentignore; run with --write")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
