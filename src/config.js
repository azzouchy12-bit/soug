import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const rootDir = process.cwd();
const stateDir = process.env.STATE_DIR || path.join(rootDir, "data");
const dataDir = path.resolve(stateDir);
const stateFile = path.join(dataDir, "state.json");
const uploadsDir = path.join(dataDir, "uploads");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

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
  publishIntervalMinutes: Number(process.env.POST_INTERVAL_MINUTES || 8 * 60),
  commentCheckIntervalMs: 15_000,
  repeatCommentReplyDelayMs: 30_000,
  commentActionGapMs: 3_000,
  databaseUrl: process.env.DATABASE_URL || "",
  facebookAppId: process.env.FB_APP_ID || "",
  facebookAppSecret: process.env.FB_APP_SECRET || "",
  facebookPageId: process.env.FB_PAGE_ID || "",
  facebookPageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN || "",
  timezone: process.env.TIMEZONE || "UTC",
  dataDir,
  stateFile,
  stateDir: dataDir,
  uploadsDir
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
