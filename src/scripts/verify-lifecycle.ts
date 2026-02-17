
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OrdersService } from '../orders/orders.service';
import { OffersService } from '../offers/offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, UserRole, ActorType } from '@prisma/client';
import { OrderCleanupService } from '../scheduler/order-cleanup.service';

async function main() {
    console.log('🚀 Starting Order Lifecycle Verification...');

    const app = await NestFactory.createApplicationContext(AppModule);
    const prisma = app.get(PrismaService);
    const ordersService = app.get(OrdersService);
    const offersService = app.get(OffersService);
    const cleanupService = app.get(OrderCleanupService);

    try {
        // 1. Setup Data (Customer & Vendor)
        console.log('\n📦 Setting up test data...');
        const emailSuffix = Date.now();

        // Create Customer
        let customer = await prisma.user.create({
            data: {
                email: `customer${emailSuffix}@test.com`,
                passwordHash: 'hashedpassword',
                name: 'Test Customer',
                role: 'CUSTOMER',
                phone: `+9665${emailSuffix.toString().slice(-8)}`
            }
        });
        console.log(`✅ Customer created: ${customer.email}`);

        // Create Vendor & Store
        const vendor = await prisma.user.create({
            data: {
                email: `vendor${emailSuffix}@test.com`,
                passwordHash: 'hashedpassword',
                name: 'Test Vendor',
                role: 'VENDOR',
                phone: `+9665${(emailSuffix + 1).toString().slice(-8)}`
            }
        });
        const store = await prisma.store.create({
            data: {
                name: `Store ${emailSuffix}`,
                ownerId: vendor.id,
                status: 'ACTIVE',
                licenseExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // +1 year
            }
        });
        console.log(`✅ Vendor & Store created: ${store.name}`);

        // 2. Create Order
        console.log('\n📝 1. Creating Order...');
        const order = await ordersService.create(customer.id, {
            vehicleMake: 'Toyota',
            vehicleModel: 'Camry',
            vehicleYear: 2022,
            parts: [{ name: 'Brake Pad', description: 'Front pair' }],
            requestType: 'PARTS',
            shippingType: 'DELIVERY'
        });

        if (order.status !== OrderStatus.AWAITING_OFFERS) throw new Error(`Status mismatch: ${order.status}`);
        console.log(`✅ Order ${order.orderNumber} created. Status: ${order.status}`);

        // 3. Create Offer
        console.log('\n🏷️ 2. Creating Offer...');
        const offer = await offersService.create(vendor.id, {
            orderId: order.id,
            unitPrice: 150,
            hasWarranty: true,
            partType: 'ORIGINAL',
            weightKg: 5,
            deliveryDays: '2 days',
            condition: 'NEW',
            notes: 'Best quality'
        });
        console.log(`✅ Offer created with price: ${offer.unitPrice}`);

        // 4. Accept Offer
        console.log('\n🤝 3. Accepting Offer...');
        const acceptedOrder = await ordersService.acceptOffer(order.id, offer.id, customer.id);

        if (acceptedOrder.status !== OrderStatus.AWAITING_PAYMENT) throw new Error(`Status mismatch: ${acceptedOrder.status}`);
        if (acceptedOrder.acceptedOfferId !== offer.id) throw new Error('Offer not linked correctly');
        console.log(`✅ Offer accepted. Order Status: ${acceptedOrder.status}`);

        // 5. Simulate Payment
        console.log('\n💳 4. Simulating Payment...');
        const paidOrder = await ordersService.transitionStatus(
            order.id,
            OrderStatus.PREPARATION,
            { id: 'payment-gateway', type: ActorType.SYSTEM, name: 'Stripe' },
            'Payment confirmed'
        );
        if (paidOrder.status !== OrderStatus.PREPARATION) throw new Error(`Status mismatch: ${paidOrder.status}`);
        console.log(`✅ Payment successful. Order Status: ${paidOrder.status}`);

        // 6. Simulate Shipping
        console.log('\n🚚 5. Simulating Shipping...');
        const shippedOrder = await ordersService.transitionStatus(
            order.id,
            OrderStatus.SHIPPED,
            { id: vendor.id, type: ActorType.VENDOR },
            'Order shipped'
        );
        console.log(`✅ Order Shipped. Status: ${shippedOrder.status}`);

        // 7. Expiration Logic Test
        console.log('\n⏳ 6. Testing Expiration Logic...');
        const expiredOrder = await ordersService.create(customer.id, {
            vehicleMake: 'Honda',
            vehicleModel: 'Accord',
            vehicleYear: 2020,
            parts: [{ name: 'Mirror', description: 'Left' }],
            requestType: 'PARTS',
            shippingType: 'DELIVERY'
        });
        console.log(`   Created temporary order ${expiredOrder.orderNumber}`);

        // Backdate to 25 hours ago
        await prisma.order.update({
            where: { id: expiredOrder.id },
            data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
        });
        console.log('   Backdated order to -25 hours');

        // Run Cleanup
        console.log('   Running cleanup job manually...');
        await cleanupService.handleCron();

        const checkExpired = await prisma.order.findUnique({ where: { id: expiredOrder.id } });
        if (checkExpired.status !== OrderStatus.CANCELLED) throw new Error(`Expiration failed. Status: ${checkExpired.status}`);
        console.log(`✅ Order ${checkExpired.orderNumber} correctly expired to CANCELLED`);

        console.log('\n✨ All Verification Steps Passed Successfully! ✨');

    } catch (error) {
        console.error('\n❌ Verification Failed:', error);
    } finally {
        await app.close();
    }
}

main();
