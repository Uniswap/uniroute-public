import {describe, expect, it} from 'vitest';
import {readFileSync} from 'fs';
import path from 'path';
import {
  hasSimulatedGasEstimate,
  isSimulationError,
  SimulationStatus,
} from './ISimulator';
import {SimulationStatus as ProtoSimulationStatus} from '../../../gen/uniroute/v1/api_pb';

const PROTO_ENUM_VALUE_PREFIX = 'SIMULATION_STATUS_';
const PROTO_ZERO_VALUE = 'UNSPECIFIED';

const VOCABULARY_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../guidestar-router/tests/data/simulation/status-vocabulary.json'
);

function readVocabularyFixture(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(VOCABULARY_FIXTURE_PATH, 'utf8')
  );
  if (
    !Array.isArray(parsed) ||
    !parsed.every(value => typeof value === 'string')
  ) {
    throw new Error('status-vocabulary.json must be an array of strings.');
  }
  return parsed;
}

function protoWireNames(): string[] {
  return Object.keys(ProtoSimulationStatus)
    .filter(key => Number.isNaN(Number(key)))
    .filter(key => key !== PROTO_ZERO_VALUE)
    .map(key => key.replace(PROTO_ENUM_VALUE_PREFIX, ''));
}

const sorted = (values: string[]): string[] => [...values].sort();

describe('SimulationStatus vocabulary', () => {
  it('matches the shared status-vocabulary fixture', () => {
    expect(sorted(Object.values(SimulationStatus))).toEqual(
      sorted(readVocabularyFixture())
    );
  });

  it('matches the proto enum with its value prefix stripped', () => {
    expect(sorted(Object.values(SimulationStatus))).toEqual(
      sorted(protoWireNames())
    );
  });

  it('uses each member name as its wire value', () => {
    for (const [name, value] of Object.entries(SimulationStatus)) {
      expect(value).toBe(name);
    }
  });
});

describe('isSimulationError', () => {
  const nonErrorStatuses = new Set<SimulationStatus | undefined>([
    SimulationStatus.SUCCESS,
    SimulationStatus.UNATTEMPTED,
    undefined,
  ]);

  it.each(Object.values(SimulationStatus))(
    'derives the flag from %s',
    status => {
      expect(isSimulationError(status)).toBe(!nonErrorStatuses.has(status));
    }
  );

  it('is false when no simulation result exists', () => {
    expect(isSimulationError(undefined)).toBe(false);
  });
});

describe('hasSimulatedGasEstimate', () => {
  const withGas = (status: SimulationStatus) => ({
    estimatedGasUsed: 150000n,
    estimatedGasUsedInQuoteToken: 2000n,
    estimatedGasUsedInUSD: 3.5,
    status,
  });

  it('is true for an executed swap: SUCCESS, or INSUFFICIENT_BALANCE from a seeded run', () => {
    expect(hasSimulatedGasEstimate(withGas(SimulationStatus.SUCCESS))).toBe(
      true
    );
    expect(
      hasSimulatedGasEstimate(withGas(SimulationStatus.INSUFFICIENT_BALANCE))
    ).toBe(true);
  });

  it('is false for an INSUFFICIENT_BALANCE that never ran', () => {
    expect(
      hasSimulatedGasEstimate({
        ...withGas(SimulationStatus.INSUFFICIENT_BALANCE),
        estimatedGasUsed: 0n,
        estimatedGasUsedInQuoteToken: 0n,
      })
    ).toBe(false);
  });

  it('is false for every other status and for no result', () => {
    for (const status of Object.values(SimulationStatus)) {
      if (
        status === SimulationStatus.SUCCESS ||
        status === SimulationStatus.INSUFFICIENT_BALANCE
      ) {
        continue;
      }
      expect(hasSimulatedGasEstimate(withGas(status))).toBe(false);
    }
    expect(hasSimulatedGasEstimate(undefined)).toBe(false);
  });
});
