const fs = require('fs');
const path = require('path');

const authPath = path.join(__dirname, '../Frontend/data/locales/auth.ts');
let content = fs.readFileSync(authPath, 'utf8');

if (!content.includes("from '../customerTerms'")) {
  content = "import { customerTermsAr, customerTermsEn } from '../customerTerms';\n\n" + content;
}

function replaceTermsContent(src, marker, replacement) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  const arrayStart = src.indexOf('termsContent: [', start);
  if (arrayStart < 0) throw new Error(`termsContent not found after ${marker}`);
  const sectionEnd = src.indexOf('\n    },\n    authSection:', arrayStart);
  if (sectionEnd < 0) throw new Error('authSection boundary not found');
  const before = src.slice(0, arrayStart);
  const after = src.slice(sectionEnd);
  return `${before}termsContent: ${replacement},${after}`;
}

content = replaceTermsContent(content, 'export const auth = {', 'customerTermsAr');
content = replaceTermsContent(content, "en: {", 'customerTermsEn');

content = content.replace(
  "termsItems: ['الالتزام بالأنظمة', 'سياسة الاسترجاع (يومين عمل)']",
  "termsItems: ['الالتزام بالأنظمة', 'سياسة الاسترجاع (24 ساعة)']",
);
content = content.replace(
  "termsItems: ['Fair Usage', 'Intellectual Property']",
  "termsItems: ['Fair Usage', 'Return Policy (24 hours)']",
);

fs.writeFileSync(authPath, content, 'utf8');
console.log('auth.ts patched');
