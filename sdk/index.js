/**
 * Zerion-AI SDK — Phosphor extension.
 *
 * Programmatic, typed entry-point for AI agents to send USDC (and other SPL
 * tokens) on Solana inside their own process — no CLI spawn, no keystore
 * dance, no interactive passphrase. Designed for the Phosphor agent runtime
 * (https://github.com/Phosphor-agent/Frontier) which needs:
 *
 *   1. An importable `send()` function returning a structured result.
 *   2. An optional `metadata.memo` field that lands as a real Memo-program
 *      instruction in the SAME transaction as the transfer — so the audit
 *      anchor and the value transfer settle atomically.
 *   3. A `phosphorAuditHook` callback fired after the tx confirms, receiving
 *      `{ signature, slot, mint, amount, recipient, memo }` so the runtime
 *      can append to its audit trail without polling.
 *
 * This file deliberately does NOT depend on the rest of the Zerion CLI
 * (which uses OWS keystore + agent-token guard). Agents pass a base58
 * secret key directly; the CLI flow remains untouched.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { Buffer } from "node:buffer";

/** Well-known Memo program v2 — same address on devnet and mainnet. */
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

/** Memo program hard limit. */
const MEMO_MAX_BYTES = 566;

const KNOWN_MINTS = {
  USDC: {
    devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
};

/**
 * @typedef {object} PhosphorAuditEvent
 * @property {string} signature
 * @property {number} slot
 * @property {string} mint
 * @property {number} amount
 * @property {string} recipient
 * @property {string=} memo
 * @property {"devnet"|"mainnet"} network
 */

/**
 * @typedef {object} ZerionSendOptions
 * @property {string} recipient                          - base58 pubkey of receiver
 * @property {number} amount                             - human-readable amount (e.g. 5 = 5 USDC)
 * @property {string=} token                             - "USDC" (default) — well-known symbol
 * @property {string=} mint                              - override mint pubkey (advanced)
 * @property {number=} decimals                          - override decimals (required if `mint` is set and token unknown)
 * @property {string} signerSecret                       - base58-encoded ed25519 secret key
 * @property {string=} rpcUrl                            - JSON-RPC endpoint (defaults to cluster default)
 * @property {"devnet"|"mainnet"=} network               - default "devnet"
 * @property {{ memo?: string }=} metadata               - optional metadata; `memo` becomes a Memo instr
 * @property {(e: PhosphorAuditEvent) => void|Promise<void>=} phosphorAuditHook
 */

/**
 * @typedef {object} ZerionSendResult
 * @property {string} signature
 * @property {number} slot
 * @property {string} mint
 * @property {number} amount
 * @property {string} recipient
 * @property {string=} memo
 * @property {"devnet"|"mainnet"} network
 * @property {string} explorerUrl
 */

/**
 * Build, sign, and broadcast a single SPL-token transfer (atomically combined
 * with a Memo instruction when `metadata.memo` is provided), then invoke the
 * optional Phosphor audit hook.
 *
 * @param {ZerionSendOptions} opts
 * @returns {Promise<ZerionSendResult>}
 */
export async function send(opts) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("zerion.send: options object required");
  }
  const {
    recipient,
    amount,
    token = "USDC",
    signerSecret,
    rpcUrl,
    network = "devnet",
    metadata,
    phosphorAuditHook,
  } = opts;

  if (!recipient) throw new Error("zerion.send: recipient required");
  if (typeof amount !== "number" || amount <= 0) {
    throw new Error("zerion.send: amount must be a positive number");
  }
  if (!signerSecret) throw new Error("zerion.send: signerSecret required");

  const known = KNOWN_MINTS[token?.toUpperCase?.()];
  const mintStr = opts.mint ?? known?.[network];
  const decimals = opts.decimals ?? known?.decimals;
  if (!mintStr) {
    throw new Error(
      `zerion.send: unknown token "${token}". Pass mint + decimals explicitly.`
    );
  }
  if (decimals == null) {
    throw new Error("zerion.send: decimals required when overriding mint");
  }

  let signer;
  try {
    signer = Keypair.fromSecretKey(bs58.decode(signerSecret));
  } catch (err) {
    throw new Error(
      "zerion.send: signerSecret is not a valid base58 ed25519 secret key"
    );
  }

  const endpoint =
    rpcUrl ??
    (network === "mainnet"
      ? clusterApiUrl("mainnet-beta")
      : clusterApiUrl("devnet"));
  const connection = new Connection(endpoint, "confirmed");

  const mint = new PublicKey(mintStr);
  const recipientPk = new PublicKey(recipient);

  const senderAta = await getOrCreateAssociatedTokenAccount(
    connection,
    signer,
    mint,
    signer.publicKey
  );
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    signer,
    mint,
    recipientPk
  );

  const rawAmount = BigInt(Math.round(amount * 10 ** decimals));

  const ixs = [
    createTransferCheckedInstruction(
      senderAta.address,
      mint,
      recipientAta.address,
      signer.publicKey,
      rawAmount,
      decimals
    ),
  ];

  // metadata.memo → Memo-program instruction in the SAME transaction.
  // This is the Phosphor-specific extension: audit and transfer settle
  // atomically; one signature, one slot, one chain record.
  const memo = metadata?.memo;
  if (memo) {
    const memoBytes = truncateUtf8(memo, MEMO_MAX_BYTES);
    ixs.push(
      new TransactionInstruction({
        keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        ],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoBytes),
      })
    );
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: blockhash,
  }).add(...ixs);

  const signature = await sendAndConfirmTransaction(connection, tx, [signer], {
    commitment: "confirmed",
  });

  // Look up slot for audit context. Best-effort — don't fail the send if RPC
  // is flaky.
  let slot = 0;
  try {
    const status = await connection.getSignatureStatuses([signature]);
    slot = status?.value?.[0]?.slot ?? 0;
  } catch {
    /* ignore */
  }

  const result = {
    signature,
    slot,
    mint: mintStr,
    amount,
    recipient,
    memo,
    network,
    explorerUrl:
      `https://explorer.solana.com/tx/${signature}` +
      (network === "mainnet" ? "" : "?cluster=devnet"),
  };

  if (typeof phosphorAuditHook === "function") {
    try {
      await phosphorAuditHook({
        signature,
        slot,
        mint: mintStr,
        amount,
        recipient,
        memo,
        network,
      });
    } catch (err) {
      // Audit hooks must NOT roll back a successful transfer. Surface as a
      // warning only.
      // eslint-disable-next-line no-console
      console.warn(
        `[zerion.send] phosphorAuditHook threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return result;
}

function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str, "utf8");
  return buf.length <= maxBytes ? buf : buf.subarray(0, maxBytes);
}

export default { send };
