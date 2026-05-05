const { Client } = require('pg');
const client = new Client({
  connectionString: "postgresql://postgres.yhasbbmieqcgyjktgyro:sasoSASO%4000901500@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
  ssl: { rejectUnauthorized: false }
});

async function runFix() {
  try {
    await client.connect();
    console.log('Connected to DB');
    
    // 1. Create correctly named type
    console.log('Creating type store_loyalty_tier...');
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_loyalty_tier') THEN
          CREATE TYPE "store_loyalty_tier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');
        END IF;
      END $$;
    `);
    
    // 2. Alter column to use new type
    console.log('Altering column loyalty_tier to use store_loyalty_tier...');
    await client.query(`
      ALTER TABLE "stores" ALTER COLUMN "loyalty_tier" DROP DEFAULT;
      ALTER TABLE "stores" 
      ALTER COLUMN "loyalty_tier" TYPE "store_loyalty_tier" 
      USING ("loyalty_tier"::text::"store_loyalty_tier");
      ALTER TABLE "stores" ALTER COLUMN "loyalty_tier" SET DEFAULT 'BRONZE';
    `);
    
    console.log('Fix applied successfully!');
    
  } catch (err) {
    console.error('Error applying fix:', err);
  } finally {
    await client.end();
  }
}

runFix();
