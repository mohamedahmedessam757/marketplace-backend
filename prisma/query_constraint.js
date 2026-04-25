const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://yhasbbmieqcgyjktgyro.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloYXNiYm1pZXFjZ3lqa3RneXJvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTcwOTE3MiwiZXhwIjoyMDg1Mjg1MTcyfQ.G03jKrgD9wjGp68GFbTXH1T4RN0O_1m25UhoVGLccgw'
);

async function verify() {
  const DISPUTE_ID = '688cc07c-71fe-49ac-8795-55c7dc004d06';
  
  console.log('=== Verifying disputes_status_check constraint ===\n');
  
  // Test AWAITING_ADMIN
  const { error } = await supabase
    .from('disputes')
    .update({ status: 'AWAITING_ADMIN' })
    .eq('id', DISPUTE_ID)
    .select('id, status');
  
  if (error && error.message.includes('check constraint')) {
    console.log('❌ AWAITING_ADMIN is STILL BLOCKED - SQL was NOT executed!');
    console.log('   Error:', error.message);
  } else if (error) {
    console.log('⚠️ Other error:', error.message);
  } else {
    console.log('✅ AWAITING_ADMIN is now ALLOWED! Constraint updated successfully.');
    // Revert back to OPEN
    await supabase.from('disputes').update({ status: 'OPEN' }).eq('id', DISPUTE_ID);
    console.log('   (Reverted back to OPEN for testing)');
  }
}

verify().catch(console.error);
