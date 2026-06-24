import {describe, it, expect, vi} from 'vitest';
import {
  createChainProtocols,
  v4SubgraphUrlOverride,
  v3SubgraphUrlOverride,
  v2SubgraphUrlOverride,
  v3TrackedEthThreshold,
  v2TrackedEthThreshold,
} from './cacheConfig';
import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import type {Logger} from './sor-providers/util/log';
import {IMetric, MetricLoggerUnit} from './sor-providers/util/metric';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
};

class MockMetric extends IMetric {
  setProperty(_key: string, _value: unknown): void {}
  putDimensions(_dimensions: Record<string, string>): void {}
  putMetric(
    _key: string,
    _value: number,
    _unit?: MetricLoggerUnit,
    _tags?: Record<string, string>
  ): void {}
}

const mockMetric = new MockMetric();

describe('cacheConfig', () => {
  describe('createChainProtocols', () => {
    it('returns expected number of chain protocol entries', () => {
      const protocols = createChainProtocols(mockLogger, mockMetric);
      // Verify a reasonable number of entries are returned
      expect(protocols.length).toBeGreaterThanOrEqual(45);
      expect(protocols.length).toBeLessThanOrEqual(66);
    });

    it('each entry has required fields', () => {
      const protocols = createChainProtocols(mockLogger, mockMetric);
      for (const entry of protocols) {
        expect(entry).toHaveProperty('protocol');
        expect(entry).toHaveProperty('chainId');
        expect(entry).toHaveProperty('timeout');
        expect(entry).toHaveProperty('provider');
        expect(typeof entry.timeout).toBe('number');
        expect(entry.timeout).toBeGreaterThan(0);
      }
    });

    it('contains V2, V3, and V4 protocols', () => {
      const protocols = createChainProtocols(mockLogger, mockMetric);
      const protocolTypes = new Set(protocols.map(p => p.protocol));
      expect(protocolTypes.has(Protocol.V2)).toBe(true);
      expect(protocolTypes.has(Protocol.V3)).toBe(true);
      expect(protocolTypes.has(Protocol.V4)).toBe(true);
    });

    it('V4 entries on MAINNET and UNICHAIN have eulerHooksProvider', () => {
      const protocols = createChainProtocols(mockLogger, mockMetric);
      const v4Mainnet = protocols.find(
        p => p.protocol === Protocol.V4 && p.chainId === ChainId.MAINNET
      );
      expect(v4Mainnet?.eulerHooksProvider).toBeDefined();

      const v4Unichain = protocols.find(
        p => p.protocol === Protocol.V4 && p.chainId === ChainId.UNICHAIN
      );
      expect(v4Unichain?.eulerHooksProvider).toBeDefined();
    });

    it('V4 entries without euler hooks do not have eulerHooksProvider', () => {
      const protocols = createChainProtocols(mockLogger, mockMetric);
      const v4Base = protocols.find(
        p => p.protocol === Protocol.V4 && p.chainId === ChainId.BASE
      );
      expect(v4Base?.eulerHooksProvider).toBeUndefined();
    });

    it('all providers have a getPools method', () => {
      const protocols = createChainProtocols(mockLogger, mockMetric);
      for (const entry of protocols) {
        expect(typeof entry.provider.getPools).toBe('function');
      }
    });
  });

  describe('v4SubgraphUrlOverride', () => {
    it('returns a string for known chains', () => {
      const knownChains = [
        ChainId.SEPOLIA,
        ChainId.ARBITRUM_ONE,
        ChainId.BASE,
        ChainId.POLYGON,
        ChainId.WORLDCHAIN,
        ChainId.ZORA,
        ChainId.UNICHAIN,
        ChainId.BNB,
        ChainId.BLAST,
        ChainId.MAINNET,
        ChainId.SONEIUM,
        ChainId.OPTIMISM,
        ChainId.MONAD,
        ChainId.XLAYER,
        ChainId.AVALANCHE,
        ChainId.LINEA,
      ];
      for (const chainId of knownChains) {
        const url = v4SubgraphUrlOverride(chainId);
        expect(typeof url).toBe('string');
      }
    });

    it('returns undefined for unknown chain', () => {
      const url = v4SubgraphUrlOverride(999999 as ChainId);
      expect(url).toBeUndefined();
    });
  });

  describe('v3SubgraphUrlOverride', () => {
    it('returns a string for known chains', () => {
      const knownChains = [
        ChainId.MAINNET,
        ChainId.ARBITRUM_ONE,
        ChainId.POLYGON,
        ChainId.OPTIMISM,
        ChainId.AVALANCHE,
        ChainId.BNB,
        ChainId.BLAST,
        ChainId.BASE,
        ChainId.CELO,
        ChainId.WORLDCHAIN,
        ChainId.UNICHAIN,
        ChainId.ZORA,
        ChainId.SONEIUM,
        ChainId.MONAD,
        ChainId.XLAYER,
        ChainId.LINEA,
      ];
      for (const chainId of knownChains) {
        const url = v3SubgraphUrlOverride(chainId);
        expect(typeof url).toBe('string');
      }
    });

    it('returns undefined for unknown chain', () => {
      const url = v3SubgraphUrlOverride(999999 as ChainId);
      expect(url).toBeUndefined();
    });
  });

  describe('v2SubgraphUrlOverride', () => {
    it('returns a string for known chains', () => {
      const knownChains = [
        ChainId.MAINNET,
        ChainId.ARBITRUM_ONE,
        ChainId.POLYGON,
        ChainId.OPTIMISM,
        ChainId.AVALANCHE,
        ChainId.BNB,
        ChainId.BLAST,
        ChainId.BASE,
        ChainId.WORLDCHAIN,
        ChainId.MONAD_TESTNET,
        ChainId.UNICHAIN,
        ChainId.SONEIUM,
        ChainId.MONAD,
        ChainId.XLAYER,
        ChainId.LINEA,
      ];
      for (const chainId of knownChains) {
        const url = v2SubgraphUrlOverride(chainId);
        expect(typeof url).toBe('string');
      }
    });

    it('returns undefined for unknown chain', () => {
      const url = v2SubgraphUrlOverride(999999 as ChainId);
      expect(url).toBeUndefined();
    });
  });

  describe('threshold constants', () => {
    it('v3TrackedEthThreshold is 0.01', () => {
      expect(v3TrackedEthThreshold).toBe(0.01);
    });

    it('v2TrackedEthThreshold is 0.025', () => {
      expect(v2TrackedEthThreshold).toBe(0.025);
    });
  });
});
