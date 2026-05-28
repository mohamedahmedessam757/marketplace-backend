import { Controller, Get, Param, UseGuards, Request } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ResourceAccessService } from '../common/authorization/resource-access.service';

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
    constructor(
        private readonly invoicesService: InvoicesService,
        private readonly resourceAccess: ResourceAccessService,
    ) { }

    @Get()
    getUserInvoices(@Request() req) {
        return this.invoicesService.getUserInvoices(req.user.id);
    }

    @Get('merchant')
    getMerchantInvoices(@Request() req) {
        return this.invoicesService.getMerchantInvoices(req.user.id);
    }

    @Get('order/:orderId')
    async getOrderInvoices(@Request() req, @Param('orderId') orderId: string) {
        await this.resourceAccess.assertUserCanAccessInvoice(
            { id: req.user.id, role: req.user.role, storeId: req.user.storeId },
            orderId,
        );
        return this.invoicesService.getInvoicesByOrder(orderId);
    }

    @Get(':id')
    getInvoiceById(@Request() req, @Param('id') id: string) {
        return this.invoicesService.getInvoiceById(req.user.id, id);
    }
}
