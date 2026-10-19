import {describe, beforeEach, it, expect, vi} from 'vitest';
import {
  PoolDiscovererWithFallbackV2,
  PoolDiscovererWithFallbackV3,
  PoolDiscovererWithFallbackV4,
} from './PoolDiscovererWithFallback';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {buildTestContext} from '@uniswap/lib-testhelpers';
import {
  getUniRouteTestConfig,
  IUniRouteServiceConfig,
} from '../../../lib/config';
import {BaseCachingPoolDiscoverer} from '../BaseCachingPoolDiscoverer';
import {
  IPoolDiscoverer,
  UniPoolInfo,
  V2PoolInfo,
  V3PoolInfo,
  V4PoolInfo,
} from '../interface';
import {NoSuchKey} from '@aws-sdk/client-s3';
import {utils} from 'ethers';
import {Address} from '../../../models/address/Address';
import {USDC_MAINNET, USDT_MAINNET} from '../../../lib/tokenUtils';
import {ITopPoolsSelector, PoolsForTokensCacheDirective} from '../interface';
import {Context} from '@uniswap/lib-uni/context';
import {HooksOptions} from '../../../models/hooks/HooksOptions';
import {
  EMPTY_NAMESPACE_CONTEXT,
  RouteNamespaceContext,
} from '../../../models/hooks/namespaces';

// Mock pool data
const mockV2Pool: V2PoolInfo = {
  id: '0x1234',
  token0: {id: USDC_MAINNET.address},
  token1: {id: USDT_MAINNET.address},
  supply: 100,
  reserve: 100,
  reserveUSD: 100,
};

const mockV3Pool: V3PoolInfo = {
  id: '0x5678',
  feeTier: '3000',
  liquidity: '1000',
  token0: {id: USDC_MAINNET.address},
  token1: {id: USDT_MAINNET.address},
  tvlETH: 1000,
  tvlUSD: 1000,
};

const mockV4Pool: V4PoolInfo = {
  id: '0x9abc',
  feeTier: '3000',
  liquidity: '1000',
  tickSpacing: '60',
  hooks: '0x0000',
  token0: {id: USDC_MAINNET.address},
  token1: {id: USDT_MAINNET.address},
  tvlETH: 1000,
  tvlUSD: 1000,
};

// Test implementations of TopPoolsSelector for each version
class TestTopPoolsSelectorV2 implements ITopPoolsSelector<V2PoolInfo> {
  async filterPools(
    pools: V2PoolInfo[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<V2PoolInfo[]> {
    return Promise.resolve(pools);
  }
}

class TestTopPoolsSelectorV3 implements ITopPoolsSelector<V3PoolInfo> {
  async filterPools(
    pools: V3PoolInfo[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<V3PoolInfo[]> {
    return Promise.resolve(pools);
  }
}

class TestTopPoolsSelectorV4 implements ITopPoolsSelector<V4PoolInfo> {
  async filterPools(
    pools: V4PoolInfo[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    chainId: ChainId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenIn: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    tokenOut: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protocol: Protocol,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hooksOptions: HooksOptions | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    nsCtx: RouteNamespaceContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ctx: Context,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cacheDirective: PoolsForTokensCacheDirective
  ): Promise<V4PoolInfo[]> {
    return Promise.resolve(pools);
  }
}

describe('PoolDiscovererWithFallback', () => {
  const ctx = buildTestContext();
  const serviceConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
  const tokenIn = new Address(USDC_MAINNET.address);
  const tokenOut = new Address(USDT_MAINNET.address);

  describe('V2', () => {
    let primaryDiscoverer: BaseCachingPoolDiscoverer<V2PoolInfo>;
    let fallbackDiscoverer: BaseCachingPoolDiscoverer<V2PoolInfo>;
    let discoverer: PoolDiscovererWithFallbackV2;
    const topPoolSelector = new TestTopPoolsSelectorV2();

    beforeEach(() => {
      primaryDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V2PoolInfo>;

      fallbackDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V2PoolInfo>;

      discoverer = new PoolDiscovererWithFallbackV2(
        serviceConfig,
        primaryDiscoverer,
        fallbackDiscoverer
      );
    });

    describe('getPools', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([mockV2Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V2,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV2Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V2,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV2Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V2,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockRejectedValue(error);
        await expect(
          discoverer.getPools(ChainId.MAINNET, Protocol.V2, ctx)
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPoolsForTokens', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV2Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V2,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV2Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V2,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV2Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V2,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV2Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockRejectedValue(
          error
        );
        await expect(
          discoverer.getPoolsForTokens(
            ChainId.MAINNET,
            Protocol.V2,
            tokenIn,
            tokenOut,
            topPoolSelector,
            undefined,
            false,
            EMPTY_NAMESPACE_CONTEXT,
            ctx
          )
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('V3', () => {
    let primaryDiscoverer: BaseCachingPoolDiscoverer<V3PoolInfo>;
    let fallbackDiscoverer: BaseCachingPoolDiscoverer<V3PoolInfo>;
    let discoverer: PoolDiscovererWithFallbackV3;
    const topPoolSelector = new TestTopPoolsSelectorV3();

    beforeEach(() => {
      primaryDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V3PoolInfo>;

      fallbackDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V3PoolInfo>;

      discoverer = new PoolDiscovererWithFallbackV3(
        serviceConfig,
        primaryDiscoverer,
        fallbackDiscoverer
      );
    });

    describe('getPools', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([mockV3Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V3,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV3Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V3,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV3Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V3,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockRejectedValue(error);
        await expect(
          discoverer.getPools(ChainId.MAINNET, Protocol.V3, ctx)
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPoolsForTokens', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV3Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V3,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV3Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V3,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV3Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('V4', () => {
    let primaryDiscoverer: BaseCachingPoolDiscoverer<V4PoolInfo>;
    let fallbackDiscoverer: BaseCachingPoolDiscoverer<V4PoolInfo>;
    let discoverer: PoolDiscovererWithFallbackV4;
    const topPoolSelector = new TestTopPoolsSelectorV4();

    beforeEach(() => {
      primaryDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V4PoolInfo>;

      fallbackDiscoverer = {
        getPools: vi.fn(),
        getPoolsForTokens: vi.fn(),
      } as unknown as BaseCachingPoolDiscoverer<V4PoolInfo>;

      discoverer = new PoolDiscovererWithFallbackV4(
        serviceConfig,
        primaryDiscoverer,
        fallbackDiscoverer
      );
    });

    describe('getPools', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([mockV4Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V4,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV4Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V4,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should use fallback discoverer when primary throws', async () => {
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockResolvedValue([mockV4Pool]);
        const pools = await discoverer.getPools(
          ChainId.MAINNET,
          Protocol.V4,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });

      it('should propagate error when both discoverers fail', async () => {
        const error = new Error('Both failed');
        vi.mocked(primaryDiscoverer.getPools).mockRejectedValue(
          new Error('Primary failed')
        );
        vi.mocked(fallbackDiscoverer.getPools).mockRejectedValue(error);
        await expect(
          discoverer.getPools(ChainId.MAINNET, Protocol.V4, ctx)
        ).rejects.toThrow(error);
        expect(primaryDiscoverer.getPools).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPools).toHaveBeenCalledTimes(1);
      });
    });

    describe('getPoolsForTokens', () => {
      it('should use primary discoverer when it returns pools', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV4Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V4,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).not.toHaveBeenCalled();
      });

      it('should use fallback discoverer when primary returns empty', async () => {
        vi.mocked(primaryDiscoverer.getPoolsForTokens).mockResolvedValue([]);
        vi.mocked(fallbackDiscoverer.getPoolsForTokens).mockResolvedValue([
          mockV4Pool,
        ]);
        const pools = await discoverer.getPoolsForTokens(
          ChainId.MAINNET,
          Protocol.V4,
          tokenIn,
          tokenOut,
          topPoolSelector,
          undefined,
          false,
          EMPTY_NAMESPACE_CONTEXT,
          ctx
        );
        expect(pools).toEqual([mockV4Pool]);
        expect(primaryDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
        expect(fallbackDiscoverer.getPoolsForTokens).toHaveBeenCalledTimes(1);
      });
    });
  });
});

class FakeRejectingDiscoverer<TPool extends UniPoolInfo>
  implements IPoolDiscoverer<TPool>
{
  constructor(private readonly failure: () => Promise<never>) {}
  getPools(): Promise<TPool[]> {
    return this.failure();
  }
  getPoolsForTokens(): Promise<TPool[]> {
    return this.failure();
  }
}

class FakeResolvingDiscoverer<TPool extends UniPoolInfo>
  implements IPoolDiscoverer<TPool>
{
  constructor(private readonly pools: TPool[]) {}
  getPools(): Promise<TPool[]> {
    return Promise.resolve(this.pools);
  }
  getPoolsForTokens(): Promise<TPool[]> {
    return Promise.resolve(this.pools);
  }
}

describe('PoolDiscovererWithFallback primary-failure log fields', () => {
  const serviceConfig: IUniRouteServiceConfig = getUniRouteTestConfig();
  const tokenIn = new Address(USDC_MAINNET.address);
  const tokenOut = new Address(USDT_MAINNET.address);
  const SECRET_PATH = 'v2/0123456789abcdef-secret-key';

  // Each failure is produced by the real library that throws it in prod, not
  // a hand-built object with the shape this code expects.
  function ethersServerError(): Error {
    return new utils.Logger('web/5.7.1').makeError(
      'missing response',
      utils.Logger.errors.SERVER_ERROR,
      {
        requestBody: '{"method":"eth_call","params":[{"data":"0xdeadbeef"}]}',
        requestMethod: 'POST',
        url: `https://rpc.provider.example/${SECRET_PATH}`,
      }
    );
  }

  function invalidUrlError(): unknown {
    try {
      new URL('not a url');
    } catch (error) {
      return error;
    }
    throw new Error('expected new URL to throw');
  }

  async function warnFieldsFor(
    failure: () => Promise<never>,
    call: 'getPools' | 'getPoolsForTokens'
  ): Promise<Record<string, unknown>> {
    const ctx = buildTestContext();
    const discoverer = new PoolDiscovererWithFallbackV2(
      serviceConfig,
      new FakeRejectingDiscoverer<V2PoolInfo>(failure),
      new FakeResolvingDiscoverer<V2PoolInfo>([mockV2Pool])
    );
    const pools =
      call === 'getPools'
        ? await discoverer.getPools(ChainId.MAINNET, Protocol.V2, ctx)
        : await discoverer.getPoolsForTokens(
            ChainId.MAINNET,
            Protocol.V2,
            tokenIn,
            tokenOut,
            new TestTopPoolsSelectorV2(),
            undefined,
            false,
            EMPTY_NAMESPACE_CONTEXT,
            ctx
          );
    expect(pools).toEqual([mockV2Pool]);

    const warns = ctx.logger.outputs.filter(o => o.prefix === 'WARN:');
    expect(warns).toHaveLength(1);
    const fields: Record<string, unknown> = warns[0].extra;
    // The serving logger writes fields with JSON semantics; anything that
    // does not survive a round trip (a nested Error becomes `{}`) is lost.
    expect(JSON.parse(JSON.stringify(fields))).toEqual(fields);
    expect(Object.values(fields).some(v => v instanceof Error)).toBe(false);
    return fields;
  }

  it.each(['getPools', 'getPoolsForTokens'] as const)(
    '%s logs the error name and message as flat fields',
    async call => {
      const fields = await warnFieldsFor(
        () =>
          Promise.reject(new Error('Snapshot memo deny-list payload missing')),
        call
      );
      expect(fields).toMatchObject({
        chainId: ChainId.MAINNET,
        protocol: Protocol.V2,
        errorName: 'Error',
        errorMessage: 'Snapshot memo deny-list payload missing',
      });
      expect(fields).not.toHaveProperty('error');
      expect(fields).not.toHaveProperty('errorCode');
    }
  );

  it('keeps tokenIn/tokenOut on the per-token warn', async () => {
    const fields = await warnFieldsFor(
      () => Promise.reject(new Error('boom')),
      'getPoolsForTokens'
    );
    expect(fields).toMatchObject({
      tokenIn: tokenIn.toString(),
      tokenOut: tokenOut.toString(),
    });
  });

  it('drops the URL path and request body an ethers error carries', async () => {
    const fields = await warnFieldsFor(
      () => Promise.reject(ethersServerError()),
      'getPoolsForTokens'
    );
    expect(fields).toMatchObject({
      errorName: 'Error',
      errorMessage: 'missing response',
      errorCode: 'SERVER_ERROR',
    });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain('0xdeadbeef');
  });

  it('carries a Node error code alongside the name', async () => {
    const fields = await warnFieldsFor(
      () => Promise.reject(invalidUrlError()),
      'getPools'
    );
    expect(fields).toMatchObject({
      errorName: 'TypeError',
      errorCode: 'ERR_INVALID_URL',
    });
  });

  it('names an AWS SDK service exception by its class name', async () => {
    const fields = await warnFieldsFor(
      () =>
        Promise.reject(
          new NoSuchKey({
            message: 'The specified key does not exist.',
            $metadata: {httpStatusCode: 404},
          })
        ),
      'getPools'
    );
    expect(fields).toMatchObject({
      errorName: 'NoSuchKey',
      errorMessage: 'The specified key does not exist.',
    });
  });

  it('logs a non-Error rejection without serializing the thrown value', async () => {
    const fields = await warnFieldsFor(
      () => Promise.reject({apiKey: 'not-an-error-object'}),
      'getPoolsForTokens'
    );
    expect(fields).toMatchObject({
      errorName: 'object',
      errorMessage: 'Unknown error',
    });
    expect(JSON.stringify(fields)).not.toContain('not-an-error-object');
  });

  it('still propagates the fallback failure after logging the primary one', async () => {
    const ctx = buildTestContext();
    const discoverer = new PoolDiscovererWithFallbackV2(
      serviceConfig,
      new FakeRejectingDiscoverer<V2PoolInfo>(() =>
        Promise.reject(new Error('primary down'))
      ),
      new FakeRejectingDiscoverer<V2PoolInfo>(() =>
        Promise.reject(new Error('fallback down'))
      )
    );
    await expect(
      discoverer.getPools(ChainId.MAINNET, Protocol.V2, ctx)
    ).rejects.toThrow('fallback down');
    const warns = ctx.logger.outputs.filter(o => o.prefix === 'WARN:');
    expect(warns[0].extra).toMatchObject({
      errorName: 'Error',
      errorMessage: 'primary down',
    });
  });
});
