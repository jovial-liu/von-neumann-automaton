import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import nodePath from "path";
import { Readable } from "stream";
import { createInferenceClient } from "../conway/inference.js";
import { createOpenNodeServer } from "../cloud/open-node-server.js";

async function invokeServerJson(params: {
  server: ReturnType<typeof createOpenNodeServer>["server"];
  method: string;
  path: string;
  apiKey: string;
  body?: unknown;
}): Promise<any> {
  const payload =
    params.body === undefined ? "" : JSON.stringify(params.body);
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
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      },
    };

    const handler = params.server.listeners("request")[0] as (
      req: any,
      res: any,
    ) => Promise<void>;
    Promise.resolve(handler(req as any, res as any)).catch(reject);
  });
}

describe("open-node inference proxy", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "automaton-open-node-inference-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes agent inference through the open-node proxy path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("http://node.example.com/v1/inference/chat");

      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.sandbox_id).toBe("sb-proxy");
      expect(body.model).toBe("gpt-5-mini");

      return Response.json({
        id: "chatcmpl_proxy",
        model: "gpt-5-mini",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "proxied",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        },
      });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = createInferenceClient({
      apiUrl: "http://node.example.com",
      apiKey: "open-node-key",
      defaultModel: "gpt-5-mini",
      maxTokens: 256,
      proxyRequestPath: "/v1/inference/chat",
      proxySandboxId: "sb-proxy",
    });

    const response = await client.chat([{ role: "user", content: "hello" }], {
      model: "gpt-5-mini",
    });

    expect(response.message.content).toBe("proxied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes models and records per-request inference usage", async () => {
    process.env.OPENAI_API_KEY = "upstream-openai-key";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.openai.com/v1/chat/completions") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.model).toBe("gpt-5-mini");
        return Response.json({
          id: "chatcmpl_upstream",
          model: "gpt-5-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "hello from upstream",
              },
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

    const instance = createOpenNodeServer({
      apiKey: "node-key",
      rootDir: tmpDir,
      initialCreditsCents: 500,
    });

    const models = await invokeServerJson({
      server: instance.server,
      method: "GET",
      path: "/v1/models",
      apiKey: "node-key",
    });
    expect(models.data.some((entry: any) => entry.id === "gpt-5-mini")).toBe(true);
    expect(models.data.find((entry: any) => entry.id === "gpt-5-mini").supports_tools).toBe(true);

    const completion = await invokeServerJson({
      server: instance.server,
      method: "POST",
      path: "/v1/inference/chat",
      apiKey: "node-key",
      body: {
        sandbox_id: "sb-inference",
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 128,
      },
    });

    expect(completion.choices[0].message.content).toBe("hello from upstream");
    expect(completion.usage.total_tokens).toBe(150);

    const usage = await invokeServerJson({
      server: instance.server,
      method: "GET",
      path: "/v1/ledger/usage",
      apiKey: "node-key",
    });

    expect(usage.usage).toHaveLength(1);
    expect(usage.usage[0].capability).toBe("model_proxy");
    expect(usage.usage[0].sandboxId).toBe("sb-inference");
    expect(usage.usage[0].totalPriceCents).toBeGreaterThan(0);

    const metadata = JSON.parse(usage.usage[0].metadata);
    expect(metadata.input_tokens).toBe(120);
    expect(metadata.output_tokens).toBe(30);
    expect(metadata.provider).toBe("openai");
  });
});
