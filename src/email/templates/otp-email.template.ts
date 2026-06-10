export type OtpEmailLanguage = 'ar' | 'en';

export interface OtpEmailBrand {
    siteUrl: string;
    logoUrl: string;
}

export interface OtpEmailContent {
    subject: string;
    html: string;
    text: string;
}

/** Matches Frontend gold palette */
const COLORS = {
    gold: '#A88B3E',
    goldLight: '#C9A84C',
    goldDark: '#8B7229',
    bgOuter: '#0F0E0D',
    bgCard: '#1A1814',
    bgMuted: '#2A2418',
    borderGold: 'rgba(168,139,62,0.35)',
    textPrimary: '#FAFAF9',
    textMuted: '#A8A29E',
    textDim: '#78716C',
} as const;

const BRAND_AR = 'E-Tshaleh | إي تشليح';
const BRAND_EN = 'E-Tshaleh';
const EXPIRY_MINUTES = 10;

export function buildOtpEmail(params: {
    name: string;
    code: string;
    language?: OtpEmailLanguage;
    purposeLabel?: string;
    brand?: OtpEmailBrand;
}): OtpEmailContent {
    const lang = params.language ?? 'ar';
    const name = params.name.trim() || (lang === 'ar' ? 'مستخدم' : 'User');
    const purpose = params.purposeLabel?.trim();
    const siteUrl = params.brand?.siteUrl?.replace(/\/$/, '') || 'https://e-tashleh.net';
    const logoUrl = params.brand?.logoUrl || `${siteUrl}/logo.png`;

    if (lang === 'en') {
        const subject = purpose
            ? `${purpose} — ${BRAND_EN}`
            : `Your verification code — ${BRAND_EN}`;
        return {
            subject,
            html: buildHtml({
                dir: 'ltr',
                lang: 'en',
                name,
                code: params.code,
                purpose,
                siteUrl,
                logoUrl,
                title: purpose || 'Verification code',
                greeting: `Hello <strong style="color:${COLORS.goldLight}">${escapeHtml(name)}</strong>,`,
                body: `Use the code below to continue on <strong>${BRAND_EN}</strong>. It expires in <strong>${EXPIRY_MINUTES} minutes</strong>.`,
                codeLabel: 'Your code',
                security:
                    'Do not share this code with anyone. E-Tshaleh will never ask for it by phone, email reply, or chat.',
                footer: BRAND_EN,
                cta: 'Open E-Tshaleh',
            }),
            text: [
                `Hello ${name},`,
                '',
                purpose ? `${purpose}` : 'Verification code',
                `Your code: ${params.code}`,
                `Expires in ${EXPIRY_MINUTES} minutes.`,
                '',
                securityTextEn(),
                siteUrl,
            ].join('\n'),
        };
    }

    const subject = purpose
        ? `${purpose} — ${BRAND_AR}`
        : `رمز التحقق — ${BRAND_AR}`;

    return {
        subject,
        html: buildHtml({
            dir: 'rtl',
            lang: 'ar',
            name,
            code: params.code,
            purpose,
            siteUrl,
            logoUrl,
            title: purpose || 'رمز التحقق',
            greeting: `مرحباً <strong style="color:${COLORS.goldLight}">${escapeHtml(name)}</strong>،`,
            body: `استخدم الرمز التالي لإكمال العملية على <strong>${BRAND_AR}</strong>. صلاحيته <strong>${EXPIRY_MINUTES} دقائق</strong>.`,
            codeLabel: 'رمز التحقق',
            security:
                'لا تشارك هذا الرمز مع أي شخص. E-Tshaleh لن يطلبه منك عبر الهاتف أو الرد على الإيميل أو المحادثات.',
            footer: BRAND_AR,
            cta: 'فتح المنصة',
        }),
        text: [
            `مرحباً ${name}،`,
            '',
            purpose ? `${purpose}` : 'رمز التحقق',
            `الرمز: ${params.code}`,
            `صلاحيته ${EXPIRY_MINUTES} دقائق.`,
            '',
            securityTextAr(),
            siteUrl,
        ].join('\n'),
    };
}

interface HtmlParams {
    dir: 'rtl' | 'ltr';
    lang: string;
    name: string;
    code: string;
    purpose?: string;
    siteUrl: string;
    logoUrl: string;
    title: string;
    greeting: string;
    body: string;
    codeLabel: string;
    security: string;
    footer: string;
    cta: string;
}

function buildHtml(p: HtmlParams): string {
    const align = p.dir === 'rtl' ? 'right' : 'left';
    const purposeBadge = p.purpose
        ? `<tr>
            <td style="padding:0 32px 8px;text-align:${align}">
              <span style="display:inline-block;background:${COLORS.bgMuted};color:${COLORS.goldLight};font-size:12px;font-weight:600;padding:6px 14px;border-radius:999px;border:1px solid ${COLORS.borderGold};letter-spacing:0.3px;">
                ${escapeHtml(p.purpose)}
              </span>
            </td>
          </tr>`
        : '';

    return `<!DOCTYPE html>
<html lang="${p.lang}" dir="${p.dir}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <title>${escapeHtml(p.title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bgOuter};font-family:'Segoe UI',Tahoma,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${COLORS.bgOuter};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:${COLORS.bgCard};border-radius:20px;overflow:hidden;border:1px solid ${COLORS.borderGold};box-shadow:0 8px 32px rgba(0,0,0,0.45);">
          <!-- Gold accent bar -->
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,${COLORS.goldDark},${COLORS.gold},${COLORS.goldLight});font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <!-- Logo + brand -->
          <tr>
            <td style="padding:28px 32px 12px;text-align:center;background:linear-gradient(180deg,${COLORS.bgMuted} 0%,${COLORS.bgCard} 100%);">
              <a href="${escapeHtml(p.siteUrl)}" style="text-decoration:none;display:inline-block;">
                <img src="${escapeHtml(p.logoUrl)}" alt="E-Tshaleh" width="72" height="72" style="display:block;margin:0 auto 12px;border-radius:16px;border:1px solid ${COLORS.borderGold};"/>
              </a>
              <div style="font-size:18px;font-weight:700;color:${COLORS.textPrimary};letter-spacing:0.5px;">
                E-Tshaleh
              </div>
              <div style="font-size:12px;color:${COLORS.gold};margin-top:4px;opacity:0.9;">
                ${p.lang === 'ar' ? 'إي تشليح — سوق قطع الغيار' : 'Auto Parts Marketplace'}
              </div>
            </td>
          </tr>
          ${purposeBadge}
          <!-- Title -->
          <tr>
            <td style="padding:16px 32px 0;text-align:${align};">
              <h1 style="margin:0;font-size:22px;font-weight:700;color:${COLORS.textPrimary};line-height:1.4;">
                ${escapeHtml(p.title)}
              </h1>
            </td>
          </tr>
          <!-- Greeting -->
          <tr>
            <td style="padding:12px 32px 0;text-align:${align};">
              <p style="margin:0;font-size:15px;line-height:1.7;color:${COLORS.textMuted};">
                ${p.greeting}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0;text-align:${align};">
              <p style="margin:0;font-size:15px;line-height:1.7;color:${COLORS.textMuted};">
                ${p.body}
              </p>
            </td>
          </tr>
          <!-- OTP box -->
          <tr>
            <td style="padding:28px 32px;text-align:center;">
              <div style="font-size:11px;font-weight:600;color:${COLORS.textDim};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">
                ${escapeHtml(p.codeLabel)}
              </div>
              <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto;">
                <tr>
                  <td style="background:linear-gradient(135deg,${COLORS.bgMuted},${COLORS.bgCard});border:2px solid ${COLORS.gold};border-radius:16px;padding:22px 36px;box-shadow:0 4px 24px rgba(168,139,62,0.25);">
                    <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:${COLORS.goldLight};font-family:Consolas,'Courier New',monospace;direction:ltr;display:inline-block;">
                      ${escapeHtml(p.code)}
                    </span>
                  </td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:12px;color:${COLORS.textDim};">
                ⏱ ${p.lang === 'ar' ? `ينتهي خلال ${EXPIRY_MINUTES} دقائق` : `Expires in ${EXPIRY_MINUTES} minutes`}
              </div>
            </td>
          </tr>
          <!-- Security -->
          <tr>
            <td style="padding:0 32px 24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${COLORS.bgMuted};border-radius:12px;border:1px solid rgba(168,139,62,0.15);">
                <tr>
                  <td style="padding:14px 18px;text-align:${align};">
                    <span style="font-size:13px;line-height:1.6;color:${COLORS.textDim};">
                      🔒 ${escapeHtml(p.security)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- CTA -->
          <tr>
            <td style="padding:0 32px 28px;text-align:center;">
              <a href="${escapeHtml(p.siteUrl)}" style="display:inline-block;background:linear-gradient(90deg,${COLORS.goldDark},${COLORS.gold});color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:12px;box-shadow:0 4px 20px rgba(168,139,62,0.35);">
                ${escapeHtml(p.cta)} →
              </a>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;background:${COLORS.bgMuted};border-top:1px solid ${COLORS.borderGold};text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:${COLORS.gold};font-weight:600;">
                ${escapeHtml(p.footer)}
              </p>
              <p style="margin:0;font-size:11px;color:${COLORS.textDim};line-height:1.5;">
                <a href="${escapeHtml(p.siteUrl)}" style="color:${COLORS.textDim};text-decoration:underline;">${escapeHtml(p.siteUrl.replace(/^https?:\/\//, ''))}</a>
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;font-size:11px;color:${COLORS.textDim};text-align:center;max-width:520px;">
          ${p.lang === 'ar' ? 'رسالة تلقائية — لا ترد على هذا البريد' : 'Automated message — please do not reply'}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

function securityTextAr(): string {
    return 'لا تشارك هذا الرمز مع أي شخص.';
}

function securityTextEn(): string {
    return 'Do not share this code with anyone.';
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
