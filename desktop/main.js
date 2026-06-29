// Electron main process. Owns the window, the settings, and the bridge to the backend.
// The backend (scrapers + LLM pipeline) is the SAME code as the CLI — imported here as a
// library and driven over IPC. Everything runs locally on this machine.
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const DEFAULT_DATA_DIR = "F:\\OutboundOS";

let mainWindow = null;
let settings = {};
let backend = null; // the bundled backend API — loaded lazily after env is set

// ---- settings + environment ------------------------------------------------

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function persistSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf8");
}

// Push settings into process.env so the backend's config/groq pick them up.
function applyEnv(s) {
  const dataDir = s.dataDir || DEFAULT_DATA_DIR;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    /* drive may not exist; surfaced in UI */
  }
  process.env.OUTBOUNDOS_DATA_DIR = dataDir;
  if (s.groqApiKey) process.env.GROQ_API_KEY = s.groqApiKey;
  if (s.senderName) process.env.SENDER_NAME = s.senderName;
  if (s.senderCompany) process.env.SENDER_COMPANY = s.senderCompany;
  if (s.offer) process.env.OFFER = s.offer;
  // NOTE: do NOT force headless. Google serves a reviews-suppressed Maps layout to headless
  // Chrome, so the Maps scraper must run headed (a Chrome window appears briefly during
  // scraping). The website crawler still runs headless. This is required for reviews to work.
}

// ---- backend (lazy import so env is set first) -----------------------------

function getBackend() {
  if (!backend) {
    // backend.cjs is the bundled backend (service + storage + mailer). It reads
    // OUTBOUNDOS_DATA_DIR at load, so applyEnv() must run first (it does, on app ready).
    const api = require(path.join(__dirname, "backend.cjs"));
    backend = { service: api, store: api.createStore(), mailer: api };
  }
  return backend;
}

// Known providers — pick one and we fill in the SMTP server automatically.
const MAIL_PROVIDERS = {
  gmail: { host: "smtp.gmail.com", port: 465, secure: true, imap: "imap.gmail.com" },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, imap: "outlook.office365.com" },
};

// The user can configure several sending mailboxes. Returns the saved list (migrating an
// older single-mailbox config to a one-item list).
function getMailboxes() {
  if (Array.isArray(settings.mailboxes) && settings.mailboxes.length) return settings.mailboxes;
  if (settings.mailEmail) {
    return [
      {
        id: "legacy",
        provider: settings.mailProvider || "gmail",
        email: settings.mailEmail,
        pass: settings.mailPass,
        fromName: settings.fromName,
        smtpHost: settings.smtpHost,
        smtpPort: settings.smtpPort,
        smtpSecure: settings.smtpSecure,
      },
    ];
  }
  return [];
}

// Turn one saved mailbox into an SMTP config (provider preset → server).
function buildMailboxConfig(mb) {
  const preset = MAIL_PROVIDERS[mb.provider];
  const email = mb.email || "";
  return {
    host: preset ? preset.host : mb.smtpHost || "",
    port: preset ? preset.port : Number(mb.smtpPort) || 587,
    secure: preset ? preset.secure : Boolean(mb.smtpSecure),
    user: email,
    pass: mb.pass || "",
    fromName: mb.fromName || settings.senderName || "",
    fromEmail: email,
    imapHost: preset ? preset.imap : mb.imapHost || "", // for reply detection
    signatureAddress: settings.signatureAddress || "",
  };
}

// ---- follow-up sequence helpers --------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

// After sending sequence step N, when is the next follow-up due? (null = sequence done)
function nextFollowupAt(stepJustSent, gaps) {
  const idx = stepJustSent - 1; // after step 1, use gaps[0]
  return idx < gaps.length ? new Date(Date.now() + gaps[idx] * DAY_MS).toISOString() : null;
}

// Load every run with its emails (so we can scan/update the whole pipeline).
async function loadAllRuns() {
  const { store } = await getBackend();
  const out = [];
  for (const s of await store.listRuns()) {
    const run = await store.getRun(s.id);
    if (run && run.emails) out.push(run);
  }
  return out;
}

// Check inboxes for replies, mark replied leads, stop their sequences. Returns count.
async function checkRepliesInternal(runs) {
  const { mailer } = await getBackend();
  const byMailbox = new Map(); // mailboxId -> [emails]
  const index = new Map(); // emailId -> { run, em }
  for (const run of runs) {
    for (const em of run.emails) {
      if ((em.status === "sent") && em.threadMessageId && em.email) {
        const key = em.mailboxId || "_default";
        if (!byMailbox.has(key)) byMailbox.set(key, []);
        byMailbox.get(key).push(em);
        index.set(em.id, { run, em });
      }
    }
  }
  const changed = new Set();
  let replied = 0;
  for (const [key, ems] of byMailbox) {
    const mb = findMailbox(key === "_default" ? undefined : key);
    if (!mb) continue;
    const cfg = buildMailboxConfig(mb);
    if (!cfg.imapHost || !cfg.pass) continue;
    const threads = ems.map((em) => ({ leadId: em.id, messageId: em.threadMessageId, to: em.email }));
    const since = ems.map((e) => e.sentAt).filter(Boolean).sort()[0];
    const res = await mailer.checkReplies(cfg, threads, since);
    for (const leadId of res.repliedLeadIds || []) {
      const rec = index.get(leadId);
      if (rec && rec.em.status !== "replied") {
        rec.em.status = "replied";
        rec.em.repliedAt = new Date().toISOString();
        rec.em.nextFollowupAt = null;
        changed.add(rec.run);
        replied++;
      }
    }
  }
  const { store } = await getBackend();
  for (const run of changed) await store.saveRun(run);
  return replied;
}

function findMailbox(mailboxId) {
  const list = getMailboxes();
  return list.find((m) => m.id === mailboxId) || list[0] || null;
}

// ---- window ----------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0f1115",
    title: "OutboundOS",
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ---- IPC -------------------------------------------------------------------

function sendProgress(e) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("progress", e);
}

ipcMain.handle("settings:get", () => ({ ...settings, _defaultDataDir: DEFAULT_DATA_DIR }));

// Build/version info so the user can confirm they're running the latest packaged build.
ipcMain.handle("app:info", () => {
  let info = { version: app.getVersion(), builtAt: null };
  try {
    info = { ...info, ...JSON.parse(fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8")) };
  } catch {
    /* build-info.json is written at build time; missing in raw dev runs */
  }
  return info;
});

ipcMain.handle("settings:save", (_e, incoming) => {
  settings = { ...settings, ...incoming };
  persistSettings(settings);
  applyEnv(settings);
  return { ok: true };
});

ipcMain.handle("settings:pickDataDir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("run:scrapeAndGenerate", async (_e, { query, count }) => {
  try {
    const { service, store } = await getBackend();
    const { leads, emails } = await service.scrapeAndGenerate(query, Number(count) || 10, sendProgress);
    const run = {
      id: crypto.randomUUID(),
      query,
      createdAt: new Date().toISOString(),
      leads,
      emails,
    };
    await store.saveRun(run);
    return { ok: true, run };
  } catch (err) {
    sendProgress({ phase: "error", message: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("dialog:pickCsv", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("run:fromCsv", async (_e, filePath) => {
  try {
    const { service, store } = await getBackend();
    const { leads, emails, query } = await service.processCsvFile(filePath, sendProgress);
    const run = { id: crypto.randomUUID(), query, createdAt: new Date().toISOString(), leads, emails };
    await store.saveRun(run);
    return { ok: true, run };
  } catch (err) {
    sendProgress({ phase: "error", message: err.message });
    return { ok: false, error: err.message };
  }
});

// Flat list of every sent email across all runs (for the Sent tab).
ipcMain.handle("sent:list", async () => {
  const { store } = await getBackend();
  const runs = await store.listRuns();
  const sent = [];
  for (const summary of runs) {
    const run = await store.getRun(summary.id);
    if (!run || !run.emails) continue;
    for (const em of run.emails) {
      if (em.status === "sent") {
        sent.push({ to: em.email, name: em.name, subject: em.subject, sentAt: em.sentAt, query: run.query, from: em.sentFrom || "(unknown)" });
      }
    }
  }
  sent.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  return sent;
});

ipcMain.handle("runs:list", async () => {
  const { store } = await getBackend();
  return store.listRuns();
});

ipcMain.handle("runs:get", async (_e, id) => {
  const { store } = await getBackend();
  return store.getRun(id);
});

ipcMain.handle("runs:delete", async (_e, id) => {
  const { store } = await getBackend();
  await store.deleteRun(id);
  return { ok: true };
});

ipcMain.handle("email:delete", async (_e, { runId, emailId }) => {
  const { store } = await getBackend();
  const run = await store.getRun(runId);
  if (!run || !run.emails) return { ok: false, error: "run not found" };
  run.emails = run.emails.filter((e) => e.id !== emailId);
  await store.saveRun(run);
  return { ok: true };
});

ipcMain.handle("data:open", () => {
  shell.openPath(process.env.OUTBOUNDOS_DATA_DIR || DEFAULT_DATA_DIR);
});

// ---- sending ---------------------------------------------------------------

// Test a mailbox using the values currently in the form (passed in), so the user can verify
// before saving.
ipcMain.handle("mail:test", async (_e, mb) => {
  const { mailer } = await getBackend();
  const cfg = buildMailboxConfig(mb || {});
  if (!mailer.isMailboxConfigured(cfg)) {
    return { ok: false, error: "Fill in the email and password (and host/port for a custom server)." };
  }
  return mailer.verifyMailbox(cfg);
});

ipcMain.handle("email:setStatus", async (_e, { runId, emailId, status }) => {
  const { store } = await getBackend();
  const run = await store.getRun(runId);
  const em = run && run.emails && run.emails.find((x) => x.id === emailId);
  if (!em) return { ok: false, error: "email not found" };
  em.status = status;
  await store.saveRun(run);
  return { ok: true };
});

ipcMain.handle("email:send", async (_e, { runId, emailId, mailboxId }) => {
  const { store, mailer, service } = await getBackend();
  const mb = findMailbox(mailboxId);
  if (!mb) return { ok: false, error: "Add a mailbox in Settings first." };
  const cfg = buildMailboxConfig(mb);
  if (!mailer.isMailboxConfigured(cfg)) return { ok: false, error: "That mailbox isn't fully configured." };
  const run = await store.getRun(runId);
  const em = run && run.emails && run.emails.find((x) => x.id === emailId);
  if (!em) return { ok: false, error: "email not found" };
  if (!em.email) return { ok: false, error: "no recipient email for this lead" };
  const res = await mailer.sendEmail(cfg, { to: em.email, subject: em.subject, body: em.body });
  em.status = res.ok ? "sent" : "failed";
  if (res.ok) {
    em.sentAt = new Date().toISOString();
    em.sentFrom = cfg.fromEmail;
    em.mailboxId = mb.id;
    em.threadMessageId = res.messageId;
    em.sequenceStep = 1;
    em.nextFollowupAt = nextFollowupAt(1, service.FOLLOWUP_GAP_DAYS);
  }
  em.error = res.ok ? undefined : res.error;
  await store.saveRun(run);
  return res;
});

ipcMain.handle("email:sendApproved", async (_e, { runId, mailboxId }) => {
  const { store, mailer, service } = await getBackend();
  const mb = findMailbox(mailboxId);
  if (!mb) return { ok: false, error: "Add a mailbox in Settings first." };
  const cfg = buildMailboxConfig(mb);
  if (!mailer.isMailboxConfigured(cfg)) return { ok: false, error: "That mailbox isn't fully configured." };
  const run = await store.getRun(runId);
  if (!run || !run.emails) return { ok: false, error: "run not found" };
  const queue = run.emails.filter((e) => e.status === "approved" && e.email);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < queue.length; i++) {
    const em = queue[i];
    sendProgress({ phase: "email", message: `Sending to ${em.email} from ${cfg.fromEmail}…`, current: i + 1, total: queue.length });
    const res = await mailer.sendEmail(cfg, { to: em.email, subject: em.subject, body: em.body });
    em.status = res.ok ? "sent" : "failed";
    if (res.ok) {
      em.sentAt = new Date().toISOString();
      em.sentFrom = cfg.fromEmail;
      em.mailboxId = mb.id;
      em.threadMessageId = res.messageId;
      em.sequenceStep = 1;
      em.nextFollowupAt = nextFollowupAt(1, service.FOLLOWUP_GAP_DAYS);
      sent++;
    } else {
      em.error = res.error;
      failed++;
    }
    await store.saveRun(run);
    // Throttle between sends to protect inbox reputation.
    if (i < queue.length - 1) await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 7000)));
  }
  sendProgress({ phase: "done", message: `Sent ${sent}, failed ${failed}.` });
  return { ok: true, sent, failed };
});

// ---- follow-up sequences ---------------------------------------------------

// Counts for the banner (no IMAP, cheap).
ipcMain.handle("followups:status", async () => {
  const runs = await loadAllRuns();
  const now = Date.now();
  let due = 0;
  let scheduled = 0;
  let replied = 0;
  for (const run of runs) {
    for (const em of run.emails) {
      if (em.status === "replied") replied++;
      else if (em.status === "sent" && em.nextFollowupAt) {
        if (new Date(em.nextFollowupAt).getTime() <= now) due++;
        else scheduled++;
      }
    }
  }
  return { due, scheduled, replied };
});

// Check inboxes for replies and stop those sequences.
ipcMain.handle("replies:check", async () => {
  const runs = await loadAllRuns();
  const replied = await checkRepliesInternal(runs);
  return { ok: true, replied };
});

// Send every follow-up that is due. Checks replies first so we never follow up someone
// who already answered. Throttled between sends.
ipcMain.handle("followups:sendDue", async () => {
  const { store, mailer, service } = await getBackend();
  await checkRepliesInternal(await loadAllRuns());
  const runs = await loadAllRuns();
  const gaps = service.FOLLOWUP_GAP_DAYS;
  const maxSteps = service.MAX_SEQUENCE_STEPS;
  const now = Date.now();
  let sent = 0;
  let failed = 0;
  for (const run of runs) {
    let changed = false;
    for (const em of run.emails) {
      if (em.status !== "sent" || !em.nextFollowupAt || !em.email || !em.threadMessageId) continue;
      if (new Date(em.nextFollowupAt).getTime() > now) continue;
      const step = (em.sequenceStep || 1) + 1;
      if (step > maxSteps) {
        em.nextFollowupAt = null;
        changed = true;
        continue;
      }
      const mb = findMailbox(em.mailboxId);
      if (!mb) continue;
      const cfg = buildMailboxConfig(mb);
      if (!mailer.isMailboxConfigured(cfg)) continue;
      sendProgress({ phase: "email", message: `Follow-up ${step - 1} to ${em.email}…` });
      const fu = await service.generateFollowup({
        name: em.name,
        contactName: em.contactName,
        originalSubject: em.subject,
        originalBody: em.body,
        step,
      });
      if (fu.error) {
        failed++;
        continue;
      }
      const res = await mailer.sendEmail(cfg, { to: em.email, subject: fu.subject, body: fu.body, inReplyTo: em.threadMessageId, references: em.threadMessageId });
      changed = true;
      if (res.ok) {
        em.sequenceStep = step;
        em.nextFollowupAt = nextFollowupAt(step, gaps);
        sent++;
        await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 7000)));
      } else {
        failed++;
      }
    }
    if (changed) await store.saveRun(run);
  }
  sendProgress({ phase: "done", message: `Follow-ups sent: ${sent}${failed ? `, failed ${failed}` : ""}.` });
  return { ok: true, sent, failed };
});

// ---- lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  settings = loadSettings();
  applyEnv(settings);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
