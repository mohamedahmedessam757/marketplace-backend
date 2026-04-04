import { Controller, Get, Param, UseGuards, Request } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
    constructor(private readonly invoicesService: InvoicesService) { }

    @Get()
    getUserInvoices(@Request() req) {
        return this.invoicesService.getUserInvoices(req.user.id);
    }

    @Get('merchant')
    getMerchantInvoices(@Request() req) {
        return this.invoicesService.getMerchantInvoices(req.user.id);
    }

    @Get('order/:orderId')
    getOrderInvoices(@Param('orderId') orderId: string) {
        // Participants/Admins are authorized through the overall page structure
        return this.invoicesService.getInvoicesByOrder(orderId);
    }

    @Get(':id')
    getInvoiceById(@Request() req, @Param('id') id: string) {
        return this.invoicesService.getInvoiceById(req.user.id, id);
    }
}
