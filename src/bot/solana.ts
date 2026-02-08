import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./config.js";

export const connection = new Connection(env.SOLANA_RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60_000,
});

export function loadKeypair(): Keypair {
  // Expect base58 of secretKey bytes (Uint8Array)
  const bytes = bs58.decode(env.BOT_WALLET_PRIVATE_KEY);
  return Keypair.fromSecretKey(bytes);
}

export async function sendVersionedTx(txB64: string, signer: Keypair): Promise<string> {
  const buf = Buffer.from(txB64, "base64");
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: sig, ...latest },
    "confirmed"
  );

  return sig;
}

export async function getSolBalance(pubkey: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(pubkey, "confirmed");
  return lamports / 1e9;
}
