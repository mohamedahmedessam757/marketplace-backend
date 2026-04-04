const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function run() {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("hello");
        console.log("SUCCESS! Model: gemini-1.5-flash response:", result.response.text());
    } catch (e) {
        console.error("FAILED gemini-1.5-flash:", e.message);
    }
}

run();
