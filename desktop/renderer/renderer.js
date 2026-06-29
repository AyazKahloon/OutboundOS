// UI logic. Talks to the backend only through window.api (exposed by preload.js).

const $ = (sel) => document.querySelector(sel);

// ---- tab switching ---------------------------------------------------------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $(`#view-${tab.dataset.view}`).classList.add("active");
    if (tab.dataset.view === "results") {
      loadRuns();
      refreshFollowupBanner();
    }
    if (tab.dataset.view === "sent") loadSent();
  });
});

// ---- progress log ----------------------------------------------------------
const progressEl = $("#progress");
function logLine(text, cls = "") {
  if (progressEl.querySelector(".muted")) progressEl.innerHTML = "";
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.textContent = text;
  progressEl.appendChild(div);
  progressEl.scrollTop = progressEl.scrollHeight;
}

window.api.onProgress((e) => {
  const cls = e.phase === "error" ? "err" : e.phase === "done" ? "ok" : "";
  const counter = e.current && e.total ? `[${e.current}/${e.total}] ` : "";
  logLine(`${counter}${e.message}`, cls);
});

// ---- run -------------------------------------------------------------------
const runBtn = $("#runBtn");
runBtn.addEventListener("click", async () => {
  const query = $("#query").value.trim();
  const count = $("#count").value;
  if (!query) {
    setHint("#runHint", "Enter a search first.", "bad");
    return;
  }
  const s = await window.api.getSettings();
  if (!s.groqApiKey || !s.senderName || !s.offer) {
    setHint("#runHint", "Add your Groq key, name and offer in Settings first.", "bad");
    return;
  }
  runBtn.disabled = true;
  setHint("#runHint", "");
  progressEl.innerHTML = "";
  logLine(`Starting "${query}"…`);
  const res = await window.api.run(query, count);
  runBtn.disabled = false;
  if (res.ok) {
    setHint("#runHint", `Saved. ${res.run.emails.filter((x) => !x.error).length} emails ready — see Results.`, "good");
  } else {
    setHint("#runHint", res.error, "bad");
  }
});

// ---- CSV mode --------------------------------------------------------------
let csvPath = "";
document.querySelector("#pickCsv").addEventListener("click", async () => {
  const p = await window.api.pickCsv();
  if (p) {
    csvPath = p;
    document.querySelector("#csvPath").value = p;
  }
});

const runCsvBtn = document.querySelector("#runCsvBtn");
runCsvBtn.addEventListener("click", async () => {
  if (!csvPath) {
    setHint("#csvHint", "Choose a CSV file first.", "bad");
    return;
  }
  const s = await window.api.getSettings();
  if (!s.groqApiKey || !s.senderName || !s.offer) {
    setHint("#csvHint", "Add your Groq key, name and offer in Settings first.", "bad");
    return;
  }
  runCsvBtn.disabled = true;
  runBtn.disabled = true;
  setHint("#csvHint", "");
  progressEl.innerHTML = "";
  logLine(`Processing CSV…`);
  const res = await window.api.runFromCsv(csvPath);
  runCsvBtn.disabled = false;
  runBtn.disabled = false;
  if (res.ok) {
    setHint("#csvHint", `Saved. ${res.run.emails.filter((x) => !x.error).length} emails ready — see Results.`, "good");
  } else {
    setHint("#csvHint", res.error, "bad");
  }
});

// ---- results ---------------------------------------------------------------
async function loadRuns() {
  const runs = await window.api.listRuns();
  const list = $("#runList");
  if (!runs.length) {
    list.innerHTML = '<p class="muted">No runs yet.</p>';
    return;
  }
  list.innerHTML = "";
  runs.forEach((r) => {
    const item = document.createElement("div");
    item.className = "run-item";
    const date = new Date(r.createdAt).toLocaleString();
    item.innerHTML =
      `<div class="run-head"><div class="q"></div><button class="run-del" title="Delete this run">✕</button></div>` +
      `<div class="meta">${r.leadCount} leads · ${r.emailCount} emails<br>${date}</div>`;
    item.querySelector(".q").textContent = r.query;
    item.querySelector(".run-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete this run and its ${r.emailCount} emails? This can't be undone.`)) return;
      await window.api.deleteRun(r.id);
      if (currentRunId === r.id) {
        currentRunId = null;
        $("#emailList").innerHTML = '<p class="muted pad">Pick a run on the left.</p>';
      }
      loadRuns();
    });
    item.addEventListener("click", () => {
      document.querySelectorAll(".run-item").forEach((i) => i.classList.remove("active"));
      item.classList.add("active");
      showRun(r.id);
    });
    list.appendChild(item);
  });
}

let currentRunId = null;

// Mailboxes available for sending (from saved settings; migrates an older single config).
function mailboxesFromSettings(s) {
  if (Array.isArray(s.mailboxes) && s.mailboxes.length) return s.mailboxes;
  if (s.mailEmail) {
    return [{ id: "legacy", provider: s.mailProvider || "gmail", email: s.mailEmail, pass: s.mailPass, fromName: s.fromName, smtpHost: s.smtpHost, smtpPort: s.smtpPort, smtpSecure: s.smtpSecure }];
  }
  return [];
}
function selectedMailboxId() {
  const el = $("#sendFrom");
  return el && el.value ? el.value : null;
}
async function populateSendFrom() {
  const list = mailboxesFromSettings(await window.api.getSettings());
  const el = $("#sendFrom");
  if (!list.length) {
    el.innerHTML = '<option value="">No mailbox — add one in Settings</option>';
    return;
  }
  el.innerHTML = "";
  list.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.email || "(unnamed mailbox)";
    el.appendChild(opt);
  });
}

async function showRun(id) {
  currentRunId = id;
  await populateSendFrom();
  const run = await window.api.getRun(id);
  const box = $("#emailList");
  if (!run || !run.emails) {
    box.innerHTML = '<p class="muted">No emails in this run.</p>';
    return;
  }
  box.innerHTML = "";
  run.emails.forEach((em) => box.appendChild(emailCard(em)));
}

const STATUS_CLASS = { draft: "", approved: "ok", sent: "sent", failed: "neg", replied: "replied" };

function emailCard(em) {
  const card = document.createElement("div");
  card.className = "email-card";
  const neg = em.negativeCount ? `<span class="badge neg">${em.negativeCount} negative</span>` : "";
  const to = em.email ? `✉ ${em.email} · ` : "(no recipient email) · ";
  const sub = `${to}${em.category || ""} · ${em.rating ?? "?"}★ (${em.totalReviews ?? em.reviewCount} reviews) `;
  const status = em.status || (em.error ? "failed" : "draft");

  // Generation failed (no email body produced).
  if (!em.subject && em.error) {
    card.innerHTML = `<div class="name"></div><div class="sub"></div><div class="err">⚠️ ${escapeHtml(em.error)}</div><div class="actions"></div>`;
    card.querySelector(".name").textContent = em.name;
    card.querySelector(".sub").innerHTML = sub + neg;
    const del = document.createElement("button");
    del.className = "ghost danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm("Delete this failed email?")) return;
      await window.api.deleteEmail(currentRunId, em.id);
      showRun(currentRunId);
    });
    card.querySelector(".actions").appendChild(del);
    return card;
  }

  card.innerHTML =
    `<div class="name"></div> <span class="badge status ${STATUS_CLASS[status] || ""}">${status}</span>` +
    `<div class="sub"></div><div class="subject"></div><div class="body"></div>` +
    `<div class="actions"></div>`;
  card.querySelector(".name").textContent = em.name;
  card.querySelector(".sub").innerHTML = sub + neg;
  card.querySelector(".subject").textContent = "Subject: " + em.subject;
  card.querySelector(".body").textContent = em.body;

  const actions = card.querySelector(".actions");
  const addBtn = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    actions.appendChild(b);
    return b;
  };

  addBtn("Copy", "ghost", (e) => {
    const toLine = em.email ? `To: ${em.email}\n` : "";
    navigator.clipboard.writeText(`${toLine}Subject: ${em.subject}\n\n${em.body}`);
    e.target.textContent = "Copied ✓";
  });

  if (status === "draft" || status === "failed") {
    addBtn("Approve", "ghost", async () => {
      await window.api.setEmailStatus(currentRunId, em.id, "approved");
      showRun(currentRunId);
    });
  }
  if (status === "approved" || status === "failed") {
    const send = addBtn(status === "failed" ? "Retry send" : "Send", "primary", async () => {
      const mbId = selectedMailboxId();
      if (!mbId) {
        alert("Add a mailbox in Settings, then pick it in 'Send from'.");
        return;
      }
      send.disabled = true;
      send.textContent = "Sending…";
      const res = await window.api.sendEmail(currentRunId, em.id, mbId);
      if (!res.ok) {
        send.disabled = false;
        send.textContent = "Send";
        alert("Send failed: " + res.error);
      }
      showRun(currentRunId);
    });
    if (!em.email) {
      send.disabled = true;
      send.title = "No recipient email for this lead";
    }
  }
  if (status === "approved") {
    addBtn("Unapprove", "ghost", async () => {
      await window.api.setEmailStatus(currentRunId, em.id, "draft");
      showRun(currentRunId);
    });
  }
  if (status === "sent") {
    const when = em.sentAt ? new Date(em.sentAt).toLocaleDateString() : "";
    const step = em.sequenceStep || 1;
    let txt = `Sent ${when}`;
    if (em.nextFollowupAt) txt += ` · step ${step}/4 · next follow-up ${new Date(em.nextFollowupAt).toLocaleDateString()}`;
    else if (step >= 4) txt += " · sequence complete";
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = txt;
    actions.appendChild(note);
  }
  if (status === "replied") {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = `Replied ${em.repliedAt ? new Date(em.repliedAt).toLocaleString() : ""} ✓ (follow-ups stopped)`;
    actions.appendChild(note);
  }

  addBtn("Delete", "ghost danger", async () => {
    if (!confirm(`Delete this email${em.email ? " to " + em.email : ""}? This can't be undone.`)) return;
    await window.api.deleteEmail(currentRunId, em.id);
    showRun(currentRunId);
  });
  return card;
}

$("#refreshRuns").addEventListener("click", loadRuns);
$("#openData").addEventListener("click", () => window.api.openDataDir());
$("#sendApproved").addEventListener("click", async () => {
  if (!currentRunId) {
    alert("Open a run first.");
    return;
  }
  const mbId = selectedMailboxId();
  if (!mbId) {
    alert("Add a mailbox in Settings, then pick it in 'Send from'.");
    return;
  }
  progressEl.innerHTML = "";
  logLine("Sending approved emails…");
  const res = await window.api.sendApproved(currentRunId, mbId);
  if (!res.ok) alert(res.error);
  showRun(currentRunId);
  refreshFollowupBanner();
});

// ---- follow-ups + replies --------------------------------------------------
async function refreshFollowupBanner() {
  const s = await window.api.followupStatus();
  const banner = $("#fuBanner");
  if (!s || (!s.due && !s.scheduled && !s.replied)) {
    banner.style.display = "none";
    return;
  }
  const bits = [];
  if (s.due) bits.push(`${s.due} follow-up${s.due === 1 ? "" : "s"} due now`);
  if (s.scheduled) bits.push(`${s.scheduled} scheduled`);
  if (s.replied) bits.push(`${s.replied} replied`);
  banner.textContent = bits.join("  ·  ");
  banner.style.display = "block";
}

$("#checkReplies").addEventListener("click", async () => {
  const btn = $("#checkReplies");
  btn.disabled = true;
  btn.textContent = "Checking…";
  const res = await window.api.checkReplies();
  btn.disabled = false;
  btn.textContent = "Check replies";
  await refreshFollowupBanner();
  if (currentRunId) showRun(currentRunId);
  if (res.ok) alert(`${res.replied} new repl${res.replied === 1 ? "y" : "ies"} found.`);
  else alert(res.error || "Could not check replies. Make sure your mailbox has IMAP enabled.");
});

$("#sendFollowups").addEventListener("click", async () => {
  const btn = $("#sendFollowups");
  btn.disabled = true;
  btn.textContent = "Sending…";
  progressEl.innerHTML = "";
  logLine("Checking replies, then sending due follow-ups…");
  const res = await window.api.sendDueFollowups();
  btn.disabled = false;
  btn.textContent = "Send due follow-ups";
  await refreshFollowupBanner();
  if (currentRunId) showRun(currentRunId);
  if (!res.ok) alert(res.error);
});

// ---- sent list -------------------------------------------------------------
async function loadSent() {
  const wrap = $("#sentTableWrap");
  const sent = await window.api.listSent();
  if (!sent.length) {
    wrap.innerHTML = '<p class="muted">Nothing sent yet.</p>';
    return;
  }
  // Group by the mailbox each email was sent FROM.
  const groups = new Map();
  sent.forEach((s) => {
    const key = s.from || "(unknown)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });

  wrap.innerHTML = "";
  for (const [from, items] of groups) {
    const h = document.createElement("h3");
    h.className = "sent-group";
    h.textContent = `${from} — ${items.length} sent`;
    wrap.appendChild(h);

    const table = document.createElement("table");
    table.className = "sent-table";
    table.innerHTML = "<thead><tr><th>Sent</th><th>To</th><th>Business</th><th>Subject</th></tr></thead>";
    const tbody = document.createElement("tbody");
    items.forEach((s) => {
      const tr = document.createElement("tr");
      const when = s.sentAt ? new Date(s.sentAt).toLocaleString() : "";
      [when, s.to, s.name, s.subject].forEach((val) => {
        const td = document.createElement("td");
        td.textContent = val || "";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }
}
$("#refreshSent").addEventListener("click", loadSent);

// ---- settings: mailboxes ---------------------------------------------------
const PROVIDERS = [
  ["gmail", "Gmail"],
  ["outlook", "Outlook / Microsoft 365"],
  ["other", "Other (custom SMTP)"],
];

function newId() {
  return crypto && crypto.randomUUID ? crypto.randomUUID() : "mb-" + Date.now() + "-" + Math.round(Math.random() * 1e6);
}

function readCard(card) {
  return {
    id: card.dataset.id,
    provider: card.querySelector(".mb-provider").value,
    fromName: card.querySelector(".mb-fromName").value.trim(),
    email: card.querySelector(".mb-email").value.trim(),
    pass: card.querySelector(".mb-pass").value,
    smtpHost: card.querySelector(".mb-host").value.trim(),
    smtpPort: card.querySelector(".mb-port").value.trim(),
    smtpSecure: card.querySelector(".mb-secure").value === "true",
  };
}

function mailboxCard(mb) {
  const card = document.createElement("div");
  card.className = "mailbox-card";
  card.dataset.id = mb.id || newId();
  card.innerHTML =
    `<div class="row">` +
    `<label>Provider<select class="mb-provider">${PROVIDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>` +
    `<label>From name<input class="mb-fromName" type="text" placeholder="Ayaz" /></label>` +
    `</div>` +
    `<div class="row">` +
    `<label>Email address (send from this)<input class="mb-email" type="text" placeholder="you@gmail.com" /></label>` +
    `<label>Password / App password<input class="mb-pass" type="password" placeholder="••••••••" /></label>` +
    `</div>` +
    `<div class="row mb-custom" style="display:none">` +
    `<label>SMTP host<input class="mb-host" type="text" placeholder="smtp.yourhost.com" /></label>` +
    `<label class="narrow">Port<input class="mb-port" type="number" placeholder="587" /></label>` +
    `<label class="narrow">SSL<select class="mb-secure"><option value="false">No (587)</option><option value="true">Yes (465)</option></select></label>` +
    `</div>` +
    `<div class="actions"><button class="ghost mb-test">Test</button><button class="ghost mb-remove">Remove</button><span class="mb-hint"></span></div>`;

  card.querySelector(".mb-provider").value = mb.provider || "gmail";
  card.querySelector(".mb-fromName").value = mb.fromName || "";
  card.querySelector(".mb-email").value = mb.email || "";
  card.querySelector(".mb-pass").value = mb.pass || "";
  card.querySelector(".mb-host").value = mb.smtpHost || "";
  card.querySelector(".mb-port").value = mb.smtpPort || "";
  card.querySelector(".mb-secure").value = mb.smtpSecure ? "true" : "false";

  const toggle = () => {
    card.querySelector(".mb-custom").style.display = card.querySelector(".mb-provider").value === "other" ? "flex" : "none";
  };
  toggle();
  card.querySelector(".mb-provider").addEventListener("change", toggle);
  card.querySelector(".mb-remove").addEventListener("click", () => card.remove());
  card.querySelector(".mb-test").addEventListener("click", async () => {
    const hint = card.querySelector(".mb-hint");
    hint.textContent = "Testing…";
    hint.className = "mb-hint";
    const res = await window.api.testMailbox(readCard(card));
    hint.textContent = res.ok ? "Connected ✓" : "Failed: " + res.error;
    hint.className = "mb-hint " + (res.ok ? "good" : "bad");
  });
  return card;
}

function renderMailboxes(list) {
  const wrap = $("#mailboxList");
  wrap.innerHTML = "";
  (list.length ? list : [{ id: newId(), provider: "gmail" }]).forEach((mb) => wrap.appendChild(mailboxCard(mb)));
}

$("#addMailbox").addEventListener("click", () => {
  $("#mailboxList").appendChild(mailboxCard({ id: newId(), provider: "gmail" }));
});

// ---- settings: load/save ---------------------------------------------------
async function loadSettings() {
  const s = await window.api.getSettings();
  $("#s_groq").value = s.groqApiKey || "";
  $("#s_name").value = s.senderName || "";
  $("#s_company").value = s.senderCompany || "";
  $("#s_offer").value = s.offer || "";
  $("#s_dataDir").value = s.dataDir || s._defaultDataDir || "";
  $("#s_sigAddr").value = s.signatureAddress || "";
  renderMailboxes(mailboxesFromSettings(s));
}

$("#saveSettings").addEventListener("click", async () => {
  const mailboxes = Array.from(document.querySelectorAll(".mailbox-card")).map(readCard).filter((m) => m.email);
  await window.api.saveSettings({
    groqApiKey: $("#s_groq").value.trim(),
    senderName: $("#s_name").value.trim(),
    senderCompany: $("#s_company").value.trim(),
    offer: $("#s_offer").value.trim(),
    dataDir: $("#s_dataDir").value.trim(),
    signatureAddress: $("#s_sigAddr").value.trim(),
    mailboxes,
  });
  setHint("#settingsHint", `Saved. ${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"} configured.`, "good");
});

$("#pickDir").addEventListener("click", async () => {
  const dir = await window.api.pickDataDir();
  if (dir) $("#s_dataDir").value = dir;
});

// ---- helpers ---------------------------------------------------------------
function setHint(sel, text, cls = "") {
  const el = $(sel);
  el.textContent = text;
  el.className = `hint ${cls}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

loadSettings();

// Show the build stamp in the sidebar so the user can confirm they're on the latest build.
(async () => {
  try {
    const info = await window.api.appInfo();
    const el = document.getElementById("buildInfo");
    if (!el) return;
    const when = info.builtAt
      ? new Date(info.builtAt).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : null;
    el.textContent = `v${info.version}${when ? ` · built ${when}` : ""}`;
  } catch {
    /* non-fatal */
  }
})();
