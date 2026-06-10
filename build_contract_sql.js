const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function prepareAr(text) {
  let t = text
    .replace(
      /شركة إليب ش\.م\.ح-ذ\.م\.م\s*،?\s*المالك للمنصة الالكترونية \(E-TASHLEH\)[^\n]+/i,
      'الطرف الأول: {{FIRST_PARTY_NAME_AR}} ،المالك للمنصة الالكترونية (e-tashleh) سجل تجاري {{FIRST_PARTY_CR}}، رخصة تجارية {{FIRST_PARTY_LICENSE}} والمنتهية بتاريخ {{FIRST_PARTY_EXPIRY}} ومقرها في {{FIRST_PARTY_HQ_AR}}.',
    )
    .replace(
      /الطرف الثاني: شركة-+\s*،?\s*ويمثلها مديرها الموقع -+/,
      'الطرف الثاني: شركة {{CUSTOMER_COMPANY_NAME}}، ويمثلها مديرها الموقع {{CUSTOMER_NAME}}',
    )
    .replace(/سجل تجاري رقم:\s*-+\s*،?\s*رخصة تجارية رقم:\s*-+والمنتهية بتاريخ-+/,
      'سجل تجاري رقم {{CUSTOMER_CR}}، رخصة تجارية رقم {{CUSTOMER_LICENSE}} والمنتهية بتاريخ {{CUSTOMER_EXPIRY}}',
    )
    .replace(/ومقرها في امارة\s*-+\s*بدولة\s*-+\./,
      'ومقرها في امارة {{CUSTOMER_EMIRATE}} بدولة {{CUSTOMER_COUNTRY}}.',
    )
    .replace(/&amp;/g, '&');

  const sigIdx = t.indexOf('تم توقيع العقد من الطرفين');
  if (sigIdx >= 0) {
    t = t.slice(0, sigIdx).trimEnd() + `

تمت الموافقة من: {{CUSTOMER_COMPANY_NAME}}
بتاريخ: {{CURRENT_DATE}}
الاسم المعتمد للتوقيع الإلكتروني: {{CUSTOMER_NAME}}
البريد الإلكتروني: {{CUSTOMER_EMAIL}}
رقم الجوال: {{CUSTOMER_PHONE}}
العنوان: {{CUSTOMER_ADDRESS}}`;
  }

  return t.trim();
}

function prepareEn(text) {
  let t = text
    .replace(/&amp;/g, '&')
    .replace(
      /First Party: ELLIPP FZ-LLC \(Website\/Platform Owner e-tashleh\), represented by its authorized manager\.\s*Commercial Registration Number 4036902, Commercial License 45000927, Trade license expiry date 19-6-2026, Based in Ras Al Khaimah\.\s*Second Party: \[Company Name\], represented by its authorized manager\.Commercial Registration Number\(\s*\), Commercial License\(\s*\)\s*, Trade license expiry date \(\s*\), Based in\(\s*\)\./,
      `First Party: {{FIRST_PARTY_NAME_EN}} (Website/Platform Owner e-tashleh), represented by its authorized manager.
Commercial Registration Number {{FIRST_PARTY_CR}}, Commercial License {{FIRST_PARTY_LICENSE}}, Trade license expiry date {{FIRST_PARTY_EXPIRY}}, Based in {{FIRST_PARTY_HQ_EN}}.

Second Party: {{CUSTOMER_COMPANY_NAME}}, represented by its authorized manager {{CUSTOMER_NAME}}.
Commercial Registration Number {{CUSTOMER_CR}}, Commercial License {{CUSTOMER_LICENSE}}, Trade license expiry date {{CUSTOMER_EXPIRY}}, Based in {{CUSTOMER_EMIRATE}}, {{CUSTOMER_COUNTRY}}.`,
    );

  const sigMarkers = ['Full Agreement', 'Entire Agreement', 'Signed by', 'Accepted By', 'Date:'];
  let cutAt = -1;
  for (const m of sigMarkers) {
    const idx = t.indexOf(m);
    if (idx >= 0 && (cutAt < 0 || idx < cutAt)) cutAt = idx;
  }
  if (cutAt >= 0) {
    t = t.slice(0, cutAt).trimEnd();
  }

  t += `

Accepted By: {{CUSTOMER_COMPANY_NAME}}
Date: {{CURRENT_DATE}}
Authorized Name for Electronic Signature: {{CUSTOMER_NAME}}
Email: {{CUSTOMER_EMAIL}}
Mobile Number: {{CUSTOMER_PHONE}}
Address: {{CUSTOMER_ADDRESS}}`;

  return t.trim();
}

const arRaw = fs.readFileSync(path.join(root, 'contract_ar_v2.txt'), 'utf8');
const enRaw = fs.readFileSync(path.join(root, 'contract_en_v2.txt'), 'utf8');
const contentAr = prepareAr(arRaw);
const contentEn = prepareEn(enRaw);

const firstPartyConfig = {
  companyNameAr: 'شركة إليب ش.م.ح-ذ.م.م',
  companyNameEn: 'ELLIPP FZ-LLC',
  crNumber: '4036902',
  licenseNumber: '45000927',
  licenseExpiry: '2026-06-19',
  headquartersAr: 'إمارة رأس الخيمة بدولة الامارات العربية المتحدة',
  headquartersEn: 'Ras Al Khaimah, United Arab Emirates',
};

const sql = `-- Run manually in Supabase SQL Editor
-- Backup platform_contracts before running

UPDATE platform_contracts
SET is_active = false
WHERE type = 'vendor_agreement';

INSERT INTO platform_contracts (
  type,
  title_ar,
  title_en,
  content_ar,
  content_en,
  first_party_config,
  version,
  is_active
)
SELECT
  'vendor_agreement',
  'عقد استضافة متجر إلكتروني',
  'E-Commerce Store Hosting Agreement',
  $AR$${contentAr}$AR$,
  $EN$${contentEn}$EN$,
  '${JSON.stringify(firstPartyConfig)}'::jsonb,
  COALESCE((SELECT MAX(version) FROM platform_contracts WHERE type = 'vendor_agreement'), 0) + 1,
  true;
`;

const outPath = path.join(root, 'migration_20260609_update_vendor_contract_v3.sql');
fs.writeFileSync(outPath, sql, 'utf8');
fs.writeFileSync(path.join(root, 'contract_ar_prepared.txt'), contentAr, 'utf8');
fs.writeFileSync(path.join(root, 'contract_en_prepared.txt'), contentEn, 'utf8');
console.log(`Wrote ${outPath}`);
console.log(`AR: ${contentAr.length} chars, EN: ${contentEn.length} chars`);
