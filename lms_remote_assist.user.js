// ==UserScript==
// @name         SYSU LMS Remote Assist
// @namespace    local.sysu.lms.remote-assist
// @version      0.3.0
// @description  Large on-screen controls for manual remote operation on SYSU LMS. No unattended progress automation.
// @match        https://lms.sysu.edu.cn/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /*
   * SYSU LMS Remote Assist
   *
   * This userscript adds large manual controls to SYSU LMS course pages and
   * keeps a user-started "auto continue" mode alive across LMS page changes.
   * It intentionally avoids hidden learning-progress tampering: it only clicks
   * visible LMS controls and uses the native video element when present.
   */

  const PANEL_ID = "sysu-lms-remote-assist";
  const STYLE_ID = "sysu-lms-remote-assist-style";
  const AUTO_STORAGE_KEY = "sysu-lms-remote-assist-auto";
  const LESSON_COUNT_STORAGE_KEY = "sysu-lms-remote-assist-lesson-count";
  const AUTO_STORAGE_MAX_AGE = 6 * 60 * 60 * 1000;
  const VIDEO_CHECK_INTERVAL = 3000;
  const DEFAULT_STATUS = "手动辅助已开启";

  if (document.getElementById(PANEL_ID)) {
    return;
  }

  function getVisibleVideos() {
    return Array.from(document.querySelectorAll("video")).filter((video) => {
      const rect = video.getBoundingClientRect();
      const style = window.getComputedStyle(video);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function getPrimaryVideo() {
    const videos = getVisibleVideos();
    if (videos.length === 0) {
      return null;
    }

    // Prefer the largest visible video in the viewport; LMS pages can keep
    // hidden video tags around after partial navigation or player replacement.
    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const area = rect.width * rect.height;
        const visible =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        return { video, score: visible ? area * 2 : area };
      })
      .sort((a, b) => b.score - a.score)[0].video;
  }

  function isUsableClickTarget(candidate) {
    if (candidate.closest(`#${PANEL_ID}`)) {
      return false;
    }

    // Forum pages have their own pagination arrows. They look like "next"
    // buttons visually, but clicking them only changes discussion pages.
    if (candidate.closest(".pagination,.paging,.pagingbar,.forum-pagination,.discussion-pagination")) {
      return false;
    }

    if (candidate.tagName === "A" && /[?&]page=\d+/i.test(candidate.getAttribute("href") || "")) {
      return false;
    }

    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !candidate.disabled &&
      candidate.getAttribute("aria-disabled") !== "true"
    );
  }

  function getVisibleText(element) {
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isCourseNavigationBlock(element) {
    const rect = element.getBoundingClientRect();
    return Boolean(
      // Known Moodle/SYSU LMS course navigation containers.
      element.closest(".activity-navigation,.course-content-footer,.navbottom") ||
        // Fallback for the grey bottom navigation tiles shown by SYSU LMS.
        (rect.top > window.innerHeight * 0.55 && rect.width >= 180 && rect.height >= 40)
    );
  }

  function getCandidateSignal(element) {
    const text = getVisibleText(element);
    const label = [
      text,
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("rel") || "",
      element.className || "",
    ].join(" ");
    return label;
  }

  function isPreviousNavigation(element) {
    const signal = getCandidateSignal(element);
    return /上一|上一个|返回|previous|prev|back|◀|«|‹|fa-chevron-left|fa-angle-left/i.test(signal);
  }

  function scoreNextNavigation(element) {
    if (!isUsableClickTarget(element) || !isCourseNavigationBlock(element) || isPreviousNavigation(element)) {
      return 0;
    }

    // Score instead of first-match clicking because the footer usually contains
    // both "previous" and "next" tiles. The right-side tile with a next signal
    // should win even when class names are not stable.
    const signal = getCandidateSignal(element);
    const rect = element.getBoundingClientRect();
    const rightHalf = rect.left + rect.width / 2 > window.innerWidth / 2;
    let score = 0;

    if (/下一|下一个|继续|next/i.test(signal)) score += 60;
    if (/▶|»|›/.test(signal)) score += 45;
    if (/rel=['"]?next|fa-chevron-right|fa-angle-right|icon-next/i.test(signal)) score += 35;
    if (element.querySelector(".fa-chevron-right,.fa-angle-right,.icon-next")) score += 35;
    if (rightHalf) score += 30;
    if (element.closest(".activity-navigation,.course-content-footer,.navbottom")) score += 20;

    return score;
  }

  function clickFirst(selectors) {
    for (const selector of selectors) {
      let candidates = [];
      try {
        candidates = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }

      const element = candidates.find(isUsableClickTarget);

      if (element) {
        element.click();
        return true;
      }
    }
    return false;
  }

  function clickFirstAncestorWithDescendant(ancestorSelector, descendantSelector) {
    const element = Array.from(document.querySelectorAll(ancestorSelector)).find(
      (candidate) => candidate.querySelector(descendantSelector) && isUsableClickTarget(candidate)
    );

    if (!element) {
      return false;
    }

    element.click();
    return true;
  }

  function clickFirstMatchingText(selector, predicate) {
    const element = Array.from(document.querySelectorAll(selector)).find((candidate) => {
      if (!isUsableClickTarget(candidate)) {
        return false;
      }

      return predicate(getVisibleText(candidate), candidate);
    });

    if (!element) {
      return false;
    }

    element.click();
    return true;
  }

  function clickBestNextNavigation() {
    const candidates = Array.from(document.querySelectorAll("a,button"));
    const best = candidates
      .map((element) => ({ element, score: scoreNextNavigation(element) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.element.getBoundingClientRect().left - a.element.getBoundingClientRect().left;
      })[0];

    if (!best) {
      return false;
    }

    // Refresh the persistent flag immediately before navigation. This protects
    // auto mode across full page reloads and LMS-driven route changes.
    if (autoMode) {
      setStoredAutoMode(true);
    }

    best.element.click();
    return true;
  }

  function playOrPause() {
    const video = getPrimaryVideo();
    if (video) {
      if (video.paused) {
        video
          .play()
          .then(() => showStatus("播放中"))
          .catch(() => showStatus("浏览器阻止播放，请直接点视频一次"));
      } else {
        video.pause();
        showStatus("已暂停");
      }
      return;
    }

    const clicked = clickFirst([
      ".vjs-play-control",
      ".plyr__control[data-plyr='play']",
      "button[aria-label*='Play']",
      "button[aria-label*='播放']",
      "button[title*='Play']",
      "button[title*='播放']",
    ]);
    showStatus(clicked ? "已发送播放/暂停" : "没找到视频控件");
  }

  function seekBy(seconds) {
    const video = getPrimaryVideo();
    if (!video) {
      showStatus("没找到视频");
      return;
    }

    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    video.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
    showStatus(seconds > 0 ? `前进 ${seconds} 秒` : `后退 ${Math.abs(seconds)} 秒`);
  }

  function toggleFullscreen() {
    const video = getPrimaryVideo();
    const target = video || document.documentElement;

    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => showStatus("退出全屏失败"));
      showStatus("退出全屏");
      return;
    }

    if (!target.requestFullscreen) {
      showStatus("当前浏览器不支持全屏");
      return;
    }

    target.requestFullscreen().then(() => showStatus("进入全屏")).catch(() => showStatus("进入全屏失败"));
  }

  function nextManual() {
    const clicked = clickBestNextNavigation();
    showStatus(clicked ? "已点击下一项" : "没找到下一项按钮");
  }

  function scrollByViewport(direction) {
    window.scrollBy({
      top: Math.round(window.innerHeight * 0.8) * direction,
      behavior: "smooth",
    });
    showStatus(direction > 0 ? "向下滚动" : "向上滚动");
  }

  function showStatus(message) {
    const status = document.querySelector(`#${PANEL_ID} .remote-assist-status`);
    if (!status) {
      return;
    }

    status.textContent = message;
    window.clearTimeout(showStatus.timeout);
    showStatus.timeout = window.setTimeout(() => {
      status.textContent = DEFAULT_STATUS;
    }, 2000);
  }

  // 自动化相关变量
  let autoMode = false;
  let autoRunId = 0;
  let autoButton = null;
  let muteButton = null;
  let lessonCount = 0;
  let lessonCountNode = null;
  let countedLessonKey = null;

  function getStoredAutoMode() {
    const storages = [window.sessionStorage, window.localStorage];
    for (const storage of storages) {
      try {
        const value = storage.getItem(AUTO_STORAGE_KEY);
        if (!value) {
          continue;
        }

        // Backward compatibility with v0.1.5, which stored the flag as "1".
        if (value === "1") {
          return true;
        }

        const state = JSON.parse(value);
        if (state.enabled && Date.now() - state.updatedAt < AUTO_STORAGE_MAX_AGE) {
          return true;
        }
      } catch {
        // Try the next storage backend.
      }
    }

    setStoredAutoMode(false);
    return false;
  }

  function setStoredAutoMode(enabled) {
    const storages = [window.sessionStorage, window.localStorage];
    const value = JSON.stringify({ enabled: true, updatedAt: Date.now() });
    for (const storage of storages) {
      try {
        if (enabled) {
          storage.setItem(AUTO_STORAGE_KEY, value);
        } else {
          storage.removeItem(AUTO_STORAGE_KEY);
        }
      } catch {
        // Some browser privacy settings can block storage. The current page
        // still works, but auto mode may not survive page navigation.
      }
    }
  }

  function makeButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function setAutoButtonText() {
    if (autoButton) {
      autoButton.textContent = autoMode ? "停止自动进行" : "开始自动进行";
    }
  }

  function setMuteButtonText() {
    if (!muteButton) {
      return;
    }

    const video = getPrimaryVideo();
    muteButton.textContent = video?.muted ? "取消静音" : "静音";
  }

  function getStoredLessonCount() {
    const storages = [window.localStorage, window.sessionStorage];
    for (const storage of storages) {
      try {
        const value = storage.getItem(LESSON_COUNT_STORAGE_KEY);
        if (value == null) {
          continue;
        }

        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return parsed;
        }
      } catch {
        // Try the next storage backend.
      }
    }
    return 0;
  }

  function setStoredLessonCount(value) {
    const storages = [window.localStorage, window.sessionStorage];
    for (const storage of storages) {
      try {
        storage.setItem(LESSON_COUNT_STORAGE_KEY, String(value));
      } catch {
        // Ignore storage write failures and keep the in-memory counter usable.
      }
    }
  }

  function updateLessonCountDisplay() {
    if (lessonCountNode) {
      lessonCountNode.textContent = `已刷课程：${lessonCount} 节`;
    }
  }

  function incrementLessonCount() {
    const lessonKey = location.pathname + location.search;
    if (countedLessonKey === lessonKey) {
      return;
    }

    countedLessonKey = lessonKey;
    lessonCount += 1;
    setStoredLessonCount(lessonCount);
    updateLessonCountDisplay();
    showStatus(`已完成 ${lessonCount} 节课程`);
  }

  function resetLessonCount() {
    lessonCount = 0;
    countedLessonKey = null;
    setStoredLessonCount(lessonCount);
    updateLessonCountDisplay();
    showStatus("已重置课程计数");
  }

  function startAutoMode(options = {}) {
    if (autoMode) return;
    autoMode = true;
    autoRunId += 1;
    setStoredAutoMode(true);
    setAutoButtonText();
    showStatus(options.restored ? "已恢复自动进行..." : "自动进行中...");
    runLater(autoRunId, () => autoPlayLoop(autoRunId), options.delay || 0);
  }

  function restoreAutoMode(delay = 1800) {
    if (!autoMode && getStoredAutoMode()) {
      startAutoMode({ restored: true, delay });
    }
  }

  function stopAutoMode() {
    autoMode = false;
    autoRunId += 1;
    setStoredAutoMode(false);
    setAutoButtonText();
    showStatus("已停止自动进行");
  }

  function isCurrentAutoRun(runId) {
    return autoMode && runId === autoRunId;
  }

  function runLater(runId, callback, delay) {
    window.setTimeout(() => {
      if (isCurrentAutoRun(runId)) {
        callback();
      }
    }, delay);
  }

  function muteVideoForAutoMode(video) {
    if (!video || video.muted) {
      return;
    }

    video.muted = true;
    video.defaultMuted = true;
    setMuteButtonText();
    showStatus("自动静音已开启");
  }

  function toggleMute() {
    const video = getPrimaryVideo();
    if (!video) {
      showStatus("没找到视频");
      return;
    }

    video.muted = !video.muted;
    video.defaultMuted = video.muted;
    setMuteButtonText();
    showStatus(video.muted ? "已静音" : "已取消静音");
  }

  function keepVideoPlaying(video) {
    if (!video || video.ended || !video.paused) {
      return;
    }

    if (autoMode) {
      muteVideoForAutoMode(video);
    }

    video
      .play()
      .then(() => showStatus("检测到暂停，已继续播放"))
      .catch(() => showStatus("检测到暂停，请直接点视频一次"));
  }

  // 判断当前页面是否为讨论区（可根据实际 LMS 结构调整）
  function isDiscussionPage() {
    // 1. URL 包含 forum/discuss 关键词
    if (location.href.match(/forum|discuss|discussion|bbs|thread|topic/i)) return true;
    // 2. 标题或主内容含“讨论区”、“论坛”、“发帖”等
    const text = document.body?.innerText || "";
    if (text.match(/讨论区|论坛|发帖|发表讨论|回复|新话题|全部帖子/)) return true;
    // 3. 页面有典型讨论区结构（如帖子列表、发帖按钮等）
    if (document.querySelector(".forum-posts,.discussion-list,.post-list,.forum-thread,.discussion-thread,.forum-content")) return true;
    return false;
  }

  function autoPlayLoop(runId) {
    if (!isCurrentAutoRun(runId)) return;
    const video = getPrimaryVideo();
    if (video) {
      // Video pages: play first, then move to the next activity after the video
      // ends. Both event and polling paths are kept because some embedded
      // players do not reliably dispatch ended events.
      muteVideoForAutoMode(video);
      if (video.ended) {
        incrementLessonCount();
        showStatus("视频已结束，跳转下一项...");
        runLater(runId, () => {
          nextManual();
          runLater(runId, () => autoPlayLoop(runId), 2000);
        }, 1200);
        return;
      }
      keepVideoPlaying(video);
      const onEnded = () => {
        video.removeEventListener("ended", onEnded);
        if (!isCurrentAutoRun(runId)) return;
        incrementLessonCount();
        showStatus("视频播放完毕，跳转下一项...");
        runLater(runId, () => {
          nextManual();
          runLater(runId, () => autoPlayLoop(runId), 2000);
        }, 1200);
      };
      video.addEventListener("ended", onEnded, { once: true });
      function checkVideoState() {
        if (!isCurrentAutoRun(runId)) {
          video.removeEventListener("ended", onEnded);
          return;
        }
        if (video.ended) {
          video.removeEventListener("ended", onEnded);
          incrementLessonCount();
          showStatus("检测到视频结束，跳转下一项...");
          runLater(runId, () => {
            nextManual();
            runLater(runId, () => autoPlayLoop(runId), 2000);
          }, 1200);
          return;
        }

        // Periodically recover from accidental pauses, focus changes, or player
        // UI touches while auto mode is still intentionally enabled.
        keepVideoPlaying(video);
        runLater(runId, checkVideoState, VIDEO_CHECK_INTERVAL);
      }
      runLater(runId, checkVideoState, VIDEO_CHECK_INTERVAL);
      return;
    }
    // Discussion pages are non-video activities in this course flow. Skip them
    // by using the same visible course navigation tile as the manual button.
    if (isDiscussionPage()) {
      showStatus("检测到讨论区，自动跳过...");
      runLater(runId, () => {
        nextManual();
        runLater(runId, () => autoPlayLoop(runId), 2000);
      }, 1200);
      return;
    }
    // Last fallback: if the activity has no playable video, try the next course
    // navigation item instead of getting stuck indefinitely.
    showStatus("未找到视频，尝试下一项...");
    runLater(runId, () => {
      nextManual();
      runLater(runId, () => autoPlayLoop(runId), 2000);
    }, 1200);
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: min(320px, calc(100vw - 32px));
        padding: 12px;
        color: #111827;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(17, 24, 39, 0.16);
        border-radius: 8px;
        box-shadow: 0 10px 30px rgba(17, 24, 39, 0.18);
        font: 16px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #${PANEL_ID}.is-collapsed {
        width: auto;
        padding: 8px;
      }

      #${PANEL_ID} .remote-assist-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 700;
      }

      #${PANEL_ID} .remote-assist-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      #${PANEL_ID} button {
        min-height: 48px;
        padding: 10px 12px;
        color: #ffffff;
        background: #166534;
        border: 0;
        border-radius: 8px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      #${PANEL_ID} button:hover,
      #${PANEL_ID} button:focus {
        background: #14532d;
        outline: 2px solid #86efac;
        outline-offset: 2px;
      }

      #${PANEL_ID} .remote-assist-secondary {
        color: #111827;
        background: #e5e7eb;
      }

      #${PANEL_ID} .remote-assist-secondary:hover,
      #${PANEL_ID} .remote-assist-secondary:focus {
        background: #d1d5db;
        outline-color: #9ca3af;
      }

      #${PANEL_ID} .remote-assist-status {
        margin-top: 8px;
        color: #374151;
        font-size: 14px;
      }

      #${PANEL_ID}.is-collapsed .remote-assist-body,
      #${PANEL_ID}.is-collapsed .remote-assist-title {
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  function installPanel() {
    if (!document.body) {
      window.setTimeout(installPanel, 50);
      return;
    }

    if (document.getElementById(PANEL_ID)) {
      return;
    }

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "SYSU LMS remote assist controls");

    const header = document.createElement("div");
    header.className = "remote-assist-header";

    const title = document.createElement("span");
    title.className = "remote-assist-title";
    title.textContent = "远程手动控制";

    const collapse = makeButton("收起", () => {
      panel.classList.toggle("is-collapsed");
      collapse.textContent = panel.classList.contains("is-collapsed") ? "控制" : "收起";
    });
    collapse.className = "remote-assist-secondary";

    header.append(title, collapse);

    const body = document.createElement("div");
    body.className = "remote-assist-body";

    const grid = document.createElement("div");
    grid.className = "remote-assist-grid";
    grid.append(
      makeButton("播放/暂停", playOrPause),
      makeButton("全屏", toggleFullscreen),
      makeButton("后退15秒", () => seekBy(-15)),
      makeButton("前进15秒", () => seekBy(15)),
      makeButton("向上滚动", () => scrollByViewport(-1)),
      makeButton("向下滚动", () => scrollByViewport(1)),
      makeButton("下一项", nextManual)
    );

    muteButton = makeButton("静音", toggleMute);
    muteButton.className = "remote-assist-secondary";
    grid.append(muteButton);

    const resetCountButton = makeButton("重置计数", resetLessonCount);
    resetCountButton.className = "remote-assist-secondary";
    grid.append(resetCountButton);

    // 自动化按钮
    autoButton = makeButton("开始自动进行", () => {
      if (autoMode) {
        stopAutoMode();
      } else {
        startAutoMode();
      }
    });
    autoButton.className = "remote-assist-secondary";
    grid.append(autoButton);

    const status = document.createElement("div");
    status.className = "remote-assist-status";
    status.textContent = DEFAULT_STATUS;

    lessonCountNode = document.createElement("div");
    lessonCountNode.className = "remote-assist-status";

    body.append(grid, lessonCountNode, status);
    panel.append(header, body);
    document.body.appendChild(panel);
    lessonCount = getStoredLessonCount();
    setAutoButtonText();
    setMuteButtonText();
    updateLessonCountDisplay();

    restoreAutoMode();
  }

  function boot() {
    if (!document.head) {
      window.setTimeout(boot, 50);
      return;
    }

    installStyles();
    installPanel();
  }

  window.addEventListener("pageshow", () => restoreAutoMode(800));

  boot();
})();
