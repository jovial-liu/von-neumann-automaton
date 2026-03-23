import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import nodePath from "path";
import { Readable } from "stream";
import { createOpenNodeServer } from "../cloud/open-node-server.js";
import type { AgentCheckpoint, AutomatonConfig } from "../types.js";

async function invokeServerJson(params: {
  server: ReturnType<typeof createOpenNodeServer>["server"];
  method: string;
  path: string;
  apiKey: string;
  body?: unknown;
}): Promise<any> {
  const payload = params.body === undefined ? "" : JSON.stringify(params.body);
  const req = Object.assign(Readable.from(payload ? [payload] : []), {
    method: params.method,
    url: params.path,
    headers: {
      host: "open-node.test",
      authorization: params.apiKey,
      "content-type": "application/json",
    },
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      },
    };
    const handler = params.server.listeners("request")[0] as (req: any, res: any) => Promise<void>;
    Promise.resolve(handler(req as any, res as any)).catch(reject);
  });
}

describe("open-node migration import", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "automaton-open-node-migration-"));
    process.env.AUTOMATON_OPEN_NODE_CHILD_BOOT_COMMAND =
      "mkdir -p .automaton && echo booted > .automaton/boot.txt && echo child-started";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports a checkpoint into a remote sandbox, boots it, and records migration billing", async () => {
    const config: AutomatonConfig = {
      name: "child-one",
      genesisPrompt: "survive remotely",
      creatorAddress: "0x1234567890123456789012345678901234567890",
      registeredWithConway: false,
      sandboxId: "sb-parent",
      conwayApiUrl: "https://api.conway.tech",
      conwayApiKey: "parent-key",
      inferenceModel: "gpt-5.2",
      maxTokensPerTurn: 4096,
      heartbeatConfigPath: "~/.automaton/heartbeat.yml",
      dbPath: "~/.automaton/state.db",
      logLevel: "info",
      walletAddress: "0x9999999999999999999999999999999999999999",
      version: "0.2.1",
      skillsDir: "~/.automaton/skills",
      maxChildren: 3,
      cloudProvider: "open-node",
    };

    const checkpoint: AgentCheckpoint = {
      version: "open-cloud-checkpoint/v1",
      createdAt: new Date().toISOString(),
      config,
      walletAddress: "0x9999999999999999999999999999999999999999",
      sandboxId: "sb-parent",
      files: [
        { path: "automaton.json", content: JSON.stringify(config, null, 2) },
        { path: "wallet.json", content: JSON.stringify({ privateKey: "0xabc", createdAt: new Date().toISOString(), chainType: "evm" }) },
        { path: "heartbeat.yml", content: "entries: []" },
        { path: "skills/test.md", content: "# test skill" },
      ],
    };

    const server = createOpenNodeServer({
      apiKey: "node-key",
      rootDir: tmpDir,
      initialCreditsCents: 1000,
    });

    const result = await invokeServerJson({
      server: server.server,
      method: "POST",
      path: "/v1/migrations/import",
      apiKey: "node-key",
      body: {
        checkpoint,
        parent_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        child_name: "remote-child",
        boot: true,
      },
    });

    expect(result.status).toBe("booted");
    expect(result.childName).toBe("remote-child");
    const automatonDir = nodePath.join(tmpDir, "sandboxes", result.sandboxId, ".automaton");
    expect(fs.readFileSync(nodePath.join(automatonDir, "automaton.json"), "utf-8")).toContain("child-one");
    expect(fs.readFileSync(nodePath.join(automatonDir, "skills", "test.md"), "utf-8")).toContain("test skill");
    expect(fs.readFileSync(nodePath.join(automatonDir, "lineage.json"), "utf-8")).toContain("sb-parent");
    expect(fs.readFileSync(nodePath.join(automatonDir, "boot.txt"), "utf-8").trim()).toBe("booted");

    const migrations = await invokeServerJson({
      server: server.server,
      method: "GET",
      path: "/v1/migrations",
      apiKey: "node-key",
    });
    expect(migrations.migrations).toHaveLength(1);
    expect(migrations.migrations[0].sandboxId).toBe(result.sandboxId);

    const usage = await invokeServerJson({
      server: server.server,
      method: "GET",
      path: "/v1/ledger/usage",
      apiKey: "node-key",
    });
    expect(usage.usage.some((row: any) => row.capability === "migration")).toBe(true);
  });
});
