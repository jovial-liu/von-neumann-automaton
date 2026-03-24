# Open Cloud

Open Cloud is the open replacement for Conway Cloud inside `von-neumann-automaton`.

The goal is not only "remote exec", but a cloud substrate for a self-replicating agent system that can:

- run locally on a personal machine
- run on a third-party server
- use open HTTP nodes instead of Conway's private control plane
- preserve wallet + state continuity
- export/import checkpoints for migration
- reproduce onto another cloud
- let cloud operators charge service fees
- keep the infrastructure layer open enough for future migration between providers

This is the cloud half of the Von Neumann reproducer idea:

- description of the machine -> checkpoint
- transmission -> migration API
- reconstruction -> restore on remote node
- activation -> boot child runtime
- economics -> metered cloud settlement

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

The open node server is the first open-source substitute for the Conway infrastructure layer in this project.

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
- `AUTOMATON_OPEN_NODE_OPERATOR_PRIVATE_KEY`
- `AUTOMATON_OPEN_NODE_RPC_URL`
- `AUTOMATON_OPEN_NODE_CHILD_BOOT_COMMAND`

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
- `POST /v1/inference/chat`
- `GET /v1/settlement/operator`
- `POST /v1/settlement/operator/wallet`
- `POST /v1/settlement/accounts/deposit`
- `POST /pay/deposit/:sandboxId/:amountCents`
- `POST /v1/settlement/process`
- `GET /v1/settlement/payments`
- `POST /v1/settlement/payments/:id/claim`
- `GET /v1/settlement/withdrawals`
- `POST /v1/settlement/withdrawals`
- `POST /v1/migrations/import`
- `GET /v1/migrations`

This is enough for `von-neumann-automaton` to run against a third-party hosted infrastructure node without requiring Conway's private cloud, and to start reproducing children onto remote nodes with metered settlement.

## Migration And Reproduction

The migration primitive is checkpoint export/import plus remote restore and boot.

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

The intent is to use this for controlled migration and reproduction:

1. export checkpoint from current node
2. transfer checkpoint to destination node
3. import checkpoint on destination
4. restore wallet, config, state, and skills
5. boot the child runtime on destination
6. let the destination cloud charge migration + hosting + inference fees

This is the key idea behind `von-neumann-automaton`: a child should be able to survive on a different cloud, and that cloud should have an incentive to host it.

## Settlement

The settlement layer is meant to make open cloud hosting economically viable.

Current pieces:

- operator wallet state
- agent deposit and hold balance tracking
- usage accrual
- settlement close
- withdrawal queue
- x402 authorization deposits
- automatic claim and retry processing
- withdrawal broadcasting

This is not yet fully hardened finance infrastructure, but it is the beginning of a real service-fee model for open cloud nodes.

## What Is Still Missing

This is still not full Conway Cloud parity. The big missing pieces are:

- DNS/domain lifecycle support for open nodes
- stronger cross-node drain/handoff orchestration
- production-safe attestation and trust policies
- stronger child supervision and recovery
- multi-node routing and discovery
- production-grade confirmation handling for settlement queues

## Next Build Targets

The next layers to add are:

1. production hardening for settlement and queues
2. stronger remote child supervisor / restart model
3. migration coordinator across multiple public nodes
4. open domain/DNS provider abstraction
5. attestation, trust, and abuse control
