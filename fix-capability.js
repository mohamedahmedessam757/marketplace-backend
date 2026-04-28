// Diagnostic: Check the exact status of the connected account
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function diagnose(accountId) {
    try {
        const account = await stripe.accounts.retrieve(accountId);
        
        console.log(`\n===== Account Diagnostic: ${accountId} =====\n`);
        console.log(`Type:              ${account.type}`);
        console.log(`Business Type:     ${account.business_type}`);
        console.log(`Country:           ${account.country}`);
        console.log(`Charges Enabled:   ${account.charges_enabled}`);
        console.log(`Payouts Enabled:   ${account.payouts_enabled}`);
        console.log(`Details Submitted: ${account.details_submitted}`);
        
        console.log(`\n--- Capabilities ---`);
        if (account.capabilities) {
            for (const [key, value] of Object.entries(account.capabilities)) {
                console.log(`  ${key}: ${value}`);
            }
        } else {
            console.log(`  (none)`);
        }

        console.log(`\n--- Requirements ---`);
        const reqs = account.requirements;
        if (reqs) {
            console.log(`  Currently Due:      ${JSON.stringify(reqs.currently_due)}`);
            console.log(`  Eventually Due:     ${JSON.stringify(reqs.eventually_due)}`);
            console.log(`  Past Due:           ${JSON.stringify(reqs.past_due)}`);
            console.log(`  Pending Verification: ${JSON.stringify(reqs.pending_verification)}`);
            console.log(`  Disabled Reason:    ${reqs.disabled_reason || 'none'}`);
        }
        
        console.log(`\n===== END =====\n`);
    } catch (err) {
        console.error(`❌ Failed: ${err.message}`);
    }
}

diagnose('acct_1TLFJvRuHCJGxh5p');
