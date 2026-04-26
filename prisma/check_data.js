const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://yhasbbmieqcgyjktgyro.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloYXNiYm1pZXFjZ3lqa3RneXJvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTcwOTE3MiwiZXhwIjoyMDg1Mjg1MTcyfQ.G03jKrgD9wjGp68GFbTXH1T4RN0O_1m25UhoVGLccgw'
);

async function check() {
  const { data: returns, error: rError } = await supabase
    .from('returns')
    .select('id, status, merchant_decision, merchant_response_text')
    .limit(5);
  
  console.log('--- Returns ---');
  console.log(JSON.stringify(returns, null, 2));

  const { data: disputes, error: dError } = await supabase
    .from('disputes')
    .select('id, status, merchant_decision, merchant_response_text')
    .limit(5);
  
  console.log('\n--- Disputes ---');
  console.log(JSON.stringify(disputes, null, 2));
}

check().catch(console.error);
