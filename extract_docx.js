const mammoth = require("mammoth");
const fs = require("fs");

async function extract() {
  try {
    const enResult = await mammoth.extractRawText({path: "../العقد انجليزي.docx"});
    fs.writeFileSync("../contract_en.txt", enResult.value);
    console.log("English extracted");

    const arResult = await mammoth.extractRawText({path: "../العقد عربي (2)-2.docx"});
    fs.writeFileSync("../contract_ar.txt", arResult.value);
    console.log("Arabic extracted");
  } catch (e) {
    console.error(e);
  }
}

extract();
