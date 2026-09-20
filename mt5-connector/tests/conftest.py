import os

# Settings requires a connector secret at import time; tests never use a real one.
os.environ.setdefault("CONNECTOR_SECRET", "test-only-not-a-credential")
