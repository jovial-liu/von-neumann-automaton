import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import nodePath from "path";
import { Readable } from "stream";
import { privateKeyToAccount } from "viem/accounts";
import { createOpenNodeServer } from "../cloud/open-node-server.js";
import * as x402 from "../conway/x402.js";

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
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      },
    };
    const handler = params.server.listeners("request")[0] as (
      req: any,
      res: any,
    ) => Promise<void>;
    Promise.resolve(handler(req as any, res as any)).catch(reject);
  });
}

describe("open-node settlement flow", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "automaton-open-node-settlement-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracks deposit, hold, usage accrual, settlement close, withdrawal, and persistence", async () => {
    process.env.OPENAI_API_KEY = "upstream-openai-key";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.openai.com/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl_upstream",
          model: "gpt-5-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "hello" },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const serverA = createOpenNodeServer({
      apiKey: "node-key",
      rootDir: tmpDir,
      initialCreditsCents: 500,
    });

    await invokeServerJson({
      server: serverA.server,
      method: "POST",
      path: "/v1/settlement/operator/wallet",
      apiKey: "node-key",
      body: { wallet_address: "0xoperator" },
    });

    const deposit = await invokeServerJson({
      server: serverA.server,
      method: "POST",
      path: "/v1/settlement/accounts/deposit",
      apiKey: "node-key",
      body: {
        sandbox_id: "sb-1",
        wallet_address: "0xagent",
        amount_cents: 1000,
        tx_hash: "0xdeposit",
      },
    });
    expect(deposit.account.availableBalanceCents).toBe(1000);

    const held = await invokeServerJson({
      server: serverA.server,
      method: "POST",
      path: "/v1/settlement/accounts/sb-1/hold",
      apiKey: "node-key",
      body: { amount_cents: 300, reason: "reserve inference" },
    });
    expect(held.account.availableBalanceCents).toBe(700);
    expect(held.account.heldBalanceCents).toBe(300);

    await invokeServerJson({
      server: serverA.server,
      method: "POST",
      path: "/v1/inference/chat",
      apiKey: "node-key",
      body: {
        sandbox_id: "sb-1",
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const accountAfterUsage = await invokeServerJson({
      server: serverA.server,
      method: "GET",
      path: "/v1/settlement/accounts/sb-1",
      apiKey: "node-key",
    });
    expect(accountAfterUsage.account.heldBalanceCents).toBeLessThan(300);
    expect(accountAfterUsage.account.accruedUsageCents).toBeGreaterThan(0);

    const preview = await invokeServerJson({
      server: serverA.server,
      method: "GET",
      path: "/v1/settlement/settlements/preview",
      apiKey: "node-key",
    });
    expect(preview.grossCents).toBeGreaterThan(0);
    expect(preview.pendingSettlementCents).toBe(preview.grossCents);

    const closed = await invokeServerJson({
      server: serverA.server,
      method: "POST",
      path: "/v1/settlement/settlements/close",
      apiKey: "node-key",
    });
    expect(closed.status).toBe("settled");
    expect(closed.netCents).toBeGreaterThan(0);

    const withdrawal = await invokeServerJson({
      server: serverA.server,
      method: "POST",
      path: "/v1/settlement/withdrawals",
      apiKey: "node-key",
      body: { amount_cents: Math.max(1, closed.netCents - 1), note: "operator cash out" },
    });
    expect(withdrawal.status).toBe("requested");

    const serverB = createOpenNodeServer({
      apiKey: "node-key",
      rootDir: tmpDir,
    });

    const persistedOperator = await invokeServerJson({
      server: serverB.server,
      method: "GET",
      path: "/v1/settlement/operator",
      apiKey: "node-key",
    });
    expect(persistedOperator.operator.walletAddress).toBe("0xoperator");
    expect(persistedOperator.operator.totalWithdrawnCents).toBe(withdrawal.amountCents);

    const persistedWithdrawals = await invokeServerJson({
      server: serverB.server,
      method: "GET",
      path: "/v1/settlement/withdrawals",
      apiKey: "node-key",
    });
    expect(persistedWithdrawals.withdrawals).toHaveLength(1);
  });

  it("accepts x402 USDC authorization deposits for settlement funding", async () => {
    const operatorWallet = "0x1234567890123456789012345678901234567890";
    const payer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044976f7d7e4c6f6d71b0b4d7e5f9d1d9c9a3f0b8e5f55",
    );
    const amountCents = 250;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${"11".repeat(32)}` as `0x${string}`;

    const server = createOpenNodeServer({
      apiKey: "node-key",
      rootDir: tmpDir,
    });

    await invokeServerJson({
      server: server.server,
      method: "POST",
      path: "/v1/settlement/operator/wallet",
      apiKey: "node-key",
      body: { wallet_address: operatorWallet },
    });

    const requirement = await invokeServerJson({
      server: server.server,
      method: "GET",
      path: `/pay/deposit/sb-x402/${amountCents}?wallet=${payer.address}`,
      apiKey: "node-key",
    });
    expect(requirement.accepts[0].payToAddress).toBe(operatorWallet);

    const signature = await payer.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: x402.getUsdcAddressForNetwork("eip155:8453")!,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payer.address,
        to: operatorWallet as `0x${string}`,
        value: BigInt(amountCents * 10_000),
        validAfter: BigInt(now - 60),
        validBefore: BigInt(now + 300),
        nonce,
      },
    });

    const paymentHeader = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453",
        payload: {
          signature,
          authorization: {
            from: payer.address,
            to: operatorWallet,
            value: String(amountCents * 10_000),
            validAfter: String(now - 60),
            validBefore: String(now + 300),
            nonce,
          },
        },
      }),
    ).toString("base64");

    const paidReq = Object.assign(Readable.from([]), {
      method: "POST",
      url: `/pay/deposit/sb-x402/${amountCents}?wallet=${payer.address}`,
      headers: {
        host: "open-node.test",
        authorization: "node-key",
        "x-payment": paymentHeader,
      },
    });

    const paidResp = await new Promise<any>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const res = {
        statusCode: 200,
        setHeader() {},
        end(chunk?: string | Buffer) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        },
      };
      const handler = server.server.listeners("request")[0] as (req: any, res: any) => Promise<void>;
      Promise.resolve(handler(paidReq as any, res as any)).catch(reject);
    });

    expect(paidResp.ok).toBe(true);
    expect(paidResp.account.availableBalanceCents).toBe(amountCents);

    const payments = await invokeServerJson({
      server: server.server,
      method: "GET",
      path: "/v1/settlement/payments",
      apiKey: "node-key",
    });
    expect(payments.payments).toHaveLength(1);
    expect(payments.payments[0].payerAddress).toBe(payer.address);
  });

  it("claims authorized x402 receipts into on-chain settlement", async () => {
    const claimSpy = vi
      .spyOn(x402, "claimX402Payment")
      .mockResolvedValue({ txHash: "0xclaimhash" as `0x${string}` });

    const operatorWallet = "0x1234567890123456789012345678901234567890";
    const payer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044976f7d7e4c6f6d71b0b4d7e5f9d1d9c9a3f0b8e5f55",
    );
    const amountCents = 250;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${"22".repeat(32)}` as `0x${string}`;
    process.env.AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY =
      "0x8b3a350cf5c34c9194ca3ab3b2ec7f6f9c8f74b3f2f72f1f0a0b1c2d3e4f5678";

    const server = createOpenNodeServer({
      apiKey: "node-key",
      rootDir: tmpDir,
    });

    await invokeServerJson({
      server: server.server,
      method: "POST",
      path: "/v1/settlement/operator/wallet",
      apiKey: "node-key",
      body: { wallet_address: operatorWallet },
    });

    const signature = await payer.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: x402.getUsdcAddressForNetwork("eip155:8453")!,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payer.address,
        to: operatorWallet as `0x${string}`,
        value: BigInt(amountCents * 10_000),
        validAfter: BigInt(now - 60),
        validBefore: BigInt(now + 300),
        nonce,
      },
    });

    const paymentHeader = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: "eip155:8453",
        payload: {
          signature,
          authorization: {
            from: payer.address,
            to: operatorWallet,
            value: String(amountCents * 10_000),
            validAfter: String(now - 60),
            validBefore: String(now + 300),
            nonce,
          },
        },
      }),
    ).toString("base64");

    await new Promise<any>((resolve, reject) => {
      const req = Object.assign(Readable.from([]), {
        method: "POST",
        url: `/pay/deposit/sb-claim/${amountCents}?wallet=${payer.address}`,
        headers: {
          host: "open-node.test",
          authorization: "node-key",
          "x-payment": paymentHeader,
        },
      });
      const chunks: Buffer[] = [];
      const res = {
        statusCode: 200,
        setHeader() {},
        end(chunk?: string | Buffer) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        },
      };
      const handler = server.server.listeners("request")[0] as (req: any, res: any) => Promise<void>;
      Promise.resolve(handler(req as any, res as any)).catch(reject);
    });

    const payments = await invokeServerJson({
      server: server.server,
      method: "GET",
      path: "/v1/settlement/payments",
      apiKey: "node-key",
    });
    const receiptId = payments.payments[0].id;

    const claimed = await invokeServerJson({
      server: server.server,
      method: "POST",
      path: `/v1/settlement/payments/${receiptId}/claim`,
      apiKey: "node-key",
    });

    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimTxHash).toBe("0xclaimhash");
  });

  it("retries failed claims through the settlement processor", async () => {
    const claimSpy = vi
      .spyOn(x402, "claimX402Payment")
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockResolvedValueOnce({ txHash: "0xclaimedlater" as `0x${string}` });

    const operatorWallet = "0x1234567890123456789012345678901234567890";
    const payer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044976f7d7e4c6f6d71b0b4d7e5f9d1d9c9a3f0b8e5f55",
    );
    const amountCents = 250;
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${"33".repeat(32)}` as `0x${string}`;
    process.env.AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY =
      "0x8b3a350cf5c34c9194ca3ab3b2ec7f6f9c8f74b3f2f72f1f0a0b1c2d3e4f5678";

    const server = createOpenNodeServer({ apiKey: "node-key", rootDir: tmpDir });
    await invokeServerJson({
      server: server.server,
      method: "POST",
      path: "/v1/settlement/operator/wallet",
      apiKey: "node-key",
      body: { wallet_address: operatorWallet },
    });

    const signature = await payer.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: x402.getUsdcAddressForNetwork("eip155:8453")! },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payer.address,
        to: operatorWallet as `0x${string}`,
        value: BigInt(amountCents * 10_000),
        validAfter: BigInt(now - 60),
        validBefore: BigInt(now + 300),
        nonce,
      },
    });
    const paymentHeader = Buffer.from(JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: payer.address,
          to: operatorWallet,
          value: String(amountCents * 10_000),
          validAfter: String(now - 60),
          validBefore: String(now + 300),
          nonce,
        },
      },
    })).toString("base64");
    await new Promise<any>((resolve, reject) => {
      const req = Object.assign(Readable.from([]), {
        method: "POST",
        url: `/pay/deposit/sb-retry/${amountCents}?wallet=${payer.address}`,
        headers: { host: "open-node.test", authorization: "node-key", "x-payment": paymentHeader },
      });
      const chunks: Buffer[] = [];
      const res = { statusCode: 200, setHeader() {}, end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } };
      const handler = server.server.listeners("request")[0] as (req: any, res: any) => Promise<void>;
      Promise.resolve(handler(req as any, res as any)).catch(reject);
    });

    let payments = await invokeServerJson({
      server: server.server,
      method: "POST",
      path: "/v1/settlement/process",
      apiKey: "node-key",
    });
    expect(payments.payments[0].status).toBe("failed");
    payments.payments[0].nextClaimRetryAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(nodePath.join(tmpDir, "settlement-state.json"), JSON.stringify({
      ...JSON.parse(fs.readFileSync(nodePath.join(tmpDir, "settlement-state.json"), "utf-8")),
      paymentReceipts: payments.payments,
    }, null, 2));

    const server2 = createOpenNodeServer({ apiKey: "node-key", rootDir: tmpDir });
    payments = await invokeServerJson({
      server: server2.server,
      method: "POST",
      path: "/v1/settlement/process",
      apiKey: "node-key",
    });
    expect(claimSpy).toHaveBeenCalledTimes(2);
    expect(payments.payments[0].status).toBe("claimed");
    expect(payments.payments[0].claimTxHash).toBe("0xclaimedlater");
  });

  it("broadcasts withdrawals and retries failures through the processor", async () => {
    const transferSpy = vi
      .spyOn(x402, "broadcastUsdcTransfer")
      .mockRejectedValueOnce(new Error("nonce too low"))
      .mockResolvedValueOnce({ txHash: "0xwithdrawhash" as `0x${string}` });
    process.env.AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY =
      "0x8b3a350cf5c34c9194ca3ab3b2ec7f6f9c8f74b3f2f72f1f0a0b1c2d3e4f5678";

    const server = createOpenNodeServer({ apiKey: "node-key", rootDir: tmpDir });
    await invokeServerJson({
      server: server.server,
      method: "POST",
      path: "/v1/settlement/operator/wallet",
      apiKey: "node-key",
      body: { wallet_address: "0x1234567890123456789012345678901234567890" },
    });

    const statePath = nodePath.join(tmpDir, "settlement-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state.operator.withdrawableCents = 500;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const server2 = createOpenNodeServer({ apiKey: "node-key", rootDir: tmpDir });
    await invokeServerJson({
      server: server2.server,
      method: "POST",
      path: "/v1/settlement/withdrawals",
      apiKey: "node-key",
      body: { amount_cents: 200, note: "cash out" },
    });

    let processed = await invokeServerJson({
      server: server2.server,
      method: "POST",
      path: "/v1/settlement/process",
      apiKey: "node-key",
    });
    expect(processed.withdrawals[0].status).toBe("failed");

    const state2 = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    state2.withdrawals[0].nextRetryAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state2, null, 2));

    const server3 = createOpenNodeServer({ apiKey: "node-key", rootDir: tmpDir });
    processed = await invokeServerJson({
      server: server3.server,
      method: "POST",
      path: "/v1/settlement/process",
      apiKey: "node-key",
    });
    expect(transferSpy).toHaveBeenCalledTimes(2);
    expect(processed.withdrawals[0].status).toBe("processed");
    expect(processed.withdrawals[0].txHash).toBe("0xwithdrawhash");
  });
});
