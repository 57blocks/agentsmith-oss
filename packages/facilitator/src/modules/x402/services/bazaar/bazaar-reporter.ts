import { Inject, Injectable } from '@nestjs/common';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { Logger } from '../../../../common/logger.js';
import { CONFIG, LOG } from '../../../../common/tokens.js';
import type { FacilitatorConfig } from '../../../../config/facilitator.config.js';

const REPORT_TIMEOUT_MS = 2_000;

type ResourceValue = string | { url?: string } | undefined;

interface SettlementReport {
  transaction: string;
  resource_url: string;
  network: string;
  payer?: string;
}

function resourceUrl(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): string | undefined {
  const payloadResource = (payload as unknown as { resource?: ResourceValue }).resource;
  const requirementResource = (requirements as unknown as { resource?: ResourceValue }).resource;
  const value = payloadResource ?? requirementResource;
  return typeof value === 'string' ? value : value?.url;
}

/**
 * Reports a confirmed on-chain payment to Bazaar without making settlement depend on the
 * discovery service. Failures are logged and intentionally swallowed: the payment has already
 * settled.
 */
@Injectable()
export class BazaarReporter {
  constructor(
    @Inject(CONFIG) private readonly config: FacilitatorConfig,
    @Inject(LOG) private readonly log: Logger,
  ) {}

  async report(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    response: SettleResponse,
  ): Promise<void> {
    const endpoint = this.config.bazaarSettlementUrl;
    if (!endpoint || !response.success || !response.transaction) return;

    const url = resourceUrl(payload, requirements);
    if (!url) {
      this.log.warn('settlement_report_skipped', {
        reason: 'resource_url_missing',
        transaction: response.transaction,
      });
      return;
    }
    await this.post(endpoint, {
      transaction: response.transaction,
      resource_url: url,
      network: response.network || requirements.network,
      payer: response.payer,
    });
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.bazaarSettlementApiKey) {
      headers.authorization = `Bearer ${this.config.bazaarSettlementApiKey}`;
    }
    return headers;
  }

  private async post(endpoint: string, report: SettlementReport): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try {
      const reported = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(report),
        signal: controller.signal,
      });
      if (!reported.ok) {
        this.log.warn('settlement_report_failed', {
          status: reported.status,
          transaction: report.transaction,
        });
        return;
      }
      this.log.info('settlement_reported', {
        transaction: report.transaction,
        resource_url: report.resource_url,
      });
    } catch (error) {
      this.log.warn('settlement_report_failed', {
        transaction: report.transaction,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
