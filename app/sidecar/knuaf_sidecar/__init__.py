"""knuaf-doc companion sidecar: JSON-lines RPC over stdio, stdlib only.

The Electron main process spawns `python -m knuaf_sidecar --scripts-dir <S>`
and talks to it line by line. Core operations import gg_core in-process;
CLI-only scripts run as subprocesses with their output normalised.
"""

__version__ = "0.1.0"
