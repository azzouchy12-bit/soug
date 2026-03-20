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

function readEnv(name, fallback = "") {
  const raw = process.env[name];
  if (raw === undefined || raw === null) {
    return fallback;
  }

  const trimmed = String(raw).trim();
  if (!trimmed) {
    return fallback;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function readTokenEnv(name, fallback = "") {
  const value = readEnv(name, fallback);
  return value.replace(/[\r\n]+/g, "").trim();
}

function computeBaseUrl() {
  const configuredBaseUrl = readEnv("BASE_URL");
  if (configuredBaseUrl) {
    const raw = configuredBaseUrl;
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw;
    }

    return `https://${raw}`;
  }

  const railwayDomain = readEnv("RAILWAY_PUBLIC_DOMAIN");
  if (railwayDomain) {
    return `https://${railwayDomain}`;
  }

  return "http://localhost:3000";
}

export const config = {
  port: Number(readEnv("PORT", "3000") || 3000),
  baseUrl: computeBaseUrl(),
  dashboardAccessCode: "5598",
  publishIntervalMinutes: Number(readEnv("POST_INTERVAL_MINUTES", String(8 * 60)) || 8 * 60),
  commentCheckIntervalMs: 15_000,
  repeatCommentReplyDelayMs: 30_000,
  commentActionGapMs: 3_000,
  databaseUrl: readEnv("DATABASE_URL"),
  facebookGraphApiVersion: readEnv("FB_GRAPH_API_VERSION", "v25.0"),
  facebookPageId: readEnv("FB_PAGE_ID"),
  facebookPageAccessToken: readTokenEnv("FB_PAGE_ACCESS_TOKEN"),
  timezone: readEnv("TIMEZONE", "UTC"),
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
    missing.push("FB_PAGE_ACCESS_TOKEN");
  }

  return missing;
}
