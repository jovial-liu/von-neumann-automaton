import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import { ulid } from "ulid";
import type {
  ConwayClient,
  CreateSandboxOptions,
  CreditTransferResult,
  DnsRecord,
  DomainRegistration,
  DomainSearchResult,
  ExecResult,
  ModelInfo,
  PortInfo,
  PricingTier,
  SandboxInfo,
} from "../types.js";
import { ensureDir, normalizeSandboxId, providerNotSupported, resolveUserPath } from "./shared.js";

interface LocalClientOptions {
  rootDir?: string;
  sandboxId?: string;
}

interface LocalSandboxMetadata {
  id: string;
  name: string;
  region: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  createdAt: string;
}

const DEFAULT_LOCAL_CREDITS_CENTS = 10_000;

export function createLocalCloudClient(options: LocalClientOptions = {}): ConwayClient {
  const rootDir = resolveUserPath(
    options.rootDir || process.env.AUTOMATON_CLOUD_ROOT || "~/.automaton/open-cloud",
  );
  ensureDir(rootDir);

  const sandboxesDir = nodePath.join(rootDir, "sandboxes");
  ensureDir(sandboxesDir);

  const sandboxId = normalizeSandboxId(options.sandboxId);

  const sandboxRoot = (id: string): string => nodePath.join(sandboxesDir, id);
  const sandboxMetaPath = (id: string): string => nodePath.join(sandboxRoot(id), "sandbox.json");

  const resolveSandboxCwd = (): string => {
    if (!sandboxId) return process.env.HOME || "/root";
    const dir = sandboxRoot(sandboxId);
    ensureDir(dir);
    return dir;
  };

  const readSandboxMeta = (id: string): LocalSandboxMetadata | null => {
    const metaPath = sandboxMetaPath(id);
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as LocalSandboxMetadata;
  };

  const exec = async (command: string, timeout?: number): Promise<ExecResult> => {
    try {
      const stdout = execSync(command, {
        timeout: timeout || 30_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: resolveSandboxCwd(),
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  };

  const resolvePathInSandbox = (filePath: string): string => {
    if (!sandboxId) return resolveUserPath(filePath);
    const normalized = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    return nodePath.join(resolveSandboxCwd(), normalized);
  };

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    const resolved = resolvePathInSandbox(filePath);
    ensureDir(nodePath.dirname(resolved));
    fs.writeFileSync(resolved, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    return fs.readFileSync(resolvePathInSandbox(filePath), "utf-8");
  };

  const exposePort = async (port: number): Promise<PortInfo> => ({
    port,
    publicUrl: `http://localhost:${port}`,
    sandboxId: sandboxId || "local",
  });

  const removePort = async (_port: number): Promise<void> => {};

  const createSandbox = async (sandboxOptions: CreateSandboxOptions): Promise<SandboxInfo> => {
    const id = ulid();
    const dir = sandboxRoot(id);
    ensureDir(dir);
    const meta: LocalSandboxMetadata = {
      id,
      name: sandboxOptions.name || `local-sandbox-${id}`,
      region: sandboxOptions.region || "local",
      vcpu: sandboxOptions.vcpu || 1,
      memoryMb: sandboxOptions.memoryMb || 512,
      diskGb: sandboxOptions.diskGb || 5,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(sandboxMetaPath(id), JSON.stringify(meta, null, 2), "utf-8");
    return { ...meta, status: "running" };
  };

  const deleteSandbox = async (targetSandboxId: string): Promise<void> => {
    const dir = sandboxRoot(targetSandboxId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    if (!fs.existsSync(sandboxesDir)) return [];
    return fs
      .readdirSync(sandboxesDir)
      .map((id) => readSandboxMeta(id))
      .filter((entry): entry is LocalSandboxMetadata => entry !== null)
      .map((entry) => ({ ...entry, status: "running" }));
  };

  let localCredits = Number(process.env.AUTOMATON_LOCAL_CREDITS_CENTS || DEFAULT_LOCAL_CREDITS_CENTS);

  const getCreditsBalance = async (): Promise<number> => localCredits;

  const getCreditsPricing = async (): Promise<PricingTier[]> => [
    { name: "local", vcpu: 1, memoryMb: 512, diskGb: 5, monthlyCents: 0 },
  ];

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    _note?: string,
  ): Promise<CreditTransferResult> => {
    localCredits = Math.max(0, localCredits - amountCents);
    return {
      transferId: ulid(),
      status: "completed",
      toAddress,
      amountCents,
      balanceAfterCents: localCredits,
    };
  };

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
  }): Promise<{ automaton: Record<string, unknown> }> => ({
    automaton: {
      provider: "local",
      registered: false,
      reason: "local provider does not publish a control-plane registry entry",
      ...params,
    },
  });

  const searchDomains = async (_query: string, _tlds?: string): Promise<DomainSearchResult[]> => {
    throw providerNotSupported("local", "domain search");
  };

  const registerDomain = async (_domain: string, _years?: number): Promise<DomainRegistration> => {
    throw providerNotSupported("local", "domain registration");
  };

  const listDnsRecords = async (_domain: string): Promise<DnsRecord[]> => {
    throw providerNotSupported("local", "DNS listing");
  };

  const addDnsRecord = async (
    _domain: string,
    _type: string,
    _host: string,
    _value: string,
    _ttl?: number,
  ): Promise<DnsRecord> => {
    throw providerNotSupported("local", "DNS writes");
  };

  const deleteDnsRecord = async (_domain: string, _recordId: string): Promise<void> => {
    throw providerNotSupported("local", "DNS deletion");
  };

  const listModels = async (): Promise<ModelInfo[]> => [];

  const createScopedClient = (targetSandboxId: string): ConwayClient =>
    createLocalCloudClient({ rootDir, sandboxId: targetSandboxId });

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };
}
