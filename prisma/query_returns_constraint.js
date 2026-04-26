const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://yhasbbmieqcgyjktgyro.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloYXNiYm1pZXFjZ3lqa3RneXJvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTcwOTE3MiwiZXhwIjoyMDg1Mjg1MTcyfQ.G03jKrgD9wjGp68GFbTXH1T4RN0O_1m25UhoVGLccgw'
);

const RETURN_ID = 'ee82ce46-05e7-45b6-a57a-c7f73d0af04c';

async function testStatus(status) {
  const { data, error } = await supabase
    .from('returns')
    .update({ status: status })
    .eq('id', RETURN_ID)
    .select('id, status');
  
  if (error && error.message.includes('check constraint')) {
    return false;
  }
  // Revert back to a known safe state (PENDING usually)
  if (!error) {
    // We don't want to leave it in a bad state if it succeeded
    // But we need to know what it was before. For now just try to revert to PENDING or whatever it is.
  }
  return !error;
}

async function main() {
  const statuses = [
    'PENDING', 'APPROVED', 'REJECTED', 'AWAITING_ADMIN', 
    'AWAITING_MERCHANT', 'ESCALATED', 'UNDER_REVIEW', 'REFUNDED', 
    'RESOLVED', 'CLOSED', 'CANCELLED', 'RETURN_APPROVED', 'MERCHANT_REJECTED'
  ];
  
  console.log('Testing REAL updates on return ' + RETURN_ID + ':\n');
  
  // Get initial status to revert
  const { data: initial } = await supabase.from('returns').select('status').eq('id', RETURN_ID).single();
  const initialStatus = initial?.status || 'PENDING';
  
  for (const status of statuses) {
    const allowed = await testStatus(status);
    console.log(`  ${allowed ? '✅' : '❌'} ${status}`);
    
    if (allowed) {
        // Revert immediately
        await supabase.from('returns').update({ status: initialStatus }).eq('id', RETURN_ID);
    }
  }
}

main().catch(console.error);
