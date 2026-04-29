const IDLE_END_MS = 20 * 60 * 1000;
const ALARM_NAME = "xhs-radar-idle-check";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const { currentTask } = await chrome.storage.local.get(["currentTask"]);
  if (!isActive(currentTask)) return;
  const lastTouched = currentTask.lastCollectedAt || currentTask.startedAt;
  if (Date.now() - lastTouched >= IDLE_END_MS) {
    await finalizeTask("idle");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  return true;
});

async function handleMessage(message, sender) {
  if (message.type === "START_TASK") {
    return startTask(message.name);
  }
  if (message.type === "ADD_RECORD") {
    return addRecord(message.record, sender);
  }
  if (message.type === "END_TASK") {
    return finalizeTask(message.reason || "manual");
  }
  return { ok: false, error: "unknown message" };
}

function isActive(task) {
  return task && task.status === "active";
}

async function startTask(name) {
  const { currentTask } = await chrome.storage.local.get(["currentTask"]);
  if (isActive(currentTask)) {
    return { ok: true, task: currentTask, existing: true };
  }

  const now = Date.now();
  const task = {
    id: crypto.randomUUID(),
    name: String(name || "未命名任务").trim().slice(0, 64),
    status: "active",
    startedAt: now,
    lastCollectedAt: now
  };
  await chrome.storage.local.set({ currentTask: task });
  return { ok: true, task };
}

async function addRecord(rawRecord, sender) {
  const { currentTask, records = [] } = await chrome.storage.local.get(["currentTask", "records"]);
  if (!isActive(currentTask)) {
    return { ok: false, error: "no active task" };
  }

  const now = Date.now();
  const dataUrl = await ensureMediaDataUrl(rawRecord, sender);
  const record = {
    id: crypto.randomUUID(),
    taskId: currentTask.id,
    createdAt: now,
    type: rawRecord.type || "text",
    text: cleanText(rawRecord.text || ""),
    alt: cleanText(rawRecord.alt || ""),
    mediaUrl: rawRecord.mediaUrl || "",
    dataUrl,
    pageTitle: cleanText(rawRecord.pageTitle || ""),
    pageUrl: rawRecord.pageUrl || ""
  };

  currentTask.lastCollectedAt = now;
  records.push(record);
  await chrome.storage.local.set({ currentTask, records });
  return { ok: true, record };
}

async function ensureMediaDataUrl(rawRecord, sender) {
  if (rawRecord.dataUrl) return rawRecord.dataUrl;
  if (rawRecord.type !== "image" && rawRecord.type !== "video_frame") return "";

  const screenshot = await captureElementScreenshot(rawRecord.captureRect, sender);
  if (screenshot) return screenshot;

  if (!rawRecord.mediaUrl) return "";
  try {
    const response = await fetch(rawRecord.mediaUrl, { credentials: "include" });
    if (!response.ok) return "";
    const blob = await response.blob();
    return blobToDataUrl(blob);
  } catch (error) {
    return "";
  }
}

async function captureElementScreenshot(rect, sender) {
  if (!rect || !sender?.tab?.windowId) return "";

  try {
    const screenshotUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
      format: "png"
    });
    const blob = await (await fetch(screenshotUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const dpr = rect.dpr || bitmap.width / Math.max(1, sender.tab.width || bitmap.width);
    const sourceX = Math.max(0, Math.floor(rect.left * dpr));
    const sourceY = Math.max(0, Math.floor(rect.top * dpr));
    const sourceWidth = Math.min(bitmap.width - sourceX, Math.ceil(rect.width * dpr));
    const sourceHeight = Math.min(bitmap.height - sourceY, Math.ceil(rect.height * dpr));
    if (sourceWidth <= 0 || sourceHeight <= 0) return "";

    const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const context = canvas.getContext("2d");
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(croppedBlob);
  } catch (error) {
    return "";
  }
}

async function finalizeTask(reason) {
  const { currentTask, records = [] } = await chrome.storage.local.get(["currentTask", "records"]);
  if (!isActive(currentTask)) return { ok: false, error: "no active task" };

  const endedAt = Date.now();
  const taskRecords = records.filter((record) => record.taskId === currentTask.id);
  const remainingRecords = records.filter((record) => record.taskId !== currentTask.id);
  const folderName = safeFolderName(`${formatBeijing(endedAt, true)} ${currentTask.name}`);
  const markdownFilename = `${safeFolderName(currentTask.name || "README")}.md`;

  const finishedTask = {
    ...currentTask,
    status: "ended",
    endedAt,
    reason,
    exportedFolder: folderName
  };

  await chrome.storage.local.set({
    pendingExport: {
      task: finishedTask,
      count: taskRecords.length,
      folderName,
      markdown: "",
      createdAt: Date.now()
    }
  });

  const assets = await downloadAssets(folderName, taskRecords);
  const markdown = buildMarkdown(taskRecords, assets);

  await chrome.storage.local.set({
    pendingExport: {
      task: finishedTask,
      count: taskRecords.length,
      folderName,
      markdown,
      createdAt: Date.now()
    }
  });

  await downloadText(`${folderName}/${markdownFilename}`, markdown);

  await chrome.storage.local.set({
    currentTask: null,
    lastExport: finishedTask,
    lastExportMarkdown: markdown,
    pendingExport: null,
    records: remainingRecords
  });

  return { ok: true, folderName, count: taskRecords.length };
}

async function downloadAssets(folderName, records) {
  const assets = new Map();
  let assetIndex = 1;

  for (const record of records) {
    if (record.type !== "image" && record.type !== "video_frame") continue;

    try {
      let dataUrl = record.dataUrl;
      let extension = extensionFromDataUrl(dataUrl) || extensionFromUrl(record.mediaUrl) || "jpg";

      if (!dataUrl && record.mediaUrl) {
        const response = await fetch(record.mediaUrl, { credentials: "include" });
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const blob = await response.blob();
        extension = extensionFromMime(blob.type) || extension;
        dataUrl = await blobToDataUrl(blob);
      }

      if (!dataUrl) continue;
      const filename = `${folderName}/assets/${String(assetIndex).padStart(3, "0")}-${record.id}.${extension}`;
      await chrome.downloads.download({
        url: dataUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      assets.set(record.id, `assets/${String(assetIndex).padStart(3, "0")}-${record.id}.${extension}`);
      assetIndex += 1;
    } catch (error) {
      assets.set(record.id, "");
    }
  }

  return assets;
}

function buildMarkdown(records, assets = new Map()) {
  const lines = [
    "| 编号 | 页面 | 采集内容 |",
    "|---:|---|---|"
  ];

  records.forEach((record, index) => {
    const pageText = record.pageTitle || record.pageUrl || "页面";
    const pageLabel = truncateText(pageText, 10);
    const page = record.pageUrl
      ? `[${escapeTableCell(pageLabel)}](${escapeLink(record.pageUrl)})`
      : escapeTableCell(pageLabel);
    const content = buildContentCell(record, assets.get(record.id));
    lines.push(`| ${index + 1} | ${page} | ${content} |`);
  });

  return `${lines.join("\n")}\n`;
}

function buildContentCell(record, assetPath) {
  const parts = [];
  const text = escapeTableCell(record.text || record.alt || "");
  if (text) parts.push(text);
  if (assetPath) {
    const label = record.type === "video_frame" ? "视频截图" : "图片";
    parts.push(`![${label}](${escapeLink(assetPath)})`);
  }
  return parts.join("<br>");
}

async function downloadText(filename, text) {
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
  return chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
}

function cleanText(value) {
  return String(value).replace(/\r\n/g, "\n").trim().slice(0, 5000);
}

function typeLabel(type) {
  return {
    image: "图片",
    selection: "选中文本",
    text: "文本",
    video_frame: "视频截图"
  }[type] || type;
}

function formatBeijing(timestamp, forFolder = false) {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const colon = forFolder ? "：" : ":";
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${colon}${parts.minute}${colon}${parts.second}`;
}

function safeFolderName(value) {
  return value
    .replace(/[\\/:?*"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || "web-radar-export";
}

function escapeMd(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}

function escapeTableCell(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function escapeLink(value) {
  return String(value || "").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function extensionFromDataUrl(dataUrl) {
  const match = /^data:([^;,]+)/.exec(dataUrl || "");
  return match ? extensionFromMime(match[1]) : "";
}

function extensionFromMime(mime) {
  return {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  }[mime] || "";
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    return match ? match[1].toLowerCase() : "";
  } catch (error) {
    return "";
  }
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
