import { Inject, Injectable } from '@nestjs/common';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { CONFIG, ENGINE, SETTLEMENTS } from '../../../common/tokens.js';
import type { FacilitatorConfig } from '../../../config/facilitator.config.js';
import type { FacilitatorRequestDto } from '../dto/facilitator-request.dto.js';
import { BazaarReporter } from './bazaar/bazaar-reporter.js';
import type { PaymentEngine } from './engine/payment-engine.js';
import { SettlementCoordinator, settlementKey } from './engine/settlement-coordinator.js';
import type { Caller } from '../../credentials/caller.js';

interface Payment {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}

/** The DTO pipe has checked the shape; these are the x402 types the engine consumes. */
function paymentOf(request: FacilitatorRequestDto): Payment {
  return {
    payload: request.paymentPayload as PaymentPayload,
    requirements: request.paymentRequirements as PaymentRequirements,
  };
}

/**
 * Only an identical request shares an in-memory result. A resend with another amount, payee or
 * asset reaches the engine, which refuses it as a conflict; the caller keeps servers apart.
 */
function settlementIdentity({ payload, requirements }: Payment, caller: Caller): unknown {
  return {
    resourceServerId: caller.resourceServerId,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
}

function settleFailure(requirements: PaymentRequirements, errorReason: string): SettleResponse {
  return {
    success: false,
    errorReason,
    transaction: '',
    network: requirements.network,
  };
}

/**
 * The x402 facilitator operations behind the HTTP routes. Throws only on unexpected failures;
 * payment-level rejections are returned as protocol responses.
 */
@Injectable()
export class X402Service {
  constructor(
    @Inject(CONFIG) private readonly config: FacilitatorConfig,
    @Inject(ENGINE) private readonly engine: PaymentEngine,
    @Inject(SETTLEMENTS) private readonly settlements: SettlementCoordinator,
    @Inject(BazaarReporter) private readonly bazaar: BazaarReporter,
  ) {}

  supported(): ReturnType<PaymentEngine['supported']> {
    return this.engine.supported();
  }

  async verify(request: FacilitatorRequestDto): Promise<VerifyResponse> {
    const { payload, requirements } = paymentOf(request);
    const unsupported = this.unsupportedReason(requirements);
    if (unsupported) return { isValid: false, invalidReason: unsupported };
    return this.engine.verify(payload, requirements);
  }

  async settle(request: FacilitatorRequestDto, caller: Caller): Promise<SettleResponse> {
    const payment = paymentOf(request);
    const { payload, requirements } = payment;
    const unsupported = this.unsupportedReason(requirements);
    if (unsupported) return settleFailure(requirements, unsupported);
    const key = settlementKey(settlementIdentity(payment, caller));
    const response = await this.settlements.run(key, () =>
      this.engine.settle(payload, requirements, caller),
    );
    await this.bazaar.report(payload, requirements, response);
    return response;
  }

  /** The x402 reason for terms this deployment does not serve, before any scheme runs. */
  private unsupportedReason(requirements: PaymentRequirements): string | undefined {
    if (requirements.network !== this.config.network) return 'invalid_network';
    const served = this.engine
      .supported()
      .kinds.some(
        (kind) => kind.scheme === requirements.scheme && kind.network === requirements.network,
      );
    return served ? undefined : 'unsupported_scheme';
  }
}
