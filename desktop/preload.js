// Secure bridge between the UI (renderer) and the main process. The UI can only call
// these whitelisted functions — no direct Node access.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  pickDataDir: () => ipcRenderer.invoke("settings:pickDataDir"),
  run: (query, count) => ipcRenderer.invoke("run:scrapeAndGenerate", { query, count }),
  pickCsv: () => ipcRenderer.invoke("dialog:pickCsv"),
  runFromCsv: (filePath) => ipcRenderer.invoke("run:fromCsv", filePath),
  listRuns: () => ipcRenderer.invoke("runs:list"),
  getRun: (id) => ipcRenderer.invoke("runs:get", id),
  listSent: () => ipcRenderer.invoke("sent:list"),
  openDataDir: () => ipcRenderer.invoke("data:open"),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, data) => cb(data)),
  // sending
  testMailbox: (mailbox) => ipcRenderer.invoke("mail:test", mailbox),
  setEmailStatus: (runId, emailId, status) => ipcRenderer.invoke("email:setStatus", { runId, emailId, status }),
  sendEmail: (runId, emailId, mailboxId) => ipcRenderer.invoke("email:send", { runId, emailId, mailboxId }),
  sendApproved: (runId, mailboxId) => ipcRenderer.invoke("email:sendApproved", { runId, mailboxId }),
});
