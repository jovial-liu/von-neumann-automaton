import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import { ulid } from "ulid";
import { ensureDir } from "./shared.js";
import {
  DEFAULT_OPEN_CLOUD_PRICING,
  getCapabilityUnitPrice,
  calculateUsageTotal,
} from "../billing/open-cloud-ledger.js";
import {
  broadcastUsdcTransfer,
  claimX402Payment,
  createExactX402Requirement,
  decodeX402PaymentHeader,
  verifyX402Payment,
} from "../conway/x402.js";
import { createInferenceClient } from "../conway/inference.js";
import { STATIC_MODEL_BASELINE } from "../inference/types.js";
import type {
  AgentCheckpoint,
  ModelInfo,
  OpenCloudUsageRecord,
  OpenNodeOperatorSettlementState,
  OpenNodeSettlementAccountState,
  OpenNodePaymentReceipt,
  OpenNodeWithdrawalRequest,
  OpenNodeMigrationResult,
  OperatorSettlementRecord,
} from "../types.js";

export interface OpenNodeServerOptions {
  apiKey: string;
  rootDir?: string;
  host?: string;
  port?: number;
  initialCreditsCents?: number;
  autoProcessIntervalMs?: number;
}

interface OpenNodeSandbox {
  id: string;
  name: string;
  region: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  createdAt: string;
}

interface OpenNodeModelCatalogEntry extends ModelInfo {
  inputPer1kCents: number;
  outputPer1kCents: number;
}

interface OpenNodeSettlementStateFile {
  creditsCents: number;
  usageRecords: OpenCloudUsageRecord[];
  operator: OpenNodeOperatorSettlementState;
  accounts: Record<string, OpenNodeSettlementAccountState>;
  settlements: OperatorSettlementRecord[];
  withdrawals: OpenNodeWithdrawalRequest[];
  paymentReceipts: OpenNodePaymentReceipt[];
  migrations: OpenNodeMigrationResult[];
}

const DEFAULT_ANTHROPIC_MODELS = [
  {
    id: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    inputPer1kCents: 30,
    outputPer1kCents: 150,
    contextWindow: 200_000,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_tokens" as const,
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    inputPer1kCents: 8,
    outputPer1kCents: 40,
    contextWindow: 200_000,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_tokens" as const,
  },
] as const;

function buildOpenAiCatalog(): OpenNodeModelCatalogEntry[] {
  return STATIC_MODEL_BASELINE
    .filter((model) => model.provider === "openai")
    .map((model) => ({
      id: model.modelId,
      provider: model.provider,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsTools: model.supportsTools,
      supportsVision: model.supportsVision,
      parameterStyle: model.parameterStyle,
      available: true,
      inputPer1kCents: model.costPer1kInput,
      outputPer1kCents: model.costPer1kOutput,
      pricing: {
        inputPerMillion: model.costPer1kInput / 10,
        outputPerMillion: model.costPer1kOutput / 10,
      },
    }));
}

async function discoverOllamaModels(baseUrl: string): Promise<OpenNodeModelCatalogEntry[]> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { models?: Array<{ name?: string }> };
    return (data.models || [])
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .map((name) => ({
        id: name,
        provider: "ollama",
        displayName: name,
        contextWindow: 131_072,
        maxTokens: 8192,
        supportsTools: true,
        supportsVision: false,
        parameterStyle: "max_tokens" as const,
        available: true,
        inputPer1kCents: 0,
        outputPer1kCents: 0,
        pricing: {
          inputPerMillion: 0,
          outputPerMillion: 0,
        },
      }));
  } catch {
    return [];
  }
}

async function buildModelCatalog(): Promise<OpenNodeModelCatalogEntry[]> {
  const catalog: OpenNodeModelCatalogEntry[] = [];
  const openaiApiKey =
    process.env.AUTOMATON_OPEN_NODE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const anthropicApiKey =
    process.env.AUTOMATON_OPEN_NODE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const ollamaBaseUrl =
    process.env.AUTOMATON_OPEN_NODE_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL;

  if (openaiApiKey) {
    catalog.push(...buildOpenAiCatalog());
  }

  if (anthropicApiKey) {
    catalog.push(
      ...DEFAULT_ANTHROPIC_MODELS.map((model) => ({
        id: model.id,
        provider: "anthropic",
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        parameterStyle: model.parameterStyle,
        available: true,
        inputPer1kCents: model.inputPer1kCents,
        outputPer1kCents: model.outputPer1kCents,
        pricing: {
          inputPerMillion: model.inputPer1kCents / 10,
          outputPerMillion: model.outputPer1kCents / 10,
        },
      })),
    );
  }

  if (ollamaBaseUrl) {
    catalog.push(...(await discoverOllamaModels(ollamaBaseUrl)));
  }

  return catalog;
}

function findModelCatalogEntry(
  catalog: OpenNodeModelCatalogEntry[],
  modelId: string,
): OpenNodeModelCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === modelId);
}

export function createOpenNodeServer(options: OpenNodeServerOptions) {
  const rootDir = nodePath.resolve(options.rootDir ?? process.env.AUTOMATON_OPEN_NODE_ROOT ?? ".open-node");
  const host = options.host ?? process.env.AUTOMATON_OPEN_NODE_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.AUTOMATON_OPEN_NODE_PORT || "8787");
  const initialCreditsCents = options.initialCreditsCents ?? Number(process.env.AUTOMATON_OPEN_NODE_CREDITS_CENTS || "100000");
  const operatorId = process.env.AUTOMATON_OPEN_NODE_OPERATOR_ID || "local-operator";
  const autoProcessIntervalMs = options.autoProcessIntervalMs ?? Number(process.env.AUTOMATON_OPEN_NODE_AUTO_PROCESS_MS || "5000");

  const sandboxesDir = nodePath.join(rootDir, "sandboxes");
  const statePath = nodePath.join(rootDir, "settlement-state.json");
  ensureDir(sandboxesDir);

  const createDefaultState = (): OpenNodeSettlementStateFile => ({
    creditsCents: initialCreditsCents,
    usageRecords: [],
    operator: {
      operatorId,
      pendingSettlementCents: 0,
      withdrawableCents: 0,
      totalWithdrawnCents: 0,
      updatedAt: new Date().toISOString(),
    },
    accounts: {},
    settlements: [],
    withdrawals: [],
    paymentReceipts: [],
    migrations: [],
  });

  const loadState = (): OpenNodeSettlementStateFile => {
    if (!fs.existsSync(statePath)) {
      const initialState = createDefaultState();
      fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2), "utf-8");
      return initialState;
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Partial<OpenNodeSettlementStateFile>;
    return {
      creditsCents: parsed.creditsCents ?? initialCreditsCents,
      usageRecords: parsed.usageRecords ?? [],
      operator: {
        operatorId,
        pendingSettlementCents: parsed.operator?.pendingSettlementCents ?? 0,
        withdrawableCents: parsed.operator?.withdrawableCents ?? 0,
        totalWithdrawnCents: parsed.operator?.totalWithdrawnCents ?? 0,
        walletAddress: parsed.operator?.walletAddress,
        updatedAt: parsed.operator?.updatedAt ?? new Date().toISOString(),
      },
      accounts: parsed.accounts ?? {},
      settlements: parsed.settlements ?? [],
      withdrawals: parsed.withdrawals ?? [],
      paymentReceipts: parsed.paymentReceipts ?? [],
      migrations: parsed.migrations ?? [],
    };
  };

  let settlementState = loadState();

  const persistState = (): void => {
    fs.writeFileSync(statePath, JSON.stringify(settlementState, null, 2), "utf-8");
  };

  const nowIso = (): string => new Date().toISOString();
  const retryDelayMs = (attemptCount: number): number =>
    Math.min(60_000, Math.max(5_000, 5_000 * Math.max(1, attemptCount)));
  const isDue = (value?: string): boolean => !value || new Date(value).getTime() <= Date.now();

  const sandboxRoot = (id: string): string => nodePath.join(sandboxesDir, id);
  const sandboxMetaPath = (id: string): string => nodePath.join(sandboxRoot(id), "sandbox.json");
  const sandboxAutomatonDir = (id: string): string => nodePath.join(sandboxRoot(id), ".automaton");

  const readBody = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    return raw ? JSON.parse(raw) : {};
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const isAuthorized = (req: IncomingMessage): boolean =>
    (req.headers.authorization || "") === options.apiKey;

  const listSandboxes = (): OpenNodeSandbox[] => {
    if (!fs.existsSync(sandboxesDir)) return [];
    return fs
      .readdirSync(sandboxesDir)
      .map((id) => {
        const metaPath = sandboxMetaPath(id);
        if (!fs.existsSync(metaPath)) return null;
        return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as OpenNodeSandbox;
      })
      .filter((entry): entry is OpenNodeSandbox => entry !== null);
  };

  const restoreCheckpointIntoSandbox = (
    sandboxId: string,
    checkpoint: AgentCheckpoint,
    parentAddress?: string,
  ): void => {
    const automatonDir = sandboxAutomatonDir(sandboxId);
    ensureDir(automatonDir);
    for (const entry of checkpoint.files) {
      const relativeTarget = entry.path.startsWith("skills/")
        ? nodePath.join("skills", entry.path.slice("skills/".length))
        : entry.path;
      const target = nodePath.join(automatonDir, relativeTarget);
      ensureDir(nodePath.dirname(target));
      fs.writeFileSync(target, entry.content, "utf-8");
    }
    const lineage = {
      parentAddress: parentAddress || checkpoint.config.parentAddress || null,
      sourceSandboxId: checkpoint.sandboxId,
      importedAt: new Date().toISOString(),
      checkpointCreatedAt: checkpoint.createdAt,
    };
    fs.writeFileSync(
      nodePath.join(automatonDir, "lineage.json"),
      JSON.stringify(lineage, null, 2),
      "utf-8",
    );
  };

  const bootSandboxFromCheckpoint = (sandboxId: string): { command: string; output: string } => {
    const cwd = sandboxRoot(sandboxId);
    ensureDir(nodePath.join(cwd, ".automaton"));
    const bootCommand =
      process.env.AUTOMATON_OPEN_NODE_CHILD_BOOT_COMMAND ||
      [
        "mkdir -p .automaton",
        "if [ ! -d runtime ]; then git clone https://github.com/Conway-Research/automaton.git runtime && cd runtime && npm install && npm run build && cd ..; fi",
        "HOME=$PWD nohup node runtime/dist/index.js > .automaton/child.log 2>&1 & echo $!",
      ].join(" && ");
    const output = execSync(bootCommand, {
      cwd,
      timeout: 300_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/zsh",
    });
    return { command: bootCommand, output: output.trim() };
  };

  const recordUsage = (
    sandboxId: string,
    capability: OpenCloudUsageRecord["capability"],
    units: number,
    unitPriceCents: number,
    metadata?: Record<string, unknown>,
  ): void => {
    const totalPriceCents = calculateUsageTotal(units, unitPriceCents);
    settlementState.usageRecords.push({
      id: ulid(),
      provider: "open-node",
      operatorId,
      sandboxId,
      capability,
      units,
      unitPriceCents,
      totalPriceCents,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      createdAt: new Date().toISOString(),
    });
    if (totalPriceCents > 0) {
      const now = new Date().toISOString();
      const existing = settlementState.accounts[sandboxId];
      if (existing) {
        let remaining = totalPriceCents;
        const heldApplied = Math.min(existing.heldBalanceCents, remaining);
        existing.heldBalanceCents -= heldApplied;
        remaining -= heldApplied;
        const availableApplied = Math.min(existing.availableBalanceCents, remaining);
        existing.availableBalanceCents -= availableApplied;
        remaining -= availableApplied;
        existing.accruedUsageCents += totalPriceCents;
        existing.deficitCents += remaining;
        existing.updatedAt = now;
      }
      settlementState.operator.pendingSettlementCents += totalPriceCents;
      settlementState.operator.updatedAt = now;
      settlementState.creditsCents = Math.max(0, settlementState.creditsCents - totalPriceCents);
    }
    persistState();
  };

  const getSettlementAccount = (sandboxId: string): OpenNodeSettlementAccountState | undefined =>
    settlementState.accounts[sandboxId];

  const upsertSettlementAccount = (
    sandboxId: string,
    walletAddress: string,
  ): OpenNodeSettlementAccountState => {
    const now = new Date().toISOString();
    const existing = settlementState.accounts[sandboxId];
    if (existing) {
      existing.walletAddress = walletAddress || existing.walletAddress;
      existing.updatedAt = now;
      return existing;
    }
    const created: OpenNodeSettlementAccountState = {
      sandboxId,
      walletAddress,
      availableBalanceCents: 0,
      heldBalanceCents: 0,
      accruedUsageCents: 0,
      settledUsageCents: 0,
      deficitCents: 0,
      updatedAt: now,
    };
    settlementState.accounts[sandboxId] = created;
    return created;
  };

  const previewSettlement = () => {
    const grossCents = settlementState.operator.pendingSettlementCents;
    const platformFeeCents = Math.floor((grossCents * DEFAULT_OPEN_CLOUD_PRICING.platformFeeBps) / 10_000);
    const netCents = Math.max(0, grossCents - platformFeeCents);
    return {
      operatorId,
      grossCents,
      platformFeeCents,
      netCents,
      pendingSettlementCents: settlementState.operator.pendingSettlementCents,
      withdrawableCents: settlementState.operator.withdrawableCents,
      usageCount: settlementState.usageRecords.length,
    };
  };

  let queueProcessingPromise: Promise<void> | null = null;
  let queueInterval: ReturnType<typeof setInterval> | null = null;

  const processPaymentReceipt = async (receipt: OpenNodePaymentReceipt): Promise<void> => {
    if (receipt.status === "claimed") return;
    if (!isDue(receipt.nextClaimRetryAt)) return;
    const operatorPrivateKey =
      process.env.AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY ||
      process.env.OPERATOR_PRIVATE_KEY;
    if (!operatorPrivateKey) return;

    receipt.status = "claiming";
    receipt.claimAttemptCount = (receipt.claimAttemptCount || 0) + 1;
    persistState();

    try {
      const payment = JSON.parse(receipt.payment);
      const claim = await claimX402Payment({
        payment,
        operatorPrivateKey: operatorPrivateKey as `0x${string}`,
        rpcUrl: process.env.AUTOMATON_OPEN_NODE_RPC_URL || process.env.AUTOMATON_RPC_URL,
      });
      receipt.status = "claimed";
      receipt.claimTxHash = claim.txHash;
      receipt.claimedAt = nowIso();
      receipt.claimError = undefined;
      receipt.nextClaimRetryAt = undefined;
    } catch (err: any) {
      receipt.status = "failed";
      receipt.claimError = err?.message || String(err);
      receipt.nextClaimRetryAt = new Date(Date.now() + retryDelayMs(receipt.claimAttemptCount || 1)).toISOString();
    }
    persistState();
  };

  const processWithdrawal = async (withdrawal: OpenNodeWithdrawalRequest): Promise<void> => {
    if (withdrawal.status === "processed" || withdrawal.status === "rejected") return;
    if (!isDue(withdrawal.nextRetryAt)) return;
    const operatorPrivateKey =
      process.env.AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY ||
      process.env.OPERATOR_PRIVATE_KEY;
    if (!operatorPrivateKey) return;

    withdrawal.status = "broadcasting";
    withdrawal.attemptCount = (withdrawal.attemptCount || 0) + 1;
    persistState();

    try {
      const sent = await broadcastUsdcTransfer({
        operatorPrivateKey: operatorPrivateKey as `0x${string}`,
        toAddress: withdrawal.walletAddress as `0x${string}`,
        amountCents: withdrawal.amountCents,
        rpcUrl: process.env.AUTOMATON_OPEN_NODE_RPC_URL || process.env.AUTOMATON_RPC_URL,
      });
      withdrawal.status = "processed";
      withdrawal.txHash = sent.txHash;
      withdrawal.processedAt = nowIso();
      withdrawal.lastError = undefined;
      withdrawal.nextRetryAt = undefined;
    } catch (err: any) {
      withdrawal.status = "failed";
      withdrawal.lastError = err?.message || String(err);
      withdrawal.nextRetryAt = new Date(Date.now() + retryDelayMs(withdrawal.attemptCount || 1)).toISOString();
    }
    persistState();
  };

  const processSettlementQueues = async (): Promise<void> => {
    if (queueProcessingPromise) {
      return queueProcessingPromise;
    }
    queueProcessingPromise = (async () => {
      for (const receipt of settlementState.paymentReceipts) {
        await processPaymentReceipt(receipt);
      }
      for (const withdrawal of settlementState.withdrawals) {
        await processWithdrawal(withdrawal);
      }
    })().finally(() => {
      queueProcessingPromise = null;
    });
    return queueProcessingPromise;
  };

  const openaiApiKey =
    process.env.AUTOMATON_OPEN_NODE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const anthropicApiKey =
    process.env.AUTOMATON_OPEN_NODE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const ollamaBaseUrl =
    process.env.AUTOMATON_OPEN_NODE_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL;

  const inferenceClient = createInferenceClient({
    apiUrl: "http://127.0.0.1",
    apiKey: "open-node-local-proxy",
    defaultModel: "gpt-5-mini",
    maxTokens: 4096,
    openaiApiKey,
    anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => {
      if (/^claude/i.test(modelId)) return "anthropic";
      if (buildOpenAiCatalog().some((entry) => entry.id === modelId)) return "openai";
      if (modelId.includes(":")) return "ollama";
      return undefined;
    },
  });

  const buildInferenceResponse = (params: {
    id?: string;
    model: string;
    content: string;
    inputTokens: number;
    outputTokens: number;
    toolCalls?: unknown[];
    finishReason?: string;
  }) => ({
    id: params.id || `chatcmpl_${ulid()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        finish_reason: params.finishReason || "stop",
        message: {
          role: "assistant",
          content: params.content,
          ...(params.toolCalls ? { tool_calls: params.toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: params.inputTokens,
      completion_tokens: params.outputTokens,
      total_tokens: params.inputTokens + params.outputTokens,
    },
  });

  const server = createServer(async (req, res) => {
    try {
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }

      await processSettlementQueues();

      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;
      const modelCatalog = await buildModelCatalog();

      if (req.method === "GET" && pathname === "/v1/sandboxes") {
        return sendJson(
          res,
          200,
          listSandboxes().map((entry) => ({
            id: entry.id,
            status: "running",
            region: entry.region,
            vcpu: entry.vcpu,
            memory_mb: entry.memoryMb,
            disk_gb: entry.diskGb,
            created_at: entry.createdAt,
          })),
        );
      }

      if (req.method === "POST" && pathname === "/v1/sandboxes") {
        const body = await readBody(req);
        const id = ulid();
        const meta: OpenNodeSandbox = {
          id,
          name: body.name || `open-node-${id}`,
          region: body.region || "open-node",
          vcpu: body.vcpu || 1,
          memoryMb: body.memory_mb || 512,
          diskGb: body.disk_gb || 5,
          createdAt: new Date().toISOString(),
        };
        ensureDir(sandboxRoot(id));
        fs.writeFileSync(sandboxMetaPath(id), JSON.stringify(meta, null, 2), "utf-8");
        return sendJson(res, 200, {
          id,
          status: "running",
          region: meta.region,
          vcpu: meta.vcpu,
          memory_mb: meta.memoryMb,
          disk_gb: meta.diskGb,
          created_at: meta.createdAt,
        });
      }

      const execMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/exec$/);
      if (req.method === "POST" && execMatch) {
        const sandboxId = execMatch[1];
        const body = await readBody(req);
        const cwd = sandboxRoot(sandboxId);
        ensureDir(cwd);
        const startedAt = Date.now();
        try {
          const stdout = execSync(body.command, {
            cwd,
            timeout: body.timeout || 30_000,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          recordUsage(
            sandboxId,
            "exec",
            Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)),
            getCapabilityUnitPrice("exec", DEFAULT_OPEN_CLOUD_PRICING),
            { command: body.command },
          );
          return sendJson(res, 200, { stdout, stderr: "", exit_code: 0 });
        } catch (err: any) {
          recordUsage(
            sandboxId,
            "exec",
            Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)),
            getCapabilityUnitPrice("exec", DEFAULT_OPEN_CLOUD_PRICING),
            { command: body.command, failed: true },
          );
          return sendJson(res, 200, {
            stdout: err.stdout || "",
            stderr: err.stderr || err.message || "",
            exit_code: err.status ?? 1,
          });
        }
      }

      const fileUploadMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/upload\/json$/);
      if (req.method === "POST" && fileUploadMatch) {
        const sandboxId = fileUploadMatch[1];
        const body = await readBody(req);
        const target = nodePath.join(sandboxRoot(sandboxId), String(body.path || "").replace(/^\//, ""));
        ensureDir(nodePath.dirname(target));
        fs.writeFileSync(target, String(body.content || ""), "utf-8");
        recordUsage(
          sandboxId,
          "file_write",
          1,
          getCapabilityUnitPrice("file_write", DEFAULT_OPEN_CLOUD_PRICING),
          { path: body.path },
        );
        return sendJson(res, 200, { ok: true });
      }

      const fileReadMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/read$/);
      if (req.method === "GET" && fileReadMatch) {
        const sandboxId = fileReadMatch[1];
        const requestedPath = url.searchParams.get("path") || "";
        const target = nodePath.join(sandboxRoot(sandboxId), requestedPath.replace(/^\//, ""));
        recordUsage(
          sandboxId,
          "file_read",
          1,
          getCapabilityUnitPrice("file_read", DEFAULT_OPEN_CLOUD_PRICING),
          { path: requestedPath },
        );
        return sendJson(res, 200, { content: fs.readFileSync(target, "utf-8") });
      }

      const portExposeMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/ports\/expose$/);
      if (req.method === "POST" && portExposeMatch) {
        const sandboxId = portExposeMatch[1];
        const body = await readBody(req);
        const requestedPort = Number(body.port || 0);
        recordUsage(
          sandboxId,
          "port_expose",
          1,
          getCapabilityUnitPrice("port_expose", DEFAULT_OPEN_CLOUD_PRICING),
          { port: requestedPort },
        );
        return sendJson(res, 200, {
          port: requestedPort,
          public_url: `http://${host}:${requestedPort}`,
          sandbox_id: sandboxId,
        });
      }

      const deletePortMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)\/ports\/(\d+)$/);
      if (req.method === "DELETE" && deletePortMatch) {
        return sendJson(res, 200, { ok: true });
      }

      if (
        req.method === "POST" &&
        (pathname === "/v1/inference/chat" || pathname === "/v1/chat/completions")
      ) {
        const body = await readBody(req);
        const model = String(body.model || "");
        if (!model) {
          return sendJson(res, 400, { error: "model_required" });
        }

        const modelEntry = findModelCatalogEntry(modelCatalog, model);
        if (!modelEntry) {
          return sendJson(res, 404, { error: "model_not_available", model });
        }

        const sandboxId = String(body.sandbox_id || "inference");
        const result = await inferenceClient.chat(body.messages || [], {
          model,
          maxTokens:
            Number(body.max_completion_tokens || body.max_tokens || 0) ||
            modelEntry.maxTokens ||
            4096,
          temperature:
            body.temperature === undefined ? undefined : Number(body.temperature),
          tools: Array.isArray(body.tools) ? body.tools : undefined,
        });

        const inputTokens = result.usage?.promptTokens || 0;
        const outputTokens = result.usage?.completionTokens || 0;
        const providerCostCents =
          Math.ceil((inputTokens / 1000) * modelEntry.inputPer1kCents) +
          Math.ceil((outputTokens / 1000) * modelEntry.outputPer1kCents);
        const markupCents = getCapabilityUnitPrice("model_proxy", DEFAULT_OPEN_CLOUD_PRICING);
        const totalCostCents = providerCostCents + markupCents;

        recordUsage(sandboxId, "model_proxy", 1, totalCostCents, {
          model,
          provider: modelEntry.provider,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          provider_cost_cents: providerCostCents,
          proxy_markup_cents: markupCents,
          requested_at: new Date().toISOString(),
        });

        return sendJson(
          res,
          200,
          buildInferenceResponse({
            id: result.id,
            model: result.model || model,
            content: result.message?.content || "",
            inputTokens,
            outputTokens,
            toolCalls: result.toolCalls,
            finishReason: result.finishReason,
          }),
        );
      }

      const deleteSandboxMatch = pathname.match(/^\/v1\/sandboxes\/([^/]+)$/);
      if (req.method === "DELETE" && deleteSandboxMatch) {
        fs.rmSync(sandboxRoot(deleteSandboxMatch[1]), { recursive: true, force: true });
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/v1/credits/balance") {
        return sendJson(res, 200, { balance_cents: settlementState.creditsCents });
      }

      if (req.method === "GET" && pathname === "/v1/ledger/balance") {
        const grossCents = settlementState.usageRecords.reduce((sum, row) => sum + row.totalPriceCents, 0);
        return sendJson(res, 200, {
          balance_cents: settlementState.creditsCents,
          operator_id: operatorId,
          gross_usage_cents: grossCents,
        });
      }

      if (req.method === "GET" && pathname === "/v1/ledger/usage") {
        return sendJson(res, 200, { operator_id: operatorId, usage: settlementState.usageRecords });
      }

      if (req.method === "GET" && pathname === "/v1/ledger/settlements/preview") {
        const summary = previewSettlement();
        return sendJson(res, 200, {
          operator_id: operatorId,
          gross_cents: summary.grossCents,
          platform_fee_cents: summary.platformFeeCents,
          net_cents: summary.netCents,
          usage_count: summary.usageCount,
          pending_settlement_cents: summary.pendingSettlementCents,
          withdrawable_cents: summary.withdrawableCents,
        });
      }

      if (req.method === "POST" && pathname === "/v1/credits/transfer") {
        const body = await readBody(req);
        const amount = Number(body.amount_cents || 0);
        settlementState.creditsCents = Math.max(0, settlementState.creditsCents - amount);
        persistState();
        return sendJson(res, 200, {
          transfer_id: ulid(),
          status: "submitted",
          to_address: body.to_address,
          amount_cents: amount,
          balance_after_cents: settlementState.creditsCents,
        });
      }

      if (req.method === "GET" && pathname === "/v1/settlement/operator") {
        return sendJson(res, 200, {
          operator: settlementState.operator,
          preview: previewSettlement(),
        });
      }

      if (req.method === "POST" && pathname === "/v1/settlement/operator/wallet") {
        const body = await readBody(req);
        settlementState.operator.walletAddress = String(body.wallet_address || "");
        settlementState.operator.updatedAt = new Date().toISOString();
        persistState();
        return sendJson(res, 200, settlementState.operator);
      }

      if (req.method === "POST" && pathname === "/v1/settlement/accounts/deposit") {
        const body = await readBody(req);
        const sandboxId = String(body.sandbox_id || "");
        const walletAddress = String(body.wallet_address || "");
        const amountCents = Number(body.amount_cents || 0);
        if (!sandboxId || !walletAddress || amountCents <= 0) {
          return sendJson(res, 400, { error: "sandbox_id_wallet_address_and_positive_amount_required" });
        }
        const account = upsertSettlementAccount(sandboxId, walletAddress);
        account.availableBalanceCents += amountCents;
        account.lastDepositAt = new Date().toISOString();
        account.updatedAt = account.lastDepositAt;
        persistState();
        return sendJson(res, 200, {
          account,
          deposit: {
            id: ulid(),
            sandbox_id: sandboxId,
            wallet_address: walletAddress,
            amount_cents: amountCents,
            tx_hash: body.tx_hash,
            created_at: account.lastDepositAt,
          },
        });
      }

      const x402DepositMatch = pathname.match(/^\/pay\/deposit\/([^/]+)\/(\d+)$/);
      if (x402DepositMatch && (req.method === "GET" || req.method === "POST")) {
        const sandboxId = x402DepositMatch[1];
        const amountCents = Number(x402DepositMatch[2] || 0);
        const walletAddress = String(url.searchParams.get("wallet") || "");
        const operatorWalletAddress = settlementState.operator.walletAddress;

        if (!walletAddress || amountCents <= 0 || !operatorWalletAddress) {
          return sendJson(res, 400, {
            error: "wallet_amount_and_operator_wallet_required",
          });
        }

        const paymentHeader = req.headers["x-payment"];
        if (!paymentHeader || typeof paymentHeader !== "string") {
          const requirement = createExactX402Requirement({
            amountCents,
            payToAddress: operatorWalletAddress as `0x${string}`,
          });
          res.statusCode = 402;
          res.setHeader("X-Payment-Required", JSON.stringify(requirement));
          return sendJson(res, 402, requirement);
        }

        const payment = decodeX402PaymentHeader(paymentHeader);
        const valid = await verifyX402Payment({
          payment,
          expectedPayToAddress: operatorWalletAddress as `0x${string}`,
          expectedAmountCents: amountCents,
        });
        if (!valid) {
          return sendJson(res, 400, { error: "invalid_x402_payment" });
        }

        const account = upsertSettlementAccount(sandboxId, walletAddress);
        account.availableBalanceCents += amountCents;
        account.lastDepositAt = new Date().toISOString();
        account.updatedAt = account.lastDepositAt;
        settlementState.paymentReceipts.unshift({
          id: ulid(),
          sandboxId,
          walletAddress,
          amountCents,
          network: payment.network,
          payerAddress: payment.payload.authorization.from,
          nonce: payment.payload.authorization.nonce,
          status: "authorized",
          createdAt: account.lastDepositAt,
          payment: JSON.stringify(payment),
          claimAttemptCount: 0,
        });
        persistState();

        return sendJson(res, 200, {
          ok: true,
          settlement_method: "x402_authorization",
          account,
          receipt_id: settlementState.paymentReceipts[0].id,
          authorization: payment.payload.authorization,
        });
      }

      const settlementAccountMatch = pathname.match(/^\/v1\/settlement\/accounts\/([^/]+)$/);
      if (req.method === "GET" && settlementAccountMatch) {
        return sendJson(res, 200, { account: getSettlementAccount(settlementAccountMatch[1]) || null });
      }

      const holdMatch = pathname.match(/^\/v1\/settlement\/accounts\/([^/]+)\/hold$/);
      if (req.method === "POST" && holdMatch) {
        const body = await readBody(req);
        const amountCents = Number(body.amount_cents || 0);
        const account = getSettlementAccount(holdMatch[1]);
        if (!account) return sendJson(res, 404, { error: "settlement_account_not_found" });
        if (amountCents <= 0 || amountCents > account.availableBalanceCents) {
          return sendJson(res, 400, { error: "invalid_hold_amount" });
        }
        account.availableBalanceCents -= amountCents;
        account.heldBalanceCents += amountCents;
        account.updatedAt = new Date().toISOString();
        persistState();
        return sendJson(res, 200, { account, hold_reason: body.reason || undefined });
      }

      const releaseMatch = pathname.match(/^\/v1\/settlement\/accounts\/([^/]+)\/release$/);
      if (req.method === "POST" && releaseMatch) {
        const body = await readBody(req);
        const amountCents = Number(body.amount_cents || 0);
        const account = getSettlementAccount(releaseMatch[1]);
        if (!account) return sendJson(res, 404, { error: "settlement_account_not_found" });
        if (amountCents <= 0 || amountCents > account.heldBalanceCents) {
          return sendJson(res, 400, { error: "invalid_release_amount" });
        }
        account.heldBalanceCents -= amountCents;
        account.availableBalanceCents += amountCents;
        account.updatedAt = new Date().toISOString();
        persistState();
        return sendJson(res, 200, { account, release_reason: body.reason || undefined });
      }

      if (req.method === "GET" && pathname === "/v1/settlement/settlements/preview") {
        return sendJson(res, 200, previewSettlement());
      }

      if (req.method === "POST" && pathname === "/v1/settlement/settlements/close") {
        const now = new Date().toISOString();
        const summary = previewSettlement();
        const settlement: OperatorSettlementRecord = {
          id: ulid(),
          operatorId,
          periodStart:
            settlementState.settlements[0]?.periodEnd ||
            settlementState.usageRecords[settlementState.usageRecords.length - 1]?.createdAt ||
            now,
          periodEnd: now,
          grossCents: summary.grossCents,
          platformFeeCents: summary.platformFeeCents,
          netCents: summary.netCents,
          status: "settled",
          metadata: JSON.stringify({ usageCount: summary.usageCount }),
          createdAt: now,
        };
        settlementState.settlements.unshift(settlement);
        settlementState.operator.pendingSettlementCents = 0;
        settlementState.operator.withdrawableCents += settlement.netCents;
        settlementState.operator.updatedAt = now;
        Object.values(settlementState.accounts).forEach((account) => {
          account.settledUsageCents += account.accruedUsageCents;
          account.accruedUsageCents = 0;
          account.updatedAt = now;
        });
        persistState();
        return sendJson(res, 200, settlement);
      }

      if (req.method === "POST" && pathname === "/v1/settlement/withdrawals") {
        const body = await readBody(req);
        const amountCents = Number(body.amount_cents || 0);
        const walletAddress = settlementState.operator.walletAddress;
        if (!walletAddress) {
          return sendJson(res, 400, { error: "operator_wallet_not_configured" });
        }
        if (amountCents <= 0 || amountCents > settlementState.operator.withdrawableCents) {
          return sendJson(res, 400, { error: "insufficient_withdrawable_balance" });
        }
        const createdAt = new Date().toISOString();
        const withdrawal: OpenNodeWithdrawalRequest = {
          id: ulid(),
          operatorId,
          walletAddress,
          amountCents,
          note: body.note,
          status: "requested",
          createdAt,
          attemptCount: 0,
        };
        settlementState.operator.withdrawableCents -= amountCents;
        settlementState.operator.totalWithdrawnCents += amountCents;
        settlementState.operator.updatedAt = createdAt;
        settlementState.withdrawals.unshift(withdrawal);
        persistState();
        return sendJson(res, 200, withdrawal);
      }

      if (req.method === "GET" && pathname === "/v1/settlement/withdrawals") {
        return sendJson(res, 200, { withdrawals: settlementState.withdrawals });
      }

      if (req.method === "GET" && pathname === "/v1/settlement/payments") {
        return sendJson(res, 200, { payments: settlementState.paymentReceipts });
      }

      if (req.method === "POST" && pathname === "/v1/settlement/process") {
        await processSettlementQueues();
        return sendJson(res, 200, {
          ok: true,
          payments: settlementState.paymentReceipts,
          withdrawals: settlementState.withdrawals,
        });
      }

      const claimPaymentMatch = pathname.match(/^\/v1\/settlement\/payments\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimPaymentMatch) {
        const receipt = settlementState.paymentReceipts.find((entry) => entry.id === claimPaymentMatch[1]);
        if (!receipt) {
          return sendJson(res, 404, { error: "payment_receipt_not_found" });
        }
        if (receipt.status === "claimed") {
          return sendJson(res, 200, receipt);
        }

        const operatorPrivateKey =
          process.env.AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY ||
          process.env.OPERATOR_PRIVATE_KEY;
        if (!operatorPrivateKey) {
          return sendJson(res, 400, { error: "operator_private_key_not_configured" });
        }

        try {
          receipt.nextClaimRetryAt = undefined;
          persistState();
          await processPaymentReceipt(receipt);
          const finalReceipt = settlementState.paymentReceipts.find((entry) => entry.id === receipt.id) || receipt;
          if (finalReceipt.status !== "claimed") {
            return sendJson(res, 500, { error: finalReceipt.claimError || "claim_failed", receipt: finalReceipt });
          }
          return sendJson(res, 200, finalReceipt);
        } catch (err: any) {
          receipt.status = "failed";
          receipt.claimError = err?.message || String(err);
          persistState();
          return sendJson(res, 500, { error: receipt.claimError, receipt });
        }
      }

      if (req.method === "POST" && pathname === "/v1/migrations/import") {
        const body = await readBody(req);
        const checkpoint = body.checkpoint as AgentCheckpoint | undefined;
        if (!checkpoint || checkpoint.version !== "open-cloud-checkpoint/v1") {
          return sendJson(res, 400, { error: "valid_checkpoint_required" });
        }

        const id = ulid();
        const sandboxId = ulid();
        const createdAt = new Date().toISOString();
        const meta: OpenNodeSandbox = {
          id: sandboxId,
          name: body.child_name || checkpoint.config.name || `open-node-${sandboxId}`,
          region: checkpoint.config.cloudBaseUrl || "open-node",
          vcpu: 1,
          memoryMb: checkpoint.config.childSandboxMemoryMb || 1024,
          diskGb: 10,
          createdAt,
        };
        ensureDir(sandboxRoot(sandboxId));
        fs.writeFileSync(sandboxMetaPath(sandboxId), JSON.stringify(meta, null, 2), "utf-8");

        restoreCheckpointIntoSandbox(sandboxId, checkpoint, body.parent_address);
        recordUsage(
          sandboxId,
          "migration",
          1,
          getCapabilityUnitPrice("migration", DEFAULT_OPEN_CLOUD_PRICING),
          {
            checkpoint_created_at: checkpoint.createdAt,
            source_sandbox_id: checkpoint.sandboxId,
            parent_address: body.parent_address || checkpoint.config.parentAddress,
          },
        );

        let status: OpenNodeMigrationResult["status"] = "restored";
        let bootCommand: string | undefined;
        let bootOutput: string | undefined;
        if (body.boot !== false) {
          try {
            const boot = bootSandboxFromCheckpoint(sandboxId);
            bootCommand = boot.command;
            bootOutput = boot.output;
            status = "booted";
          } catch (err: any) {
            bootCommand = process.env.AUTOMATON_OPEN_NODE_CHILD_BOOT_COMMAND;
            bootOutput = err?.message || String(err);
            status = "boot_failed";
          }
        }

        const migration: OpenNodeMigrationResult = {
          migrationId: id,
          sandboxId,
          childName: meta.name,
          walletAddress: checkpoint.walletAddress || null,
          parentAddress: body.parent_address || checkpoint.config.parentAddress,
          status,
          bootCommand,
          bootOutput,
          createdAt,
        };
        settlementState.migrations.unshift(migration);
        persistState();
        return sendJson(res, status === "boot_failed" ? 500 : 200, migration);
      }

      if (req.method === "GET" && pathname === "/v1/migrations") {
        return sendJson(res, 200, { migrations: settlementState.migrations });
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        return sendJson(res, 200, {
          data: modelCatalog.map((entry) => ({
            id: entry.id,
            object: "model",
            provider: entry.provider,
            owned_by: entry.provider,
            display_name: entry.displayName || entry.id,
            context_window: entry.contextWindow,
            max_tokens: entry.maxTokens,
            supports_tools: entry.supportsTools ?? false,
            supports_vision: entry.supportsVision ?? false,
            parameter_style: entry.parameterStyle || "max_tokens",
            available: entry.available !== false,
            pricing: {
              input_per_1k: entry.inputPer1kCents,
              output_per_1k: entry.outputPer1kCents,
              input_per_million: entry.pricing.inputPerMillion,
              output_per_million: entry.pricing.outputPerMillion,
            },
          })),
        });
      }

      if (req.method === "POST" && pathname === "/v1/automatons/register") {
        const body = await readBody(req);
        return sendJson(res, 200, { automaton: { registered: false, provider: "open-node", ...body } });
      }

      return sendJson(res, 404, { error: "not_found", path: pathname });
    } catch (err: any) {
      return sendJson(res, 500, { error: err.message || "internal_error" });
    }
  });

  return {
    host,
    port,
    rootDir,
    server,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          if (!queueInterval && autoProcessIntervalMs > 0) {
            queueInterval = setInterval(() => {
              void processSettlementQueues();
            }, autoProcessIntervalMs);
          }
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (queueInterval) {
          clearInterval(queueInterval);
          queueInterval = null;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apiKey = process.env.AUTOMATON_OPEN_NODE_API_KEY || "dev-open-node-key";
  const instance = createOpenNodeServer({ apiKey });
  instance.start().then(() => {
    process.stdout.write(
      `Open node listening on http://${instance.host}:${instance.port} using root ${instance.rootDir}\n`,
    );
  });
}
