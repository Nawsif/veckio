#!/usr/bin/env python3
"""Compatibility launcher for the HTTP and WebSocket relay."""

from pathlib import Path
import shutil
import subprocess
import sys

if __name__ == "__main__":
    node = shutil.which("node")
    if node is None:
        sys.exit("Node.js is required. Install Node.js, then run this command again.")
    raise SystemExit(subprocess.call([node, str(Path(__file__).with_suffix(".mjs"))]))
