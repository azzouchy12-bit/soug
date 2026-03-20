import fs from "node:fs";
import { config } from "./config.js";

const defaultState = {
  facebook: {
    pageId: "",
    pageName: "",
    lastProfileSyncAt: ""
  },
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
    repliedAuthors: {},
    lastPublishedAt: "",
    lastPublishedPostId: "",
    lastPublishedNumber: 0
  },
  bot: {
    active: false,
    startedAt: ""
  },
  commentActions: {
    replyDelaySeconds: 0,
    likeDelaySeconds: 0,
    nextReplyAllowedAt: "",
    nextLikeAllowedAt: ""
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
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      market: {
        ...structuredClone(defaultState.market),
        ...(parsed.market || {}),
        repliedComments:
          parsed.market && parsed.market.repliedComments && typeof parsed.market.repliedComments === "object"
            ? parsed.market.repliedComments
            : {},
        repliedAuthors:
          parsed.market && parsed.market.repliedAuthors && typeof parsed.market.repliedAuthors === "object"
            ? parsed.market.repliedAuthors
            : {}
      },
      bot: {
        ...structuredClone(defaultState.bot),
        ...(parsed.bot || {})
      },
      commentActions: {
        ...structuredClone(defaultState.commentActions),
        ...(parsed.commentActions || {}),
        replyDelaySeconds: Math.max(
          0,
          Number.parseInt(
            String(parsed.commentActions?.replyDelaySeconds ?? defaultState.commentActions.replyDelaySeconds),
            10
          ) || 0
        ),
        likeDelaySeconds: Math.max(
          0,
          Number.parseInt(
            String(parsed.commentActions?.likeDelaySeconds ?? defaultState.commentActions.likeDelaySeconds),
            10
          ) || 0
        ),
        nextReplyAllowedAt: String(parsed.commentActions?.nextReplyAllowedAt || ""),
        nextLikeAllowedAt: String(parsed.commentActions?.nextLikeAllowedAt || "")
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
