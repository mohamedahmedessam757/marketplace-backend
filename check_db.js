const { Client } = require('pg');
const client = new Client({
  connectionString: "postgresql://postgres.yhasbbmieqcgyjktgyro:sasoSASO%4000901500@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    await client.connect();
    console.log('Connected to DB');
    
    const typesRes = await client.query("SELECT n.nspname as schema, t.typname as type FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname IN ('store_loyalty_tier', 'StoreLoyaltyTier', 'loyalty_tier', 'LoyaltyTier')");
    console.log('Existing types:', typesRes.rows);
    
    const storeColRes = await client.query("SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name = 'stores' AND column_name = 'loyalty_tier'");
    console.log('Stores Column info:', storeColRes.rows);

    const userColRes = await client.query("SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'loyalty_tier'");
    console.log('Users Column info:', userColRes.rows);
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

check();
