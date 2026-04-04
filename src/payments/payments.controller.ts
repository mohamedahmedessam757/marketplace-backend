import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Post('process')
    processPayment(@Request() req, @Body() dto: ProcessPaymentDto) {
        return this.paymentsService.processPayment(req.user.id, dto);
    }

    @Get('pending')
    getPendingPayments(@Request() req) {
        return this.paymentsService.getPendingPayments(req.user.id);
    }

    @Get('merchant/pending')
    getMerchantPendingPayments(@Request() req) {
        return this.paymentsService.getMerchantPendingPayments(req.user.id);
    }
}
