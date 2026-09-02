import {ISimulator} from './ISimulator';
import {QuoteSplit} from '../../models/quote/QuoteSplit';
import {EthSimulateV1Simulator} from './sor-port/eth-simulateV1-provider';
import {ChainId} from '../../lib/config';
import {SwapOptionsUniversalRouter} from './sor-port/simulation-provider';
import {Context} from '@uniswap/lib-uni/context';
import {CurrencyInfo} from '../../models/currency/CurrencyInfo';
import {ResolvedStateOverride} from './ResolvedStateOverride';

// Wrapper for the per-chain simulator that was ported from SOR as is.
export class MainSimulator implements ISimulator {
  constructor(
    private readonly simulators: Map<ChainId, EthSimulateV1Simulator>
  ) {}

  async simulate(
    chainId: ChainId,
    swapOptions: SwapOptionsUniversalRouter,
    quote: QuoteSplit,
    tokenInCurrencyInfo: CurrencyInfo,
    tokenOutCurrencyInfo: CurrencyInfo,
    inputAmount: bigint,
    quoteAmount: bigint,
    ctx: Context,
    gasPrice?: bigint,
    blockNumber?: number,
    stateOverrides?: ResolvedStateOverride[]
  ): Promise<QuoteSplit> {
    const simulator = this.simulators.get(chainId)!;
    return await simulator.simulate(
      swapOptions.simulate!.fromAddress,
      swapOptions,
      quote,
      tokenInCurrencyInfo,
      tokenOutCurrencyInfo,
      inputAmount,
      quoteAmount,
      ctx,
      gasPrice,
      blockNumber,
      stateOverrides
    );
  }
}
