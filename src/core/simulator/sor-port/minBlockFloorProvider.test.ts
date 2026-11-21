import {createServer, IncomingHttpHeaders, Server} from 'node:http';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  MIN_BLOCK_NUMBER_HEADER,
  MinBlockFloorJsonRpcProvider,
  pinnedBlockOf,
} from './balanceOverride';
import {findJsonRpcError} from './simulationErrorBreakDown';

const CHAIN_ID = 4663;
const SERVICE_ID_HEADER = 'x-uni-service-id';

type RecordedRequest = {method: string; headers: IncomingHttpHeaders};

describe('MinBlockFloorJsonRpcProvider over HTTP', () => {
  let server: Server;
  let url: string;
  let requests: RecordedRequest[];
  // The JSON-RPC reply the server sends for every request
  let reply: Record<string, unknown>;

  beforeEach(async () => {
    requests = [];
    reply = {result: '0x01'};
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += String(chunk);
      });
      req.on('end', () => {
        const parsed: unknown = JSON.parse(body);
        const method =
          typeof parsed === 'object' && parsed !== null && 'method' in parsed
            ? String(parsed.method)
            : '';
        const id =
          typeof parsed === 'object' && parsed !== null && 'id' in parsed
            ? parsed.id
            : null;
        requests.push({method, headers: req.headers});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({jsonrpc: '2.0', id, ...reply}));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test server has no TCP address');
    }
    url = `http://127.0.0.1:${address.port}/rpc/${CHAIN_ID}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  const provider = () =>
    new MinBlockFloorJsonRpcProvider(
      {url, headers: {[SERVICE_ID_HEADER]: 'uniroute'}},
      CHAIN_ID
    );

  it('sends the pinned block as a decimal floor and keeps the provider headers', async () => {
    const rpc = provider();
    await rpc.send('eth_call', [{to: '0x' + '1'.repeat(40)}, '0xbc614e']);
    await rpc.call({to: '0x' + '1'.repeat(40), data: '0x'}, 12345679);

    expect(requests.map(request => request.method)).toEqual([
      'eth_call',
      'eth_call',
    ]);
    const floors = requests.map(
      request => request.headers[MIN_BLOCK_NUMBER_HEADER.toLowerCase()]
    );
    expect(floors).toEqual(['12345678', '12345679']);
    for (const request of requests) {
      expect(request.headers[SERVICE_ID_HEADER]).toBe('uniroute');
    }
  });

  it('sends no floor on a latest call', async () => {
    await provider().send('eth_call', [{to: '0x' + '1'.repeat(40)}, 'latest']);

    expect(requests).toHaveLength(1);
    expect(
      requests[0].headers[MIN_BLOCK_NUMBER_HEADER.toLowerCase()]
    ).toBeUndefined();
  });

  it('surfaces a JSON-RPC error on a pinned call as ethers does on any other', async () => {
    reply = {error: {code: -32000, message: 'block not found'}};
    const pinned = provider().send('eth_call', [
      {to: '0x' + '1'.repeat(40)},
      '0xbc614e',
    ]);
    const unpinned = provider().send('eth_call', [
      {to: '0x' + '1'.repeat(40)},
      'latest',
    ]);

    const [pinnedError, unpinnedError] = await Promise.all([
      pinned.then(
        () => undefined,
        (error: unknown) => error
      ),
      unpinned.then(
        () => undefined,
        (error: unknown) => error
      ),
    ]);
    // The shape the simulator's revert classification reads
    expect(findJsonRpcError(pinnedError)?.code).toBe(-32000);
    expect(findJsonRpcError(pinnedError)).toEqual(
      findJsonRpcError(unpinnedError)
    );
  });
});

describe('pinnedBlockOf', () => {
  it('reads the block tag at each method position', () => {
    expect(pinnedBlockOf('eth_simulateV1', [{}, '0x10'])).toBe('16');
    expect(pinnedBlockOf('eth_estimateGas', [{}, '0x10'])).toBe('16');
    expect(pinnedBlockOf('eth_getStorageAt', ['0xabc', '0x0', '0x10'])).toBe(
      '16'
    );
  });

  it('gives no floor for named tags, missing tags and other methods', () => {
    expect(pinnedBlockOf('eth_call', [{}, 'latest'])).toBeUndefined();
    expect(pinnedBlockOf('eth_call', [{}])).toBeUndefined();
    expect(
      pinnedBlockOf('eth_getStorageAt', ['0xabc', '0x10'])
    ).toBeUndefined();
    expect(pinnedBlockOf('eth_blockNumber', [])).toBeUndefined();
    expect(pinnedBlockOf('eth_call', undefined)).toBeUndefined();
  });
});
