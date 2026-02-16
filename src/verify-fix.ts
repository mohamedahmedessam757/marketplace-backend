
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Start verifying order creation...');

    try {
        const customer = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
        if (!customer) {
            console.error('No customer found to test with.');
            return;
        }

        const orderNumber = `TEST-${Date.now()}`;

        console.log('Creating order for customer:', customer.id);

        const order = await prisma.order.create({
            data: {
                orderNumber,
                customerId: customer.id,
                vehicleMake: 'Toyota',
                vehicleModel: 'Camry',
                vehicleYear: 2022,
                status: 'AWAITING_OFFERS',

                // Legacy check
                partName: 'Engine',
                partDescription: 'V6 Engine',
                partImages: [],

                // Multi-part support check
                // @ts-ignore: IDE stale type definition
                parts: {
                    create: [
                        { name: 'Engine', description: 'V6 Engine', images: [] },
                        { name: 'Gearbox', description: 'Automatic', images: [] }
                    ]
                },
            },
            include: {
                // @ts-ignore: IDE stale type definition
                parts: true
            }
        });

        console.log('✅ Order created successfully:', order.id);

        // @ts-ignore: IDE stale type definition
        console.log('Parts created:', order.parts.length);
        // @ts-ignore: IDE stale type definition
        console.log('Parts:', order.parts);

        // @ts-ignore: IDE stale type definition
        if (order.parts.length === 2) {
            console.log('SUCCESS: Multiple parts created.');
        } else {
            // @ts-ignore: IDE stale type definition
            console.error('FAILURE: Expected 2 parts, got', order.parts.length);
        }

    } catch (error) {
        console.error('❌ Error creating order:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
