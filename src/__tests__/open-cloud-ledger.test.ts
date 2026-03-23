import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import nodePath from "path";
import { createDatabase } from "../state/database.js";
import {
  DEFAULT_OPEN_CLOUD_PRICING,
  getCapabilityUnitPrice,
  persistSettlement,
  recordUsage,
} from "../billing/open-cloud-ledger.js";

describe("open cloud ledger", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "automaton-open-ledger-"));
    dbPath = nodePath.join(tmpDir, "state.db");
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records usage and computes operator settlement preview", () => {
    recordUsage(db.raw, {
      provider: "open-node",
      operatorId: "operator-1",
      sandboxId: "sb-1",
      capability: "exec",
      units: 12,
      unitPriceCents: getCapabilityUnitPrice("exec", DEFAULT_OPEN_CLOUD_PRICING),
      metadata: { command: "npm run build" },
    });

    recordUsage(db.raw, {
      provider: "open-node",
      operatorId: "operator-1",
      sandboxId: "sb-1",
      capability: "port_expose",
      units: 1,
      unitPriceCents: getCapabilityUnitPrice("port_expose", DEFAULT_OPEN_CLOUD_PRICING),
    });

    const settlement = persistSettlement(
      db.raw,
      "operator-1",
      "2000-01-01T00:00:00.000Z",
      "2999-01-01T00:00:00.000Z",
    );

    expect(settlement.grossCents).toBe(17);
    expect(settlement.platformFeeCents).toBe(0);
    expect(settlement.netCents).toBe(17);
    expect(settlement.status).toBe("pending");
  });
});
