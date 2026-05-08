require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const all = await prisma.platformSettings.findMany({ 
    where: { 
        settingKey: { in: ['ALLOW_CUSTOMER_ACCOUNT_DELETION', 'CHAT_ATTACHMENTS_ENABLED'] } 
    }
  });
  console.log(JSON.stringify(all, null, 2));
}
main().finally(() => prisma.$disconnect());
