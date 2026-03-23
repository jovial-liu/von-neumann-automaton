import type { ConwayClient } from "../types.js";
import { createLocalCloudClient } from "./local-client.js";
import { createOpenNodeClient } from "./open-node-client.js";

export interface CloudClientFactoryOptions {
  provider?: "conway" | "local" | "open-node";
  apiUrl: string;
  apiKey: string;
  sandboxId: string;
  cloudBaseUrl?: string;
  cloudApiKey?: string;
  cloudRootDir?: string;
  createConwayControlPlaneClient: (options: {
    apiUrl: string;
    apiKey: string;
    sandboxId: string;
  }) => ConwayClient;
}

export function createInfrastructureClient(options: CloudClientFactoryOptions): ConwayClient {
  const provider = options.provider || "conway";

  if (provider === "local") {
    return createLocalCloudClient({
      rootDir: options.cloudRootDir,
      sandboxId: options.sandboxId,
    });
  }

  if (provider === "open-node") {
    return createOpenNodeClient({
      apiUrl: options.cloudBaseUrl || options.apiUrl,
      apiKey: options.cloudApiKey || options.apiKey,
      sandboxId: options.sandboxId,
    });
  }

  return options.createConwayControlPlaneClient({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    sandboxId: options.sandboxId,
  });
}
