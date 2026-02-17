
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('--- Enabling RLS Policies ---');

    const policies = [
        {
            table: 'returns',
            name: 'Enable read for users based on customer_id',
            sql: `CREATE POLICY "Enable read for users based on customer_id" ON public.returns FOR SELECT USING (auth.uid() = customer_id);`
        },
        {
            table: 'disputes',
            name: 'Enable read for users based on customer_id',
            sql: `CREATE POLICY "Enable read for users based on customer_id" ON public.disputes FOR SELECT USING (auth.uid() = customer_id);`
        }
    ];

    for (const p of policies) {
        try {
            console.log(`Setting up policy for ${p.table}...`);
            // Enable RLS
            await prisma.$executeRawUnsafe(`ALTER TABLE public.${p.table} ENABLE ROW LEVEL SECURITY;`);

            // Drop if exists
            await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS "${p.name}" ON public.${p.table};`);

            // Create Policy
            await prisma.$executeRawUnsafe(p.sql);
            console.log(`✅ Policy applied on ${p.table}`);
        } catch (e) {
            console.error(`❌ Error on ${p.table}:`, e.message);
        }
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
