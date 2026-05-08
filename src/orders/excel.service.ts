import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';

@Injectable()
export class ExcelService {
    constructor(private prisma: PrismaService) {}

    async exportInvoice(orderId: string, user: any, res: Response) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                customer: true,
                store: true,
                parts: true,
                acceptedOffer: true,
                offers: {
                    where: { status: 'accepted' }
                },
                payments: {
                    where: { status: 'SUCCESS' },
                    include: { 
                        escrow: true,
                        offer: true 
                    }
                },
                invoices: true
            }
        });

        if (!order) throw new NotFoundException('Order not found');

        // Security Check: Only related parties can export
        const isMerchant = user.role === 'VENDOR' || user.role === 'MERCHANT';
        const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
        const isCustomer = user.role === 'CUSTOMER' && order.customerId === user.id;

        // Verify merchant ownership via multiple potential sources (Robust scan for legacy data)
        const orderStoreId = order.storeId 
            || order.acceptedOffer?.storeId 
            || order.offers?.[0]?.storeId 
            || order.payments?.[0]?.offer?.storeId;
        
        if (isMerchant && orderStoreId !== user.storeId) {
            console.error(`[ExcelService] 403 Forbidden: Store mismatch for Order ${orderId}`);
            console.error(`UserStore: ${user.storeId}, OrderStore: ${order.storeId}, AcceptedOfferStore: ${order.acceptedOffer?.storeId}, OfferListStore: ${order.offers?.[0]?.storeId}, PaymentOfferStore: ${order.payments?.[0]?.offer?.storeId}`);
            throw new ForbiddenException('Unauthorized access to this order invoice');
        }
        
        if (!isAdmin && !isMerchant && !isCustomer) {
            console.error(`[ExcelService] 403 Forbidden: User role ${user.role} not authorized for order ${orderId}`);
            throw new ForbiddenException('Unauthorized access');
        }

        const customerName = isMerchant ? 'E-Tashleh Customer' : (order.customer?.name || 'Customer');
        const customerEmail = isMerchant ? '---' : (order.customer?.email || '---');
        const customerPhone = isMerchant ? '---' : (order.customer?.phone || '---');

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Invoice');

        // Styles
        const headerStyle: Partial<ExcelJS.Style> = {
            font: { bold: true, size: 14, color: { argb: 'FFFFFFFF' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4AF37' } }, // Gold
            alignment: { horizontal: 'center' }
        };

        // Header
        sheet.mergeCells('A1:E1');
        const mainHeader = sheet.getCell('A1');
        mainHeader.value = isMerchant ? 'Merchant Entitlement Invoice' : 'Tax Invoice';
        mainHeader.style = headerStyle;

        sheet.addRow(['Order Number', order.orderNumber]);
        sheet.addRow(['Invoice Number', order.invoices?.[0]?.invoiceNumber || '---']);
        sheet.addRow(['Date', new Date().toLocaleDateString()]);
        sheet.addRow(['Status', order.status]);
        sheet.addRow(['Billed To', customerName]);
        if (!isMerchant) {
            sheet.addRow(['Email', customerEmail]);
            sheet.addRow(['Phone', customerPhone]);
        }
        sheet.addRow([]);

        // Data Table
        const tableHeader = isMerchant 
            ? ['Part Name', 'Description', 'Quantity', 'Currency', 'Earnings']
            : ['Part Name', 'Description', 'Quantity', 'Currency', 'Unit Price'];
        
        sheet.addRow(tableHeader);
        const tableHeaderRow = sheet.lastRow;
        tableHeaderRow.font = { bold: true };

        const payment = order.payments[0];
        const escrow = payment?.escrow;

        order.parts.forEach(part => {
            const amount = isMerchant 
                ? (escrow?.merchantAmount || payment?.unitPrice || 0)
                : (payment?.unitPrice || 0);

            sheet.addRow([
                part.name,
                part.description || '-',
                part.quantity || 1,
                payment?.currency || 'AED',
                Number(amount)
            ]);
        });

        sheet.addRow([]);

        // Totals breakdown based on role
        if (isMerchant) {
            sheet.addRow(['Merchant Earnings', Number(escrow?.merchantAmount || payment?.unitPrice || 0)]);
            sheet.addRow(['Total Entitlement', Number(escrow?.merchantAmount || payment?.unitPrice || 0)]);
        } else {
            sheet.addRow(['Subtotal', Number(payment?.unitPrice || 0)]);
            sheet.addRow(['Shipping', Number(payment?.shippingCost || 0)]);
            sheet.addRow(['Fees & VAT', Number(payment?.commission || 0)]);
            sheet.addRow(['Total Amount', Number(payment?.totalAmount || 0)]);
        }

        // Final Styling
        sheet.getColumn(1).width = 25;
        sheet.getColumn(2).width = 40;
        sheet.getColumn(5).width = 15;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Invoice_${order.orderNumber}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    }

    async exportWaybill(orderId: string, user: any, res: Response) {
        const waybills = await this.prisma.shippingWaybill.findMany({
            where: { orderId },
            include: { order: true, store: true }
        });

        if (!waybills || waybills.length === 0) throw new NotFoundException('Waybills not found');

        const isMerchant = user.role === 'VENDOR' || user.role === 'MERCHANT';
        if (isMerchant && waybills[0].storeId !== user.storeId) {
            console.error(`[ExcelService] 403 Forbidden: Waybill Store mismatch. UserStore: ${user.storeId}, WaybillStore: ${waybills[0].storeId}`);
            throw new ForbiddenException('Unauthorized access');
        }

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Waybills');

        sheet.addRow(['Waybill Number', 'Recipient', 'City', 'Phone', 'Part', 'Price', 'Currency', 'Issued At']);
        sheet.getRow(1).font = { bold: true };

        waybills.forEach(wb => {
            sheet.addRow([
                wb.waybillNumber,
                isMerchant ? 'E-Tashleh Customer' : wb.recipientName,
                wb.recipientCity,
                isMerchant ? '---' : wb.recipientPhone,
                wb.partName,
                Number(wb.finalPrice),
                wb.currency,
                wb.issuedAt.toLocaleDateString()
            ]);
        });

        sheet.getColumn(1).width = 20;
        sheet.getColumn(2).width = 25;
        sheet.getColumn(5).width = 30;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Waybills_${orderId}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    }
}
