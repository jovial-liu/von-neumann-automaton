# Open Cloud

Open Cloud is the open replacement for Conway Cloud inside Automaton.

The goal is not only "remote exec", but an agent-friendly runtime that can:

- run locally on a personal machine
- run on a third-party server
- use open HTTP nodes instead of Conway's private control plane
- preserve wallet + state continuity
- export/import checkpoints for migration
- keep the infrastructure layer open enough for future migration between providers

## Current Foundation

The current implementation adds three infrastructure modes:

- `conway`
  The existing private Conway control plane.

- `local`
  A self-hosted local provider that stores sandboxes under `~/.automaton/open-cloud`.

- `open-node`
  A third-party HTTP node provider that speaks an open sandbox/files/ports API.

## Config

Automaton config now supports:

```json
{
  "cloudProvider": "open-node",
  "cloudBaseUrl": "http://your-node.example.com:8787",
  "cloudApiKey": "replace-me",
  "cloudRootDir": "~/.automaton/open-cloud"
}
```

Valid values for `cloudProvider`:

- `conway`
- `local`
- `open-node`

## Open Node

The open node server is the first open-source substitute for the Conway infrastructure layer.

Start it with:

```bash
pnpm cloud:open-node
```

Environment variables:

- `AUTOMATON_OPEN_NODE_API_KEY`
- `AUTOMATON_OPEN_NODE_HOST`
- `AUTOMATON_OPEN_NODE_PORT`
- `AUTOMATON_OPEN_NODE_ROOT`
- `AUTOMATON_OPEN_NODE_CREDITS_CENTS`

Implemented endpoints:

- `POST /v1/sandboxes`
- `GET /v1/sandboxes`
- `DELETE /v1/sandboxes/:id`
- `POST /v1/sandboxes/:id/exec`
- `POST /v1/sandboxes/:id/files/upload/json`
- `GET /v1/sandboxes/:id/files/read`
- `POST /v1/sandboxes/:id/ports/expose`
- `DELETE /v1/sandboxes/:id/ports/:port`
- `GET /v1/credits/balance`
- `POST /v1/credits/transfer`
- `GET /v1/models`
- `POST /v1/automatons/register`

This is enough for Automaton to run against a third-party hosted infrastructure node without requiring Conway's private cloud.

## Migration

The first migration primitive is checkpoint export/import.

Checkpoint contents:

- `automaton.json`
- `wallet.json`
- `heartbeat.yml`
- `SOUL.md` if present
- `genesis.json` if present
- `state.db`
- files under `skills/`

This is implemented in:

- `src/migration/checkpoint.ts`

The intent is to use this for controlled migration:

1. export checkpoint from current node
2. transfer checkpoint to destination node
3. import checkpoint on destination
4. resume loop with same wallet and state

## What Is Still Missing

This is not yet full Conway Cloud parity. The big missing pieces are:

- hosted inference proxying
- crypto-funded utility billing for real node operators
- internet-facing migration orchestration
- DNS/domain lifecycle support for open nodes
- cross-node drain/handoff orchestration
- production-safe attestation and trust policies

## Next Build Targets

The next layers to add are:

1. metered utility ledger for node operators
2. remote checkpoint transfer + restore workflow
3. inference proxy support on open nodes
4. migration coordinator
5. open domain/DNS provider abstraction
