import { Controller, Get, Post, Body, UseGuards, Request, Query, Param, Put } from '@nestjs/common';
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

    @Get('customer/dashboard')
    getCustomerDashboard(@Request() req) {
        return this.paymentsService.getCustomerWalletDashboard(req.user.id);
    }

    @Get('customer/wallet')

    @Get('customer/transactions')
    getCustomerTransactions(@Request() req) {
        return this.paymentsService.getCustomerTransactions(req.user.id);
    }

    @Get('customer/stripe-onboarding')
    getCustomerStripeOnboarding(@Request() req) {
        return this.paymentsService.getCustomerStripeOnboardingLink(req.user.id);
    }

    @Post('customer/bank-details')
    saveCustomerBankDetails(@Request() req, @Body() body: { bankName: string; accountHolder: string; iban: string; swift?: string }) {
        return this.paymentsService.saveCustomerBankDetails(req.user.id, body);
    }

    @Get('customer/bank-details')
    getCustomerBankDetails(@Request() req) {
        return this.paymentsService.getCustomerBankDetails(req.user.id);
    }

    @Post('customer/withdraw')
    requestCustomerWithdrawal(@Request() req, @Body() body: { amount: number; payoutMethod?: string }) {
        return this.paymentsService.requestCustomerWithdrawal(req.user.id, body.amount, body.payoutMethod || 'BANK_TRANSFER');
    }

    @Get('merchant/dashboard')
    getMerchantDashboard(
        @Request() req, 
        @Query('startDate') startDate?: string, 
        @Query('endDate') endDate?: string
    ) {
        return this.paymentsService.getMerchantWalletDashboard(req.user.id, { startDate, endDate });
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

    // --- Withdrawal & Stripe Connect Endpoints ---

    @Get('merchant/stripe-onboarding')
    getStripeOnboarding(@Request() req) {
        return this.paymentsService.getStripeOnboardingLink(req.user.id);
    }

    @Post('merchant/bank-details')
    saveBankDetails(@Request() req, @Body() body: { bankName: string; accountHolder: string; iban: string; swift?: string }) {
        return this.paymentsService.saveBankDetails(req.user.id, body);
    }

    @Get('merchant/bank-details')
    getBankDetails(@Request() req) {
        return this.paymentsService.getBankDetails(req.user.id);
    }

    @Post('merchant/withdraw')
    requestWithdrawal(@Request() req, @Body() body: { amount: number; payoutMethod?: string }) {
        return this.paymentsService.requestWithdrawal(req.user.id, body.amount, body.payoutMethod || 'BANK_TRANSFER');
    }

    @Get('withdrawals')
    getWithdrawals(@Request() req) {
        return this.paymentsService.getWithdrawalRequests(req.user.id, req.user.role);
    }

    @Post('admin/withdrawals/:id/process')
    processWithdrawal(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { action: 'APPROVE' | 'REJECT'; notes?: string }
    ) {
        // Role check should be enforced by a Guard
        return this.paymentsService.processWithdrawalRequest(req.user.id, id, body.action, body.notes);
    }

    @Get('admin/withdrawal-settings')
    getWithdrawalSettings() {
        return this.paymentsService.getWithdrawalLimits();
    }

    @Put('admin/withdrawal-settings')
    updateWithdrawalSettings(@Body() body: { min: number; max: number }) {
        return this.paymentsService.updateWithdrawalLimits(body);
    }
}
