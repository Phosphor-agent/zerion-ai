# zerion-ai SDK (Phosphor fork)

Programmatic, typed entry-point for AI agents to send SPL tokens on Solana —
no CLI spawn, no keystore dance, no interactive passphrase.

This fork adds two Phosphor-specific extensions on top of the upstream Zerion CLI:

1. **`metadata.memo`** — when set, becomes a real Memo-program instruction in
   the **same transaction** as the transfer. Audit anchor and value transfer
   settle atomically: one signature, one slot, one chain record.
2. **`phosphorAuditHook`** — callback fired after the tx confirms, receiving
   `{ signature, slot, mint, amount, recipient, memo, network }`. Lets the
   runtime append to its audit trail without polling.

## Usage

```ts
import { send } from "zerion-ai";

const result = await send({
  recipient: "BobPubkeyBase58…",
  amount: 5,                       // 5 USDC
  token: "USDC",                   // resolves to devnet/mainnet mint
  signerSecret: process.env.AGENT_WALLET_KEY!, // base58 ed25519 secret
  network: "devnet",
  metadata: {
    memo: JSON.stringify({ kind: "phosphor.audit.v1", intentId: "..." }),
  },
  phosphorAuditHook: async (e) => {
    await auditEmit({ kind: "execution.confirmed", ...e });
  },
});

console.log(result.signature, result.explorerUrl);
```

## API

### `send(options)`

| field | type | notes |
|---|---|---|
| `recipient` | `string` | base58 pubkey |
| `amount` | `number` | human-readable (5 = 5 USDC) |
| `token` | `"USDC"` | (default) known symbol — resolves mint + decimals |
| `mint` | `string?` | override mint pubkey |
| `decimals` | `number?` | required with custom `mint` |
| `signerSecret` | `string` | base58 ed25519 secret |
| `rpcUrl` | `string?` | overrides cluster default |
| `network` | `"devnet" \| "mainnet"` | default `"devnet"` |
| `metadata.memo` | `string?` | added as Memo-program ix in same tx |
| `phosphorAuditHook` | `(e) => void \| Promise<void>` | fired after confirm |

Returns `{ signature, slot, mint, amount, recipient, memo, network, explorerUrl }`.

## Why a separate SDK file?

The upstream Zerion CLI is built around the Open-Wallet-Standard keystore +
interactive agent-token guard, which doesn't fit an autonomous agent runtime
that already manages its own key material. The `sdk/` directory ships a
clean programmatic surface that re-uses the same on-chain primitives without
forcing agents through the CLI flow.
