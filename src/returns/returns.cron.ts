import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReturnsService } from './returns.service';

@Injectable()
export class ReturnsCronService {
    private readonly logger = new Logger(ReturnsCronService.name);

    constructor(private readonly returnsService: ReturnsService) { }

    @Cron(CronExpression.EVERY_HOUR)
    async handleReturnsCron() {
        this.logger.debug('Running Returns & Disputes Maintenance Job...');
        
        try {
            this.logger.log('Checking for auto-escalations...');
            await this.returnsService.checkAutoEscalation();
            
            this.logger.log('Checking for expired return handovers...');
            await this.returnsService.checkExpiredHandovers();
        } catch (error) {
            this.logger.error('Error during returns cron maintenance:', error.message);
        }
    }
}
