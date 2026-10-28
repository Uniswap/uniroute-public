import {describe, it, expect, vi} from 'vitest';
import {
  type ChainProtocol,
  createChainProtocols,
  v3TrackedEthThreshold,
  v2TrackedEthThreshold,
} from './cacheConfig';
import {Protocol} from '@uniswap/router-sdk';
import {ChainId} from '@uniswap/sdk-core';
import {ethers} from 'ethers';
import {
  AGG_HOOKS_ON_BASE,
  AGG_HOOKS_ON_MAINNET,
  AGG_HOOKS_ON_TEMPO,
} from './util/aggHooksAddressesAllowlist';

const CHAIN_ID_TEMPO = 4217;

// The StaticJsonRpcProvider the config builds keeps its endpoint on
// `connection.url`; a non-JSON-RPC provider has no such field.
function aggHooksRpcUrl(chainProtocol: ChainProtocol): string | undefined {
  const provider = chainProtocol.aggHooks?.ethersProvider;
  return provider instanceof ethers.providers.JsonRpcProvider
    ? provider.connection.url
    : undefined;
}

describe('cacheConfig', () => {
  describe('createChainProtocols', () => {
    it('returns the V2/V3/V4 cron matrix', () => {
      const protocols = createChainProtocols();
      expect(protocols).toHaveLength(62);
      const byProtocol = (protocol: Protocol) =>
        protocols.filter(p => p.protocol === protocol).length;
      expect(byProtocol(Protocol.V3)).toBe(21);
      expect(byProtocol(Protocol.V2)).toBe(19);
      expect(byProtocol(Protocol.V4)).toBe(22);
    });

    it('lists every combo once', () => {
      const keys = createChainProtocols().map(
        p => `${p.chainId}:${String(p.protocol)}`
      );
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('installs no provider itself', () => {
      for (const entry of createChainProtocols()) {
        expect(entry.provider).toBeUndefined();
        expect(entry.extraPoolSources).toBeUndefined();
      }
    });

    it('has no entry for Monad testnet, which the cron no longer caches', () => {
      expect(
        createChainProtocols().some(p => p.chainId === ChainId.MONAD_TESTNET)
      ).toBe(false);
    });

    it('has no V2 entry for Celo or Zora', () => {
      const v2Chains = createChainProtocols()
        .filter(p => p.protocol === Protocol.V2)
        .map(p => p.chainId);
      expect(v2Chains).not.toContain(ChainId.CELO);
      expect(v2Chains).not.toContain(ChainId.ZORA);
    });

    it('configures agg hooks on the V4 combos with listed hooks, read through UNI_RPC_V2_INTERNAL_ENDPOINT when set', () => {
      vi.stubEnv('UNI_RPC_ENDPOINT', 'https://unresolvable.example');
      vi.stubEnv('UNI_RPC_V2_INTERNAL_ENDPOINT', 'https://v2-internal.example');
      try {
        const protocols = createChainProtocols();
        const withAggHooks = protocols.filter(p => p.aggHooks !== undefined);
        expect(
          withAggHooks.map(p => [p.protocol, p.chainId, aggHooksRpcUrl(p)])
        ).toEqual([
          [
            Protocol.V4,
            ChainId.MAINNET,
            `https://v2-internal.example/rpc/${ChainId.MAINNET}`,
          ],
          [
            Protocol.V4,
            CHAIN_ID_TEMPO,
            `https://v2-internal.example/rpc/${CHAIN_ID_TEMPO}`,
          ],
        ]);
        const mainnet = withAggHooks[0]?.aggHooks;
        expect(mainnet?.hookAddresses).toBe(AGG_HOOKS_ON_MAINNET);
        expect(mainnet?.useExternalLiquidity).toBe(false);
        const tempo = withAggHooks[1]?.aggHooks;
        expect(tempo?.hookAddresses).toBe(AGG_HOOKS_ON_TEMPO);
        expect(tempo?.useExternalLiquidity).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('configures no Base agg hooks while Base lists no agg hooks', () => {
      vi.stubEnv('UNI_RPC_ENDPOINT', 'https://uni-rpc.example');
      try {
        const v4Base = createChainProtocols().find(
          p => p.protocol === Protocol.V4 && p.chainId === ChainId.BASE
        );
        expect(AGG_HOOKS_ON_BASE).toEqual([]);
        expect(v4Base?.aggHooks).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('agg hooks fall back to UNI_RPC_ENDPOINT', () => {
      vi.stubEnv('UNI_RPC_ENDPOINT', 'https://uni-rpc.example');
      vi.stubEnv('UNI_RPC_V2_INTERNAL_ENDPOINT', '');
      try {
        const mainnet = createChainProtocols().find(
          p => p.protocol === Protocol.V4 && p.chainId === ChainId.MAINNET
        );
        expect(mainnet && aggHooksRpcUrl(mainnet)).toBe(
          `https://uni-rpc.example/rpc/${ChainId.MAINNET}`
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('configures no agg hooks without an RPC endpoint', () => {
      vi.stubEnv('UNI_RPC_ENDPOINT', '');
      vi.stubEnv('UNI_RPC_V2_INTERNAL_ENDPOINT', '');
      try {
        expect(createChainProtocols().some(p => p.aggHooks !== undefined)).toBe(
          false
        );
      } finally {
        vi.unstubAllEnvs();
      }
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
