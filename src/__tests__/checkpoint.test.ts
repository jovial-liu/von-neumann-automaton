import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import nodePath from "path";
import { exportAgentCheckpoint } from "../migration/checkpoint.js";
import type { AutomatonConfig } from "../types.js";

describe("agent checkpoint export", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "automaton-checkpoint-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports config, state, wallet, and skills into a portable checkpoint", () => {
    const dbPath = nodePath.join(tmpDir, "state.db");
    const heartbeatPath = nodePath.join(tmpDir, "heartbeat.yml");
    const skillsDir = nodePath.join(tmpDir, "skills");
    const walletPath = nodePath.join(tmpDir, "wallet.json");
    const configPath = nodePath.join(tmpDir, "automaton.json");

    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(dbPath, "db-content");
    fs.writeFileSync(heartbeatPath, "heartbeat: []");
    fs.writeFileSync(walletPath, JSON.stringify({
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      createdAt: new Date().toISOString(),
      chainType: "evm",
    }));
    fs.writeFileSync(nodePath.join(skillsDir, "hello.md"), "# skill");
    fs.writeFileSync(configPath, "{}");

    const config: AutomatonConfig = {
      name: "checkpoint-test",
      genesisPrompt: "test",
      creatorAddress: "0x1234567890123456789012345678901234567890",
      registeredWithConway: false,
      sandboxId: "sb-checkpoint",
      conwayApiUrl: "https://api.conway.tech",
      conwayApiKey: "test-key",
      inferenceModel: "gpt-5.2",
      maxTokensPerTurn: 4096,
      heartbeatConfigPath: heartbeatPath,
      dbPath,
      logLevel: "info",
      walletAddress: "0x1234567890123456789012345678901234567890",
      version: "0.2.1",
      skillsDir,
      maxChildren: 3,
      cloudProvider: "open-node",
      cloudBaseUrl: "https://node.example.com",
      cloudApiKey: "open-key",
    };

    const checkpoint = exportAgentCheckpoint(config);

    expect(checkpoint.version).toBe("open-cloud-checkpoint/v1");
    expect(checkpoint.sandboxId).toBe("sb-checkpoint");
    expect(checkpoint.files.some((entry) => entry.path === "state.db")).toBe(true);
    expect(checkpoint.files.some((entry) => entry.path === "heartbeat.yml")).toBe(true);
    expect(checkpoint.files.some((entry) => entry.path === "skills/hello.md")).toBe(true);
  });
});
