import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const rootDir = process.cwd();
const stateDir = process.env.STATE_DIR || path.join(rootDir, "data");
const dataDir = path.resolve(stateDir);
const stateFile = path.join(dataDir, "state.json");

fs.mkdirSync(dataDir, { recursive: true });

function computeBaseUrl() {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }

  return "http://localhost:3000";
}

function computeAiProvider() {
  const explicitProvider = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicitProvider === "gemini" || explicitProvider === "") {
    return "gemini";
  }

  return explicitProvider;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: computeBaseUrl(),
  aiProvider: computeAiProvider(),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
  facebookAppId: process.env.FB_APP_ID || "",
  facebookAppSecret: process.env.FB_APP_SECRET || "",
  facebookPageId: process.env.FB_PAGE_ID || "",
  contentLanguage: process.env.CONTENT_LANGUAGE || "Arabic",
  contentBrief:
    process.env.CONTENT_BRIEF ||
    "اكتب منشورات عربية قصيرة ومفيدة لصفحتي على فيسبوك، بأسلوب احترافي وقريب من الناس.",
  postIntervalMinutes: Number(process.env.POST_INTERVAL_MINUTES || 10),
  timezone: process.env.TIMEZONE || "UTC",
  dataDir,
  stateFile,
  stateDir: dataDir
};

export function getMissingCoreConfig() {
  const missing = [];

  if (config.aiProvider !== "gemini") {
    missing.push("AI_PROVIDER must be gemini");
  }

  if (!config.geminiApiKey) {
    missing.push("GEMINI_API_KEY");
  }

  if (!config.facebookAppId) {
    missing.push("FB_APP_ID");
  }

  if (!config.facebookAppSecret) {
    missing.push("FB_APP_SECRET");
  }

  if (!config.facebookPageId) {
    missing.push("FB_PAGE_ID");
  }

  return missing;
}
