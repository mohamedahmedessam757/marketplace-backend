const https = require('https');
require('dotenv').config();

const apiKey = process.env.GEMINI_API_KEY;

https.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(body);
            if (parsed.models) {
                console.log("AVAILABLE MODELS:", parsed.models.map(m => m.name).join(', '));
            } else {
                console.log("RESPONSE:", parsed);
            }
        } catch (e) {
            console.log("Error parsing:", e);
        }
    });
}).on('error', (e) => {
    console.error(e);
});
