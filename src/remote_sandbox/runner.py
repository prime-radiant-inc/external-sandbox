"""Run the shipped suite with normal pytest arguments and exit codes."""
import sys
from pathlib import Path

import pytest


def main():
    suite = Path(__file__).with_name("suite")
    return pytest.main([str(suite), "-p", "remote_sandbox.plugin", "-o", "asyncio_mode=auto",
                        "-o", "timeout=90", *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
