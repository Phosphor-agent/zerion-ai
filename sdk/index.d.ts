/**
 * Zerion-AI SDK type declarations (Phosphor extension).
 */

export interface PhosphorAuditEvent {
  signature: string;
  slot: number;
  mint: string;
  amount: number;
  recipient: string;
  memo?: string;
  network: "devnet" | "mainnet";
}

export interface ZerionSendOptions {
  recipient: string;
  amount: number;
  token?: "USDC" | string;
  mint?: string;
  decimals?: number;
  signerSecret: string;
  rpcUrl?: string;
  network?: "devnet" | "mainnet";
  metadata?: { memo?: string };
  phosphorAuditHook?: (e: PhosphorAuditEvent) => void | Promise<void>;
}

export interface ZerionSendResult {
  signature: string;
  slot: number;
  mint: string;
  amount: number;
  recipient: string;
  memo?: string;
  network: "devnet" | "mainnet";
  explorerUrl: string;
}

export declare const MEMO_PROGRAM_ID: import("@solana/web3.js").PublicKey;

export declare function send(opts: ZerionSendOptions): Promise<ZerionSendResult>;

declare const _default: { send: typeof send };
export default _default;
