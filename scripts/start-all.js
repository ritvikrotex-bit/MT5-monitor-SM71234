// Unified launcher: MT5 connector (Python) + web app (Node).
//   node scripts/start-all.js          dev  — Vite dev server with hot reload
//   node scripts/start-all.js --prod   prod — runs the built server (.output/server/index.mjs); run `npm run build` first
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const connectorDir = join(rootDir, "mt5-connector");
const isProd = process.argv.includes("--prod");
const WEB_PORT = process.env.PORT || "3000";
const CONNECTOR_PORT = "8765";

console.log("\x1b[36m%s\x1b[0m", "=======================================================");
console.log(
  "\x1b[36m%s\x1b[0m",
  `  MT5 Trade Monitor - Unified Launcher (${isProd ? "production" : "development"})`,
);
console.log("\x1b[36m%s\x1b[0m", "=======================================================");
console.log("\x1b[90m%s\x1b[0m", `Access website at: http://localhost:${WEB_PORT}`);
console.log("\x1b[90m%s\x1b[0m", "Press Ctrl+C to stop all services");
console.log("");

// Prefer the connector's own virtualenv; fall back to the Windows py launcher, then plain python.
function getPythonCommand() {
  const venvPython = join(
    connectorDir,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if (existsSync(venvPython)) return { cmd: venvPython, args: [] };
  if (process.platform === "win32") return { cmd: "py", args: ["-3"] };
  return { cmd: "python3", args: [] };
}

const py = getPythonCommand();

if (isProd && !existsSync(join(rootDir, ".output", "server", "index.mjs"))) {
  console.error("\x1b[31m%s\x1b[0m", "No production build found. Run `npm run build` first.");
  process.exit(1);
}

console.log("\x1b[33m%s\x1b[0m", `→ Starting MT5 Connector (Python on port ${CONNECTOR_PORT})...`);

// The connector reads CONNECTOR_SECRET from mt5-connector/.env. Only override it
// when explicitly set in the environment — never inject a default secret.
const connectorEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
if (process.env.MT5_CONNECTOR_SECRET)
  connectorEnv.CONNECTOR_SECRET = process.env.MT5_CONNECTOR_SECRET;

const connectorArgs = [
  ...py.args,
  "-m",
  "uvicorn",
  "connector.main:app",
  "--host",
  "127.0.0.1",
  "--port",
  CONNECTOR_PORT,
];

const connectorProc = spawn(py.cmd, connectorArgs, {
  cwd: connectorDir,
  env: connectorEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

connectorProc.stdout.on("data", (data) => {
  const line = data.toString();
  if (!line.includes("GET /health")) {
    process.stdout.write(`\x1b[34m[Connector]\x1b[0m ${line}`);
  }
});

connectorProc.stderr.on("data", (data) => {
  process.stderr.write(`\x1b[34m[Connector]\x1b[0m ${data}`);
});

connectorProc.on("exit", (code) => {
  console.log(`\x1b[31m[Connector] Process exited with code ${code}\x1b[0m`);
});

function checkConnectorHealth(retries = 30) {
  return new Promise((resolve) => {
    const check = (remaining) => {
      const req = http.get(`http://127.0.0.1:${CONNECTOR_PORT}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else if (remaining > 0) {
          setTimeout(() => check(remaining - 1), 500);
        } else {
          resolve(false);
        }
      });
      req.on("error", () => {
        if (remaining > 0) {
          setTimeout(() => check(remaining - 1), 500);
        } else {
          resolve(false);
        }
      });
      req.end();
    };
    check(retries);
  });
}

let webProc = null;

async function startWebServer() {
  const ready = await checkConnectorHealth();
  if (ready) {
    console.log(
      "\x1b[32m%s\x1b[0m",
      `✔ MT5 Connector is online and healthy on port ${CONNECTOR_PORT}.`,
    );
  } else {
    console.log("\x1b[33m%s\x1b[0m", "! MT5 Connector is starting up...");
  }

  console.log("\x1b[33m%s\x1b[0m", `→ Starting MT5 Monitor Web Server on port ${WEB_PORT}...`);

  const webEnv = { ...process.env, HOST: "127.0.0.1", PORT: WEB_PORT };
  const webArgs = isProd
    ? ["--env-file=.env", join(".output", "server", "index.mjs")]
    : [
        join(rootDir, "node_modules", "vite", "bin", "vite.js"),
        "--port",
        WEB_PORT,
        "--host",
        "127.0.0.1",
      ];
  if (isProd) webEnv.NODE_ENV = "production";

  webProc = spawn(process.execPath, webArgs, {
    cwd: rootDir,
    env: webEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  webProc.stdout.on("data", (data) => {
    process.stdout.write(`\x1b[32m[Web]\x1b[0m ${data}`);
  });

  webProc.stderr.on("data", (data) => {
    process.stderr.write(`\x1b[33m[Web Log]\x1b[0m ${data}`);
  });

  webProc.on("exit", (code) => {
    console.log(`\x1b[31m[Web] Process exited with code ${code}\x1b[0m`);
    cleanup();
  });
}

startWebServer();

function cleanup() {
  console.log("\n\x1b[33m%s\x1b[0m", "Shutting down all MT5 Monitor services...");
  try {
    if (webProc && !webProc.killed) webProc.kill();
    if (connectorProc && !connectorProc.killed) connectorProc.kill();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
