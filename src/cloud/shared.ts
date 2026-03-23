import fs from "fs";
import nodePath from "path";

export function normalizeSandboxId(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (trimmed === "undefined" || trimmed === "null") return "";
  return trimmed;
}

export function resolveUserPath(filePath: string): string {
  return filePath.startsWith("~")
    ? nodePath.join(process.env.HOME || "/root", filePath.slice(1))
    : filePath;
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function providerNotSupported(provider: string, capability: string): Error {
  return new Error(`${provider} provider does not support ${capability}`);
}
