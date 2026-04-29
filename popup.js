const IDLE_END_MS = 20 * 60 * 1000;

const els = {
  activeTask: document.getElementById("activeTask"),
  endTask: document.getElementById("endTask"),
  idleText: document.getElementById("idleText"),
  newTask: document.getElementById("newTask"),
  recordCount: document.getElementById("recordCount"),
  recordList: document.getElementById("recordList"),
  startTask: document.getElementById("startTask"),
  statusText: document.getElementById("statusText"),
  taskError: document.getElementById("taskError"),
  taskInput: document.getElementById("taskInput"),
  taskName: document.getElementById("taskName")
};

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

function typeLabel(type) {
  return {
    image: "图片",
    selection: "选中文本",
    text: "文本",
    video_frame: "视频截图"
  }[type] || type;
}

function preview(record) {
  return record.text || record.alt || record.mediaUrl || record.pageTitle || record.pageUrl || "";
}

async function readState() {
  return chrome.storage.local.get(["currentTask", "records"]);
}

async function render() {
  const { currentTask, records = [] } = await readState();
  const active = Boolean(currentTask && currentTask.status === "active");
  els.activeTask.classList.toggle("hidden", !active);
  els.newTask.classList.toggle("hidden", active);

  if (!active) {
    els.statusText.textContent = "没有进行中的任务";
    els.recordList.innerHTML = "";
    return;
  }

  const taskRecords = records.filter((item) => item.taskId === currentTask.id);
  const idleMs = Date.now() - (currentTask.lastCollectedAt || currentTask.startedAt);
  els.statusText.textContent = "采集中";
  els.taskName.textContent = currentTask.name;
  els.recordCount.textContent = `${taskRecords.length} 条`;
  els.idleText.textContent = `空闲 ${formatDuration(idleMs)} / ${formatDuration(IDLE_END_MS)}`;

  els.recordList.innerHTML = "";
  taskRecords.slice(-8).reverse().forEach((record) => {
    const li = document.createElement("li");
    const type = document.createElement("div");
    const body = document.createElement("div");
    type.className = "record-type";
    body.className = "record-preview";
    type.textContent = typeLabel(record.type);
    body.textContent = preview(record).slice(0, 140);
    li.append(type, body);
    els.recordList.append(li);
  });
}

async function startTask() {
  const name = els.taskInput.value.trim();
  if (!name) {
    els.taskInput.focus();
    return;
  }
  els.startTask.disabled = true;
  await chrome.runtime.sendMessage({ type: "START_TASK", name });
  els.taskInput.value = "";
  els.startTask.disabled = false;
  await render();
}

async function endTask() {
  els.taskError.textContent = "";
  els.endTask.disabled = true;
  els.endTask.textContent = "导出中";
  try {
    const response = await sendMessageWithTimeout({ type: "END_TASK", reason: "manual" }, 15000);
    if (!response?.ok) throw new Error(response?.error || "导出失败");
    els.endTask.textContent = "已导出";
    await render();
  } catch (error) {
    els.taskError.textContent = readableError(error);
    els.endTask.disabled = false;
    els.endTask.textContent = "再试一次";
  }
}

function sendMessageWithTimeout(message, timeoutMs) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("操作超时，请确认浏览器下载权限后再试")), timeoutMs);
    })
  ]);
}

function readableError(error) {
  const message = error?.message || String(error || "");
  if (message.includes("User gesture")) return "浏览器要求用户手势，请重新打开弹窗再点一次";
  if (message.includes("Download")) return "下载被浏览器拦截，请检查下载权限";
  if (message.includes("no active task")) return "没有进行中的任务，可能已经导出过了";
  return message || "操作失败，请再试一次";
}

els.startTask.addEventListener("click", startTask);
els.endTask.addEventListener("click", endTask);
els.taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") startTask();
});

render();
setInterval(render, 1000);
