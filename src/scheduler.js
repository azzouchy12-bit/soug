import { config } from "./config.js";

let currentTimer = null;
let isRunning = false;
let currentExpression = "";
let currentJob = null;
let currentTimezone = config.timezone;
let currentIntervalMs = 0;
let nextRunAt = "";

function clearCurrentTimer() {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
}

function scheduleNextRun(delayMs) {
  if (!currentJob) {
    return;
  }

  const safeDelayMs = Math.max(250, Number(delayMs || 0));
  nextRunAt = new Date(Date.now() + safeDelayMs).toISOString();

  currentTimer = setInterval(async () => {
    if (!currentJob || isRunning || !nextRunAt) {
      return;
    }

    const dueAt = Date.parse(nextRunAt);
    if (!Number.isFinite(dueAt) || Date.now() < dueAt) {
      return;
    }

    isRunning = true;

    try {
      await currentJob();
    } finally {
      isRunning = false;
      if (currentJob && currentIntervalMs > 0) {
        nextRunAt = new Date(Date.now() + currentIntervalMs).toISOString();
      }
    }
  }, 1000);
}

export function startScheduler(job, options = {}) {
  currentJob = job;
  stopScheduler();

  const interval = Math.max(1, Number(options.intervalMinutes || config.postIntervalMinutes));
  const expression = `every ${interval} minute(s)`;
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs ?? interval * 60 * 1000));
  currentExpression = expression;
  currentTimezone = options.timezone || config.timezone;
  currentIntervalMs = interval * 60 * 1000;
  scheduleNextRun(initialDelayMs);

  return expression;
}

export function stopScheduler() {
  clearCurrentTimer();
  currentExpression = "";
  currentIntervalMs = 0;
  nextRunAt = "";
}

export function restartScheduler(options = {}) {
  if (!currentJob) {
    return "";
  }

  return startScheduler(currentJob, options);
}

export function schedulerIsActive() {
  return Boolean(currentTimer);
}

export function getSchedulerSnapshot() {
  return {
    active: schedulerIsActive(),
    expression: currentExpression,
    timezone: currentTimezone,
    nextRunAt
  };
}
