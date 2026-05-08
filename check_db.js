require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  // Test: set to boolean false
  console.log('--- Setting ALLOW_CUSTOMER_ACCOUNT_DELETION to boolean false ---');
  const updated = await prisma.platformSettings.update({
    where: { settingKey: 'ALLOW_CUSTOMER_ACCOUNT_DELETION' },
    data: { settingValue: false, updatedAt: new Date() }
  });
  console.log('After update:', JSON.stringify(updated, null, 2));
  console.log('settingValue type:', typeof updated.settingValue);
  console.log('settingValue ===', updated.settingValue);
  
  // Read it back
  const readBack = await prisma.platformSettings.findUnique({
    where: { settingKey: 'ALLOW_CUSTOMER_ACCOUNT_DELETION' }
  });
  console.log('\nRead back:', JSON.stringify(readBack, null, 2));
  console.log('Read back type:', typeof readBack.settingValue);

  // Restore to true
  console.log('\n--- Restoring to boolean true ---');
  await prisma.platformSettings.update({
    where: { settingKey: 'ALLOW_CUSTOMER_ACCOUNT_DELETION' },
    data: { settingValue: true, updatedAt: new Date() }
  });
  const final = await prisma.platformSettings.findUnique({
    where: { settingKey: 'ALLOW_CUSTOMER_ACCOUNT_DELETION' }
  });
  console.log('Final:', JSON.stringify(final, null, 2));
  console.log('Final type:', typeof final.settingValue);
}
main().finally(() => prisma.$disconnect());
