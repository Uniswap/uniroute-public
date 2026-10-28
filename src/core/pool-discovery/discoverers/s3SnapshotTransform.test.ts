import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {
  convertV2PoolData,
  convertV3PoolData,
  convertV4PoolData,
  forceSelectV2Pool,
  forceSelectV4Pool,
  isVirtualPairBaseV2Pool,
  SnapshotRecordSkipReason,
  transformSnapshotPoolBytes,
  transformSnapshotPoolString,
  TRACKED_ETH_THRESHOLD,
  V2PoolData,
  V3PoolData,
  V4PoolData,
} from './s3SnapshotTransform';
import {ChainId} from '../../../lib/config';
import {Protocol} from '../../../models/pool/Protocol';
import {V2PoolInfo, V4PoolInfo} from '../interface';

const FEI_TOKEN_ADDRESS = '0x956f47f50a910163d8bf957cf5846d573e7f87ca';
const VIRTUAL_TOKEN_ADDRESS = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';

describe('s3SnapshotTransform', () => {
  describe('convertV2PoolData', () => {
    it('lowercases addresses and defaults missing numeric fields to 100', () => {
      const raw: V2PoolData = {
        id: '0xABC',
        token0: {id: '0xDEF'},
        token1: {id: '0x123'},
      };
      expect(convertV2PoolData(raw)).toEqual({
        id: '0xabc',
        token0: {id: '0xdef'},
        token1: {id: '0x123'},
        supply: 100,
        reserve: 100,
        reserveUSD: 100,
      });
    });

    it('keeps explicit supply/reserve/reserveUSD values', () => {
      const raw: V2PoolData = {
        id: '0xabc',
        token0: {id: '0xdef'},
        token1: {id: '0x123'},
        supply: 5,
        reserve: 10,
        reserveUSD: 20,
      };
      expect(convertV2PoolData(raw)).toMatchObject({
        supply: 5,
        reserve: 10,
        reserveUSD: 20,
      });
    });
  });

  describe('convertV3PoolData / convertV4PoolData', () => {
    it('stringifies feeTier/liquidity and lowercases addresses for V3', () => {
      const raw: V3PoolData = {
        id: '0xABC',
        token0: {id: '0xDEF'},
        token1: {id: '0x123'},
        liquidity: '1000',
        tvlETH: 1,
        tvlUSD: 2000,
        feeTier: 3000,
      };
      expect(convertV3PoolData(raw)).toEqual({
        id: '0xabc',
        feeTier: '3000',
        liquidity: '1000',
        token0: {id: '0xdef'},
        token1: {id: '0x123'},
        tvlETH: 1,
        tvlUSD: 2000,
      });
    });

    it('omits isExternalLiquidity entirely when the source field is undefined', () => {
      const raw: V4PoolData = {
        id: '0xabc',
        token0: {id: '0xdef'},
        token1: {id: '0x123'},
        liquidity: '0',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
        tickSpacing: '60',
        hooks: '0x0000000000000000000000000000000000000000',
      };
      const converted = convertV4PoolData(raw);
      expect('isExternalLiquidity' in converted).toBe(false);
    });

    it('carries isExternalLiquidity through when the source sets it', () => {
      const raw: V4PoolData = {
        id: '0xabc',
        token0: {id: '0xdef'},
        token1: {id: '0x123'},
        liquidity: '0',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
        tickSpacing: '60',
        hooks: '0x0000000000000000000000000000000000000000',
        isExternalLiquidity: true,
      };
      expect(convertV4PoolData(raw).isExternalLiquidity).toBe(true);
    });
  });

  describe('forceSelectV2Pool / isVirtualPairBaseV2Pool', () => {
    const pool = (token0: string, token1: string): V2PoolInfo => ({
      id: '0xpool',
      token0: {id: token0},
      token1: {id: token1},
      supply: 1,
      reserve: 0,
      reserveUSD: 0,
    });

    it('force-selects a pool containing the FEI token on any chain', () => {
      expect(
        forceSelectV2Pool(pool(FEI_TOKEN_ADDRESS, OTHER_TOKEN), ChainId.MAINNET)
      ).toBe(true);
    });

    it('force-selects a VIRTUAL-token pool on Base but not elsewhere', () => {
      const virtualPool = pool(VIRTUAL_TOKEN_ADDRESS, OTHER_TOKEN);
      expect(isVirtualPairBaseV2Pool(virtualPool, ChainId.BASE)).toBe(true);
      expect(isVirtualPairBaseV2Pool(virtualPool, ChainId.MAINNET)).toBe(false);
      expect(forceSelectV2Pool(virtualPool, ChainId.MAINNET)).toBe(false);
    });

    it('does not force-select an unrelated pool', () => {
      expect(
        forceSelectV2Pool(pool(OTHER_TOKEN, OTHER_TOKEN), ChainId.MAINNET)
      ).toBe(false);
    });
  });

  describe('forceSelectV4Pool', () => {
    const pool = (hooks: string): V4PoolInfo => ({
      id: '0xpool',
      feeTier: '3000',
      tickSpacing: '60',
      hooks,
      liquidity: '0',
      token0: {id: '0xaaa'},
      token1: {id: '0xbbb'},
      tvlETH: 0,
      tvlUSD: 0,
    });

    it('returns false when no bypass set is configured', () => {
      expect(forceSelectV4Pool(pool('0xhook'), undefined)).toBe(false);
    });

    it('matches case-insensitively against the bypass set', () => {
      const bypass = new Set(['0xhook']);
      expect(forceSelectV4Pool(pool('0xHOOK'), bypass)).toBe(true);
      expect(forceSelectV4Pool(pool('0xother'), bypass)).toBe(false);
    });
  });

  describe('transformSnapshotPoolString', () => {
    it('dedups by exact (case-sensitive) raw pool id, keeping the first occurrence', () => {
      // Dedup keys on the RAW id before lowercasing — matching
      // case '0xabc' is a dup, but a differently-cased '0xABC' would NOT be
      // (see the loop in transformSnapshotPoolString), so this uses an
      // identical raw id to exercise the actual dedup path.
      const pools: V3PoolData[] = [
        {
          id: '0xabc',
          token0: {id: '0xdef'},
          token1: {id: '0x123'},
          liquidity: '1',
          tvlETH: 1,
          tvlUSD: 1,
          feeTier: 3000,
        },
        {
          id: '0xabc',
          token0: {id: '0xdef'},
          token1: {id: '0x123'},
          liquidity: '999',
          tvlETH: 999,
          tvlUSD: 999,
          feeTier: 500,
        },
      ];
      const result = transformSnapshotPoolString(JSON.stringify(pools), {
        chainId: ChainId.MAINNET,
        protocol: Protocol.V3,
      });
      expect(result.pools).toEqual([
        {
          id: '0xabc',
          token0: {id: '0xdef'},
          token1: {id: '0x123'},
          liquidity: '1',
          tvlETH: 1,
          tvlUSD: 1,
          feeTier: '3000',
        },
      ]);
    });

    it('V2: keeps pools above the TVL threshold and drops low-reserve ones', () => {
      const above: V2PoolData = {
        id: '0x1',
        token0: {id: '0xa'},
        token1: {id: '0xb'},
        reserve: TRACKED_ETH_THRESHOLD + 1,
      };
      const below: V2PoolData = {
        id: '0x2',
        token0: {id: '0xa'},
        token1: {id: '0xc'},
        reserve: TRACKED_ETH_THRESHOLD - 0.001,
      };
      const result = transformSnapshotPoolString(
        JSON.stringify([above, below]),
        {chainId: ChainId.MAINNET, protocol: Protocol.V2}
      );
      expect(result.pools.map(pool => pool.id)).toEqual(['0x1']);
    });

    it('V2: force-selects a below-threshold pool via forceSelectV2Pool (FEI)', () => {
      const belowButFei: V2PoolData = {
        id: '0x1',
        token0: {id: FEI_TOKEN_ADDRESS},
        token1: {id: '0xb'},
        reserve: 0,
      };
      const result = transformSnapshotPoolString(
        JSON.stringify([belowButFei]),
        {chainId: ChainId.MAINNET, protocol: Protocol.V2}
      );
      expect(result.pools.map(pool => pool.id)).toEqual(['0x1']);
    });

    it('V3: keeps a zero-tvlETH pool with positive liquidity (missing derivedETH case)', () => {
      const zeroTvlButLiquid: V3PoolData = {
        id: '0x1',
        token0: {id: '0xa'},
        token1: {id: '0xb'},
        liquidity: '1',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
      };
      const zeroTvlAndIlliquid: V3PoolData = {
        id: '0x2',
        token0: {id: '0xa'},
        token1: {id: '0xc'},
        liquidity: '0',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
      };
      const result = transformSnapshotPoolString(
        JSON.stringify([zeroTvlButLiquid, zeroTvlAndIlliquid]),
        {chainId: ChainId.MAINNET, protocol: Protocol.V3}
      );
      expect(result.pools.map(pool => pool.id)).toEqual(['0x1']);
    });

    it('V4: force-selects a below-threshold pool whose hook is in v4BypassHookAddresses', () => {
      const bypassed: V4PoolData = {
        id: '0x1',
        token0: {id: '0xa'},
        token1: {id: '0xb'},
        liquidity: '0',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
        tickSpacing: '60',
        hooks: '0xHOOK',
      };
      const notBypassed: V4PoolData = {
        id: '0x2',
        token0: {id: '0xa'},
        token1: {id: '0xc'},
        liquidity: '0',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
        tickSpacing: '60',
        hooks: '0xother',
      };
      const result = transformSnapshotPoolString(
        JSON.stringify([bypassed, notBypassed]),
        {
          chainId: ChainId.MAINNET,
          protocol: Protocol.V4,
          v4BypassHookAddresses: ['0xhook'],
        }
      );
      expect(result.pools.map(pool => pool.id)).toEqual(['0x1']);
    });

    it('V4: keeps externally-sourced liquidity pools regardless of TVL/liquidity', () => {
      const external: V4PoolData = {
        id: '0x1',
        token0: {id: '0xa'},
        token1: {id: '0xb'},
        liquidity: '0',
        tvlETH: 0,
        tvlUSD: 0,
        feeTier: 3000,
        tickSpacing: '60',
        hooks: '0x0000000000000000000000000000000000000000',
        isExternalLiquidity: true,
      };
      const result = transformSnapshotPoolString(JSON.stringify([external]), {
        chainId: ChainId.MAINNET,
        protocol: Protocol.V4,
      });
      expect(result.pools.map(pool => pool.id)).toEqual(['0x1']);
    });

    it('throws on malformed JSON input (failure path)', () => {
      expect(() =>
        transformSnapshotPoolString('{not valid json', {
          chainId: ChainId.MAINNET,
          protocol: Protocol.V3,
        })
      ).toThrow();
    });

    it('throws on an unsupported protocol with an empty snapshot (failure path)', () => {
      expect(() =>
        transformSnapshotPoolString('[]', {
          chainId: ChainId.MAINNET,
          protocol: Protocol.MIXED,
        })
      ).toThrow(/Unsupported protocol/);
    });

    it('throws converting a pool under an unsupported protocol (failure path)', () => {
      const rawPool: V3PoolData = {
        id: '0x1',
        token0: {id: '0xa'},
        token1: {id: '0xb'},
        liquidity: '1',
        tvlETH: 1,
        tvlUSD: 1,
        feeTier: 3000,
      };
      expect(() =>
        transformSnapshotPoolString(JSON.stringify([rawPool]), {
          chainId: ChainId.MAINNET,
          protocol: Protocol.MIXED,
        })
      ).toThrow(/Unsupported protocol/);
    });

    it('throws when the top-level payload is not an array (failure path)', () => {
      expect(() =>
        transformSnapshotPoolString(JSON.stringify({not: 'an array'}), {
          chainId: ChainId.MAINNET,
          protocol: Protocol.V3,
        })
      ).toThrow(/not an array/);
    });

    describe('skips a malformed record and keeps the rest of the snapshot (failure path)', () => {
      const validV3: V3PoolData = {
        id: '0xgood',
        token0: {id: '0xa'},
        token1: {id: '0xb'},
        liquidity: '1',
        tvlETH: 1,
        tvlUSD: 1,
        feeTier: '3000',
      };
      const v3Params = {chainId: ChainId.MAINNET, protocol: Protocol.V3};

      it.each([
        {
          name: 'a record that is not an object',
          bad: null,
          reason: SnapshotRecordSkipReason.NOT_AN_OBJECT,
        },
        {
          name: 'a record with no string id',
          bad: {token0: {id: '0xa'}, token1: {id: '0xb'}},
          reason: SnapshotRecordSkipReason.MISSING_ID,
        },
        {
          name: 'a record with no token1',
          bad: {...validV3, id: '0xbad', token1: undefined},
          reason: SnapshotRecordSkipReason.SHAPE_MISMATCH,
        },
        {
          name: 'a record with a null liquidity',
          bad: {...validV3, id: '0xbad', liquidity: null},
          reason: SnapshotRecordSkipReason.SHAPE_MISMATCH,
        },
        {
          name: 'a record with an object tvlETH',
          bad: {...validV3, id: '0xbad', tvlETH: {}},
          reason: SnapshotRecordSkipReason.SHAPE_MISMATCH,
        },
      ])('$name', ({bad, reason}) => {
        const result = transformSnapshotPoolString(
          JSON.stringify([bad, validV3]),
          v3Params
        );

        expect(result.pools.map(pool => pool.id)).toEqual(['0xgood']);
        expect(result.skippedRecords).toEqual({[reason]: 1});
      });

      it('V4: skips a record with a non-boolean isExternalLiquidity or no hooks', () => {
        const validV4: V4PoolData = {
          ...validV3,
          tickSpacing: '60',
          hooks: '0x0000000000000000000000000000000000000000',
        };
        const result = transformSnapshotPoolString(
          JSON.stringify([
            {...validV4, id: '0xbad1', isExternalLiquidity: 'yes'},
            {...validV4, id: '0xbad2', hooks: undefined},
            validV4,
          ]),
          {chainId: ChainId.MAINNET, protocol: Protocol.V4}
        );

        expect(result.pools.map(pool => pool.id)).toEqual(['0xgood']);
        expect(result.skippedRecords).toEqual({
          [SnapshotRecordSkipReason.SHAPE_MISMATCH]: 2,
        });
      });

      it('keeps a later valid record whose id a skipped record already used', () => {
        const result = transformSnapshotPoolString(
          JSON.stringify([{...validV3, liquidity: null}, validV3]),
          v3Params
        );

        expect(result.pools.map(pool => pool.id)).toEqual(['0xgood']);
      });
    });

    it('accepts the value types the converters stringify or compare as numbers', () => {
      const result = transformSnapshotPoolString(
        JSON.stringify([
          {
            id: '0x1',
            token0: {id: '0xa'},
            token1: {id: '0xb'},
            liquidity: 5,
            tvlETH: '2.5',
            tvlUSD: 7,
            feeTier: 500,
          },
        ]),
        {chainId: ChainId.MAINNET, protocol: Protocol.V3}
      );

      expect(result).toEqual({
        pools: [
          {
            id: '0x1',
            token0: {id: '0xa'},
            token1: {id: '0xb'},
            liquidity: '5',
            tvlETH: 2.5,
            tvlUSD: 7,
            feeTier: '500',
          },
        ],
        skippedRecords: {},
      });
    });

    it.each([
      {file: 'v2-pools.json.gz', protocol: Protocol.V2},
      {file: 'v3-pools.json.gz', protocol: Protocol.V3},
      {file: 'v4-pools.json.gz', protocol: Protocol.V4},
    ])(
      'skips nothing in the real $file snapshot fixture',
      ({file, protocol}) => {
        const poolString = inflateSync(
          readFileSync(join(process.cwd(), 'tests/data', file))
        ).toString('utf-8');

        const result = transformSnapshotPoolString(poolString, {
          chainId: ChainId.MAINNET,
          protocol,
        });

        expect(result.skippedRecords).toEqual({});
        expect(result.pools.length).toBeGreaterThan(0);
      }
    );

    it('drops only the corrupted record from the real V4 snapshot fixture', () => {
      const records: unknown = JSON.parse(
        inflateSync(
          readFileSync(join(process.cwd(), 'tests/data/v4-pools.json.gz'))
        ).toString('utf-8')
      );
      if (!Array.isArray(records)) {
        throw new Error('fixture is not an array');
      }
      const params = {chainId: ChainId.MAINNET, protocol: Protocol.V4};
      const intact = transformSnapshotPoolString(
        JSON.stringify(records),
        params
      );
      const [first, ...rest] = records;
      if (
        typeof first !== 'object' ||
        first === null ||
        !('id' in first) ||
        typeof first.id !== 'string'
      ) {
        throw new Error('fixture record has no string id');
      }
      const corruptedId = first.id.toLowerCase();
      const corrupted = [{...first, tickSpacing: {unexpected: true}}, ...rest];

      const result = transformSnapshotPoolString(
        JSON.stringify(corrupted),
        params
      );

      expect(result.skippedRecords).toEqual({
        [SnapshotRecordSkipReason.SHAPE_MISMATCH]: 1,
      });
      expect(result.pools).toEqual(
        intact.pools.filter(pool => pool.id !== corruptedId)
      );
    });
  });

  describe('transformSnapshotPoolBytes', () => {
    it('decodes utf-8 bytes and produces the same result as the string-based transform', () => {
      const pools: V3PoolData[] = [
        {
          id: '0xABC',
          token0: {id: '0xdef'},
          token1: {id: '0x123'},
          liquidity: '1',
          tvlETH: 1,
          tvlUSD: 1,
          feeTier: 3000,
        },
      ];
      const poolString = JSON.stringify(pools);
      const params = {chainId: ChainId.MAINNET, protocol: Protocol.V3};

      const fromBytes = transformSnapshotPoolBytes(
        new TextEncoder().encode(poolString),
        params
      );
      const fromString = transformSnapshotPoolString(poolString, params);

      expect(fromBytes).toEqual(fromString);
      expect(fromBytes.pools).toHaveLength(1);
    });

    it('throws on malformed bytes the same way the string-based transform does (failure path)', () => {
      expect(() =>
        transformSnapshotPoolBytes(
          new TextEncoder().encode('{not valid json'),
          {
            chainId: ChainId.MAINNET,
            protocol: Protocol.V3,
          }
        )
      ).toThrow();
    });
  });
});
