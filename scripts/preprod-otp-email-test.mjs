/**
 * Pre-production OTP email smoke test (Resend + API + DB schema).
 * Run: node scripts/preprod-otp-email-test.mjs
 */
import 'dotenv/config';
import { Resend } from 'resend';
import pg from 'pg';

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`✅ ${name}: ${detail}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`❌ ${name}: ${detail}`);
}

async function checkDbSchema() {
  const client = new pg.Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    const cols = await client.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'otp_challenges'
        AND column_name IN ('channel', 'phone', 'email')
      ORDER BY column_name
    `);
    const map = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.is_nullable]));
    if (!map.channel) {
      fail('DB migration', 'column "channel" missing — run 20260610_otp_channel.sql in Supabase');
      return null;
    }
    pass('DB migration', `channel=yes, phone_nullable=${map.phone}, email_nullable=${map.email}`);

    const sample = await client.query(
      `SELECT email, role FROM users WHERE role = 'CUSTOMER' AND email IS NOT NULL LIMIT 1`,
    );
    return sample.rows[0]?.email ?? null;
  } finally {
    await client.end();
  }
}

async function checkResendDirect() {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!key) {
    fail('Resend API key', 'RESEND_API_KEY missing');
    return;
  }
  if (!from) {
    fail('Resend from address', 'RESEND_FROM_EMAIL missing');
    return;
  }
  pass('Resend config', `from=${from}, enabled flag=${process.env.RESEND_ENABLED}`);

  const resend = new Resend(key);
  const to = process.env.OTP_TEST_TO?.trim();
  if (!to) {
    fail('Resend live send', 'Set OTP_TEST_TO in env to run a real delivery test (your inbox email)');
    return;
  }

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: 'E-Tshaleh OTP pre-prod test',
    html: '<p>If you received this, Resend + <strong>e-tshaleh.net</strong> are working.</p>',
    text: 'E-Tshaleh OTP pre-prod test — Resend delivery OK.',
  });

  if (error) {
    fail('Resend live send', error.message);
    return;
  }
  pass('Resend live send', `message id=${data?.id ?? 'unknown'} → ${to}`);
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function checkApiHealth() {
  try {
    const res = await fetch(`${API_BASE}/`);
    if (res.ok || res.status === 404) {
      pass('Backend reachable', API_BASE);
      return true;
    }
    fail('Backend reachable', `HTTP ${res.status}`);
    return false;
  } catch (e) {
    fail('Backend reachable', e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function checkRegisterInitEmail() {
  const stamp = Date.now();
  const body = {
    email: `otp.test.${stamp}@example.com`,
    phone: `+9665${String(stamp).slice(-8)}`,
    channel: 'email',
    name: 'OTP Test',
    role: 'customer',
  };
  const { status, json } = await apiPost('/auth/register-init', body);
  if (status === 201 || status === 200) {
    const ch = json?.channel ?? json?.message;
    pass('API register-init (email)', `HTTP ${status} — ${ch}`);
    return;
  }
  if (status === 500 && String(json?.message || json?.raw || '').includes('channel')) {
    fail('API register-init (email)', 'DB missing channel column — run migration');
    return;
  }
  fail('API register-init (email)', `HTTP ${status} — ${JSON.stringify(json)}`);
}

async function checkEmailLoginInit(existingEmail) {
  if (!existingEmail) {
    fail('API email-login-init', 'No CUSTOMER user in DB to test with');
    return;
  }
  const { status, json } = await apiPost('/auth/email-login-init', { email: existingEmail });
  if (status === 200 || status === 201) {
    pass('API email-login-init', `HTTP ${status} channel=${json?.channel} masked=${json?.maskedEmail ?? 'n/a'}`);
    return;
  }
  fail('API email-login-init', `HTTP ${status} — ${JSON.stringify(json)}`);
}

async function main() {
  console.log('\n=== E-Tshaleh OTP Email Pre-Prod Test ===\n');

  if (process.env.RESEND_ENABLED !== 'true') {
    console.log('⚠️  RESEND_ENABLED=false — API will log OTP to console only (dev mode).');
    console.log('   For real inbox test set RESEND_ENABLED=true and restart backend.\n');
  }

  const customerEmail = await checkDbSchema();
  await checkResendDirect();
  const up = await checkApiHealth();
  if (up) {
    await checkRegisterInitEmail();
    await checkEmailLoginInit(customerEmail);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Summary: ${results.length - failed.length}/${results.length} passed ===\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
