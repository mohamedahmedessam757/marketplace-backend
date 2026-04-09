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

    // --- Escrow & Wallet Endpoints ---

    @Get('customer/wallet')
    getCustomerWallet(@Request() req) {
        return this.paymentsService.getCustomerWallet(req.user.id);
    }

    @Get('customer/transactions')
    getCustomerTransactions(@Request() req) {
        return this.paymentsService.getCustomerTransactions(req.user.id);
    }

    @Get('merchant/wallet')
    getMerchantWallet(@Request() req) {
        return this.paymentsService.getMerchantWallet(req.user.id);
    }

    @Get('merchant/transactions')
    getMerchantTransactions(@Request() req) {
        return this.paymentsService.getMerchantTransactions(req.user.id);
    }

    @Post('admin/release-escrow')
    releaseEscrow(@Body() body: { orderId: string }, @Request() req) {
        // Should have Admin Guard in production
        return this.paymentsService.releaseEscrowManually(body.orderId);
    }
}
