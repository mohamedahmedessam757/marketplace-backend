const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, '../terms_ar_new.txt'), 'utf8');
const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const enStartIdx = lines.findIndex((l) => l.includes('Terms &') || l.startsWith('Terms '));
const arLines = enStartIdx > 0 ? lines.slice(1, enStartIdx) : lines;
const enLines = enStartIdx > 0 ? lines.slice(enStartIdx + 1) : [];

const AR_HEADERS = new Set([
  'القبول والإلزام القانوني', 'طبيعة المنصة', 'الأنظمة والاختصاص القضائي',
  'الطلبات والعروض', 'الدفع والرسوم', 'الشحن والتوصيل', 'التوثيق بالصور',
  'المنتجات المحظورة', 'حدود المسؤولية', 'إخلاء المسؤولية', 'مكافحة التحايل',
  'الحساب والبيانات', 'النزاعات والتحكيم', 'القوة القاهرة', 'أحكام عامة',
  'سياسة الاسترجاع والاستبدال', 'طلب الاسترجاع', 'التسوية',
  'الاسترجاع بسبب عدم الرغبة', 'الاسترجاع بسبب خطأ أو عيب', 'شرط حالة المنتج',
  'مهلة إعادة الشحن', 'الاستبدال', 'عدم استلام الطلب',
  'المنتجات غير القابلة للإرجاع', 'استرجاع الأموال', 'إساءة استخدام سياسة الإرجاع',
  'تجميع الشحنات', 'الإلغاء قبل الشحن',
]);

function normalizeLine(line) {
  return line.replace(/^•\s*/, '').replace(/&amp;/g, '&').trim();
}

function finalizeBullets(raw) {
  const bullets = [];
  let current = '';

  const push = () => {
    const text = current.replace(/,\s*$/, '').trim();
    if (text && text !== '.' && text !== ':') bullets.push(text);
    current = '';
  };

  for (const line of raw) {
    const n = normalizeLine(line);
    if (!n || n === '.' || n === '⚠️') continue;

    if (n === ':') {
      current += ': ';
      continue;
    }

    if (n === '%' && current.endsWith('2')) {
      current += '%';
      push();
      continue;
    }

    if (current.endsWith(':') || current.endsWith(': ')) {
      current += n;
      push();
      continue;
    }

    if (current) push();
    current = n;
  }
  push();
  const merged = [];
  for (const b of bullets) {
    if (b === '%' && merged.length && merged[merged.length - 1].endsWith('2')) {
      merged[merged.length - 1] += '%';
    } else {
      merged.push(b);
    }
  }
  return merged;
}

function parseArSections(linesArr) {
  const sections = [];
  let current = null;

  for (const line of linesArr) {
    const n = normalizeLine(line);
    if (!n) continue;
    if (n === 'الشروط والأحكام وسياسة الارجاع') continue;

    if (AR_HEADERS.has(n)) {
      if (current) {
        current.content = finalizeBullets(current.raw);
        if (current.content.length) sections.push({ title: current.title, content: current.content });
      }
      current = { title: n, raw: [] };
      continue;
    }

    if (!current) current = { title: 'أحكام عامة', raw: [] };
    current.raw.push(n);
  }

  if (current) {
    current.content = finalizeBullets(current.raw);
    if (current.content.length) sections.push({ title: current.title, content: current.content });
  }

  return sections;
}

function parseEnSections(linesArr) {
  const sections = [];
  let current = null;

  const startSection = (title) => {
    if (current) {
      current.content = finalizeBullets(current.raw);
      if (current.content.length) sections.push({ title: current.title, content: current.content });
    }
    current = { title, raw: [] };
  };

  for (let i = 0; i < linesArr.length; i++) {
    const line = normalizeLine(linesArr[i]);
    if (!line || line === '⚠️') continue;

    if (/^Return\s*&/i.test(line)) {
      startSection('Return & Exchange Policy');
      continue;
    }

    if (/^\d+$/.test(line) && i + 1 < linesArr.length) {
      const next = normalizeLine(linesArr[i + 1]);
      const title = next.replace(/^\.\s*/, '').trim();
      if (title) {
        startSection(title);
        i++;
        continue;
      }
    }

    const inline = line.match(/^(\d+)\s*\.?\s*(.+)$/);
    if (inline && inline[2].length > 3) {
      startSection(inline[2].trim());
      continue;
    }

    if (!current) startSection('General Terms');
    if (line.startsWith('. ')) {
      current.raw.push(line.slice(2));
    } else {
      current.raw.push(line);
    }
  }

  if (current) {
    current.content = finalizeBullets(current.raw);
    if (current.content.length) sections.push({ title: current.title, content: current.content });
  }

  return sections;
}

const ar = parseArSections(arLines);
const en = parseEnSections(enLines);

const out = path.join(__dirname, '../Frontend/data/customerTerms.ts');
const content = `import type { TermsSection } from './termsTypes';

export const customerTermsAr: TermsSection[] = ${JSON.stringify(ar, null, 2)};

export const customerTermsEn: TermsSection[] = ${JSON.stringify(en, null, 2)};
`;
fs.writeFileSync(out, content, 'utf8');
console.log(`Wrote ${out} — AR: ${ar.length}, EN: ${en.length}`);
