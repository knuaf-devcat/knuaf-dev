#!/usr/bin/env python3
"""Merge into a versioned review package; force never grants approval."""

from gg_commands import main

if __name__ == "__main__":
    raise SystemExit(main("merge"))
