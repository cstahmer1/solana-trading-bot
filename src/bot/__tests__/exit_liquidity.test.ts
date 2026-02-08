import { describe, it, expect, vi, beforeEach } from "vitest";

const mockJupQuote = vi.fn();
const mockGetConfig = vi.fn();

vi.mock("../jupiter.js", () => ({
  jupQuote: (...args: any[]) => mockJupQuote(...args),
}));

vi.mock("../runtime_config.js", () => ({
  getConfig: () => mockGetConfig(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  checkExitLiquidityForEntry,
  checkPromotionExitLiquidity,
  getExitLiquiditySettings,
  type ExitLiquidityResult,
} from "../exit_liquidity.js";

const defaultConfig = {
  exitLiquidityCheckEnabled: true,
  exitLiqMaxImpactPctScout: 0.08,
  exitLiqMaxImpactPctCore: 0.05,
  exitLiqMinRoundTripScout: 0.94,
  exitLiqMinRoundTripCore: 0.96,
  exitLiqMaxHopsScout: 3,
  exitLiqMaxHopsCore: 2,
  exitLiqSafetyHaircut: 0.90,
  exitLiqDisallowMints: "",
  maxSlippageBps: 80,
};

describe("Exit Liquidity Check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockReturnValue(defaultConfig);
  });

  describe("getExitLiquiditySettings", () => {
    it("returns settings from config", () => {
      const settings = getExitLiquiditySettings();
      expect(settings.enabled).toBe(true);
      expect(settings.maxExitImpactPctScout).toBe(0.08);
      expect(settings.maxExitImpactPctCore).toBe(0.05);
      expect(settings.minRoundTripRatioScout).toBe(0.94);
      expect(settings.minRoundTripRatioCore).toBe(0.96);
      expect(settings.maxRouteHopsScout).toBe(3);
      expect(settings.maxRouteHopsCore).toBe(2);
      expect(settings.safetyHaircut).toBe(0.90);
    });

    it("parses disallow mints from comma-separated string", () => {
      mockGetConfig.mockReturnValue({
        ...defaultConfig,
        exitLiqDisallowMints: "MINT1,MINT2,MINT3",
      });
      const settings = getExitLiquiditySettings();
      expect(settings.disallowIntermediateMints).toEqual(["MINT1", "MINT2", "MINT3"]);
    });
  });

  describe("checkExitLiquidityForEntry", () => {
    it("returns ok when disabled", async () => {
      mockGetConfig.mockReturnValue({
        ...defaultConfig,
        exitLiquidityCheckEnabled: false,
      });

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe("DISABLED");
      expect(mockJupQuote).not.toHaveBeenCalled();
    });

    it("fails when buy quote fails", async () => {
      mockJupQuote.mockRejectedValueOnce(new Error("No route"));

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("NO_BUY_QUOTE");
    });

    it("fails when buy quote returns zero tokens", async () => {
      mockJupQuote.mockResolvedValueOnce({
        outAmount: "0",
        priceImpactPct: "0.01",
        routePlan: [],
      });

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("BUY_QUOTE_ZERO");
    });

    it("fails when sell quote fails", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockRejectedValueOnce(new Error("No sell route"));

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("NO_SELL_QUOTE");
    });

    it("passes when roundtrip and impact are within scout thresholds", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [{ swapInfo: { inputMint: "SOL", outputMint: "TOKEN" } }],
        })
        .mockResolvedValueOnce({
          outAmount: "950000000",
          priceImpactPct: "0.02",
          routePlan: [{ swapInfo: { inputMint: "TOKEN", outputMint: "SOL" } }],
        });

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe("PASSED");
      expect(result.lane).toBe("scout");
    });

    it("fails when roundtrip ratio is too low for scout", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "800000000",
          priceImpactPct: "0.02",
          routePlan: [],
        });

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("ROUNDTRIP_TOO_LOW");
    });

    it("fails when exit impact is too high for core", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "970000000",
          priceImpactPct: "0.10",
          routePlan: [],
        });

      const result = await checkExitLiquidityForEntry({
        lane: "core",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("EXIT_TOO_COSTLY");
    });

    it("fails when route has too many hops for core", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "980000000",
          priceImpactPct: "0.02",
          routePlan: [
            { swapInfo: { inputMint: "A", outputMint: "B" } },
            { swapInfo: { inputMint: "B", outputMint: "C" } },
            { swapInfo: { inputMint: "C", outputMint: "SOL" } },
          ],
        });

      const result = await checkExitLiquidityForEntry({
        lane: "core",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("ROUTE_TOO_FRAGMENTED");
      expect(result.routeHops).toBe(3);
    });

    it("scout allows more hops than core", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "980000000",
          priceImpactPct: "0.02",
          routePlan: [
            { swapInfo: { inputMint: "A", outputMint: "B" } },
            { swapInfo: { inputMint: "B", outputMint: "C" } },
            { swapInfo: { inputMint: "C", outputMint: "SOL" } },
          ],
        });

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TEST_MINT",
        slippageBps: 80,
      });

      expect(result.ok).toBe(true);
    });

    it("fails when route contains blacklisted intermediate mint", async () => {
      mockGetConfig.mockReturnValue({
        ...defaultConfig,
        exitLiqDisallowMints: "BLACKLISTED_MINT",
      });

      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "1000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "980000000",
          priceImpactPct: "0.02",
          routePlan: [
            { swapInfo: { inputMint: "TOKEN", outputMint: "BLACKLISTED_MINT" } },
            { swapInfo: { inputMint: "BLACKLISTED_MINT", outputMint: "So11111111111111111111111111111111111111112" } },
          ],
        });

      const result = await checkExitLiquidityForEntry({
        lane: "scout",
        inputSolLamports: "1000000000",
        outputMint: "TOKEN",
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("ROUTE_BLACKLISTED");
    });
  });

  describe("checkPromotionExitLiquidity", () => {
    it("returns ok when disabled", async () => {
      mockGetConfig.mockReturnValue({
        ...defaultConfig,
        exitLiquidityCheckEnabled: false,
      });

      const result = await checkPromotionExitLiquidity({
        mint: "TEST_MINT",
        currentTokenQty: 1000,
        coreBuyDeltaSol: 0.5,
        slippageBps: 80,
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe("DISABLED");
    });

    it("fails when buy quote for core delta fails", async () => {
      mockJupQuote.mockRejectedValueOnce(new Error("No route"));

      const result = await checkPromotionExitLiquidity({
        mint: "TEST_MINT",
        currentTokenQty: 1000,
        coreBuyDeltaSol: 0.5,
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("PROMO_NO_BUY_QUOTE");
    });

    it("fails when post-promo sell quote is too costly", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "5000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "400000000",
          priceImpactPct: "0.15",
          routePlan: [],
        });

      const result = await checkPromotionExitLiquidity({
        mint: "TEST_MINT",
        currentTokenQty: 1000000,
        coreBuyDeltaSol: 0.5,
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("PROMO_EXIT_TOO_COSTLY");
    });

    it("passes when post-promo exit is within thresholds", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "5000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "600000000",
          priceImpactPct: "0.02",
          routePlan: [{ swapInfo: { inputMint: "TOKEN", outputMint: "SOL" } }],
        });

      const result = await checkPromotionExitLiquidity({
        mint: "TEST_MINT",
        currentTokenQty: 1000000,
        coreBuyDeltaSol: 0.5,
        slippageBps: 80,
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe("PASSED");
      expect(result.lane).toBe("core");
    });

    it("fails when post-promo exit route is too fragmented", async () => {
      mockJupQuote
        .mockResolvedValueOnce({
          outAmount: "5000000",
          priceImpactPct: "0.01",
          routePlan: [],
        })
        .mockResolvedValueOnce({
          outAmount: "600000000",
          priceImpactPct: "0.02",
          routePlan: [
            { swapInfo: { inputMint: "A", outputMint: "B" } },
            { swapInfo: { inputMint: "B", outputMint: "C" } },
            { swapInfo: { inputMint: "C", outputMint: "SOL" } },
          ],
        });

      const result = await checkPromotionExitLiquidity({
        mint: "TEST_MINT",
        currentTokenQty: 1000000,
        coreBuyDeltaSol: 0.5,
        slippageBps: 80,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("PROMO_ROUTE_TOO_FRAGMENTED");
    });
  });
});
