import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import nodePath from "path";
import { createInfrastructureClient } from "../cloud/provider-factory.js";

describe("open cloud provider factory", () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "automaton-open-cloud-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses the local provider to create scoped sandboxes and files", async () => {
    const client = createInfrastructureClient({
      provider: "local",
      apiUrl: "https://api.conway.tech",
      apiKey: "unused",
      sandboxId: "",
      cloudRootDir: tmpDir,
      createConwayControlPlaneClient: () => {
        throw new Error("unexpected conway client");
      },
    });

    const sandbox = await client.createSandbox({ name: "local-test" });
    const scoped = client.createScopedClient(sandbox.id);
    await scoped.writeFile("/notes.txt", "hello local cloud");
    const content = await scoped.readFile("/notes.txt");

    expect(content).toBe("hello local cloud");

    const listed = await client.listSandboxes();
    expect(listed.some((entry) => entry.id === sandbox.id)).toBe(true);
  });

  it("uses the open-node provider against a third-party HTTP node", async () => {
    const files = new Map<string, string>();
    const sandboxes = [{ id: "sb-open-node", status: "running", region: "open-node", vcpu: 1, memory_mb: 512, disk_gb: 5, created_at: new Date().toISOString() }];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method || "GET";

      if (url.endsWith("/v1/sandboxes") && method === "POST") {
        return Response.json(sandboxes[0]);
      }

      if (url.endsWith("/v1/credits/balance")) {
        return Response.json({ balance_cents: 12345 });
      }

      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [] });
      }

      if (url.includes("/files/upload/json") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        files.set(body.path, body.content);
        return Response.json({ ok: true });
      }

      if (url.includes("/files/read") && method === "GET") {
        const parsed = new URL(url);
        const path = parsed.searchParams.get("path") || "";
        return Response.json({ content: files.get(path) || "" });
      }

      if (url.endsWith("/exec") && method === "POST") {
        return Response.json({ stdout: files.get("/hello.txt") || "", stderr: "", exit_code: 0 });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof globalThis.fetch;

    const client = createInfrastructureClient({
      provider: "open-node",
      apiUrl: "https://api.conway.tech",
      apiKey: "unused",
      sandboxId: "",
      cloudBaseUrl: "http://127.0.0.1:8791",
      cloudApiKey: "open-node-test-key",
      createConwayControlPlaneClient: () => {
        throw new Error("unexpected conway client");
      },
    });

    const sandbox = await client.createSandbox({ name: "remote-test" });
    const scoped = client.createScopedClient(sandbox.id);

    await scoped.writeFile("/hello.txt", "from open node");
    const content = await scoped.readFile("/hello.txt");
    const execResult = await scoped.exec("cat hello.txt");
    const balance = await client.getCreditsBalance();

    expect(content).toBe("from open node");
    expect(execResult.stdout.trim()).toBe("from open node");
    expect(balance).toBe(12345);
  });
});
