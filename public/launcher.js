/**
 * Discrub Launcher — Standalone splash screen for version selection.
 * No React, no bundler. Pure vanilla JS for instant load.
 */

const COUNTDOWN_SECONDS = 5;
const PREF_KEY = 'discrub-launcher-preference';


const LAUNCHER_COPY = {
  en: {
    title: 'Discrub Launcher',
    subtitle: 'Discord Data Management',
    selectVersion: 'Select version',
    versionPrompt: 'Modern or Classic?',
    launch: 'Launch Discrub',
    launching: 'Launching...',
    launchingIn: (seconds) => 'Launching in ' + seconds + '...',
    loading: 'Loading...',
    switchHint: 'Click the dropdown to switch versions',
    selectHint: 'Select a version to get started',
    classicSuffix: ' (Classic)',
  },
  'zh-CN': {
    title: 'Discrub 启动器',
    subtitle: 'Discord 数据管理',
    selectVersion: '选择版本',
    versionPrompt: '新版还是经典版？',
    launch: '启动 Discrub',
    launching: '正在启动…',
    launchingIn: (seconds) => seconds + ' 秒后启动…',
    loading: '正在加载…',
    switchHint: '点击下拉菜单可切换版本',
    selectHint: '请选择一个版本以开始使用',
    classicSuffix: '（经典版）',
  },
};

function detectLauncherLanguage() {
  const candidates = navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];

  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase().replace(/_/g, '-');
    if (
      normalized === 'zh' ||
      normalized === 'zh-hans' ||
      normalized.startsWith('zh-hans-') ||
      normalized === 'zh-cn' ||
      normalized.startsWith('zh-cn-') ||
      normalized === 'zh-sg' ||
      normalized.startsWith('zh-sg-')
    ) {
      return 'zh-CN';
    }
  }

  return 'en';
}

const launcherLanguage = detectLauncherLanguage();
const copy = LAUNCHER_COPY[launcherLanguage];

// DOM elements
const logo = document.getElementById('logo');
const versionSelect = document.getElementById('version-select');
const launchBtn = document.getElementById('launch-btn');
const launchText = document.getElementById('launch-text');
const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const countdownText = document.getElementById('countdown-text');
const hintText = document.getElementById('hint-text');


function applyLauncherLanguage() {
  document.documentElement.lang = launcherLanguage;
  document.title = copy.title;

  const subtitle = document.querySelector('.subtitle');
  const selectorLabel = document.querySelector('.selector-label');
  const promptOption = versionSelect.querySelector('option[value=""]');
  const classicOption = versionSelect.querySelector('option[value="classic"]');

  if (subtitle) subtitle.textContent = copy.subtitle;
  if (selectorLabel) selectorLabel.textContent = copy.selectVersion;
  if (promptOption) promptOption.textContent = copy.versionPrompt;
  if (classicOption) {
    classicOption.textContent = classicOption.textContent.replace(
      /\s*\(Classic\)$/,
      copy.classicSuffix,
    );
  }
  launchText.textContent = copy.launch;
}

// State
let countdown = COUNTDOWN_SECONDS;
let countdownInterval = null;
let countdownPaused = false;
let isFirstTime = true;
let selectedVersion = '';

/**
 * Set the logo src using chrome.runtime.getURL if available
 */
function initLogo() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    logo.src = chrome.runtime.getURL('discrub.png');
  } else {
    logo.src = 'discrub.png';
  }
}

/**
 * Update the progress bar to reflect remaining time
 */
function updateProgressBar(remaining) {
  const progress = ((COUNTDOWN_SECONDS - remaining) / COUNTDOWN_SECONDS) * 100;
  progressFill.style.width = progress + '%';
}

/**
 * Start the countdown timer
 */
function startCountdown() {
  if (isFirstTime || !selectedVersion) return;

  countdown = COUNTDOWN_SECONDS;
  countdownPaused = false;
  progressBar.classList.add('active');
  updateProgressBar(countdown);
  countdownText.textContent = copy.launchingIn(countdown);

  clearInterval(countdownInterval);
  countdownInterval = setInterval(function () {
    if (countdownPaused) return;

    countdown -= 0.1;
    updateProgressBar(countdown);

    if (countdown <= 0) {
      clearInterval(countdownInterval);
      countdownText.textContent = copy.launching;
      launch();
    } else {
      countdownText.textContent = copy.launchingIn(Math.ceil(countdown));
    }
  }, 100);
}

/**
 * Pause the countdown
 */
function pauseCountdown() {
  countdownPaused = true;
  countdownText.textContent = '';
  progressBar.classList.remove('active');
}

/**
 * Launch the selected version
 */
function launch() {
  clearInterval(countdownInterval);
  countdownText.textContent = '';
  progressBar.classList.remove('active');
  launchBtn.disabled = true;
  launchText.textContent = copy.loading;

  // Save preference
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ [PREF_KEY]: selectedVersion });
  }

  // Notify content script
  window.parent.postMessage({
    type: 'discrub:launch',
    version: selectedVersion,
  }, '*');
}

/**
 * Check auth status via content script
 */
function checkAuth() {
  window.parent.postMessage({ type: 'discrub:checkAuth' }, '*');
}

/**
 * Load saved preference
 */
function loadPreference(callback) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(PREF_KEY, function (result) {
      callback(result[PREF_KEY] || null);
    });
  } else {
    callback(null);
  }
}

/**
 * Handle version selection change
 */
function onVersionChange() {
  selectedVersion = versionSelect.value;
  launchBtn.disabled = !selectedVersion;

  if (selectedVersion) {
    launchText.textContent = copy.launch;
    hintText.textContent = '';

    // Restart countdown if returning user changed selection
    if (!isFirstTime) {
      startCountdown();
    }
  }
}

/**
 * Listen for auth status response from content script
 */
window.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'discrub:authStatus') {
    if (!event.data.authenticated) {
      // Need to authenticate first — tell content script to load Discrub for auth
      window.parent.postMessage({ type: 'discrub:requestAuth' }, '*');
    }
  }
});

/**
 * Initialize launcher
 */
function init() {
  applyLauncherLanguage();
  initLogo();

  loadPreference(function (savedVersion) {
    if (savedVersion) {
      isFirstTime = false;
      selectedVersion = savedVersion;
      versionSelect.value = savedVersion;
      launchBtn.disabled = false;
      hintText.textContent = copy.switchHint;
      startCountdown();
    } else {
      isFirstTime = true;
      hintText.textContent = copy.selectHint;
      launchBtn.disabled = true;
    }
  });

  // Event listeners
  versionSelect.addEventListener('change', onVersionChange);

  // Pause countdown when dropdown is interacted with
  versionSelect.addEventListener('mousedown', pauseCountdown);
  versionSelect.addEventListener('focus', pauseCountdown);

  launchBtn.addEventListener('click', function () {
    if (selectedVersion) {
      launch();
    }
  });

  // Check auth status
  checkAuth();
}

// Boot
init();
