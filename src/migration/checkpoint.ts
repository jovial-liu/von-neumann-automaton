import fs from "fs";
import nodePath from "path";
import type { AgentCheckpoint, AutomatonConfig } from "../types.js";
import { getConfigPath, loadConfig, resolvePath, saveConfig } from "../config.js";
import { getAutomatonDir, getWalletAddress, getWalletPath } from "../identity/wallet.js";

const CHECKPOINT_VERSION = "open-cloud-checkpoint/v1" as const;

function readOptionalFile(path: string): string | null {
  if (!fs.existsSync(path)) return null;
  return fs.readFileSync(path, "utf-8");
}

function writeCheckpointFile(baseDir: string, relativePath: string, content: string): void {
  const target = nodePath.join(baseDir, relativePath);
  fs.mkdirSync(nodePath.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

export function exportAgentCheckpoint(configOverride?: AutomatonConfig): AgentCheckpoint {
  const config = configOverride || loadConfig();
  if (!config) {
    throw new Error("Cannot export checkpoint without a loaded automaton config");
  }

  const automatonDir = getAutomatonDir();
  const checkpointFiles: AgentCheckpoint["files"] = [];

  const trackedFiles = [
    { path: "automaton.json", source: getConfigPath() },
    { path: "wallet.json", source: getWalletPath() },
    { path: "heartbeat.yml", source: resolvePath(config.heartbeatConfigPath) },
    { path: "SOUL.md", source: nodePath.join(automatonDir, "SOUL.md") },
    { path: "genesis.json", source: nodePath.join(automatonDir, "genesis.json") },
    { path: "state.db", source: resolvePath(config.dbPath) },
  ];

  for (const entry of trackedFiles) {
    const content = readOptionalFile(entry.source);
    if (content !== null) {
      checkpointFiles.push({ path: entry.path, content });
    }
  }

  const skillsDir = resolvePath(config.skillsDir);
  if (fs.existsSync(skillsDir)) {
    const queue = [skillsDir];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const name of fs.readdirSync(current)) {
        const abs = nodePath.join(current, name);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          queue.push(abs);
          continue;
        }
        checkpointFiles.push({
          path: nodePath.join("skills", nodePath.relative(skillsDir, abs)),
          content: fs.readFileSync(abs, "utf-8"),
        });
      }
    }
  }

  return {
    version: CHECKPOINT_VERSION,
    createdAt: new Date().toISOString(),
    config,
    walletAddress: getWalletAddress(),
    sandboxId: config.sandboxId,
    files: checkpointFiles,
  };
}

export function importAgentCheckpoint(checkpoint: AgentCheckpoint, targetDir?: string): void {
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new Error(`Unsupported checkpoint version: ${checkpoint.version}`);
  }

  const automatonDir = targetDir || getAutomatonDir();
  fs.mkdirSync(automatonDir, { recursive: true });

  for (const entry of checkpoint.files) {
    if (entry.path.startsWith("skills/")) {
      const skillsRoot = resolvePath(checkpoint.config.skillsDir);
      const relativeSkillPath = entry.path.slice("skills/".length);
      writeCheckpointFile(skillsRoot, relativeSkillPath, entry.content);
      continue;
    }

    writeCheckpointFile(automatonDir, entry.path, entry.content);
  }

  saveConfig({
    ...checkpoint.config,
    sandboxId: checkpoint.sandboxId || checkpoint.config.sandboxId,
  });
}
