import { describe, it, expect, beforeEach } from 'vitest';
import { 
  updateOrphanTracking, 
  clearOrphanTracking, 
  clearAllOrphanTracking,
  getOrphanTrackingState 
} from '../orphan_tracker.js';

describe('orphan_tracker', () => {
  beforeEach(() => {
    clearAllOrphanTracking();
  });

  describe('updateOrphanTracking', () => {
    it('should detect orphan positions not in target mints', () => {
      const walletHoldings = [
        { mint: 'MINT_A', symbol: 'A', usdValue: 100 },
        { mint: 'MINT_B', symbol: 'B', usdValue: 50 },
        { mint: 'MINT_C', symbol: 'C', usdValue: 200 },
      ];
      const targetMints = new Set(['MINT_A', 'MINT_C']);
      const minTradeUsd = 10;

      const result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);

      expect(result.unmanagedHeldCount).toBe(1);
      expect(result.unmanagedHeldUsd).toBe(50);
      expect(result.orphans.length).toBe(1);
      expect(result.orphans[0].mint).toBe('MINT_B');
      expect(result.orphans[0].ticksMissing).toBe(1);
    });

    it('should filter out positions below minTradeUsd', () => {
      const walletHoldings = [
        { mint: 'MINT_A', symbol: 'A', usdValue: 5 },
        { mint: 'MINT_B', symbol: 'B', usdValue: 50 },
      ];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      const result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);

      expect(result.unmanagedHeldCount).toBe(1);
      expect(result.orphans[0].mint).toBe('MINT_B');
    });

    it('should increment ticksMissing on consecutive calls', () => {
      const walletHoldings = [{ mint: 'MINT_ORPHAN', symbol: 'ORPHAN', usdValue: 100 }];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      const result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);

      expect(result.orphans[0].ticksMissing).toBe(2);
    });

    it('should mark orphan ready for exit after grace period (2 ticks)', () => {
      const walletHoldings = [{ mint: 'MINT_ORPHAN', symbol: 'ORPHAN', usdValue: 100 }];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      let result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      expect(result.readyForExit.length).toBe(0);
      
      result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      expect(result.readyForExit.length).toBe(1);
      expect(result.readyForExit[0].mint).toBe('MINT_ORPHAN');
      expect(result.readyForExit[0].ticksMissing).toBe(2);
    });

    it('should reset tracking when orphan returns to target set', () => {
      const walletHoldings = [{ mint: 'MINT_A', symbol: 'A', usdValue: 100 }];
      const minTradeUsd = 10;

      updateOrphanTracking(walletHoldings, new Set<string>(), minTradeUsd);
      
      const state1 = getOrphanTrackingState();
      expect(state1.get('MINT_A')?.ticksMissing).toBe(1);

      updateOrphanTracking(walletHoldings, new Set(['MINT_A']), minTradeUsd);
      
      const state2 = getOrphanTrackingState();
      expect(state2.has('MINT_A')).toBe(false);
    });

    it('should clear tracking for mints no longer in wallet', () => {
      const walletHoldings1 = [{ mint: 'MINT_A', symbol: 'A', usdValue: 100 }];
      const walletHoldings2 = [{ mint: 'MINT_B', symbol: 'B', usdValue: 100 }];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      updateOrphanTracking(walletHoldings1, targetMints, minTradeUsd);
      expect(getOrphanTrackingState().has('MINT_A')).toBe(true);

      updateOrphanTracking(walletHoldings2, targetMints, minTradeUsd);
      expect(getOrphanTrackingState().has('MINT_A')).toBe(false);
      expect(getOrphanTrackingState().has('MINT_B')).toBe(true);
    });

    it('should ignore SOL holdings', () => {
      const walletHoldings = [
        { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', usdValue: 1000 },
        { mint: 'MINT_A', symbol: 'A', usdValue: 100 },
      ];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      const result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);

      expect(result.unmanagedHeldCount).toBe(1);
      expect(result.orphans[0].mint).toBe('MINT_A');
    });
  });

  describe('clearOrphanTracking', () => {
    it('should clear tracking for a specific mint', () => {
      const walletHoldings = [
        { mint: 'MINT_A', symbol: 'A', usdValue: 100 },
        { mint: 'MINT_B', symbol: 'B', usdValue: 100 },
      ];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      expect(getOrphanTrackingState().has('MINT_A')).toBe(true);
      expect(getOrphanTrackingState().has('MINT_B')).toBe(true);

      clearOrphanTracking('MINT_A');
      
      expect(getOrphanTrackingState().has('MINT_A')).toBe(false);
      expect(getOrphanTrackingState().has('MINT_B')).toBe(true);
    });
  });

  describe('clearAllOrphanTracking', () => {
    it('should clear all orphan tracking data', () => {
      const walletHoldings = [
        { mint: 'MINT_A', symbol: 'A', usdValue: 100 },
        { mint: 'MINT_B', symbol: 'B', usdValue: 100 },
      ];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      expect(getOrphanTrackingState().size).toBe(2);

      clearAllOrphanTracking();
      
      expect(getOrphanTrackingState().size).toBe(0);
    });
  });

  describe('universe_exit decision generation', () => {
    it('should generate exit for orphan after 2 consecutive missing ticks', () => {
      const walletHoldings = [{ mint: 'ORPHAN_TOKEN', symbol: 'ORPHAN', usdValue: 50 }];
      const targetMints = new Set(['OTHER_TOKEN']);
      const minTradeUsd = 10;

      let result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      expect(result.readyForExit.length).toBe(0);
      expect(result.orphans[0].ticksMissing).toBe(1);

      result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      expect(result.readyForExit.length).toBe(1);
      expect(result.readyForExit[0].mint).toBe('ORPHAN_TOKEN');
      expect(result.readyForExit[0].ticksMissing).toBe(2);
    });

    it('should include usdValue in ready for exit info', () => {
      const walletHoldings = [{ mint: 'ORPHAN_TOKEN', symbol: 'ORPHAN', usdValue: 150 }];
      const targetMints = new Set<string>();
      const minTradeUsd = 10;

      updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);
      const result = updateOrphanTracking(walletHoldings, targetMints, minTradeUsd);

      expect(result.readyForExit[0].usdValue).toBe(150);
    });
  });
});
