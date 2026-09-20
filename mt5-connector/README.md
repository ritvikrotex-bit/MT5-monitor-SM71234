# MT5 Client Live Monitor — Chunk 1

Windows-only MT5 Manager connector. This chunk only establishes a read-only ManagerAPI connection and keeps it alive.

Requirements: Windows x64, Python 3.10–3.13, and the exact MT5Manager SDK + MT5APIManager64.dll used by the existing MT5 integration/reference project.

Run:

```powershell
cd mt5-connector
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn connector.main:app --host 127.0.0.1 --port 8765
```

Then open http://127.0.0.1:8765/docs.

No trading/dealer endpoints are implemented.
