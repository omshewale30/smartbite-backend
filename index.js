

const express = require("express");
const cors = require("cors");


const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");
const fsSync = require("fs"); // Synchronous methods


const {
    VertexAI,
    HarmBlockThreshold,
    HarmCategory,
} = require("@google-cloud/vertexai");


const app = express();
app.use(cors());
app.use(express.json({limit:"10mb"})); // Parses JSON request
// s

const uploadDir = "/tmp/uploads";
if (!fsSync.existsSync(uploadDir)) {
    fsSync.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir); // Use /tmp/uploads
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname); // Get original extension
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Vertex AI Setup
const project = "studied-brand-452423-t6"; // Replace with your Google Cloud project ID
const location = "us-central1";
const textModel = "gemini-2.0-flash-001"
const visionModel = "gemini-1.0-pro-vision";


export const getGCPCredentials = () => {
    // for Vercel, use environment variables
    return process.env.GCP_PRIVATE_KEY
        ? {
            credentials: {
                client_email: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
                private_key: process.env.GCP_PRIVATE_KEY,
            },
            projectId: process.env.GCP_PROJECT_ID,
        }
        // for local development, use gcloud CLI
        : {};
};

const vertexAI = new VertexAI({
    project: process.env.GCP_PROJECT_ID,
    location: process.env.GCP_REGION,
    googleAuthOptions: getGCPCredentials()
});


const textGenerativeModel = vertexAI.getGenerativeModel({
    model: textModel,
    safetySettings: [
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
    ],
    generationConfig: { maxOutputTokens: 256 },
    systemInstruction: {
        role: "system",
        parts: [{ text: "You are a healthy cooking expert." }],
    },
});

const visionGenerativeModel = vertexAI.getGenerativeModel({
    model: visionModel,
});

// Function to clean Markdown from response
function cleanJsonResponse(text) {
    let cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    try {
        const parsed = JSON.parse(cleaned);
        // Ensure nutrition exists
        if (!parsed.nutrition) {
            parsed.nutrition = { protein: "N/A", carbs: "N/A", fat: "N/A" };
            cleaned = JSON.stringify(parsed); // Re-stringify with fallback
        }
        return cleaned;
    } catch (error) {
        console.error("Initial Parse Error:", error);
        throw error;
    }
}
// Extract ingredients from image
async function getIngredientsFromImage(imagePath) {
    try {
        console.log("Image Path:", imagePath);
        const imageBuffer = await fs.readFile(imagePath);
        const base64Image = imageBuffer.toString("base64");

        const prompt = `
            You are a culinary ingredient expert analyzing images of kitchen counters or fridge contents. 
            Identify all visible ingredients in the image. If a finished product (e.g., a sandwich, pizza) is present, deduce and list the likely ingredients used to make it, ignoring non-edible items. 
            Return only a comma-separated list of ingredients (e.g., "chicken, spinach, quinoa") with no extra text, explanations, or formatting.
        `;

        let mimeType;
        const ext = path.extname(imagePath).toLowerCase();
        console.log("Image Extension:", ext);

        switch (ext) {
            case '.jpg':
                mimeType = 'image/jpg';
                break;
            case '.jpeg':
                mimeType = 'image/jpeg';
                break;
            case '.png':
                mimeType = 'image/png';
                break;
            case '.webp':
                mimeType = 'image/webp';
                break;
            case '.heic':
                mimeType = 'image/heic';
                break;
            case '.heif':
                mimeType = 'image/heif';
                break;
            default:
                throw new Error(`Unsupported image format: ${ext}`);
        }

        const request = {
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt }, // Updated prompt
                    {
                        inlineData: {
                            data: base64Image,
                            mimeType: mimeType,
                        },
                    },
                ],
            }],
        };

        const response = await visionGenerativeModel.generateContent(request);
        const ingredients = response.response.candidates[0].content.parts[0].text.trim();
        return ingredients;

    } catch (error) {
        console.error("Error in getIngredientsFromImage:", error);
        throw error; // Re-throw for main handler
    }
}

app.post("/ingredients", upload.single("image"), async (req, res) => {
    let ingredients = req.body.ingredients;

    try {
        if (req.file) {
            ingredients = await getIngredientsFromImage(req.file.path);
            await fs.unlink(req.file.path);
        }
        if (!ingredients) return res.status(400).json({ error: "No ingredients provided" });
        res.json({ ingredients });
    } catch (error) {
        console.error("Vertex AI Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/recipes", upload.single("image"), async (req, res) => {
    let ingredients = req.body.ingredients;
    const dietaryRestriction = req.body.dietaryRestriction;

    try {
        if (req.file) {
            ingredients = await getIngredientsFromImage(req.file.path);
            await fs.unlink(req.file.path);
        }
        if (!ingredients) return res.status(400).json({ error: "No ingredients provided" });

        const prompt = `
            You are a skilled chef and nutritionist tasked with creating healthy recipes.
            Using these ingredients: ${ingredients}, suggest a ${dietaryRestriction ? `${dietaryRestriction} ` : ""}recipe that maximizes the use of the provided items.
            If the ingredients suggest a finished product (e.g., "bread, ham, cheese" from a sandwich), create a recipe that incorporates those components logically.
            Return only a complete JSON object with exactly these fields:
            - "name": string (recipe name)
            - "steps": string (cooking instructions with steps numbered clearly, separated by newlines)
            - "calories": number (total calories, estimated)
            - "nutrition": object with "protein", "carbs", "fat" (each as strings with units, e.g., "20g")
            Do not include extra text, markdown, explanations, or incomplete data outside the JSON object.
        `;

        const response = await textGenerativeModel.generateContent(prompt);
        const recipeText = response.response.candidates[0].content.parts[0].text;
        console.log("Raw Recipe Text:", recipeText); // Debug raw output
        const cleanText = cleanJsonResponse(recipeText);
        const recipe = JSON.parse(cleanText);
        res.json(recipe);
    } catch (error) {
        console.error("VertexAI Error:", error);
        res.status(500).json({ error: error.message });
    }
});
const PORT = process.env.PORT || 5000;
//
app.listen(PORT, () => console.log("Backend running on http://localhost:5000"));
module.exports = app;
