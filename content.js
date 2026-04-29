const BUTTON_ID = "xhs-radar-collect-button";
const MEDIA_TYPES = new Set(["image", "video_frame"]);
const MAX_TEXT_LENGTH = 5000;
const STICKY_SCALE = 1.2;

let hoverTarget = null;
let pendingRecord = null;
let stickyRect = null;
let taskModal = null;

const button = document.createElement("button");
button.id = BUTTON_ID;
button.type = "button";
button.textContent = "采集";
document.documentElement.appendChild(button);

function pageInfo() {
  return {
    pageTitle: document.title,
    pageUrl: location.href
  };
}

function isExtensionNode(node) {
  return node && (node.id === BUTTON_ID || node.closest?.(`#${BUTTON_ID}, #xhs-radar-task-modal`));
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
}

function clampRect(rect) {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    dpr: window.devicePixelRatio || 1
  };
}

function expandRect(rect, scale) {
  const extraX = (rect.width * (scale - 1)) / 2;
  const extraY = (rect.height * (scale - 1)) / 2;
  return {
    left: rect.left - extraX,
    top: rect.top - extraY,
    right: rect.right + extraX,
    bottom: rect.bottom + extraY
  };
}

function isPointInsideRect(x, y, rect) {
  return rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function mediaRecordForElement(element) {
  if (!element || isExtensionNode(element) || !isVisible(element)) return null;

  const image = element.closest("img");
  if (image && isVisible(image)) {
    const rect = image.getBoundingClientRect();
    return {
      type: "image",
      mediaUrl: image.currentSrc || image.src,
      alt: image.alt || image.title || "",
      text: image.alt || image.title || "",
      captureRect: clampRect(rect),
      ...pageInfo()
    };
  }

  const video = element.closest("video");
  if (video && isVisible(video)) {
    const rect = video.getBoundingClientRect();
    return {
      type: "video_frame",
      mediaUrl: video.currentSrc || video.src || video.poster || "",
      text: video.title || video.getAttribute("aria-label") || "视频暂停截图",
      captureRect: clampRect(rect),
      ...pageInfo()
    };
  }

  return null;
}

function selectedRecord() {
  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
  if (!text) return null;
  return {
    type: "selection",
    text: text.slice(0, MAX_TEXT_LENGTH),
    ...pageInfo()
  };
}

function showButton(x, y, record, targetRect = null) {
  pendingRecord = record;
  stickyRect = targetRect ? expandRect(targetRect, STICKY_SCALE) : null;
  button.className = "";
  button.textContent = "采集";
  button.style.left = `${Math.min(window.innerWidth - 72, Math.max(8, x))}px`;
  button.style.top = `${Math.min(window.innerHeight - 36, Math.max(8, y))}px`;
  button.style.display = "block";
  button.style.visibility = "visible";
}

function isButtonVisible() {
  return button.style.display === "block";
}

function hideButton() {
  button.style.display = "none";
  button.style.visibility = "visible";
  pendingRecord = null;
  stickyRect = null;
  if (hoverTarget) hoverTarget.classList.remove("xhs-radar-hover-target");
  hoverTarget = null;
}

function hideFloatingUiForCapture() {
  const previous = {
    buttonVisibility: button.style.visibility,
    modalVisibility: taskModal?.style.visibility || ""
  };
  button.style.visibility = "hidden";
  if (taskModal) taskModal.style.visibility = "hidden";
  return previous;
}

function restoreFloatingUi(previous) {
  button.style.visibility = previous.buttonVisibility;
  if (taskModal) taskModal.style.visibility = previous.modalVisibility;
}

async function addRecord(record) {
  const shouldHideUi = MEDIA_TYPES.has(record.type);
  const previous = shouldHideUi ? hideFloatingUiForCapture() : null;
  try {
    return await chrome.runtime.sendMessage({ type: "ADD_RECORD", record });
  } finally {
    if (previous) restoreFloatingUi(previous);
  }
}

async function hasActiveTask() {
  try {
    const { currentTask } = await chrome.storage.local.get(["currentTask"]);
    return Boolean(currentTask && currentTask.status === "active");
  } catch (error) {
    return false;
  }
}

document.addEventListener("mouseover", (event) => {
  if (isExtensionNode(event.target) || isButtonVisible()) return;

  const record = mediaRecordForElement(event.target);
  if (!record) return;

  const target = event.target.closest(record.type === "image" ? "img" : "video");
  const rect = target.getBoundingClientRect();

  if (hoverTarget && hoverTarget !== target) {
    hoverTarget.classList.remove("xhs-radar-hover-target");
  }
  hoverTarget = target;
  hoverTarget.classList.add("xhs-radar-hover-target");

  showButton(rect.right - 58, rect.top + 8, record, rect);
}, true);

document.addEventListener("mousemove", (event) => {
  if (!isButtonVisible() || !pendingRecord || !MEDIA_TYPES.has(pendingRecord.type)) return;
  if (isExtensionNode(event.target)) return;
  if (!isPointInsideRect(event.clientX, event.clientY, stickyRect)) hideButton();
}, true);

document.addEventListener("selectionchange", () => {
  if (pendingRecord?.type !== "selection") return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) hideButton();
});

document.addEventListener("mouseup", () => {
  setTimeout(() => {
    const record = selectedRecord();
    if (!record) return;
    const selection = window.getSelection();
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    if (!rect) return;
    showButton(rect.right + 8, rect.top - 4, record);
  }, 0);
});

document.addEventListener("scroll", hideButton, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideButton();
});

button.addEventListener("mousedown", (event) => {
  event.preventDefault();
  event.stopPropagation();
});

button.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!pendingRecord) return;

  const record = pendingRecord;
  if (!(await hasActiveTask())) {
    showTaskModal(record);
    return;
  }

  button.textContent = "保存中";
  try {
    const response = await addRecord(record);
    if (!response?.ok) {
      if (response?.error === "no active task") {
        showTaskModal(record);
        return;
      }
      throw new Error(response?.error || "没有进行中的任务");
    }
    button.textContent = "已采集";
    button.className = "xhs-radar-ok";
    setTimeout(hideButton, 650);
  } catch (error) {
    showTaskModal(record);
  }
});

function ensureTaskModal() {
  if (taskModal) return taskModal;

  const modal = document.createElement("div");
  modal.id = "xhs-radar-task-modal";

  const card = document.createElement("form");
  card.className = "xhs-radar-task-card";

  const title = document.createElement("h2");
  title.className = "xhs-radar-task-title";
  title.textContent = "新建采集任务";

  const input = document.createElement("input");
  input.className = "xhs-radar-task-input";
  input.maxLength = 64;
  input.placeholder = "例如：竞品评论观察";

  const error = document.createElement("div");
  error.className = "xhs-radar-task-error";
  error.setAttribute("role", "status");

  const actions = document.createElement("div");
  actions.className = "xhs-radar-task-actions";

  const cancel = document.createElement("button");
  cancel.className = "xhs-radar-task-cancel";
  cancel.type = "button";
  cancel.textContent = "取消";

  const create = document.createElement("button");
  create.className = "xhs-radar-task-create";
  create.type = "submit";
  create.textContent = "新建并采集";

  actions.append(cancel, create);
  card.append(title, input, error, actions);
  modal.append(card);
  document.documentElement.appendChild(modal);

  cancel.addEventListener("click", hideTaskModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) hideTaskModal();
  });
  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim() || defaultTaskName();

    error.textContent = "";
    create.disabled = true;
    create.textContent = "采集中";
    try {
      const record = modal.record;
      if (!record) throw new Error("采集内容丢失，请重新点页面上的采集按钮");
      const started = await chrome.runtime.sendMessage({ type: "START_TASK", name });
      if (!started?.ok && started?.error !== "task already active") {
        throw new Error(started?.error || "create task failed");
      }
      const added = await addRecord(record);
      if (!added?.ok) throw new Error(added?.error || "add record failed");
      hideTaskModal();
      button.textContent = "已采集";
      button.className = "xhs-radar-ok";
      button.style.display = "block";
      setTimeout(hideButton, 650);
    } catch (error) {
      modal.error.textContent = readableError(error);
      create.textContent = "再试一次";
    } finally {
      create.disabled = false;
    }
  });

  taskModal = modal;
  taskModal.input = input;
  taskModal.error = error;
  return taskModal;
}

function showTaskModal(record) {
  const modal = ensureTaskModal();
  modal.record = record;
  modal.input.value = defaultTaskName();
  modal.error.textContent = "";
  modal.classList.add("xhs-radar-open");
  button.style.display = "none";
  setTimeout(() => {
    modal.input.focus();
    modal.input.select();
  }, 0);
}

function hideTaskModal() {
  if (!taskModal) return;
  taskModal.classList.remove("xhs-radar-open");
  taskModal.record = null;
  taskModal.error.textContent = "";
}

function defaultTaskName() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `采集 ${parts.month}-${parts.day} ${parts.hour}${parts.minute}`;
}

function readableError(error) {
  const message = error?.message || String(error || "");
  if (message.includes("Extension context invalidated")) return "扩展刚刚更新过，请刷新页面后再试";
  if (message.includes("Receiving end does not exist")) return "后台未响应，请在扩展页重新加载插件后刷新页面";
  if (message.includes("Cannot access")) return "当前页面不允许扩展访问，请换普通网页或刷新后再试";
  return message || "创建失败，请再试一次";
}
