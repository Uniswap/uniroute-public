import {describe, it, expect} from 'vitest';
import {utils} from 'ethers';
import {Contract} from 'ethers';
import {JsonRpcProvider} from '@ethersproject/providers';
import {
  breakDownSimulationError,
  classifySimulationException,
  describeSimulationException,
  isSimulationBackendUnavailable,
} from './simulationErrorBreakDown';
import {
  captureEthersRpcError,
  GATEWAY_BAD_GATEWAY,
  NODE_HEADER_NOT_FOUND,
  RpcErrorReply,
  UNIRPC_ALL_PROVIDERS_FAILED,
} from '../../../../tests/test-utils/ethersRpcErrors';
import {SimulationStatus} from '../ISimulator';
import {VIRTUAL_BASE} from '../../../lib/tokenUtils';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)
// with minAmountOutReceived=1000000, amountReceived=999999
const V4_TOO_LITTLE_RECEIVED_WITH_ARGS =
  '0x8b063d73' +
  '00000000000000000000000000000000000000000000000000000000000f4240' +
  '00000000000000000000000000000000000000000000000000000000000f423f';

// V2TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)
const V2_TOO_LITTLE_RECEIVED_PER_HOP_WITH_ARGS =
  '0x65d564a5' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000000f4240' +
  '00000000000000000000000000000000000000000000000000000000000f423f';

const INSUFFICIENT_OUTPUT_AMOUNT_PAYLOAD =
  '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000025556e697377617056323a20494e53554646494349454e545f4f55545055545f414d4f554e54000000000000000000000000000000000000000000000000000000';
const IIA_PAYLOAD =
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000034949410000000000000000000000000000000000000000000000000000000000';
const TRANSFER_FROM_FAILED_PAYLOAD =
  '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000145452414e534645525f46524f4d5f4641494c4544000000000000000000000000';

describe('breakDownSimulationError', () => {
  describe('slippage selectors', () => {
    it.each([
      ['0x849eaf98', 'V2TooLittleReceived()'],
      ['0x8ab0bc16', 'V2TooMuchRequested()'],
      ['0x65d564a5', 'V2TooLittleReceivedPerHop(uint256,uint256,uint256)'],
      ['0x39d35496', 'V3TooLittleReceived()'],
      ['0x739dbe52', 'V3TooMuchRequested()'],
      ['0x8b063d73', 'V4TooLittleReceived(uint256,uint256)'],
      ['0x12bacdd3', 'V4TooMuchRequested(uint256,uint256)'],
      ['0x4713c18b', 'V4TooLittleReceivedPerHopSingle(uint256,uint256)'],
      ['0xefc8d8eb', 'V4TooMuchRequestedPerHopSingle(uint256,uint256)'],
    ])('classifies bare selector %s (%s) as SLIPPAGE_TOO_LOW', selector => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, selector)
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies V4TooLittleReceived with encoded args as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          V4_TOO_LITTLE_RECEIVED_WITH_ARGS
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies V2TooLittleReceivedPerHop with encoded args as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          V2_TOO_LITTLE_RECEIVED_PER_HOP_WITH_ARGS
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('matches selectors case-insensitively', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          '0x8B063D73' +
            '00000000000000000000000000000000000000000000000000000000000F4240' +
            '00000000000000000000000000000000000000000000000000000000000F423F'
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });
  });

  describe('Error(string) payloads', () => {
    it('classifies UniswapV2 INSUFFICIENT_OUTPUT_AMOUNT as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          INSUFFICIENT_OUTPUT_AMOUNT_PAYLOAD
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies IIA as SLIPPAGE_TOO_LOW', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, IIA_PAYLOAD)
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('classifies TRANSFER_FROM_FAILED as TRANSFER_FROM_FAILED', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          TRANSFER_FROM_FAILED_PAYLOAD
        )
      ).toBe(SimulationStatus.TRANSFER_FROM_FAILED);
    });

    it('returns FAILED for an unrecognized Error(string) payload', () => {
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          WETH_ADDRESS,
          '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b736f6d65206572726f72000000000000000000000000000000000000000000000000'
        )
      ).toBe(SimulationStatus.FAILED);
    });
  });

  describe('InsufficientToken', () => {
    it('classifies InsufficientToken as SLIPPAGE_TOO_LOW when trading VIRTUAL', () => {
      expect(
        breakDownSimulationError(
          VIRTUAL_BASE.address,
          WETH_ADDRESS,
          '0x675cae38'
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
      expect(
        breakDownSimulationError(
          USDC_ADDRESS,
          VIRTUAL_BASE.address.toLowerCase(),
          '0x675cae38'
        )
      ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    });

    it('returns FAILED for InsufficientToken on other pairs', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0x675cae38')
      ).toBe(SimulationStatus.FAILED);
    });
  });

  describe('fallbacks', () => {
    it('returns FAILED when no data is present', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, undefined)
      ).toBe(SimulationStatus.FAILED);
      expect(breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '')).toBe(
        SimulationStatus.FAILED
      );
    });

    it('returns FAILED for an unknown selector', () => {
      expect(
        breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0xdeadbeef')
      ).toBe(SimulationStatus.FAILED);
    });

    it('returns FAILED for truncated data', () => {
      expect(breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0x')).toBe(
        SimulationStatus.FAILED
      );
    });
  });
});

const makeEthersError = (
  message: string,
  code: string,
  details: Record<string, unknown> = {}
): Error => Object.assign(new Error(message), {code, ...details});

describe('classifySimulationException', () => {
  it('classifies ethers timeouts as SYSTEM_DOWN', () => {
    expect(
      classifySimulationException(
        makeEthersError('timed out', utils.Logger.errors.TIMEOUT),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.SYSTEM_DOWN);
  });

  it('classifies ethers network errors as SYSTEM_DOWN', () => {
    expect(
      classifySimulationException(
        makeEthersError('network changed', utils.Logger.errors.NETWORK_ERROR),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.SYSTEM_DOWN);
  });

  it('classifies transport-level SERVER_ERROR responses as SYSTEM_DOWN', () => {
    expect(
      classifySimulationException(
        makeEthersError('bad gateway', utils.Logger.errors.SERVER_ERROR, {
          status: 502,
        }),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.SYSTEM_DOWN);
  });

  it('classifies a 5xx SERVER_ERROR as SYSTEM_DOWN even when the body carries a JSON-RPC error', () => {
    expect(
      classifySimulationException(
        makeEthersError(
          'service unavailable',
          utils.Logger.errors.SERVER_ERROR,
          {
            status: 503,
            body: '{"jsonrpc":"2.0","error":{"code":-32603,"message":"upstream unavailable"}}',
          }
        ),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.SYSTEM_DOWN);
  });

  it('classifies a SERVER_ERROR with no response (connection refused) as SYSTEM_DOWN', () => {
    expect(
      classifySimulationException(
        makeEthersError('missing response', utils.Logger.errors.SERVER_ERROR, {
          serverError: Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          }),
        }),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.SYSTEM_DOWN);
  });

  it('uses revert classification for SERVER_ERROR responses with JSON-RPC data', () => {
    expect(
      classifySimulationException(
        makeEthersError(
          'execution reverted',
          utils.Logger.errors.SERVER_ERROR,
          {
            error: {code: -32000, data: '0x8b063d73'},
            body: '{"jsonrpc":"2.0","error":{"code":-32000,"data":"0x8b063d73"}}',
          }
        ),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
  });

  it('keeps JSON-RPC execution reverts without data as FAILED', () => {
    expect(
      classifySimulationException(
        makeEthersError(
          'execution reverted',
          utils.Logger.errors.SERVER_ERROR,
          {
            error: {code: -32000, message: 'execution reverted'},
          }
        ),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.FAILED);
  });

  it('keeps local exceptions as FAILED', () => {
    expect(
      classifySimulationException(
        new TypeError('cannot parse result'),
        USDC_ADDRESS,
        WETH_ADDRESS
      )
    ).toBe(SimulationStatus.FAILED);
  });
});

const ERC20_BALANCE_OF_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

type RpcCall = (provider: JsonRpcProvider) => Promise<unknown>;

const simulateV1Call: RpcCall = provider =>
  provider.send('eth_simulateV1', [{}]);
const estimateGasCall: RpcCall = provider =>
  provider.estimateGas({to: WETH_ADDRESS, from: WETH_ADDRESS, data: '0x'});
const getBalanceCall: RpcCall = provider => provider.getBalance(WETH_ADDRESS);
const balanceOfCall: RpcCall = provider =>
  new Contract(USDC_ADDRESS, ERC20_BALANCE_OF_ABI, provider).balanceOf(
    WETH_ADDRESS
  );

describe('classifySimulationException with errors thrown by ethers', () => {
  const cases: Array<{
    name: string;
    reply: RpcErrorReply;
    call: RpcCall;
    expected: SimulationStatus;
  }> = [
    {
      name: 'unirpc-go all-providers-failed via eth_simulateV1',
      reply: UNIRPC_ALL_PROVIDERS_FAILED,
      call: simulateV1Call,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'unirpc-go all-providers-failed via eth_estimateGas',
      reply: UNIRPC_ALL_PROVIDERS_FAILED,
      call: estimateGasCall,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'a 502 from the gateway via eth_simulateV1',
      reply: GATEWAY_BAD_GATEWAY,
      call: simulateV1Call,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'a node-side header-not-found via eth_simulateV1',
      reply: NODE_HEADER_NOT_FOUND,
      call: simulateV1Call,
      expected: SimulationStatus.FAILED,
    },
    {
      name: 'a node-side header-not-found via eth_estimateGas',
      reply: NODE_HEADER_NOT_FOUND,
      call: estimateGasCall,
      expected: SimulationStatus.FAILED,
    },
  ];

  it.each(cases)('$name → $expected', async ({reply, call, expected}) => {
    const error = await captureEthersRpcError(reply, call);
    expect(classifySimulationException(error, USDC_ADDRESS, WETH_ADDRESS)).toBe(
      expected
    );
  });
});

describe('isSimulationBackendUnavailable with errors thrown by ethers', () => {
  const cases: Array<{
    name: string;
    reply: RpcErrorReply;
    call: RpcCall;
    expected: boolean;
  }> = [
    {
      name: 'unirpc-go all-providers-failed on getBalance',
      reply: UNIRPC_ALL_PROVIDERS_FAILED,
      call: getBalanceCall,
      expected: true,
    },
    {
      name: 'unirpc-go all-providers-failed on a contract balanceOf',
      reply: UNIRPC_ALL_PROVIDERS_FAILED,
      call: balanceOfCall,
      expected: true,
    },
    {
      name: 'a 502 from the gateway on a contract balanceOf',
      reply: GATEWAY_BAD_GATEWAY,
      call: balanceOfCall,
      expected: true,
    },
    {
      name: 'a node-side header-not-found on a contract balanceOf',
      reply: NODE_HEADER_NOT_FOUND,
      call: balanceOfCall,
      expected: false,
    },
  ];

  it.each(cases)('$name → $expected', async ({reply, call, expected}) => {
    const error = await captureEthersRpcError(reply, call);
    expect(isSimulationBackendUnavailable(error)).toBe(expected);
  });
});

describe('describeSimulationException log fields', () => {
  it('logs only the error name, code and upstream HTTP status for an outage', async () => {
    const error = await captureEthersRpcError(
      GATEWAY_BAD_GATEWAY,
      simulateV1Call
    );

    expect(
      describeSimulationException(error, USDC_ADDRESS, WETH_ADDRESS)
    ).toEqual({
      status: SimulationStatus.SYSTEM_DOWN,
      logFields: {
        errorName: 'Error',
        errorCode: utils.Logger.errors.SERVER_ERROR,
        upstreamStatus: GATEWAY_BAD_GATEWAY.httpStatus,
      },
    });
  });

  it('logs the raw error when the backend evaluated the transaction', async () => {
    const error = await captureEthersRpcError(
      NODE_HEADER_NOT_FOUND,
      simulateV1Call
    );

    expect(
      describeSimulationException(error, USDC_ADDRESS, WETH_ADDRESS)
    ).toEqual({status: SimulationStatus.FAILED, logFields: {e: error}});
  });
});
