import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildExecutionResultFromSwap,
  computeGlobalGates,
  getActiveGateNames,
  type AllocationEvent,
  type ExecutionResult,
} from "../allocation_events.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  q: (...args: any[]) => mockQuery(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("allocation_events", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("GlobalGates", () => {
    describe("computeGlobalGates", () => {
      it("returns all false when no gates are active", () => {
        const gates = computeGlobalGates(false, false, false, true);
        expect(gates.manualPause).toBe(false);
        expect(gates.riskPaused).toBe(false);
        expect(gates.lowSolMode).toBe(false);
        expect(gates.priceCoverageOk).toBe(true);
      });

      it("returns manualPause true when manual pause is active", () => {
        const gates = computeGlobalGates(true, false, false, true);
        expect(gates.manualPause).toBe(true);
      });

      it("returns riskPaused true when risk circuit paused", () => {
        const gates = computeGlobalGates(false, true, false, true);
        expect(gates.riskPaused).toBe(true);
      });

      it("returns lowSolMode true when SOL balance too low", () => {
        const gates = computeGlobalGates(false, false, true, true);
        expect(gates.lowSolMode).toBe(true);
      });

      it("returns priceCoverageOk false when coverage incomplete", () => {
        const gates = computeGlobalGates(false, false, false, false);
        expect(gates.priceCoverageOk).toBe(false);
      });
    });

    describe("getActiveGateNames", () => {
      it("returns empty array when no gates active", () => {
        const gates = computeGlobalGates(false, false, false, true);
        expect(getActiveGateNames(gates)).toEqual([]);
      });

      it("returns manualPause when manual pause active", () => {
        const gates = computeGlobalGates(true, false, false, true);
        expect(getActiveGateNames(gates)).toContain("manualPause");
      });

      it("returns multiple gates when multiple active", () => {
        const gates = computeGlobalGates(true, true, false, true);
        const names = getActiveGateNames(gates);
        expect(names).toContain("manualPause");
        expect(names).toContain("riskPaused");
      });

      it("returns lowSolMode when SOL too low", () => {
        const gates = computeGlobalGates(false, false, true, true);
        expect(getActiveGateNames(gates)).toContain("lowSolMode");
      });

      it("returns priceCoverageNotOk when coverage incomplete", () => {
        const gates = computeGlobalGates(false, false, false, false);
        expect(getActiveGateNames(gates)).toContain("priceCoverageNotOk");
      });
    });
  });

  describe("buildExecutionResultFromSwap", () => {
    const MINT_SOL = "So11111111111111111111111111111111111111112";
    const MINT_TOKEN = "TokenMintAddressForTesting";

    it("returns SUBMITTED for sent status with txSig", () => {
      const swapResult = {
        status: "sent",
        txSig: "abc123xyz",
        quote: { 
          inputMint: MINT_SOL, 
          outputMint: MINT_TOKEN, 
          inAmount: "100000000", 
          outAmount: "1000000" 
        },
        feeDecision: { priorityLevel: "medium", maxLamports: 50000, reason: "normal" },
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("SUBMITTED");
      expect(result.txSig).toBe("abc123xyz");
      expect(result.reason).toBeUndefined();
    });

    it("calculates executedUsd from SOL input for buy trades", () => {
      const swapResult = {
        status: "sent",
        txSig: "abc123",
        quote: { 
          inputMint: MINT_SOL, 
          outputMint: MINT_TOKEN, 
          inAmount: "1000000000", // 1 SOL
          outAmount: "1000000" // some token amount
        },
      };

      const solPriceUsd = 150;
      const result = buildExecutionResultFromSwap(swapResult, solPriceUsd);

      expect(result.executedUsd).toBe(150); // 1 SOL * $150
    });

    it("calculates executedUsd from SOL output for sell trades", () => {
      const swapResult = {
        status: "sent",
        txSig: "abc123",
        quote: { 
          inputMint: MINT_TOKEN, 
          outputMint: MINT_SOL, 
          inAmount: "1000000", // some token amount
          outAmount: "2000000000" // 2 SOL received
        },
      };

      const solPriceUsd = 100;
      const result = buildExecutionResultFromSwap(swapResult, solPriceUsd);

      expect(result.executedUsd).toBe(200); // 2 SOL * $100
    });

    it("returns CONFIRMED for paper mode with correct executedUsd", () => {
      const swapResult = {
        status: "paper",
        txSig: null,
        quote: { 
          inputMint: MINT_SOL, 
          outputMint: MINT_TOKEN, 
          inAmount: "1000000000", // 1 SOL spent
          outAmount: "1000000" // token received
        },
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("CONFIRMED");
      expect(result.reason).toBe("paper_mode");
      expect(result.executedUsd).toBe(100); // 1 SOL * $100
      expect(result.txSig).toBeUndefined();
    });

    it("returns FAILED for insufficient_funds", () => {
      const swapResult = {
        status: "insufficient_funds",
        txSig: null,
        quote: null,
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("FAILED");
      expect(result.reason).toBe("insufficient_funds");
    });

    it("returns FAILED for simulation_failed with error message", () => {
      const swapResult = {
        status: "simulation_failed",
        txSig: null,
        quote: null,
        error: "Slippage exceeded",
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("FAILED");
      expect(result.reason).toBe("Slippage exceeded");
    });

    it("returns FAILED for error status", () => {
      const swapResult = {
        status: "error",
        txSig: null,
        quote: null,
        error: "Network timeout",
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("FAILED");
      expect(result.reason).toBe("Network timeout");
    });

    it("returns FAILED for unknown status", () => {
      const swapResult = {
        status: "some_unknown_status",
        txSig: null,
        quote: null,
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("FAILED");
      expect(result.reason).toBe("unknown_status_some_unknown_status");
    });

    it("extracts feeDecision correctly", () => {
      const swapResult = {
        status: "sent",
        txSig: "xyz",
        quote: { outAmount: "500000000" },
        feeDecision: {
          priorityLevel: "high",
          maxLamports: 100000,
          reason: "exit_urgency",
        },
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.feeDecision).toEqual({
        priorityLevel: "high",
        maxLamports: 100000,
        reason: "exit_urgency",
      });
    });

    it("handles missing feeDecision", () => {
      const swapResult = {
        status: "sent",
        txSig: "xyz",
        quote: { outAmount: "500000000" },
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.feeDecision).toBeUndefined();
    });

    it("handles missing quote gracefully", () => {
      const swapResult = {
        status: "sent",
        txSig: "xyz",
        quote: null,
      };

      const result = buildExecutionResultFromSwap(swapResult, 100);

      expect(result.outcome).toBe("SUBMITTED");
      expect(result.executedUsd).toBeUndefined();
    });
  });

  describe("AllocationEvent type compatibility", () => {
    it("AllocationEvent type has all expected fields", () => {
      const event: AllocationEvent = {
        symbol: "TEST",
        mint: "mint123",
        side: "buy",
        rawTargetPct: 0.1,
        scaledTargetPct: 0.12,
        currentPct: 0.05,
        desiredUsd: 100,
        plannedUsd: 80,
        executedUsd: 75,
        outcome: "CONFIRMED",
        reason: "success",
        txSig: "tx123",
        feeMaxLamports: 50000,
        feePaidLamports: 45000,
        bindingConstraint: "ramp_limit",
      };

      expect(event.symbol).toBe("TEST");
      expect(event.mint).toBe("mint123");
      expect(event.side).toBe("buy");
      expect(event.rawTargetPct).toBe(0.1);
      expect(event.scaledTargetPct).toBe(0.12);
      expect(event.currentPct).toBe(0.05);
      expect(event.desiredUsd).toBe(100);
      expect(event.plannedUsd).toBe(80);
      expect(event.executedUsd).toBe(75);
      expect(event.outcome).toBe("CONFIRMED");
      expect(event.reason).toBe("success");
      expect(event.txSig).toBe("tx123");
      expect(event.feeMaxLamports).toBe(50000);
      expect(event.feePaidLamports).toBe(45000);
      expect(event.bindingConstraint).toBe("ramp_limit");
    });

    it("AllocationEvent allows optional fields to be undefined", () => {
      const event: AllocationEvent = {
        symbol: "TEST",
        mint: "mint123",
        side: "sell",
        outcome: "SKIPPED",
      };

      expect(event.rawTargetPct).toBeUndefined();
      expect(event.scaledTargetPct).toBeUndefined();
      expect(event.currentPct).toBeUndefined();
      expect(event.desiredUsd).toBeUndefined();
      expect(event.plannedUsd).toBeUndefined();
      expect(event.executedUsd).toBeUndefined();
      expect(event.reason).toBeUndefined();
      expect(event.txSig).toBeUndefined();
      expect(event.feeMaxLamports).toBeUndefined();
      expect(event.feePaidLamports).toBeUndefined();
      expect(event.bindingConstraint).toBeUndefined();
    });

    it("AllocationEvent side is buy or sell", () => {
      const buyEvent: AllocationEvent = {
        symbol: "BUY",
        mint: "mint1",
        side: "buy",
        outcome: "SUBMITTED",
      };

      const sellEvent: AllocationEvent = {
        symbol: "SELL",
        mint: "mint2",
        side: "sell",
        outcome: "CONFIRMED",
      };

      expect(buyEvent.side).toBe("buy");
      expect(sellEvent.side).toBe("sell");
    });

    it("AllocationEvent outcome includes all valid values", () => {
      const outcomes: AllocationEvent["outcome"][] = [
        "NOT_ATTEMPTED",
        "SUBMITTED",
        "CONFIRMED",
        "SKIPPED",
        "FAILED",
      ];

      for (const outcome of outcomes) {
        const event: AllocationEvent = {
          symbol: "TEST",
          mint: "mint",
          side: "buy",
          outcome,
        };
        expect(event.outcome).toBe(outcome);
      }
    });
  });

  describe("recordAllocationEvent with mock DB", () => {
    it("inserts event with correct parameters", async () => {
      mockQuery.mockResolvedValueOnce([]);

      const { recordAllocationEvent } = await import("../allocation_events.js");

      const event: AllocationEvent = {
        symbol: "SOL",
        mint: "So11...",
        side: "buy",
        rawTargetPct: 0.1,
        scaledTargetPct: 0.12,
        currentPct: 0.05,
        desiredUsd: 100,
        plannedUsd: 90,
        executedUsd: 85,
        outcome: "CONFIRMED",
        reason: "success",
        txSig: "tx123abc",
        feeMaxLamports: 50000,
        feePaidLamports: 48000,
        bindingConstraint: "ramp",
      };

      await recordAllocationEvent(event);

      expect(mockQuery).toHaveBeenCalledTimes(1);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO allocation_events");
      expect(params).toContain("SOL");
      expect(params).toContain("So11...");
      expect(params).toContain("buy");
      expect(params).toContain(0.1);
      expect(params).toContain(0.12);
      expect(params).toContain("CONFIRMED");
      expect(params).toContain("tx123abc");
    });

    it("handles null optional fields correctly", async () => {
      mockQuery.mockResolvedValueOnce([]);

      const { recordAllocationEvent } = await import("../allocation_events.js");

      const event: AllocationEvent = {
        symbol: "TEST",
        mint: "mint_addr",
        side: "sell",
        outcome: "SKIPPED",
      };

      await recordAllocationEvent(event);

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toContain("TEST");
      expect(params).toContain("mint_addr");
      expect(params).toContain("sell");
      expect(params).toContain("SKIPPED");
      expect(params).toContain(null);
    });

    it("handles database error gracefully", async () => {
      mockQuery.mockRejectedValueOnce(new Error("DB connection failed"));

      const { recordAllocationEvent } = await import("../allocation_events.js");

      const event: AllocationEvent = {
        symbol: "FAIL",
        mint: "fail_mint",
        side: "buy",
        outcome: "FAILED",
      };

      await expect(recordAllocationEvent(event)).resolves.not.toThrow();
    });
  });

  describe("ExecutionResult type", () => {
    it("ExecutionResult has required fields", () => {
      const result: ExecutionResult = {
        outcome: "SUBMITTED",
      };

      expect(result.outcome).toBe("SUBMITTED");
    });

    it("ExecutionResult includes optional fields", () => {
      const result: ExecutionResult = {
        outcome: "CONFIRMED",
        reason: "success",
        txSig: "sig123",
        executedUsd: 100,
        feePaidLamports: 50000,
        feeDecision: {
          priorityLevel: "high",
          maxLamports: 100000,
          reason: "exit",
        },
      };

      expect(result.outcome).toBe("CONFIRMED");
      expect(result.reason).toBe("success");
      expect(result.txSig).toBe("sig123");
      expect(result.executedUsd).toBe(100);
      expect(result.feePaidLamports).toBe(50000);
      expect(result.feeDecision?.priorityLevel).toBe("high");
    });
  });
});
