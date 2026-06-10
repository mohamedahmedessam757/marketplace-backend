const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const jobs = [
  { input: 'الشروط والاحكام للعملاء نهائي2.docx', output: 'terms_ar_new.txt' },
  { input: 'العقد عربي (2).docx', output: 'contract_ar_v2.txt' },
  { input: 'العقد انجليزي (1).docx', output: 'contract_en_v2.txt' },
];

async function extract() {
  for (const job of jobs) {
    const inputPath = path.join(root, job.input);
    const outputPath = path.join(root, job.output);
    if (!fs.existsSync(inputPath)) {
      console.error(`Missing: ${inputPath}`);
      continue;
    }
    const result = await mammoth.extractRawText({ path: inputPath });
    fs.writeFileSync(outputPath, result.value, 'utf8');
    console.log(`OK: ${job.output} (${result.value.length} chars)`);
  }
}

extract().catch((e) => {
  console.error(e);
  process.exit(1);
});
