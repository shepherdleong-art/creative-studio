import type {
  CostQuote,
  ExecutionFacade,
  ExecutionGrant,
  ExecutionReceipt,
  Money,
} from '../media-core/execution/context.ts';

export interface LlmExecutionTransport {
  facade: ExecutionFacade;
  grant: ExecutionGrant;
  quote: CostQuote;
  submittingStarted?: boolean;
  persistCheckpoint?(attemptId: string, rawText: string): void;
}

export interface LlmTransportOutcome<T> {
  value: T;
  terminalState: 'succeeded' | 'failed';
  result?: unknown;
  actualCost?: Money | null;
  errorCode?: string;
  /** 明确的温度拒绝需要保留原 permit，供同一操作的协议回退复用。 */
  remoteTerminal?: boolean;
}

export async function runLlmTransport<T>(
  transport: LlmExecutionTransport,
  input: {
    requestSnapshot: unknown;
    retryKind?: 'initial' | 'protocol_fallback';
    send: () => Promise<LlmTransportOutcome<T>>;
  },
): Promise<T> {
  const intent = await transport.facade.markSubmitting({
    grant: transport.grant,
    requestSnapshot: input.requestSnapshot,
    retryKind: input.retryKind ?? 'initial',
    ...(input.retryKind === 'protocol_fallback' ? { quote: transport.quote } : {}),
  });
  transport.submittingStarted = true;
  let outcome: LlmTransportOutcome<T> | undefined;
  await transport.facade.transmit(intent, async (): Promise<ExecutionReceipt> => {
    outcome = await input.send();
    if (outcome.terminalState === 'succeeded' && typeof outcome.result === 'string') {
      transport.persistCheckpoint?.(intent.attemptId, outcome.result);
    }
    return {
      terminalState: outcome.terminalState,
      actualCost: outcome.actualCost ?? null,
      errorCode: outcome.errorCode,
    };
  });
  if (!outcome) throw new Error('LLM 传输未返回终态');
  const settledOutcome = outcome as LlmTransportOutcome<T>;
  await transport.facade.settle({
    attemptId: intent.attemptId,
    outcome: settledOutcome.terminalState,
    actualCost: settledOutcome.actualCost ?? null,
    remoteTerminal: settledOutcome.remoteTerminal ?? settledOutcome.terminalState === 'succeeded',
    result: settledOutcome.result,
    errorCode: settledOutcome.errorCode,
  });
  return settledOutcome.value;
}
