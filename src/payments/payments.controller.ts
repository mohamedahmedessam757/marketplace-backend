import { Controller, Get, Post, Body, UseGuards, Request, Query, Param, Put, ForbiddenException } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PaymentsService } from './payments.service';
import { ProcessPaymentDto } from './dto/process-payment.dto';
import { CreateIntentDto } from './dto/create-intent.dto';
import { AdminManualPayoutDto } from './dto/admin-payout.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
    constructor (private readonly paymentsService: PaymentsService) { }

    @Post('process')
    processPayment(@Request() req, @Body() dto: ProcessPaymentDto) {
        return this.paymentsService.processPayment(req.user.id, dto);
    }

    @Post('create-intent')
    createPaymentIntent(@Request() req, @Body() dto: CreateIntentDto) {
        return this.paymentsService.createPaymentIntent(req.user.id, dto);
    }

    @Get('status/:offerId')
    getPaymentStatus(@Request() req, @Param('offerId') offerId: string) {
        return this.paymentsService.getPaymentStatus(req.user.id, offerId);
    }

    @Post('shipping-intent')
    createShippingPaymentIntent(@Request() req, @Body() body: { caseId: string; caseType: 'return' | 'dispute' }) {
        return this.paymentsService.createShippingPaymentIntent(req.user.id, body.caseId, body.caseType);
    }

    @Post('shipping-checkout')
    createShippingCheckoutSession(@Request() req, @Body() body: { caseId: string; caseType: 'return' | 'dispute'; frontendUrl?: string }) {
        return this.paymentsService.createShippingCheckoutSession(req.user.id, body.caseId, body.caseType, body.frontendUrl);
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
    getCustomerWallet(@Request() req) {
        return this.paymentsService.getCustomerWallet(req.user.id);
    }

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

    @Get('admin/merchant/:targetUserId/dashboard')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'view')
    getAdminMerchantDashboard(
        @Param('targetUserId') targetUserId: string,
        @Query('startDate') startDate?: string, 
        @Query('endDate') endDate?: string
    ) {
        return this.paymentsService.getMerchantWalletDashboard(targetUserId, { startDate, endDate });
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
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'edit')
    releaseEscrow(@Body() body: { orderId: string }, @Request() req) {
        return this.paymentsService.releaseEscrowManually(req.user.id, body.orderId);
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
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'edit')
    processWithdrawal(
        @Request() req,
        @Param('id') id: string,
        @Body() body: { action: 'APPROVE' | 'REJECT'; notes?: string; adminSignature?: string; adminName?: string; adminEmail?: string; method?: string }
    ) {
        // Role check should be enforced by a Guard
        return this.paymentsService.processWithdrawalRequest(
            req.user.id, 
            id, 
            body.action, 
            body.notes,
            body.adminSignature,
            body.adminName,
            body.adminEmail,
            body.method
        );
    }

    @Get('admin/withdrawal-settings')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'view')
    getWithdrawalSettings() {
        return this.paymentsService.getWithdrawalLimits();
    }

    @Put('admin/withdrawal-settings')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'edit')
    updateWithdrawalSettings(@Request() req, @Body() body: { min: number; max: number }) {
        return this.paymentsService.updateWithdrawalLimits(req.user.id, body);
    }

    // --- Admin Financial Hub Endpoints ---

    @Get('admin/financials')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'view')
    getAdminFinancials(@Query() filters: any) {
        return this.paymentsService.getAdminFinancials(filters);
    }

    @Get('admin/financial-feed')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'view')
    getUnifiedFinancialFeed(@Query() filters: any) {
        return this.paymentsService.getUnifiedFinancialFeed(filters);
    }

    @Get('admin/order-financial-timeline/:orderId')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'view')
    getOrderFinancialTimeline(@Param('orderId') orderId: string) {
        return this.paymentsService.getOrderFinancialTimeline(orderId);
    }

    @Get('admin/financials/export')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'view')
    exportFinancialTransactions(@Query() filters: any) {
        return this.paymentsService.exportFinancialTransactions(filters);
    }

    @Post('admin/manual-payout')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'edit') // Note: Guard still enforces SUPER_ADMIN for sensitive logic if needed
    sendManualPayout(@Request() req, @Body() dto: AdminManualPayoutDto) {
        return this.paymentsService.sendManualPayout(req.user.id, dto);
    }

    @Post('admin/verify-bank-details')
    @UseGuards(PermissionsGuard)
    @Permissions('billing', 'edit')
    verifyBankDetails(
        @Request() req,
        @Body() body: { targetId: string; role: 'CUSTOMER' | 'VENDOR' }
    ) {
        return this.paymentsService.adminVerifyBankDetails(req.user.id, body.targetId, body.role);
    }
}
