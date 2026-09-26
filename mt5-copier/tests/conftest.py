"""Make ``copier`` importable when pytest is run from the repository root."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# The engine and rules are pure logic, but importing copier.config builds the
# Settings object, which needs the shared secret. Tests never call out over
# HTTP, so a placeholder is enough.
import os

os.environ.setdefault("COPIER_SECRET", "test-secret")
