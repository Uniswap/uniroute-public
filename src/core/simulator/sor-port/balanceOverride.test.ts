import {describe, expect, it} from 'vitest';
import {JsonRpcProvider, StaticJsonRpcProvider} from '@ethersproject/providers';
import {utils} from 'ethers';
import {ChainId} from '../../../lib/config';
import {
  BALANCE_OVERRIDE_HEADER,
  BalanceOverrideRefusalReason,
  BalanceOverrideRefusedError,
  createSeededProviderFactory,
  describeBalanceOverrideRefusal,
  NATIVE_BALANCE_OVERRIDE_ASSET,
  withBalanceOverride,
} from './balanceOverride';
import {
  captureEthersRpcError,
  NODE_HEADER_NOT_FOUND,
  UNIRPC_ALL_PROVIDERS_FAILED,
  UNIRPC_BALANCE_OVERRIDE_REFUSED,
} from '../../../../tests/test-utils/ethersRpcErrors';
import {withFakeJsonRpcServer} from '../../../../tests/test-utils/fakeJsonRpcServer';

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const SERVICE_ID_HEADER = 'x-uni-service-id';

/** unirpc-go's answer to a header that is not an address */
const UNIRPC_OVERRIDE_HEADER_MALFORMED = {
  httpStatus: 400,
  code: -32602,
  message:
    'invalid x-unirpc-balance-override header: expected a 0x address (the zero address for the native coin)',
};

/** A node rejecting the request's own params with the same code as a refusal */
const NODE_INVALID_PARAMS = {
  httpStatus: 200,
  code: -32602,
  message: 'invalid argument 0: json: cannot unmarshal hex string',
};

const sendSimulation = (provider: JsonRpcProvider) =>
  provider.send('eth_simulateV1', [{blockStateCalls: []}, 'latest']);

describe('withBalanceOverride', () => {
  it('keeps the connection and adds the header, pinned to the chain', () => {
    const base = new StaticJsonRpcProvider(
      {
        url: 'http://unirpc.internal/rpc/1',
        timeout: 1234,
        skipFetchSetup: true,
        headers: {[SERVICE_ID_HEADER]: 'uniroute'},
      },
      ChainId.MAINNET
    );

    const seeded = withBalanceOverride(base, ChainId.MAINNET, USDC_ADDRESS);

    expect(seeded).toBeInstanceOf(StaticJsonRpcProvider);
    expect(seeded).not.toBe(base);
    expect(seeded.connection.url).toBe(base.connection.url);
    expect(seeded.connection.timeout).toBe(1234);
    expect(seeded.connection.skipFetchSetup).toBe(true);
    expect(seeded.connection.headers).toEqual({
      [SERVICE_ID_HEADER]: 'uniroute',
      [BALANCE_OVERRIDE_HEADER]: USDC_ADDRESS,
    });
    expect(seeded.network.chainId).toBe(ChainId.MAINNET);
    // The base provider is untouched so unseeded calls stay unseeded
    expect(base.connection.headers).toEqual({[SERVICE_ID_HEADER]: 'uniroute'});
  });

  it('names the native coin with the zero address', () => {
    expect(NATIVE_BALANCE_OVERRIDE_ASSET).toBe(
      '0x0000000000000000000000000000000000000000'
    );
  });
});

describe('createSeededProviderFactory', () => {
  const base = new StaticJsonRpcProvider(
    {url: 'http://unirpc.internal/rpc/1', skipFetchSetup: true},
    ChainId.MAINNET
  );

  it('reuses one provider per asset regardless of address case', () => {
    const seededProviderFor = createSeededProviderFactory(
      base,
      ChainId.MAINNET
    );

    const usdc = seededProviderFor(USDC_ADDRESS);

    expect(seededProviderFor(USDC_ADDRESS.toLowerCase())).toBe(usdc);
    expect(seededProviderFor(WETH_ADDRESS)).not.toBe(usdc);
    expect(usdc.connection.headers?.[BALANCE_OVERRIDE_HEADER]).toBe(
      USDC_ADDRESS
    );
  });

  it('puts the header on the wire next to the injected provider headers', async () => {
    const {received, outcome} = await withFakeJsonRpcServer(
      {result: []},
      url => {
        const seededProviderFor = createSeededProviderFactory(
          new StaticJsonRpcProvider(
            {url, headers: {[SERVICE_ID_HEADER]: 'uniroute'}},
            ChainId.MAINNET
          ),
          ChainId.MAINNET
        );
        return sendSimulation(seededProviderFor(USDC_ADDRESS));
      }
    );

    expect(outcome.status).toBe('fulfilled');
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('eth_simulateV1');
    expect(received[0].headers[BALANCE_OVERRIDE_HEADER]).toBe(USDC_ADDRESS);
    expect(received[0].headers[SERVICE_ID_HEADER]).toBe('uniroute');
  });
});

describe('describeBalanceOverrideRefusal', () => {
  it("classifies unirpc-go's refusal, as ethers surfaces it", async () => {
    const thrown = await captureEthersRpcError(
      UNIRPC_BALANCE_OVERRIDE_REFUSED,
      sendSimulation
    );

    const refusal = describeBalanceOverrideRefusal(thrown);

    expect(refusal).toBeInstanceOf(BalanceOverrideRefusedError);
    expect(refusal?.reason).toBe(BalanceOverrideRefusalReason.REFUSED);
    expect(refusal?.message).toBe(
      'balance override is not available for this token'
    );
  });

  it('classifies a malformed-header 400 as invalid params', async () => {
    const thrown = await captureEthersRpcError(
      UNIRPC_OVERRIDE_HEADER_MALFORMED,
      sendSimulation
    );

    expect(describeBalanceOverrideRefusal(thrown)?.reason).toBe(
      BalanceOverrideRefusalReason.INVALID_PARAMS
    );
  });

  it("classifies a node's own -32602 as invalid params", async () => {
    const thrown = await captureEthersRpcError(
      NODE_INVALID_PARAMS,
      sendSimulation
    );

    expect(describeBalanceOverrideRefusal(thrown)?.reason).toBe(
      BalanceOverrideRefusalReason.INVALID_PARAMS
    );
  });

  it('leaves every other error to the regular classification', async () => {
    const upstreamOutage = await captureEthersRpcError(
      UNIRPC_ALL_PROVIDERS_FAILED,
      sendSimulation
    );
    const nodeError = await captureEthersRpcError(
      NODE_HEADER_NOT_FOUND,
      sendSimulation
    );
    const timeout = Object.assign(new Error('timed out'), {
      code: utils.Logger.errors.TIMEOUT,
    });

    expect(describeBalanceOverrideRefusal(upstreamOutage)).toBeUndefined();
    expect(describeBalanceOverrideRefusal(nodeError)).toBeUndefined();
    expect(describeBalanceOverrideRefusal(timeout)).toBeUndefined();
    expect(describeBalanceOverrideRefusal(undefined)).toBeUndefined();
  });
});
