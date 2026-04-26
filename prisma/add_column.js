const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://yhasbbmieqcgyjktgyro.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloYXNiYm1pZXFjZ3lqa3RneXJvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTcwOTE3MiwiZXhwIjoyMDg1Mjg1MTcyfQ.G03jKrgD9wjGp68GFbTXH1T4RN0O_1m25UhoVGLccgw'
);

async function main() {
  console.log('=== Adding merchant_decision column to returns table ===\n');
  
  // Direct SQL via RPC (Assuming exec_sql is available or using the REST workaround if needed)
  // Since I don't have a reliable exec_sql RPC, I'll just inform the user to run it if I can't.
  // Wait, I can try to use a dummy update to see if it exists.
  
  const { error } = await supabase.rpc('exec_sql', {
    query: `ALTER TABLE returns ADD COLUMN IF NOT EXISTS merchant_decision TEXT;`
  });
  
  if (error) {
    console.log('Failed to add column via RPC:', error.message);
    console.log('Please run this SQL in Supabase SQL Editor:');
    console.log('ALTER TABLE returns ADD COLUMN IF NOT EXISTS merchant_decision TEXT;');
  } else {
    console.log('✅ Column merchant_decision added successfully!');
  }
}

main().catch(console.error);
