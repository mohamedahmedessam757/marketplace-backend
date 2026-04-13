import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function test() {
    try {
        const store = await prisma.store.findFirst({
            where: { owner: { name: { contains: "Mohamed", mode: "insensitive" } } },
            include: { owner: true }
        });
        
        let targetStore = store;
        const allStores = await prisma.store.findMany({ include: { owner: true } });
        for(const s of allStores) {
            const c = await prisma.walletTransaction.count({ where: { userId: s.ownerId } });
            if(c > 0) targetStore = s;
        }

        const walletActs = await prisma.walletTransaction.findMany({
            where: { userId: targetStore.ownerId, role: 'VENDOR' },
            include: {
                payment: {
                    select: {
                        orderId: true,
                        status: true,
                        totalAmount: true,
                        unitPrice: true,
                        commission: true,
                        order: { select: { id: true, orderNumber: true, status: true } }
                    }
                }
            }
        });

        console.log(`Testing with Store: ${targetStore.name}, User: ${targetStore.ownerId}`);
        console.log(`walletActions count: ${walletActs.length}`);
        
        const COMPLETED_STATUSES = ['COMPLETED', 'DELIVERED'];
        const ACTIVE_STATUSES = ['PREPARATION', 'PREPARED', 'VERIFICATION', 'VERIFICATION_SUCCESS', 'READY_FOR_SHIPPING', 'SHIPPED', 'CORRECTION_PERIOD', 'CORRECTION_SUBMITTED', 'DELAYED_PREPARATION', 'NON_MATCHING'];
        const FROZEN_STATUSES = ['DISPUTED', 'RETURN_REQUESTED', 'RETURNED', 'RETURN_APPROVED'];
        const EXCLUDED_STATUSES = ['CANCELLED', 'AWAITING_PAYMENT', 'AWAITING_OFFERS', 'REFUNDED'];

        let available = 0, pending = 0, totalSales = 0;

        walletActs.forEach(action => {
            const amount = Number(action.amount);
            console.log(`Action: ${action.transactionType}, Amt: ${amount}, Type: ${action.type}, OrderStatus: ${action.payment?.order?.status}`);
            
            if (['payment', 'SALE', 'commission'].includes(action.transactionType) && action.type === 'CREDIT') {
                const orderStatus = action.payment?.order?.status || 'COMPLETED';
                if (COMPLETED_STATUSES.includes(orderStatus)) available += amount;
                else if (ACTIVE_STATUSES.includes(orderStatus)) pending += amount;
                
                if (!EXCLUDED_STATUSES.includes(orderStatus)) totalSales += amount;
            }
        });

        console.log(`Simulated stats -> available: ${available}, pending: ${pending}, totalSales: ${totalSales}`);

    } catch(err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}
test();
