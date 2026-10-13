import {ethers} from 'ethers';
import pLimit from 'p-limit';

// Module-scoped (not per-instance): one aggregator-hook pool source is
// constructed per chain, and their reads can run concurrently across chains
// in the same cron-worker process. The constrained resource (Node's default
// DNS resolution capacity, UV_THREADPOOL_SIZE=4) is process-wide, so the cap
// must be shared across every reader, subgraph- or Aurora-backed, not scoped
// per chain. Without it, a burst of 100+ simultaneous pseudoTotalValueLocked
// eth_calls has been observed to saturate DNS resolution and fail with
// ENOTFOUND even though the RPC endpoint itself is reachable and working
// (see ROUTE-1134 CCA scheduled-pools outage RCA, 2026-07-23, which hit the
// identical failure mode from a different caller sharing this container).
const PSEUDO_TVL_CONCURRENCY = 10;
export const pseudoTvlLimit = pLimit(PSEUDO_TVL_CONCURRENCY);

// Shadow reads (an Aurora source compared against the served subgraph one)
// pass through this cap before taking a slot in the shared one above. The
// process-wide total stays at PSEUDO_TVL_CONCURRENCY, and at most
// SHADOW_PSEUDO_TVL_CONCURRENCY of those slots or queue positions ever hold
// shadow work, so a fast shadow read cannot queue its whole fan-out ahead of
// the serving path's reads.
const SHADOW_PSEUDO_TVL_CONCURRENCY = 3;
export const shadowPseudoTvlLimit = pLimit(SHADOW_PSEUDO_TVL_CONCURRENCY);

type ConcurrencyLimit = ReturnType<typeof pLimit>;

export const PSEUDO_TVL_ABI = [
  {
    type: 'function',
    name: 'pseudoTotalValueLocked',
    inputs: [{name: 'poolId', type: 'bytes32', internalType: 'PoolId'}],
    outputs: [
      {name: 'amount0', type: 'uint256', internalType: 'uint256'},
      {name: 'amount1', type: 'uint256', internalType: 'uint256'},
    ],
    stateMutability: 'view',
  },
] as const;

export interface PseudoTvlAmounts {
  // Raw base-unit amounts the hook reports for the pool, wherever it holds them.
  amount0: bigint;
  amount1: bigint;
}

// An aggregator hook's `pseudoTotalValueLocked(poolId)`: the liquidity it
// holds outside the PoolManager, which the PoolManager's own state reports
// as roughly zero.
export interface PseudoTvlReader {
  read(hook: string, poolId: string): Promise<PseudoTvlAmounts>;
}

export class EthersPseudoTvlReader implements PseudoTvlReader {
  constructor(
    private readonly provider: ethers.providers.BaseProvider,
    // An extra cap applied before the shared one (shadowPseudoTvlLimit for
    // shadow reads); absent for serving reads.
    private readonly outerLimit?: ConcurrencyLimit
  ) {}

  read(hook: string, poolId: string): Promise<PseudoTvlAmounts> {
    const outerLimit = this.outerLimit;
    if (outerLimit) {
      return outerLimit(() => this.readWithSharedLimit(hook, poolId));
    }
    return this.readWithSharedLimit(hook, poolId);
  }

  private readWithSharedLimit(
    hook: string,
    poolId: string
  ): Promise<PseudoTvlAmounts> {
    return pseudoTvlLimit(async () => {
      const hookContract = new ethers.Contract(
        hook,
        PSEUDO_TVL_ABI,
        this.provider
      );
      const result: unknown = await hookContract.pseudoTotalValueLocked(poolId);
      if (
        !Array.isArray(result) ||
        !ethers.BigNumber.isBigNumber(result[0]) ||
        !ethers.BigNumber.isBigNumber(result[1])
      ) {
        throw new Error('Unexpected pseudoTotalValueLocked result shape');
      }
      return {
        amount0: result[0].toBigInt(),
        amount1: result[1].toBigInt(),
      };
    });
  }
}
