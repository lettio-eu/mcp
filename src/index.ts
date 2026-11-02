#!/usr/bin/env node
/**
 * Lettio MCP server.
 * Lets an AI agent read, search and send email from a private, EU-hosted
 * Lettio mailbox over JMAP. Supports one or many accounts.
 *
 * Configuration (environment variables):
 *   Single account:
 *     LETTIO_USERNAME   full email, e.g. you@yourcompany.eu
 *     LETTIO_PASSWORD   mailbox (app) password
 *     LETTIO_HOST       mail host (default https://mail.lettio.eu)
 *     LETTIO_ACCOUNT_NAME  optional friendly name (default = username)
 *   Multiple accounts:
 *     LETTIO_BRANDS     optional JSON (or a path to it) mapping domains to brand colours
 *     LETTIO_ACCOUNTS   JSON array:
 *       [{ "name": "work", "username": "...", "password": "...", "host": "..." }, ...]
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JmapClient } from "./core/jmap.js";
import type { Brand } from "./core/format.js";
import { registerTools } from "./core/tools.js";

const DEFAULT_HOST = process.env.LETTIO_HOST || "https://mail.lettio.eu";

type AccountConfig = { name: string; host: string; username: string; password: string };

function loadAccounts(): AccountConfig[] {
  const multi = process.env.LETTIO_ACCOUNTS;
  if (multi) {
    const arr = JSON.parse(multi) as any[];
    return arr.map((a) => ({
      name: a.name || a.username,
      host: a.host || DEFAULT_HOST,
      username: a.username,
      password: a.password,
    }));
  }
  const username = process.env.LETTIO_USERNAME;
  const password = process.env.LETTIO_PASSWORD;
  if (username && password) {
    return [
      {
        name: process.env.LETTIO_ACCOUNT_NAME || username,
        host: DEFAULT_HOST,
        username,
        password,
      },
    ];
  }
  return [];
}

const accounts = loadAccounts();
const clients = new Map<string, JmapClient>();
/** Optional brands by domain: LETTIO_BRANDS is a JSON object, or a path to a JSON file. */
async function loadBrands(): Promise<Record<string, Brand>> {
  const v = process.env.LETTIO_BRANDS;
  if (!v) return {};
  return JSON.parse(v.trim().startsWith("{") ? v : await readFile(v, "utf8"));
}

const brands = await loadBrands();
for (const a of accounts) {
  const client = new JmapClient(a.host, a.username, a.password);
  client.brand = brands[a.username.split("@")[1]?.toLowerCase()] ?? client.brand;
  clients.set(a.name, client);
}

function pick(account?: string): JmapClient {
  if (clients.size === 0) {
    throw new Error(
      "No Lettio account configured. Set LETTIO_USERNAME and LETTIO_PASSWORD (or LETTIO_ACCOUNTS).",
    );
  }
  const name = account ?? [...clients.keys()][0];
  const client = clients.get(name);
  if (!client) {
    throw new Error(`Unknown account "${name}". Available: ${[...clients.keys()].join(", ")}`);
  }
  return client;
}

const server = new McpServer({ name: "lettio-mcp", version: "0.4.0" });

registerTools(server, {
  client: pick,
  canSend: () => true,
  accounts: () => accounts.map((a) => ({ name: a.name, address: a.username })),
  readFile: async (path) => ({ name: basename(path), bytes: new Uint8Array(await readFile(path)) }),
  writeFile: (path, bytes) => writeFile(path, bytes),
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it doesn't corrupt the stdio protocol
  console.error(
    `Lettio MCP running · ${clients.size} account(s): ${[...clients.keys()].join(", ") || "none"}`,
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
