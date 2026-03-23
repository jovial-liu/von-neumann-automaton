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
  OpenNodeMigrationResult,
  OpenNodeOperatorSettlementState,
  OpenNodePaymentReceipt,
  OpenNodeSettlementAccountState,
  OpenNodeSettlementPreview,
  OpenNodeWithdrawalRequest,
  PortInfo,
  PricingTier,
  SandboxInfo,
} from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { normalizeSandboxId } from "./shared.js";

interface OpenNodeClientOptions {
  apiUrl: string;
  apiKey?: string;
  sandboxId?: string;
}

export function createOpenNodeClient(options: OpenNodeClientOptions): ConwayClient {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const apiKey = options.apiKey || "";
  const sandboxId = normalizeSandboxId(options.sandboxId);
  const httpClient = new ResilientHttpClient();

  async function request(
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: { retries404?: number; idempotencyKey?: string },
  ): Promise<any> {
    const max404Retries = requestOptions?.retries404 ?? 0;
    for (let attempt = 0; attempt <= max404Retries; attempt++) {
      const resp = await httpClient.request(`${apiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: apiKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        idempotencyKey: requestOptions?.idempotencyKey,
      });

      if (resp.status === 404 && attempt < max404Retries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text();
        const err: any = new Error(`Open node API error: ${method} ${path} -> ${resp.status}: ${text}`);
        err.status = resp.status;
        throw err;
      }

      return resp.headers.get("content-type")?.includes("application/json")
        ? resp.json()
        : resp.text();
    }

    throw new Error("Unreachable");
  }

  const exec = async (command: string, timeout?: number): Promise<ExecResult> => {
    const result = await request("POST", `/v1/sandboxes/${sandboxId}/exec`, { command, timeout });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.exit_code ?? result.exitCode ?? 0,
    };
  };

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    await request("POST", `/v1/sandboxes/${sandboxId}/files/upload/json`, {
      path: filePath,
      content,
    });
  };

  const readFile = async (filePath: string): Promise<string> => {
    const result = await request(
      "GET",
      `/v1/sandboxes/${sandboxId}/files/read?path=${encodeURIComponent(filePath)}`,
    );
    return typeof result === "string" ? result : result.content || "";
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    const result = await request("POST", `/v1/sandboxes/${sandboxId}/ports/expose`, { port });
    return {
      port: result.port ?? port,
      publicUrl: result.public_url || result.publicUrl || result.url,
      sandboxId,
    };
  };

  const removePort = async (port: number): Promise<void> => {
    await request("DELETE", `/v1/sandboxes/${sandboxId}/ports/${port}`);
  };

  const createSandbox = async (sandboxOptions: CreateSandboxOptions): Promise<SandboxInfo> => {
    const result = await request("POST", "/v1/sandboxes", {
      name: sandboxOptions.name,
      vcpu: sandboxOptions.vcpu || 1,
      memory_mb: sandboxOptions.memoryMb || 512,
      disk_gb: sandboxOptions.diskGb || 5,
      region: sandboxOptions.region,
    });
    return {
      id: result.id || result.sandbox_id,
      status: result.status || "running",
      region: result.region || "",
      vcpu: result.vcpu || sandboxOptions.vcpu || 1,
      memoryMb: result.memory_mb || sandboxOptions.memoryMb || 512,
      diskGb: result.disk_gb || sandboxOptions.diskGb || 5,
      terminalUrl: result.terminal_url,
      createdAt: result.created_at || new Date().toISOString(),
    };
  };

  const deleteSandbox = async (targetSandboxId: string): Promise<void> => {
    await request("DELETE", `/v1/sandboxes/${targetSandboxId}`);
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    const result = await request("GET", "/v1/sandboxes");
    const sandboxes = Array.isArray(result) ? result : result.sandboxes || [];
    return sandboxes.map((s: any) => ({
      id: s.id || s.sandbox_id,
      status: s.status || "unknown",
      region: s.region || "",
      vcpu: s.vcpu || 0,
      memoryMb: s.memory_mb || 0,
      diskGb: s.disk_gb || 0,
      terminalUrl: s.terminal_url,
      createdAt: s.created_at || "",
    }));
  };

  const getCreditsBalance = async (): Promise<number> => {
    const balancePaths = ["/v1/credits/balance", "/v1/ledger/balance"];
    for (const path of balancePaths) {
      try {
        const result = await request("GET", path);
        return result.balance_cents ?? result.credits_cents ?? 0;
      } catch (err: any) {
        if (err?.status === 404) continue;
        throw err;
      }
    }
    return 0;
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    try {
      const result = await request("GET", "/v1/credits/pricing");
      const tiers = result.tiers || result.pricing || [];
      return tiers.map((t: any) => ({
        name: t.name || "",
        vcpu: t.vcpu || 0,
        memoryMb: t.memory_mb || 0,
        diskGb: t.disk_gb || 0,
        monthlyCents: t.monthly_cents || 0,
      }));
    } catch (err: any) {
      if (err?.status === 404) return [];
      throw err;
    }
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<CreditTransferResult> => {
    const payload = { to_address: toAddress, amount_cents: amountCents, note };
    const paths = ["/v1/credits/transfer", "/v1/ledger/transfer"];
    let lastError = "unknown error";

    for (const path of paths) {
      try {
        const result = await request("POST", path, payload, { idempotencyKey: ulid() });
        return {
          transferId: result.transfer_id || result.id || ulid(),
          status: result.status || "submitted",
          toAddress: result.to_address || toAddress,
          amountCents: result.amount_cents ?? amountCents,
          balanceAfterCents: result.balance_after_cents ?? result.new_balance_cents ?? undefined,
        };
      } catch (err: any) {
        lastError = err.message;
        if (err?.status === 404) continue;
        throw err;
      }
    }

    throw new Error(`Open node transfer failed: ${lastError}`);
  };

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    try {
      return await request("POST", "/v1/automatons/register", params);
    } catch (err: any) {
      if (err?.status === 404) {
        return {
          automaton: {
            provider: "open-node",
            registered: false,
            reason: "remote node does not expose a registry endpoint",
            ...params,
          },
        };
      }
      throw err;
    }
  };

  const searchDomains = async (query: string, tlds?: string): Promise<DomainSearchResult[]> => {
    const params = new URLSearchParams({ query });
    if (tlds) params.set("tlds", tlds);
    const result = await request("GET", `/v1/domains/search?${params.toString()}`);
    const entries = result.results || result.domains || [];
    return entries.map((d: any) => ({
      domain: d.domain,
      available: d.available ?? d.purchasable ?? false,
      registrationPrice: d.registration_price ?? d.purchase_price,
      renewalPrice: d.renewal_price,
      currency: d.currency || "USD",
    }));
  };

  const registerDomain = async (domain: string, years = 1): Promise<DomainRegistration> => {
    const result = await request("POST", "/v1/domains/register", { domain, years });
    return {
      domain: result.domain || domain,
      status: result.status || "registered",
      expiresAt: result.expires_at || result.expiry,
      transactionId: result.transaction_id || result.id,
    };
  };

  const listDnsRecords = async (domain: string): Promise<DnsRecord[]> => {
    const result = await request("GET", `/v1/domains/${encodeURIComponent(domain)}/dns`);
    const records = result.records || result || [];
    return (Array.isArray(records) ? records : []).map((r: any) => ({
      id: r.id || r.record_id || "",
      type: r.type || "",
      host: r.host || r.name || "",
      value: r.value || r.answer || "",
      ttl: r.ttl,
      distance: r.distance ?? r.priority,
    }));
  };

  const addDnsRecord = async (
    domain: string,
    type: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<DnsRecord> => {
    const result = await request("POST", `/v1/domains/${encodeURIComponent(domain)}/dns`, {
      type,
      host,
      value,
      ttl: ttl || 3600,
    });
    return {
      id: result.id || result.record_id || "",
      type: result.type || type,
      host: result.host || host,
      value: result.value || value,
      ttl: result.ttl || ttl || 3600,
    };
  };

  const deleteDnsRecord = async (domain: string, recordId: string): Promise<void> => {
    await request("DELETE", `/v1/domains/${encodeURIComponent(domain)}/dns/${encodeURIComponent(recordId)}`);
  };

  const listModels = async (): Promise<ModelInfo[]> => {
    const result = await request("GET", "/v1/models");
    const raw = result.data || result.models || [];
    return raw.map((m: any) => ({
      id: m.id,
      provider: m.provider || m.owned_by || "unknown",
      displayName: m.display_name || m.id,
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
      supportsTools: m.supports_tools,
      supportsVision: m.supports_vision,
      parameterStyle: m.parameter_style,
      available: m.available,
      pricing: {
        inputPerMillion: m.pricing?.input_per_million ?? 0,
        outputPerMillion: m.pricing?.output_per_million ?? 0,
      },
    }));
  };

  const createScopedClient = (targetSandboxId: string): ConwayClient =>
    createOpenNodeClient({ apiUrl, apiKey, sandboxId: targetSandboxId });

  const configureSettlementOperatorWallet = async (
    walletAddress: string,
  ): Promise<OpenNodeOperatorSettlementState> => {
    return request("POST", "/v1/settlement/operator/wallet", {
      wallet_address: walletAddress,
    });
  };

  const getSettlementState = async (): Promise<{
    operator: OpenNodeOperatorSettlementState;
    preview: OpenNodeSettlementPreview;
  }> => request("GET", "/v1/settlement/operator");

  const getSettlementAccount = async (
    targetSandboxId = sandboxId,
  ): Promise<OpenNodeSettlementAccountState | undefined> => {
    const result = await request("GET", `/v1/settlement/accounts/${targetSandboxId}`);
    return result.account || undefined;
  };

  const depositSettlementFunds = async (params: {
    sandboxId?: string;
    walletAddress: string;
    amountCents: number;
    txHash?: string;
  }): Promise<OpenNodeSettlementAccountState> => {
    const result = await request("POST", "/v1/settlement/accounts/deposit", {
      sandbox_id: params.sandboxId || sandboxId,
      wallet_address: params.walletAddress,
      amount_cents: params.amountCents,
      tx_hash: params.txHash,
    });
    return result.account;
  };

  const createSettlementHold = async (
    amountCents: number,
    reason?: string,
  ): Promise<OpenNodeSettlementAccountState> => {
    const result = await request("POST", `/v1/settlement/accounts/${sandboxId}/hold`, {
      amount_cents: amountCents,
      reason,
    });
    return result.account;
  };

  const releaseSettlementHold = async (
    amountCents: number,
    reason?: string,
  ): Promise<OpenNodeSettlementAccountState> => {
    const result = await request("POST", `/v1/settlement/accounts/${sandboxId}/release`, {
      amount_cents: amountCents,
      reason,
    });
    return result.account;
  };

  const previewOperatorSettlement = async (): Promise<OpenNodeSettlementPreview> =>
    request("GET", "/v1/settlement/settlements/preview");

  const closeOperatorSettlement = async (): Promise<any> =>
    request("POST", "/v1/settlement/settlements/close");

  const requestOperatorWithdrawal = async (
    amountCents: number,
    note?: string,
  ): Promise<OpenNodeWithdrawalRequest> =>
    request("POST", "/v1/settlement/withdrawals", {
      amount_cents: amountCents,
      note,
    });

  const listSettlementPayments = async (): Promise<OpenNodePaymentReceipt[]> => {
    const result = await request("GET", "/v1/settlement/payments");
    return result.payments || [];
  };

  const claimSettlementPayment = async (receiptId: string): Promise<OpenNodePaymentReceipt> =>
    request("POST", `/v1/settlement/payments/${encodeURIComponent(receiptId)}/claim`);

  const processSettlementQueue = async (): Promise<{
    ok: boolean;
    payments: OpenNodePaymentReceipt[];
    withdrawals: OpenNodeWithdrawalRequest[];
  }> => request("POST", "/v1/settlement/process");

  const importCheckpoint = async (params: {
    checkpoint: any;
    parentAddress?: string;
    boot?: boolean;
    childName?: string;
  }): Promise<OpenNodeMigrationResult> =>
    request("POST", "/v1/migrations/import", {
      checkpoint: params.checkpoint,
      parent_address: params.parentAddress,
      boot: params.boot ?? true,
      child_name: params.childName,
    });

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
    configureSettlementOperatorWallet,
    getSettlementState,
    getSettlementAccount,
    depositSettlementFunds,
    createSettlementHold,
    releaseSettlementHold,
    previewOperatorSettlement,
    closeOperatorSettlement,
    requestOperatorWithdrawal,
    listSettlementPayments,
    claimSettlementPayment,
    processSettlementQueue,
    importCheckpoint,
  };
}
