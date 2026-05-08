require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  await prisma.platformSettings.update({ 
    where: { settingKey: 'CHAT_ATTACHMENTS_ENABLED' }, 
    data: { settingValue: false } 
  });
  await prisma.platformSettings.update({ 
    where: { settingKey: 'ALLOW_CUSTOMER_ACCOUNT_DELETION' }, 
    data: { settingValue: false } 
  });
  console.log('Successfully set both to false');
}
main().finally(() => prisma.$disconnect());
