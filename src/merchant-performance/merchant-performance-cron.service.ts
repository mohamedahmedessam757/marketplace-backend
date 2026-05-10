import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MerchantPerformanceService } from './merchant-performance.service';

/**
 * Scheduled reconciliation for store tiers (spec: every 24h).
 * Registered from SchedulerModule to keep a single ScheduleModule.forRoot().
 */
@Injectable()
export class MerchantPerformanceCronService {
  private readonly logger = new Logger(MerchantPerformanceCronService.name);

  constructor(private readonly merchantPerformance: MerchantPerformanceService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async nightlyRecalculateStores() {
    this.logger.log('Starting nightly merchant performance batch');
    const { processed } = await this.merchantPerformance.recalculateAllActiveStoresBatch();
    this.logger.log(`Nightly merchant performance batch finished, stores touched: ${processed}`);
  }
}
