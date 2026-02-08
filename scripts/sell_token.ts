import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { connection } from "../src/bot/solana.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { jupQuote, jupSwapTx } from "../src/bot/jupiter.js";
import { sendVersionedTx } from "../src/bot/solana.js";

const MINT_SOL = "So11111111111111111111111111111111111111112";

async function main() {
  const privKey = process.env.BOT_WALLET_PRIVATE_KEY;
  if (!privKey) throw new Error("Missing BOT_WALLET_PRIVATE_KEY");

  const signer = Keypair.fromSecretKey(bs58.decode(privKey));
  const owner = signer.publicKey;

  console.log("Wallet:", owner.toBase58());
  console.log("Fetching all tokens...\n");

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: TOKEN_PROGRAM_ID,
  });

  const targetMint = process.env.SELL_MINT;
  let foundMint: string | null = null;
  let foundAmount = 0;
  let foundDecimals = 0;

  console.log("Tokens in wallet with balance > 0:");
  for (const { account } of tokenAccounts.value) {
    const parsed = account.data.parsed;
    if (parsed?.type !== "account") continue;

    const info = parsed.info;
    const mint = info.mint as string;
    const decimals = info.tokenAmount?.decimals ?? 0;
    const amount = Number(info.tokenAmount?.uiAmount ?? 0);

    if (amount > 0) {
      console.log(`  ${mint}`);
      console.log(`    Amount: ${amount} (${decimals} decimals)`);
      
      if (targetMint && mint === targetMint) {
        foundMint = mint;
        foundAmount = amount;
        foundDecimals = decimals;
      }
    }
  }

  if (!targetMint) {
    console.log("\n---------------------------------------------");
    console.log("To sell a token, run with SELL_MINT env var:");
    console.log("  SELL_MINT=<mint_address> npx tsx scripts/sell_token.ts");
    console.log("---------------------------------------------");
    return;
  }

  if (!foundMint) {
    console.log(`\nToken ${targetMint} not found in wallet or has 0 balance.`);
    return;
  }

  console.log(`\nSelling: ${foundMint}`);
  console.log(`Amount: ${foundAmount}`);

  const baseUnits = Math.floor(foundAmount * Math.pow(10, foundDecimals)).toString();
  console.log(`Base units to sell: ${baseUnits}`);

  console.log("\nGetting quote...");
  const quote = await jupQuote({
    inputMint: foundMint,
    outputMint: MINT_SOL,
    amount: baseUnits,
    slippageBps: 300,
  });

  const outSol = Number(BigInt(quote.outAmount)) / 1e9;
  console.log(`Expected output: ${outSol.toFixed(6)} SOL`);
  console.log(`Price impact: ${quote.priceImpactPct}%`);

  console.log("\nBuilding swap transaction...");
  const swap = await jupSwapTx({
    userPublicKey: owner.toBase58(),
    quoteResponse: quote,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 1_000_000,
        priorityLevel: "medium",
      },
    },
  });

  console.log("Sending transaction...");
  const sig = await sendVersionedTx(swap.swapTransaction, signer);
  console.log(`\nTransaction sent!`);
  console.log(`Signature: ${sig}`);
  console.log(`Explorer: https://solscan.io/tx/${sig}`);
}

main().catch(console.error);
