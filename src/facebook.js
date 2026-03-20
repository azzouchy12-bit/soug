import fs from "node:fs/promises";
import { config } from "./config.js";

const graphVersion = config.facebookGraphApiVersion || "v25.0";

function requireAccessToken(token, operation) {
  if (!String(token || "").trim()) {
    throw new Error(`Missing page access token for ${operation}.`);
  }

  return String(token).trim();
}

function requireGraphId(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`Missing ${label}.`);
  }

  if (/[/?#\s]/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${normalized}`);
  }

  return normalized;
}

function buildGraphPath(...segments) {
  const cleaned = segments
    .map((segment) => String(segment || "").trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""));

  if (!cleaned.length) {
    throw new Error("Missing Graph API path.");
  }

  return `/${cleaned.join("/")}`;
}

function buildGraphUrl(pathname, params = {}) {
  const safePath = buildGraphPath(pathname);
  const url = new URL(`https://graph.facebook.com/${graphVersion}${safePath}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

async function graphRequest(pathname, options = {}) {
  const { method = "GET", query = {}, body } = options;
  const url = buildGraphUrl(pathname, query);
  let requestBody;
  let headers;

  if (body && method !== "GET") {
    const form = new URLSearchParams();

    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null && value !== "") {
        form.set(key, String(value));
      }
    }

    headers = {
      "Content-Type": "application/x-www-form-urlencoded"
    };
    requestBody = form.toString();
  }

  const response = await fetch(url, {
    method,
    headers,
    body: requestBody
  });

  const raw = await response.text();
  let payload = {};

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  if (!response.ok || payload.error) {
    const message =
      payload?.error?.message || payload?.raw || `Facebook request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

async function graphMultipartRequest(pathname, { query = {}, fields = {} } = {}) {
  const url = buildGraphUrl(pathname, query);
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (value && typeof value === "object" && value.type === "file") {
      const buffer = await fs.readFile(value.path);
      const blob = new Blob([buffer], { type: value.mimeType || "application/octet-stream" });
      form.set(key, blob, value.filename || "upload.bin");
      continue;
    }

    form.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "POST",
    body: form
  });

  const raw = await response.text();
  let payload = {};

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  if (!response.ok || payload.error) {
    const message =
      payload?.error?.message || payload?.raw || `Facebook request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export function getFacebookLoginUrl(baseUrl = config.baseUrl) {
  const url = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.facebookAppId);
  url.searchParams.set("redirect_uri", `${baseUrl}/auth/facebook/callback`);
  url.searchParams.set(
    "scope",
    [
      "pages_manage_posts",
      "pages_read_engagement",
      "pages_show_list",
      "pages_manage_engagement",
      "pages_read_user_engagement"
    ].join(",")
  );
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export async function exchangeCodeForLongLivedUserToken(code, baseUrl = config.baseUrl) {
  const redirectUri = `${baseUrl}/auth/facebook/callback`;

  const shortLived = await graphRequest("/oauth/access_token", {
    query: {
      client_id: config.facebookAppId,
      client_secret: config.facebookAppSecret,
      redirect_uri: redirectUri,
      code
    }
  });

  const longLived = await graphRequest("/oauth/access_token", {
    query: {
      grant_type: "fb_exchange_token",
      client_id: config.facebookAppId,
      client_secret: config.facebookAppSecret,
      fb_exchange_token: shortLived.access_token
    }
  });

  return longLived.access_token;
}

export async function getManagedPages(userAccessToken) {
  const response = await graphRequest("/me/accounts", {
    query: {
      access_token: userAccessToken,
      fields: "id,name,access_token,tasks"
    }
  });

  return response.data || [];
}

export async function publishPagePost({ pageId, pageAccessToken, message }) {
  const safePageId = requireGraphId(pageId, "pageId");
  const accessToken = requireAccessToken(pageAccessToken, "publishPagePost");
  return graphRequest(buildGraphPath(safePageId, "feed"), {
    method: "POST",
    query: {
      access_token: accessToken
    },
    body: {
      message,
      published: true
    }
  });
}

export async function publishPagePhoto({ pageId, pageAccessToken, caption, imagePath, imageMimeType, imageFilename }) {
  const safePageId = requireGraphId(pageId, "pageId");
  const accessToken = requireAccessToken(pageAccessToken, "publishPagePhoto");
  return graphMultipartRequest(buildGraphPath(safePageId, "photos"), {
    fields: {
      access_token: accessToken,
      caption,
      published: true,
      source: {
        type: "file",
        path: imagePath,
        mimeType: imageMimeType,
        filename: imageFilename
      }
    }
  });
}

export async function getPageProfile({ pageId, pageAccessToken }) {
  const safePageId = requireGraphId(pageId, "pageId");
  const accessToken = requireAccessToken(pageAccessToken, "getPageProfile");
  return graphRequest(buildGraphPath(safePageId), {
    query: {
      access_token: accessToken,
      fields: "id,name,fan_count,followers_count,link"
    }
  });
}

export async function getPostDetails({ postId, pageAccessToken }) {
  const safePostId = requireGraphId(postId, "postId");
  const accessToken = requireAccessToken(pageAccessToken, "getPostDetails");
  return graphRequest(buildGraphPath(safePostId), {
    query: {
      access_token: accessToken,
      fields: "id,message,created_time,permalink_url,comments.summary(true),reactions.summary(true),shares"
    }
  });
}

export async function getPostComments({ postId, pageAccessToken, limit = 10 }) {
  const safePostId = requireGraphId(postId, "postId");
  const accessToken = requireAccessToken(pageAccessToken, "getPostComments");
  const response = await graphRequest(buildGraphPath(safePostId, "comments"), {
    query: {
      access_token: accessToken,
      fields: "id,created_time,message,from{id,name}",
      limit
    }
  });

  return response.data || [];
}

export async function likeComment({ commentId, pageAccessToken }) {
  const safeCommentId = requireGraphId(commentId, "commentId");
  const accessToken = requireAccessToken(pageAccessToken, "likeComment");
  return graphRequest(buildGraphPath(safeCommentId, "likes"), {
    method: "POST",
    query: {
      access_token: accessToken
    },
    body: {
      access_token: accessToken
    }
  });
}

export async function replyToComment({ commentId, pageAccessToken, message }) {
  const safeCommentId = requireGraphId(commentId, "commentId");
  const accessToken = requireAccessToken(pageAccessToken, "replyToComment");
  return graphRequest(buildGraphPath(safeCommentId, "comments"), {
    method: "POST",
    query: {
      access_token: accessToken
    },
    body: {
      access_token: accessToken,
      message
    }
  });
}
