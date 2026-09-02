import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ChainId} from '@uniswap/sdk-core';
import {getMajorTokens, isMajorPair} from './majorTokens';
import {v4SubgraphUrlOverride} from '../cacheConfig';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ALL_CHAIN_IDS = Object.values(ChainId).filter(
  (value): value is ChainId => typeof value === 'number'
);

describe('MAJOR_TOKENS_BY_CHAIN coverage', () => {
  it('has a non-empty entry for every chain in the V4 pool-caching matrix', () => {
    // A V4 chain with no majors has no major pairs at all, so every hooked
    // pool on it bypasses allowlist gating in v4HooksPoolsFiltering. Guard
    // against a new chain being wired into cacheConfig without one.
    const v4Chains = ALL_CHAIN_IDS.filter(
      chainId => v4SubgraphUrlOverride(chainId) !== undefined
    );
    expect(v4Chains.length).toBeGreaterThan(0);

    const chainsMissingMajors = v4Chains.filter(
      chainId => getMajorTokens(chainId).size === 0
    );
    expect(
      chainsMissingMajors.map(chainId => `${ChainId[chainId]} (${chainId})`)
    ).toEqual([]);
  });

  it('includes the zero address for V4 native-currency pools on chains with a native token', () => {
    // Tempo and Arc pay gas in an ERC-20 and have no native currency, so no
    // zero-address pools exist there.
    const chainsWithoutNativeToken = new Set<ChainId>([
      ChainId.TEMPO,
      ChainId.ARC,
      // Celo's native asset is the CELO ERC-20, not address(0).
      ChainId.CELO,
    ]);
    const v4Chains = ALL_CHAIN_IDS.filter(
      chainId => v4SubgraphUrlOverride(chainId) !== undefined
    );

    for (const chainId of v4Chains) {
      const expectNative = !chainsWithoutNativeToken.has(chainId);
      expect(
        getMajorTokens(chainId).has(ZERO_ADDRESS),
        `${ChainId[chainId]} (${chainId}) zero-address entry`
      ).toBe(expectNative);
    }
  });

  it('keys Tempo by the sdk-core enum member', () => {
    const tempoMajors = getMajorTokens(ChainId.TEMPO);
    expect(
      tempoMajors.has('0x20c0000000000000000000000000000000000000') // pathUSD
    ).toBe(true);
  });

  it('covers Robinhood with its chain anchors', () => {
    const robinhoodMajors = getMajorTokens(ChainId.ROBINHOOD);
    expect(
      robinhoodMajors.has('0x0bd7d308f8e1639fab988df18a8011f41eacad73') // WETH
    ).toBe(true);
    expect(
      robinhoodMajors.has('0x5fc5360d0400a0fd4f2af552add042d716f1d168') // USDG
    ).toBe(true);
  });

  it('returns an empty set for a chain with no entry', () => {
    expect(getMajorTokens(ChainId.GNOSIS).size).toBe(0);
  });
});

describe('getMajorTokens env extensions', () => {
  let savedGlobal: string | undefined;
  let savedByChain: string | undefined;

  beforeEach(() => {
    savedGlobal = process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS;
    savedByChain = process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN;
    delete process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS;
    delete process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN;
  });

  afterEach(() => {
    if (savedGlobal === undefined) {
      delete process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS;
    } else {
      process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS = savedGlobal;
    }
    if (savedByChain === undefined) {
      delete process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN;
    } else {
      process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN = savedByChain;
    }
  });

  it('adds lowercased global additions from the comma-separated env var', () => {
    process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS = ' 0xAAAA , ,0xbbbb ';
    const majors = getMajorTokens(ChainId.MAINNET);
    expect(majors.has('0xaaaa')).toBe(true);
    expect(majors.has('0xbbbb')).toBe(true);
  });

  it('adds per-chain additions only for the matching chain', () => {
    process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN = JSON.stringify({
      [ChainId.MAINNET]: ['0xCCCC'],
    });
    expect(getMajorTokens(ChainId.MAINNET).has('0xcccc')).toBe(true);
    expect(getMajorTokens(ChainId.BASE).has('0xcccc')).toBe(false);
  });

  it('keeps global additions when the per-chain JSON is malformed', () => {
    process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS = '0xdddd';
    process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN = 'not-json';
    const majors = getMajorTokens(ChainId.MAINNET);
    expect(majors.has('0xdddd')).toBe(true);
  });

  it('ignores non-array and non-string per-chain values', () => {
    process.env.V4_HOOKS_EXTRA_MAJOR_TOKENS_BY_CHAIN = JSON.stringify({
      [ChainId.MAINNET]: 'not-an-array',
      [ChainId.BASE]: ['0xEEEE', 42],
    });
    expect(getMajorTokens(ChainId.MAINNET).has('not-an-array')).toBe(false);
    const baseMajors = getMajorTokens(ChainId.BASE);
    expect(baseMajors.has('0xeeee')).toBe(true);
    expect(baseMajors.has('42')).toBe(false);
  });
});

describe('isMajorPair', () => {
  it('matches case-insensitively against the lowercased major set', () => {
    const majors = getMajorTokens(ChainId.MAINNET);
    expect(
      isMajorPair(
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH, checksummed
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC, checksummed
        majors
      )
    ).toBe(true);
  });

  it('rejects pairs with a non-major leg', () => {
    const majors = getMajorTokens(ChainId.MAINNET);
    expect(
      isMajorPair(
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
        '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI (not a major)
        majors
      )
    ).toBe(false);
  });
});
