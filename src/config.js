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
    const raw = process.env.BASE_URL.trim();
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw;
    }

    return `https://${raw}`;
  }

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }

  return "http://localhost:3000";
}

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: computeBaseUrl(),
  dashboardAccessCode: "5598",
  databaseUrl: process.env.DATABASE_URL || "",
  deepSeekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepSeekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  postsPerBatch: Number(process.env.POSTS_PER_BATCH || 20),
  queueRefillThreshold: Number(process.env.QUEUE_REFILL_THRESHOLD || 0),
  minWords: Number(process.env.MIN_WORDS || 8),
  maxWords: Number(process.env.MAX_WORDS || 12),
  similarityThreshold: Number(process.env.SIMILARITY_THRESHOLD || 0.75),
  topic: process.env.TOPIC || "حكم وأمثال قصيرة",
  language: process.env.LANGUAGE || "ar",
  style: process.env.STYLE || "قصير وواضح",
  facebookAppId: process.env.FB_APP_ID || "",
  facebookAppSecret: process.env.FB_APP_SECRET || "",
  facebookPageId: process.env.FB_PAGE_ID || "",
  facebookPageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN || "",
  postIntervalMinutes: Number(process.env.POST_INTERVAL_MINUTES || 10),
  timezone: process.env.TIMEZONE || "UTC",
  dataDir,
  stateFile,
  stateDir: dataDir
};

export function getMissingCoreConfig() {
  const missing = [];

  if (!config.facebookPageId) {
    missing.push("FB_PAGE_ID");
  }

  if (!config.facebookPageAccessToken) {
    if (!config.facebookAppId) {
      missing.push("FB_APP_ID");
    }

    if (!config.facebookAppSecret) {
      missing.push("FB_APP_SECRET");
    }
  }

  return missing;
}
