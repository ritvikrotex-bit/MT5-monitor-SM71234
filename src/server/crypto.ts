/**
 * AES-256-GCM credential encryption.
 * Key lives in ENCRYPTION_KEY (64-char hex) — never stored next to ciphertext in git.
 * Swap this module for KMS/HSM later without changing callers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dataDir, dataFile } from "./paths";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex key");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function loadOrCreateKey(): Uint8Array {
  const fromEnv = process.env["ENCRYPTION_KEY"];
  if (fromEnv && fromEnv.length === 64) return hexToBytes(fromEnv);

  const dir = dataDir();
  const keyPath = dataFile("encryption.key");
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, "utf8").trim();
    if (stored.length === 64) return hexToBytes(stored);
  }
  mkdirSync(dir, { recursive: true });
  const generated = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  writeFileSync(keyPath, generated, { encoding: "utf8", mode: 0o600 });
  return hexToBytes(generated);
}

let cachedKey: CryptoKey | undefined;

async function key(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    "raw",
    loadOrCreateKey() as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return cachedKey;
}

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    await key(),
    encoder.encode(plain),
  );
  const bytes = new Uint8Array(cipher);
  const tag = bytes.slice(-16);
  const body = bytes.slice(0, -16);
  return `${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(body)}`;
}

export async function decryptSecret(payload: string): Promise<string> {
  const parts = payload.split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Invalid encrypted payload");
  }
  const iv = hexToBytes(parts[0]);
  const tag = hexToBytes(parts[1]);
  const body = hexToBytes(parts[2]);
  const packed = new Uint8Array(body.length + tag.length);
  packed.set(body, 0);
  packed.set(tag, body.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    await key(),
    packed as unknown as BufferSource,
  );
  return decoder.decode(plain);
}
