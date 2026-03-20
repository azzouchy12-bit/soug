import fs from "node:fs";
import { config } from "./config.js";

const defaultState = {
  facebook: {
    userAccessToken: "",
    pageAccessToken: "",
    pageId: "",
    pageName: "",
    pages: [],
    lastAuthAt: ""
  },
  queuedPosts: [],
  queueCounter: 0,
  posts: [],
  market: {
    imageFilename: "",
    imageOriginalName: "",
    imageMimeType: "",
    nextNumber: 1,
    activePostId: "",
    activeNumber: 0,
    activeCommentCount: 0,
    repliedComments: {},
    lastPublishedAt: "",
    lastPublishedPostId: "",
    lastPublishedNumber: 0
  },
  bot: {
    active: false,
    startedAt: ""
  },
  scheduler: {
    enabled: true,
    intervalMinutes: config.publishIntervalMinutes,
    lastRunAt: "",
    lastResult: "",
    lastError: ""
  }
};

export function readState() {
  if (!fs.existsSync(config.stateFile)) {
    return structuredClone(defaultState);
  }

  try {
    const raw = fs.readFileSync(config.stateFile, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...structuredClone(defaultState),
      ...parsed,
      facebook: {
        ...structuredClone(defaultState.facebook),
        ...(parsed.facebook || {})
      },
      queuedPosts: Array.isArray(parsed.queuedPosts) ? parsed.queuedPosts : [],
      queueCounter: Number.isInteger(parsed.queueCounter) ? parsed.queueCounter : 0,
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      market: {
        ...structuredClone(defaultState.market),
        ...(parsed.market || {}),
        repliedComments:
          parsed.market && parsed.market.repliedComments && typeof parsed.market.repliedComments === "object"
            ? parsed.market.repliedComments
            : {}
      },
      bot: {
        ...structuredClone(defaultState.bot),
        ...(parsed.bot || {})
      },
      scheduler: {
        ...structuredClone(defaultState.scheduler),
        ...(parsed.scheduler || {})
      }
    };
  } catch {
    return structuredClone(defaultState);
  }
}

export function writeState(nextState) {
  fs.writeFileSync(config.stateFile, JSON.stringify(nextState, null, 2), "utf8");
}

export function updateState(updater) {
  const current = readState();
  const next = updater(current);
  writeState(next);
  return next;
}
