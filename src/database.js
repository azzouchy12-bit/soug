import { Pool } from "pg";
import { config } from "./config.js";

let pool = null;

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

export async function initDatabase() {
  const db = getPool();
  if (!db) {
    return false;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id BIGINT PRIMARY KEY,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS image_filename TEXT;`);
  await db.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS market_number INT;`);
  await db.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled';`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS published_posts (
      id TEXT PRIMARY KEY,
      queue_id BIGINT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS image_filename TEXT;`);
  await db.query(`ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS market_number INT;`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS comment_reply_queue (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_message TEXT,
      reply_message TEXT NOT NULL,
      market_number INT,
      comment_number INT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      handled_at TIMESTAMPTZ
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS comment_like_queue (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      comment_message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      handled_at TIMESTAMPTZ
    );
  `);

  return true;
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

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    for (const post of state.queuedPosts || []) {
      await client.query(
        `
          INSERT INTO scheduled_posts (id, message, created_at)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO NOTHING
        `,
        [post.id, post.text, post.createdAt || new Date().toISOString()]
      );
    }

    for (const post of state.posts || []) {
      await client.query(
        `
          INSERT INTO published_posts (id, queue_id, message, created_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO NOTHING
        `,
        [post.id, post.queueId || null, post.message || "", post.createdAt || new Date().toISOString()]
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
      SELECT id, message, created_at
      FROM scheduled_posts
      ORDER BY id ASC
    `),
    db.query(`
      SELECT id, queue_id, message, created_at
      FROM published_posts
      ORDER BY created_at ASC, id ASC
    `)
  ]);

  const queuedPosts = scheduledResult.rows.map((row) => ({
    id: Number(row.id),
    text: row.message,
    createdAt: new Date(row.created_at).toISOString()
  }));

  const posts = publishedResult.rows.map((row) => ({
    id: row.id,
    queueId: row.queue_id === null ? null : Number(row.queue_id),
    message: row.message,
    createdAt: new Date(row.created_at).toISOString()
  }));

  const maxScheduledId = queuedPosts.reduce((max, post) => Math.max(max, Number(post.id) || 0), 0);
  const maxPublishedQueueId = posts.reduce((max, post) => Math.max(max, Number(post.queueId) || 0), 0);

  return {
    queuedPosts,
    posts,
    queueCounter: Math.max(maxScheduledId, maxPublishedQueueId)
  };
}

export async function insertScheduledPosts(posts) {
  const db = getPool();
  if (!db || !posts.length) {
    return;
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    for (const post of posts) {
      await client.query(
        `
          INSERT INTO scheduled_posts (id, message, created_at)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE
          SET message = EXCLUDED.message,
              created_at = EXCLUDED.created_at
        `,
        [post.id, post.text, post.createdAt || new Date().toISOString()]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteScheduledPost(postId) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query("DELETE FROM scheduled_posts WHERE id = $1", [postId]);
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
        INSERT INTO published_posts (id, queue_id, message, created_at, image_filename, market_number)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE
        SET queue_id = EXCLUDED.queue_id,
            message = EXCLUDED.message,
            created_at = EXCLUDED.created_at,
            image_filename = EXCLUDED.image_filename,
            market_number = EXCLUDED.market_number
      `,
      [
        facebookPostId,
        queueId,
        message,
        createdAt,
        imageFilename || null,
        marketNumber || null
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertScheduledMarketPost({ id, message, createdAt, scheduledFor, imageFilename, marketNumber }) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO scheduled_posts (id, message, created_at, scheduled_for, image_filename, market_number, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
      ON CONFLICT (id) DO UPDATE
      SET message = EXCLUDED.message,
          created_at = EXCLUDED.created_at,
          scheduled_for = EXCLUDED.scheduled_for,
          image_filename = EXCLUDED.image_filename,
          market_number = EXCLUDED.market_number,
          status = 'scheduled'
    `,
    [id, message, createdAt, scheduledFor, imageFilename || null, marketNumber || null]
  );
}

export async function enqueueCommentReply({
  commentId,
  postId,
  authorId,
  authorName,
  commentMessage,
  replyMessage,
  marketNumber,
  commentNumber
}) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO comment_reply_queue (
        comment_id, post_id, author_id, author_name, comment_message,
        reply_message, market_number, comment_number, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      ON CONFLICT (comment_id) DO UPDATE
      SET post_id = EXCLUDED.post_id,
          author_id = EXCLUDED.author_id,
          author_name = EXCLUDED.author_name,
          comment_message = EXCLUDED.comment_message,
          reply_message = EXCLUDED.reply_message,
          market_number = EXCLUDED.market_number,
          comment_number = EXCLUDED.comment_number
    `,
    [commentId, postId, authorId || null, authorName || null, commentMessage || "", replyMessage, marketNumber || null, commentNumber || null]
  );
}

export async function markCommentReplyHandled(commentId) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE comment_reply_queue
      SET status = 'handled',
          handled_at = NOW()
      WHERE comment_id = $1
    `,
    [commentId]
  );
}

export async function enqueueCommentLike({
  commentId,
  postId,
  authorId,
  authorName,
  commentMessage
}) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO comment_like_queue (
        comment_id, post_id, author_id, author_name, comment_message, status
      )
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (comment_id) DO UPDATE
      SET post_id = EXCLUDED.post_id,
          author_id = EXCLUDED.author_id,
          author_name = EXCLUDED.author_name,
          comment_message = EXCLUDED.comment_message
    `,
    [commentId, postId, authorId || null, authorName || null, commentMessage || ""]
  );
}

export async function markCommentLikeHandled(commentId) {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(
    `
      UPDATE comment_like_queue
      SET status = 'handled',
          handled_at = NOW()
      WHERE comment_id = $1
    `,
    [commentId]
  );
}

export async function listCommentReplies({ status, limit = 50 } = {}) {
  const db = getPool();
  if (!db) {
    return [];
  }

  const values = [];
  let where = "";
  if (status) {
    values.push(status);
    where = `WHERE status = $${values.length}`;
  }

  values.push(Math.max(1, Number(limit || 50)));

  const result = await db.query(
    `
      SELECT
        comment_id,
        post_id,
        author_id,
        author_name,
        comment_message,
        reply_message,
        market_number,
        comment_number,
        status,
        created_at,
        handled_at
      FROM comment_reply_queue
      ${where}
      ORDER BY COALESCE(handled_at, created_at) DESC, created_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  return result.rows;
}

export async function listCommentLikes({ status, limit = 50 } = {}) {
  const db = getPool();
  if (!db) {
    return [];
  }

  const values = [];
  let where = "";
  if (status) {
    values.push(status);
    where = `WHERE status = $${values.length}`;
  }

  values.push(Math.max(1, Number(limit || 50)));

  const result = await db.query(
    `
      SELECT
        comment_id,
        post_id,
        author_id,
        author_name,
        comment_message,
        status,
        created_at,
        handled_at
      FROM comment_like_queue
      ${where}
      ORDER BY COALESCE(handled_at, created_at) DESC, created_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  return result.rows;
}
