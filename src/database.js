import { Pool } from "pg";
import { config } from "./config.js";

let pool = null;
const SCHEMA_VERSION = "3";

function getPool() {
  if (!config.databaseUrl) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl
    });
  }

  return pool;
}

export function isDatabaseConfigured() {
  return Boolean(config.databaseUrl);
}

async function createFreshSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await client.query("DROP TABLE IF EXISTS liked_comments;");
  await client.query("DROP TABLE IF EXISTS pending_comment_likes;");
  await client.query("DROP TABLE IF EXISTS replied_comments;");
  await client.query("DROP TABLE IF EXISTS pending_comment_replies;");
  await client.query("DROP TABLE IF EXISTS published_posts;");
  await client.query("DROP TABLE IF EXISTS scheduled_posts;");
  await client.query("DROP TABLE IF EXISTS comment_like_queue;");
  await client.query("DROP TABLE IF EXISTS comment_reply_queue;");

  await client.query(`
    CREATE TABLE scheduled_posts (
      id BIGINT PRIMARY KEY,
      message TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ,
      image_filename TEXT,
      market_number INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE published_posts (
      id TEXT PRIMARY KEY,
      queue_id BIGINT,
      message TEXT NOT NULL,
      image_filename TEXT,
      market_number INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE pending_comment_replies (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_message TEXT,
      reply_message TEXT NOT NULL,
      market_number INT,
      comment_number INT,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INT NOT NULL DEFAULT 0,
      scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE replied_comments (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_message TEXT,
      reply_message TEXT NOT NULL,
      market_number INT,
      comment_number INT,
      queued_at TIMESTAMPTZ,
      handled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE pending_comment_likes (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_message TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INT NOT NULL DEFAULT 0,
      scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE liked_comments (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_message TEXT,
      queued_at TIMESTAMPTZ,
      handled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(
    `
      INSERT INTO schema_meta (key, value)
      VALUES ('schema_version', $1)
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value
    `,
    [SCHEMA_VERSION]
  );
}

async function applyNonDestructiveQueueMigrations(client) {
  await client.query(`
    ALTER TABLE pending_comment_replies
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued';
  `);
  await client.query(`
    ALTER TABLE pending_comment_replies
    ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
  `);
  await client.query(`
    ALTER TABLE pending_comment_replies
    ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    ALTER TABLE pending_comment_likes
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued';
  `);
  await client.query(`
    ALTER TABLE pending_comment_likes
    ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
  `);
  await client.query(`
    ALTER TABLE pending_comment_likes
    ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    UPDATE pending_comment_replies
    SET status = 'queued'
    WHERE status IS NULL OR status = '' OR status = 'processing';
  `);
  await client.query(`
    UPDATE pending_comment_likes
    SET status = 'queued'
    WHERE status IS NULL OR status = '' OR status = 'processing';
  `);
  await client.query(`
    UPDATE pending_comment_replies
    SET retry_count = 0
    WHERE retry_count IS NULL;
  `);
  await client.query(`
    UPDATE pending_comment_likes
    SET retry_count = 0
    WHERE retry_count IS NULL;
  `);
  await client.query(`
    UPDATE pending_comment_replies
    SET scheduled_for = COALESCE(scheduled_for, created_at, NOW())
    WHERE scheduled_for IS NULL;
  `);
  await client.query(`
    UPDATE pending_comment_likes
    SET scheduled_for = COALESCE(scheduled_for, created_at, NOW())
    WHERE scheduled_for IS NULL;
  `);
}

export async function initDatabase() {
  const db = getPool();
  if (!db) {
    return false;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const versionResult = await client.query(
      "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1"
    );
    const currentVersion = versionResult.rows[0]?.value || "";

    if (currentVersion !== SCHEMA_VERSION) {
      await createFreshSchema(client);
    }

    await applyNonDestructiveQueueMigrations(client);

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDatabaseSeededFromState(state) {
  const db = getPool();
  if (!db) {
    return false;
  }

  const counts = await db.query(`
    SELECT
      (SELECT COUNT(*)::INT FROM scheduled_posts) AS scheduled_count,
      (SELECT COUNT(*)::INT FROM published_posts) AS published_count
  `);

  const row = counts.rows[0] || { scheduled_count: 0, published_count: 0 };
  if (Number(row.scheduled_count) > 0 || Number(row.published_count) > 0) {
    return false;
  }

  const posts = Array.isArray(state.posts) ? state.posts : [];
  if (!posts.length) {
    return false;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const post of posts) {
      await client.query(
        `
          INSERT INTO published_posts (id, queue_id, message, image_filename, market_number, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          post.id,
          post.queueId || null,
          post.message || "",
          post.imageFilename || null,
          post.marketNumber || null,
          post.createdAt || new Date().toISOString()
        ]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadDatabaseSnapshot() {
  const db = getPool();
  if (!db) {
    return null;
  }

  const [scheduledResult, publishedResult] = await Promise.all([
    db.query(`
      SELECT id, message, scheduled_for, image_filename, market_number, created_at
      FROM scheduled_posts
      ORDER BY scheduled_for ASC NULLS LAST, id ASC
      LIMIT 50
    `),
    db.query(`
      SELECT id, queue_id, message, image_filename, market_number, created_at
      FROM published_posts
      ORDER BY created_at ASC, id ASC
      LIMIT 500
    `)
  ]);

  const scheduledPosts = scheduledResult.rows.map((row) => ({
    id: Number(row.id),
    message: row.message,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : "",
    imageFilename: row.image_filename || "",
    marketNumber: row.market_number || null,
    createdAt: new Date(row.created_at).toISOString()
  }));

  const posts = publishedResult.rows.map((row) => ({
    id: row.id,
    queueId: row.queue_id === null ? null : Number(row.queue_id),
    message: row.message,
    imageFilename: row.image_filename || "",
    marketNumber: row.market_number || null,
    createdAt: new Date(row.created_at).toISOString()
  }));

  return {
    scheduledPosts,
    posts
  };
}

export async function upsertScheduledMarketPost({
  id,
  message,
  createdAt,
  scheduledFor,
  imageFilename,
  marketNumber
}) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO scheduled_posts (id, message, scheduled_for, image_filename, market_number, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE
      SET message = EXCLUDED.message,
          scheduled_for = EXCLUDED.scheduled_for,
          image_filename = EXCLUDED.image_filename,
          market_number = EXCLUDED.market_number,
          created_at = EXCLUDED.created_at
    `,
    [id, message, scheduledFor || null, imageFilename || null, marketNumber || null, createdAt]
  );
}

export async function moveScheduledPostToPublished({
  queueId,
  facebookPostId,
  message,
  createdAt,
  imageFilename,
  marketNumber
}) {
  const db = getPool();
  if (!db) {
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (queueId !== null && queueId !== undefined) {
      await client.query("DELETE FROM scheduled_posts WHERE id = $1", [queueId]);
    }

    await client.query(
      `
        INSERT INTO published_posts (id, queue_id, message, image_filename, market_number, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE
        SET queue_id = EXCLUDED.queue_id,
            message = EXCLUDED.message,
            image_filename = EXCLUDED.image_filename,
            market_number = EXCLUDED.market_number,
            created_at = EXCLUDED.created_at
      `,
      [facebookPostId, queueId, message, imageFilename || null, marketNumber || null, createdAt]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueCommentReply({
  commentId,
  postId,
  authorId,
  authorName,
  commentMessage,
  replyMessage,
  marketNumber,
  commentNumber,
  scheduledFor
}) {
  const db = getPool();
  if (!db) {
    return false;
  }

  const result = await db.query(
    `
      INSERT INTO pending_comment_replies (
        comment_id, post_id, author_id, author_name, comment_message,
        reply_message, market_number, comment_number, status, retry_count, scheduled_for, last_error
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 0, $9, '')
      ON CONFLICT (comment_id) DO NOTHING
      RETURNING comment_id
    `,
    [
      commentId,
      postId,
      authorId || null,
      authorName || null,
      commentMessage || "",
      replyMessage,
      marketNumber || null,
      commentNumber || null,
      scheduledFor || new Date().toISOString()
    ]
  );

  return result.rowCount > 0;
}

export async function enqueueCommentLike({
  commentId,
  postId,
  authorId,
  authorName,
  commentMessage,
  scheduledFor
}) {
  const db = getPool();
  if (!db) {
    return false;
  }

  const result = await db.query(
    `
      INSERT INTO pending_comment_likes (
        comment_id, post_id, author_id, author_name, comment_message, status, retry_count, scheduled_for, last_error
      )
      VALUES ($1, $2, $3, $4, $5, 'queued', 0, $6, '')
      ON CONFLICT (comment_id) DO NOTHING
      RETURNING comment_id
    `,
    [commentId, postId, authorId || null, authorName || null, commentMessage || "", scheduledFor || new Date().toISOString()]
  );

  return result.rowCount > 0;
}

export async function markCommentReplyHandled(commentId) {
  const db = getPool();
  if (!db) {
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO replied_comments (
          comment_id, post_id, author_id, author_name, comment_message,
          reply_message, market_number, comment_number, queued_at, handled_at
        )
        SELECT
          comment_id, post_id, author_id, author_name, comment_message,
          reply_message, market_number, comment_number, created_at, NOW()
        FROM pending_comment_replies
        WHERE comment_id = $1
        ON CONFLICT (comment_id) DO UPDATE
        SET post_id = EXCLUDED.post_id,
            author_id = EXCLUDED.author_id,
            author_name = EXCLUDED.author_name,
            comment_message = EXCLUDED.comment_message,
            reply_message = EXCLUDED.reply_message,
            market_number = EXCLUDED.market_number,
            comment_number = EXCLUDED.comment_number,
            queued_at = EXCLUDED.queued_at,
            handled_at = EXCLUDED.handled_at
      `,
      [commentId]
    );
    await client.query("DELETE FROM pending_comment_replies WHERE comment_id = $1", [commentId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setPendingCommentReplyError(commentId, errorMessage) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_replies
      SET last_error = $2
      WHERE comment_id = $1
    `,
    [commentId, String(errorMessage || "").slice(0, 1500)]
  );
}

export async function setPendingCommentReplyProcessing(commentId) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_replies
      SET status = 'processing', last_error = ''
      WHERE comment_id = $1
    `,
    [commentId]
  );
}

export async function setPendingCommentReplyFailed(commentId, errorMessage, scheduledFor) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_replies
      SET status = 'failed',
          retry_count = retry_count + 1,
          last_error = $2,
          scheduled_for = $3
      WHERE comment_id = $1
    `,
    [commentId, String(errorMessage || "").slice(0, 1500), scheduledFor || new Date().toISOString()]
  );
}

export async function deferPendingCommentReply(commentId, scheduledFor, reason = "") {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_replies
      SET status = 'queued',
          last_error = $2,
          scheduled_for = $3
      WHERE comment_id = $1
    `,
    [commentId, String(reason || "").slice(0, 1500), scheduledFor || new Date().toISOString()]
  );
}

export async function markCommentLikeHandled(commentId) {
  const db = getPool();
  if (!db) {
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO liked_comments (
          comment_id, post_id, author_id, author_name, comment_message, queued_at, handled_at
        )
        SELECT
          comment_id, post_id, author_id, author_name, comment_message, created_at, NOW()
        FROM pending_comment_likes
        WHERE comment_id = $1
        ON CONFLICT (comment_id) DO UPDATE
        SET post_id = EXCLUDED.post_id,
            author_id = EXCLUDED.author_id,
            author_name = EXCLUDED.author_name,
            comment_message = EXCLUDED.comment_message,
            queued_at = EXCLUDED.queued_at,
            handled_at = EXCLUDED.handled_at
      `,
      [commentId]
    );
    await client.query("DELETE FROM pending_comment_likes WHERE comment_id = $1", [commentId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setPendingCommentLikeError(commentId, errorMessage) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_likes
      SET last_error = $2
      WHERE comment_id = $1
    `,
    [commentId, String(errorMessage || "").slice(0, 1500)]
  );
}

export async function setPendingCommentLikeProcessing(commentId) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_likes
      SET status = 'processing', last_error = ''
      WHERE comment_id = $1
    `,
    [commentId]
  );
}

export async function setPendingCommentLikeFailed(commentId, errorMessage, scheduledFor) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE pending_comment_likes
      SET status = 'failed',
          retry_count = retry_count + 1,
          last_error = $2,
          scheduled_for = $3
      WHERE comment_id = $1
    `,
    [commentId, String(errorMessage || "").slice(0, 1500), scheduledFor || new Date().toISOString()]
  );
}

export async function fetchNextDuePendingCommentReply(nowIso = new Date().toISOString()) {
  const db = getPool();
  if (!db) {
    return null;
  }

  const result = await db.query(
    `
      SELECT
        comment_id, post_id, author_id, author_name, comment_message,
        reply_message, market_number, comment_number, status, retry_count, scheduled_for, last_error, created_at
      FROM pending_comment_replies
      WHERE status IN ('queued', 'failed') AND scheduled_for <= $1
      ORDER BY scheduled_for ASC, created_at ASC
      LIMIT 1
    `,
    [nowIso]
  );

  return result.rows[0] || null;
}

export async function fetchNextDuePendingCommentLike(nowIso = new Date().toISOString()) {
  const db = getPool();
  if (!db) {
    return null;
  }

  const result = await db.query(
    `
      SELECT
        comment_id, post_id, author_id, author_name, comment_message, status, retry_count, scheduled_for, last_error, created_at
      FROM pending_comment_likes
      WHERE status IN ('queued', 'failed') AND scheduled_for <= $1
      ORDER BY scheduled_for ASC, created_at ASC
      LIMIT 1
    `,
    [nowIso]
  );

  return result.rows[0] || null;
}

export async function hasPendingLikeForComment(commentId) {
  const db = getPool();
  if (!db) {
    return false;
  }

  const result = await db.query(
    `
      SELECT 1
      FROM pending_comment_likes
      WHERE comment_id = $1
      LIMIT 1
    `,
    [commentId]
  );

  return result.rowCount > 0;
}

export async function isLikeHandledForComment(commentId) {
  const db = getPool();
  if (!db) {
    return false;
  }

  const result = await db.query(
    `
      SELECT 1
      FROM liked_comments
      WHERE comment_id = $1
      LIMIT 1
    `,
    [commentId]
  );

  return result.rowCount > 0;
}

export async function listPendingCommentReplies(limit = 80) {
  const db = getPool();
  if (!db) {
    return [];
  }

  const safeLimit = Math.max(1, Number(limit || 80));
  const result = await db.query(
    `
      SELECT
        comment_id, post_id, author_id, author_name, comment_message,
        reply_message, market_number, comment_number, status, retry_count, scheduled_for, last_error, created_at
      FROM pending_comment_replies
      ORDER BY scheduled_for ASC, created_at ASC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows;
}

export async function listRepliedComments(limit = 80) {
  const db = getPool();
  if (!db) {
    return [];
  }

  const safeLimit = Math.max(1, Number(limit || 80));
  const result = await db.query(
    `
      SELECT
        comment_id, post_id, author_id, author_name, comment_message,
        reply_message, market_number, comment_number, queued_at, handled_at
      FROM replied_comments
      ORDER BY handled_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows;
}

export async function listPendingCommentLikes(limit = 80) {
  const db = getPool();
  if (!db) {
    return [];
  }

  const safeLimit = Math.max(1, Number(limit || 80));
  const result = await db.query(
    `
      SELECT
        comment_id, post_id, author_id, author_name, comment_message, status, retry_count, scheduled_for, last_error, created_at
      FROM pending_comment_likes
      ORDER BY scheduled_for ASC, created_at ASC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows;
}

export async function listLikedComments(limit = 80) {
  const db = getPool();
  if (!db) {
    return [];
  }

  const safeLimit = Math.max(1, Number(limit || 80));
  const result = await db.query(
    `
      SELECT
        comment_id, post_id, author_id, author_name, comment_message, queued_at, handled_at
      FROM liked_comments
      ORDER BY handled_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows;
}
