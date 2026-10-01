import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
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
  FEE_CAP_BELOW_BASE_FEE,
  GATEWAY_BAD_GATEWAY,
  HTML_ERROR_PAGE,
  MALFORMED_RESULT,
  NODE_HEADER_NOT_FOUND,
  RpcErrorReply,
  UNIRPC_ALL_PROVIDERS_FAILED,
  VENDOR_RATE_LIMITED,
} from '../../../../tests/test-utils/ethersRpcErrors';
import {SimulationStatus} from '../ISimulator';
import {VIRTUAL_BASE} from '../../../lib/tokenUtils';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

type RevertVector = {
  name: string;
  revertData: string;
  tokenIn?: string;
  tokenOut?: string;
  expected: SimulationStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSimulationStatus(value: unknown): value is SimulationStatus {
  return (
    typeof value === 'string' &&
    Object.values(SimulationStatus).some(status => status === value)
  );
}

function readRevertVectors(): RevertVector[] {
  const fixturePath = path.resolve(
    __dirname,
    '../../../../../guidestar-router/tests/data/simulation/revert-vectors.json'
  );
  const parsed: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Revert vectors fixture must be an array.');
  }
  return parsed.map(vector => {
    if (
      !isRecord(vector) ||
      typeof vector.name !== 'string' ||
      typeof vector.revertData !== 'string' ||
      !isSimulationStatus(vector.expected) ||
      (vector.tokenIn !== undefined && typeof vector.tokenIn !== 'string') ||
      (vector.tokenOut !== undefined && typeof vector.tokenOut !== 'string')
    ) {
      throw new Error('Revert vectors fixture has an invalid entry.');
    }
    return {
      name: vector.name,
      revertData: vector.revertData,
      tokenIn: vector.tokenIn,
      tokenOut: vector.tokenOut,
      expected: vector.expected,
    };
  });
}

describe('breakDownSimulationError', () => {
  it.each(readRevertVectors())(
    'classifies $name',
    ({revertData, tokenIn, tokenOut, expected}) => {
      expect(
        breakDownSimulationError(
          tokenIn ?? USDC_ADDRESS,
          tokenOut ?? WETH_ADDRESS,
          revertData
        )
      ).toBe(expected);
    }
  );

  it('matches selectors case-insensitively', () => {
    expect(
      breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '0x8B063D73')
    ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
  });

  it('returns FAILED when no data is present', () => {
    expect(
      breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, undefined)
    ).toBe(SimulationStatus.FAILED);
    expect(breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, '')).toBe(
      SimulationStatus.FAILED
    );
  });

  it('classifies InsufficientToken as SLIPPAGE_TOO_LOW for VIRTUAL on either side, any casing', () => {
    expect(
      breakDownSimulationError(VIRTUAL_BASE.address, WETH_ADDRESS, '0x675cae38')
    ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
    expect(
      breakDownSimulationError(
        USDC_ADDRESS,
        VIRTUAL_BASE.address.toLowerCase(),
        '0x675cae38'
      )
    ).toBe(SimulationStatus.SLIPPAGE_TOO_LOW);
  });

  it('classifies a TRANSFER_FROM_FAILED substring', () => {
    const data =
      '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001e726f75746572205452414e534645525f46524f4d5f4641494c4544206661696c65640000';
    expect(breakDownSimulationError(USDC_ADDRESS, WETH_ADDRESS, data)).toBe(
      SimulationStatus.TRANSFER_FROM_FAILED
    );
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
    {
      name: 'a vendor rate-limit refusal via eth_simulateV1',
      reply: VENDOR_RATE_LIMITED,
      call: simulateV1Call,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'a vendor rate-limit refusal via eth_estimateGas',
      reply: VENDOR_RATE_LIMITED,
      call: estimateGasCall,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'a node rejecting a fee cap below the base fee via eth_simulateV1',
      reply: FEE_CAP_BELOW_BASE_FEE,
      call: simulateV1Call,
      expected: SimulationStatus.FAILED,
    },
    {
      name: 'an HTML error page via eth_simulateV1',
      reply: HTML_ERROR_PAGE,
      call: simulateV1Call,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'an HTML error page via eth_estimateGas',
      reply: HTML_ERROR_PAGE,
      call: estimateGasCall,
      expected: SimulationStatus.SYSTEM_DOWN,
    },
    {
      name: 'a malformed eth_estimateGas result',
      reply: MALFORMED_RESULT,
      call: estimateGasCall,
      expected: SimulationStatus.SYSTEM_DOWN,
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
    {
      name: 'a vendor rate-limit refusal on a contract balanceOf',
      reply: VENDOR_RATE_LIMITED,
      call: balanceOfCall,
      expected: true,
    },
    {
      name: 'an HTML error page on a contract balanceOf',
      reply: HTML_ERROR_PAGE,
      call: balanceOfCall,
      expected: true,
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

  it('logs the upstream HTTP status from inside a contract read', async () => {
    const error = await captureEthersRpcError(
      GATEWAY_BAD_GATEWAY,
      balanceOfCall
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
