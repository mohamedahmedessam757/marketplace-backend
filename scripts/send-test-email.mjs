/**
 * Send branded OTP preview email (run after: npm run build).
 * Usage: node scripts/send-test-email.mjs <email> [ar|en]
 */
import 'dotenv/config';
import { Resend } from 'resend';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let buildOtpEmail;
try {
  ({ buildOtpEmail } = require('../dist/src/email/templates/otp-email.template.js'));
} catch {
  console.error('Run "npm run build" first, then retry.');
  process.exit(1);
}

const to = process.argv[2];
const lang = process.argv[3] === 'en' ? 'en' : 'ar';

if (!to) {
  console.error('Usage: node scripts/send-test-email.mjs <email> [ar|en]');
  process.exit(1);
}

const siteUrl =
  process.env.RESEND_SITE_URL?.trim() ||
  (process.env.FRONTEND_URL?.includes('localhost')
    ? 'https://e-tashleh.net'
    : process.env.FRONTEND_URL?.replace(/\/$/, '')?.replace(/^["']|["']$/g, '')) ||
  'https://e-tashleh.net';

const logoUrl = process.env.RESEND_LOGO_URL?.trim() || `${siteUrl}/logo.png`;

const content = buildOtpEmail({
  name: lang === 'ar' ? 'محمد' : 'Mohamed',
  code: '482910',
  language: lang,
  purposeLabel: lang === 'ar' ? 'تسجيل الدخول' : 'Sign in',
  brand: { siteUrl, logoUrl },
});

const resend = new Resend(process.env.RESEND_API_KEY);
const { data, error } = await resend.emails.send({
  from: process.env.RESEND_FROM_EMAIL,
  to,
  subject: content.subject,
  html: content.html,
  text: content.text,
});

if (error) {
  console.error('FAIL:', error.message);
  process.exit(1);
}

console.log(`OK sent id=${data.id} → ${to} (${lang})`);
