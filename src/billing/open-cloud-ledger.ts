import { ulid } from "ulid";
import type {
  OpenCloudCapability,
  OpenCloudUsageRecord,
  OperatorSettlementRecord,
} from "../types.js";
import {
  openCloudUsageGetAll,
  openCloudUsageInsert,
  operatorSettlementGetAll,
  operatorSettlementInsert,
} from "../state/database.js";

export interface OpenCloudPricingConfig {
  execPricePerSecondCents: number;
  fileWritePriceCents: number;
  fileReadPriceCents: number;
  portExposePriceCents: number;
  modelProxyPriceCents: number;
  migrationPriceCents: number;
  platformFeeBps: number;
}

export interface OpenCloudUsageInput {
  provider: string;
  operatorId: string;
  sandboxId: string;
  capability: OpenCloudCapability;
  units: number;
  unitPriceCents: number;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_OPEN_CLOUD_PRICING: OpenCloudPricingConfig = {
  execPricePerSecondCents: 1,
  fileWritePriceCents: 1,
  fileReadPriceCents: 0,
  portExposePriceCents: 5,
  modelProxyPriceCents: 3,
  migrationPriceCents: 25,
  platformFeeBps: 500,
};

export function calculateUsageTotal(units: number, unitPriceCents: number): number {
  return Math.max(0, Math.ceil(units * unitPriceCents));
}

export function getCapabilityUnitPrice(
  capability: OpenCloudCapability,
  pricing: OpenCloudPricingConfig = DEFAULT_OPEN_CLOUD_PRICING,
): number {
  switch (capability) {
    case "exec":
      return pricing.execPricePerSecondCents;
    case "file_write":
      return pricing.fileWritePriceCents;
    case "file_read":
      return pricing.fileReadPriceCents;
    case "port_expose":
      return pricing.portExposePriceCents;
    case "model_proxy":
      return pricing.modelProxyPriceCents;
    case "migration":
      return pricing.migrationPriceCents;
  }
}

export function createUsageRecord(input: OpenCloudUsageInput): OpenCloudUsageRecord {
  return {
    id: ulid(),
    provider: input.provider,
    operatorId: input.operatorId,
    sandboxId: input.sandboxId,
    capability: input.capability,
    units: input.units,
    unitPriceCents: input.unitPriceCents,
    totalPriceCents: calculateUsageTotal(input.units, input.unitPriceCents),
    metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    createdAt: new Date().toISOString(),
  };
}

export function recordUsage(
  db: import("better-sqlite3").Database,
  input: OpenCloudUsageInput,
): OpenCloudUsageRecord {
  const record = createUsageRecord(input);
  openCloudUsageInsert(db, {
    ...record,
    metadata: record.metadata ?? "{}",
  });
  return record;
}

export function previewSettlement(
  db: import("better-sqlite3").Database,
  operatorId: string,
  periodStart: string,
  periodEnd: string,
  pricing: OpenCloudPricingConfig = DEFAULT_OPEN_CLOUD_PRICING,
): OperatorSettlementRecord {
  const usage = openCloudUsageGetAll(db, { operatorId, periodStart, periodEnd });
  const grossCents = usage.reduce((sum, row) => sum + row.totalPriceCents, 0);
  const platformFeeCents = Math.floor((grossCents * pricing.platformFeeBps) / 10_000);
  const netCents = Math.max(0, grossCents - platformFeeCents);

  return {
    id: ulid(),
    operatorId,
    periodStart,
    periodEnd,
    grossCents,
    platformFeeCents,
    netCents,
    status: "pending",
    metadata: JSON.stringify({ usageCount: usage.length }),
    createdAt: new Date().toISOString(),
  };
}

export function persistSettlement(
  db: import("better-sqlite3").Database,
  operatorId: string,
  periodStart: string,
  periodEnd: string,
  pricing: OpenCloudPricingConfig = DEFAULT_OPEN_CLOUD_PRICING,
): OperatorSettlementRecord {
  const settlement = previewSettlement(db, operatorId, periodStart, periodEnd, pricing);
  operatorSettlementInsert(db, {
    ...settlement,
    metadata: settlement.metadata ?? "{}",
  });
  return settlement;
}

export function listOperatorSettlements(
  db: import("better-sqlite3").Database,
  operatorId?: string,
): OperatorSettlementRecord[] {
  return operatorSettlementGetAll(db, operatorId ? { operatorId } : undefined);
}
