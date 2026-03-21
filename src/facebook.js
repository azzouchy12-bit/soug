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
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function sanitizePayload(payload = {}) {
  const sanitized = { ...(payload || {}) };
  delete sanitized.access_token;
  delete sanitized.__operation;
  return sanitized;
}

function sanitizeUrlForLogs(url) {
  const copy = new URL(url.toString());
  copy.searchParams.delete("access_token");
  return copy.toString();
}

function getObjectIdFromEndpoint(endpoint) {
  const segments = String(endpoint || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return segments[0] || "";
}

function parseRawPayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { raw };
  }
}

export async function fbRequest(method, endpoint, payload = {}, accessToken) {
  const safeMethod = String(method || "GET").trim().toUpperCase();
  const safeEndpoint = buildGraphPath(endpoint);
  const token = requireAccessToken(accessToken, `fbRequest ${safeMethod} ${safeEndpoint}`);
  const operation = String(payload?.__operation || `${safeMethod} ${safeEndpoint}`);
  const objectId = getObjectIdFromEndpoint(safeEndpoint);
  const requestPayload = sanitizePayload(payload);

  const query =
    safeMethod === "GET"
      ? {
          ...requestPayload,
          access_token: token
        }
      : {
          access_token: token
        };

  const requestUrl = buildGraphUrl(safeEndpoint, query);
  const logUrl = safeMethod === "GET" ? sanitizeUrlForLogs(requestUrl) : buildGraphUrl(safeEndpoint).toString();

  let requestBody = null;
  let headers = undefined;
  if (safeMethod !== "GET") {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries({
      ...requestPayload,
      access_token: token
    })) {
      if (value !== undefined && value !== null && value !== "") {
        form.set(key, String(value));
      }
    }
    requestBody = form.toString();
    headers = {
      "Content-Type": "application/x-www-form-urlencoded"
    };
  }

  console.log(
    `[fb] request op=${operation} method=${safeMethod} endpoint=${logUrl} objectId=${objectId} body=${JSON.stringify(requestPayload)}`
  );

  const response = await fetch(requestUrl, {
    method: safeMethod,
    headers,
    body: requestBody
  });

  const raw = await response.text();
  const parsed = parseRawPayload(raw);
  console.log(
    `[fb] response op=${operation} status=${response.status} objectId=${objectId} body=${JSON.stringify(parsed)}`
  );

  if (!response.ok || parsed.error) {
    const message = parsed?.error?.message || parsed?.raw || `Facebook request failed with ${response.status}`;
    throw new Error(`[${operation}] ${message}`);
  }

  return {
    ok: true,
    status: response.status,
    data: parsed
  };
}

async function graphMultipartRequest(pathname, { fields = {} } = {}) {
  const safePath = buildGraphPath(pathname);
  const operation = String(fields?.__operation || `POST ${safePath}`);
  const accessToken = requireAccessToken(fields?.access_token, operation);
  const objectId = getObjectIdFromEndpoint(safePath);
  const requestUrl = buildGraphUrl(safePath);
  const form = new FormData();
  const logBody = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (key === "__operation") {
      continue;
    }

    if (value && typeof value === "object" && value.type === "file") {
      const buffer = await fs.readFile(value.path);
      const blob = new Blob([buffer], { type: value.mimeType || "application/octet-stream" });
      form.set(key, blob, value.filename || "upload.bin");
      logBody[key] = `[file:${value.filename || "upload.bin"}]`;
      continue;
    }

    form.set(key, String(value));
    if (key !== "access_token") {
      logBody[key] = value;
    }
  }

  if (!fields.access_token) {
    form.set("access_token", accessToken);
  }

  console.log(
    `[fb] request op=${operation} method=POST endpoint=${requestUrl.toString()} objectId=${objectId} body=${JSON.stringify(logBody)}`
  );

  const response = await fetch(requestUrl, {
    method: "POST",
    body: form
  });

  const raw = await response.text();
  const parsed = parseRawPayload(raw);
  console.log(
    `[fb] response op=${operation} status=${response.status} objectId=${objectId} body=${JSON.stringify(parsed)}`
  );

  if (!response.ok || parsed.error) {
    const message = parsed?.error?.message || parsed?.raw || `Facebook request failed with ${response.status}`;
    throw new Error(`[${operation}] ${message}`);
  }

  return parsed;
}

export async function publishPagePost({ pageId, pageAccessToken, message }) {
  const safePageId = requireGraphId(pageId, "pageId");
  const accessToken = requireAccessToken(pageAccessToken, "publishPagePost");
  const response = await fbRequest(
    "POST",
    buildGraphPath(safePageId, "feed"),
    {
      __operation: "publishPagePost",
      message,
      published: true
    },
    accessToken
  );

  return response.data;
}

export async function publishPagePhoto({ pageId, pageAccessToken, caption, imagePath, imageMimeType, imageFilename }) {
  const safePageId = requireGraphId(pageId, "pageId");
  const accessToken = requireAccessToken(pageAccessToken, "publishPagePhoto");
  return graphMultipartRequest(buildGraphPath(safePageId, "photos"), {
    fields: {
      __operation: "publishPagePhoto",
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
  const response = await fbRequest(
    "GET",
    buildGraphPath(safePageId),
    {
      __operation: "getPageProfile",
      fields: "id,name,fan_count,followers_count,link"
    },
    accessToken
  );

  return response.data;
}

export async function getPostDetails({ postId, pageAccessToken }) {
  const safePostId = requireGraphId(postId, "postId");
  const accessToken = requireAccessToken(pageAccessToken, "getPostDetails");
  const response = await fbRequest(
    "GET",
    buildGraphPath(safePostId),
    {
      __operation: "getPostDetails",
      fields: "id,message,created_time,permalink_url,comments.summary(true),reactions.summary(true),shares"
    },
    accessToken
  );

  return response.data;
}

export async function getPostComments({ postId, pageAccessToken, limit = 10 }) {
  const safePostId = requireGraphId(postId, "postId");
  const accessToken = requireAccessToken(pageAccessToken, "getPostComments");
  // IMPORTANT: Reading comments uses POST ID -> /{post-id}/comments
  const response = await fbRequest(
    "GET",
    buildGraphPath(safePostId, "comments"),
    {
      __operation: "getPostComments",
      fields: "id,created_time,message,from{id,name}",
      limit
    },
    accessToken
  );

  return response.data?.data || [];
}

export async function likeComment({ commentId, pageAccessToken }) {
  const safeCommentId = requireGraphId(commentId, "commentId");
  const accessToken = requireAccessToken(pageAccessToken, "likeComment");
  // IMPORTANT: Like action uses COMMENT ID -> /{comment-id}/likes
  const response = await fbRequest(
    "POST",
    buildGraphPath(safeCommentId, "likes"),
    {
      __operation: "likeComment"
    },
    accessToken
  );

  return response.data;
}

export async function replyToComment({ commentId, pageAccessToken, message }) {
  const safeCommentId = requireGraphId(commentId, "commentId");
  const accessToken = requireAccessToken(pageAccessToken, "replyToComment");
  // IMPORTANT: Reply action uses COMMENT ID -> /{comment-id}/comments
  const response = await fbRequest(
    "POST",
    buildGraphPath(safeCommentId, "comments"),
    {
      __operation: "replyToComment",
      message
    },
    accessToken
  );

  return response.data;
}
