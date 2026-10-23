import { Horizon, SorobanDataBuilder, StrKey, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { vi, type MockInstance } from 'vitest';

/** What the stubbed Stellar RPC answers; change the fields to change later answers. */
export interface FakeRpc {
  latestLedger: number;
  simulation: rpc.Api.SimulateTransactionResponse;
  readonly getLatestLedger: MockInstance<rpc.Server['getLatestLedger']>;
  readonly simulateTransaction: MockInstance<rpc.Server['simulateTransaction']>;
}

/** A token transfer as the asset contract emits it: `transfer(from, to)` topics, amount as data. */
export interface TransferEvent {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
}

function transferEvent({ asset, from, to, amount }: TransferEvent): xdr.DiagnosticEvent {
  const topics = [
    xdr.ScVal.scvSymbol('transfer'),
    nativeToScVal(from, { type: 'address' }),
    nativeToScVal(to, { type: 'address' }),
  ];
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(asset),
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({ topics, data: nativeToScVal(amount, { type: 'i128' }) }),
      ),
    }),
  });
}

export function simulationSuccess(
  minResourceFee = '100',
  transfers: readonly TransferEvent[] = [],
): rpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 0,
    events: transfers.map(transferEvent),
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee,
  };
}

export function simulationFailure(error = 'HostError'): rpc.Api.SimulateTransactionResponse {
  return { id: '1', latestLedger: 0, events: [], _parsed: true, error };
}

/**
 * Stubs every `rpc.Server` the schemes create, on its prototype; `vi.restoreAllMocks` undoes it.
 * Horizon's ledger read throws, so upstream's ledger-close estimate falls back to its 5 s default
 * instead of reaching public Horizon.
 */
export function fakeRpc(initial: Partial<Pick<FakeRpc, 'latestLedger' | 'simulation'>> = {}) {
  const state = { latestLedger: 1_990, simulation: simulationSuccess(), ...initial };
  vi.spyOn(Horizon.Server.prototype, 'ledgers').mockImplementation(() => {
    throw new Error('Horizon is not reachable from unit tests');
  });
  const fake: FakeRpc = {
    ...state,
    getLatestLedger: vi.spyOn(rpc.Server.prototype, 'getLatestLedger').mockImplementation(
      async () =>
        ({
          id: '1',
          sequence: fake.latestLedger,
          protocolVersion: '23',
        }) as rpc.Api.GetLatestLedgerResponse,
    ),
    simulateTransaction: vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockImplementation(async () => fake.simulation),
  };
  return fake;
}
