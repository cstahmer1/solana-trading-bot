import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "./solana.js";
import { MINT_SOL } from "./config.js";
import { logger } from "../utils/logger.js";

export type WalletBalances = {
  sol: number;
  tokens: Record<string, { amount: number; decimals: number; ata: string; programId?: string }>;
};

export async function getWalletBalances(owner: PublicKey, mints: { mint: string; decimals?: number }[]): Promise<WalletBalances> {
  const solLamports = await connection.getBalance(owner, "confirmed");
  const sol = solLamports / 1e9;

  const tokens: WalletBalances["tokens"] = {};
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  
  for (const { mint } of mints) {
    if (mint === MINT_SOL) continue;
    const mintPk = new PublicKey(mint);
    
    let found = false;
    for (const programId of programs) {
      try {
        const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
        const info = await connection.getTokenAccountBalance(ata, "confirmed");
        const decimals = info.value.decimals;
        const amount = Number(info.value.uiAmount ?? 0);
        tokens[mint] = { amount, decimals, ata: ata.toBase58(), programId: programId.toBase58() };
        found = true;
        break;
      } catch {
        // Try next program
      }
    }
    
    if (!found) {
      const ata = getAssociatedTokenAddressSync(mintPk, owner, false);
      tokens[mint] = { amount: 0, decimals: 0, ata: ata.toBase58() };
    }
  }

  return { sol, tokens };
}

export async function getAllTokenAccounts(owner: PublicKey): Promise<WalletBalances> {
  const solLamports = await connection.getBalance(owner, "confirmed");
  const sol = solLamports / 1e9;

  const tokens: WalletBalances["tokens"] = {};
  
  const fetchTokensFromProgram = async (programId: PublicKey, programName: string) => {
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
        programId,
      });

      for (const { pubkey, account } of tokenAccounts.value) {
        const parsed = account.data.parsed;
        if (parsed?.type !== "account") continue;
        
        const info = parsed.info;
        const mint = info.mint as string;
        const decimals = info.tokenAmount?.decimals ?? 0;
        const amount = Number(info.tokenAmount?.uiAmount ?? 0);
        
        if (amount > 0) {
          if (tokens[mint]) {
            tokens[mint].amount += amount;
          } else {
            tokens[mint] = { 
              amount, 
              decimals, 
              ata: pubkey.toBase58(),
              programId: programId.toBase58(),
            };
          }
        }
      }
      return tokenAccounts.value.length;
    } catch (e) {
      logger.warn({ programName, err: String(e) }, "Failed to fetch token accounts from program");
      return 0;
    }
  };

  const splCount = await fetchTokensFromProgram(TOKEN_PROGRAM_ID, "SPL Token");
  const token2022Count = await fetchTokensFromProgram(TOKEN_2022_PROGRAM_ID, "Token-2022");

  logger.debug({
    owner: owner.toBase58().slice(0, 8),
    splAccounts: splCount,
    token2022Accounts: token2022Count,
    totalTokens: Object.keys(tokens).length,
  }, "Fetched all token accounts (SPL + Token-2022)");

  return { sol, tokens };
}
