import { join, resolve } from "node:path";

/**
 * Directory holding all persisted state (brokers, users, alerts, encryption key...).
 *
 * Set DATA_DIR to pin it somewhere that survives rebuilds. The default is <cwd>/data,
 * which is the project root in dev and when a service runs with AppDirectory = project root.
 * It must NOT be derived from the location of the bundled server file: the production build
 * lives in .output/, which every build wipes.
 */
export function dataDir(): string {
  const configured = process.env["DATA_DIR"]?.trim();
  return configured ? resolve(configured) : join(process.cwd(), "data");
}

export const dataFile = (name: string): string => join(dataDir(), name);
