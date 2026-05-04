// ── Pipee i18n ──
// Bilingual support: English (en) + Traditional Chinese (zh)

const T = {
  // ── Shared / Nav ──
  'nav.console': { en: 'Console', zh: '控制台' },
  'nav.github': { en: 'GitHub', zh: 'GitHub' },
  'nav.getStarted': { en: 'Get Started', zh: '開始使用' },
  'nav.license': { en: 'MIT License', zh: 'MIT 授權' },

  // ── Index: Hero ──
  'hero.badge': { en: 'Open Source \u00B7 Self-Hosted', zh: '開源 \u00B7 自託管' },
  'hero.title1': { en: 'Host your site.', zh: '託管你的網站。' },
  'hero.title2': { en: 'Simple. Instant.', zh: '簡單。即時。' },
  'hero.sub': {
    en: 'Upload a ZIP, get a live static site. Self-hosted on your own machine.\nNo cloud bills. No vendor lock-in. Just deploy.',
    zh: '上傳一個 ZIP，即可取得靜態網站。自託管在你自己的機器上。\n不需雲端費用，不受供應商綁定，直接部署。'
  },
  'hero.cta.console': { en: 'Go to Console', zh: '前往控制台' },
  'hero.cta.star': { en: 'Star on GitHub', zh: '在 GitHub 給星' },

  // ── Index: Terminal ──
  'terminal.title': { en: 'terminal', zh: '終端機' },
  'terminal.line4': { en: '\u2713 Server running on http://localhost:3939', zh: '\u2713 伺服器運行於 http://localhost:3939' },
  'terminal.line5': { en: 'Open /console to manage your sites', zh: '開啟 /console 管理你的網站' },
  'terminal.line6': { en: '# 3 dependencies. Zero config. All yours.', zh: '# 3 個依賴。零設定。完全屬於你。' },

  // ── Index: Stats ──
  'stats.deps': { en: 'Dependencies', zh: '依賴套件' },
  'stats.cost': { en: 'Monthly Cost', zh: '每月費用' },
  'stats.yourData': { en: 'Your Data', zh: '你的資料' },
  'stats.files': { en: 'Core Files', zh: '核心檔案' },

  // ── Index: Features ──
  'features.label': { en: 'Features', zh: '功能特色' },
  'features.title': { en: 'Everything you need.', zh: '你需要的一切。' },
  'features.titleLine2': { en: 'Nothing you don\'t.', zh: '沒有多餘的。' },

  'feature.upload.title': { en: 'ZIP Upload Deploy', zh: 'ZIP 上傳部署' },
  'feature.upload.desc': { en: 'Drag and drop a ZIP file containing your static site. Deployed instantly with zero downtime.', zh: '拖放包含靜態網站的 ZIP 檔案，即時部署，零停機。' },
  'feature.auth.title': { en: 'Built-in Auth', zh: '內建認證' },
  'feature.auth.desc': { en: 'User registration and login with JWT tokens. No external auth service needed.', zh: '使用 JWT token 的用戶註冊與登入，不需外部認證服務。' },
  'feature.console.title': { en: 'Web Console', zh: '網頁控制台' },
  'feature.console.desc': { en: 'Manage all your sites from a clean browser UI. Create, deploy, and delete sites in seconds.', zh: '透過簡潔的瀏覽器介面管理所有網站。幾秒內建立、部署與刪除網站。' },
  'feature.spa.title': { en: 'SPA Support', zh: 'SPA 支援' },
  'feature.spa.desc': { en: 'Automatic SPA fallback for single-page apps. React, Vue, Svelte \u2014 just upload and it works.', zh: '自動 SPA fallback，支援單頁應用程式。React、Vue、Svelte \u2014 上傳即可使用。' },
  'feature.subdomain.title': { en: 'Subdomain Routing', zh: '子網域路由' },
  'feature.subdomain.desc': { en: 'Each site gets its own subdomain. my-blog.yourdomain.com \u2014 clean, memorable URLs.', zh: '每個網站擁有獨立子網域。my-blog.yourdomain.com \u2014 簡潔好記的網址。' },
  'feature.multi.title': { en: 'Multi-User', zh: '多用戶' },
  'feature.multi.desc': { en: 'Multiple users can register and manage their own sites independently. Configurable site limits.', zh: '多用戶可獨立註冊並管理各自的網站，可設定網站數量上限。' },

  // ── Index: How It Works ──
  'how.label': { en: 'How It Works', zh: '運作方式' },
  'how.title': { en: 'Three steps. That\'s it.', zh: '三個步驟，就這樣。' },

  'how.step1.title': { en: 'Clone and start', zh: '複製並啟動' },
  'how.step1.desc': { en: 'Clone the repo, install 3 dependencies, and start the server. Works on Windows, Mac, and Linux.', zh: '複製儲存庫，安裝 3 個依賴，啟動伺服器。支援 Windows、Mac 與 Linux。' },
  'how.step2.title': { en: 'Register and create a site', zh: '註冊並建立網站' },
  'how.step2.desc': { en: 'Open the console, register an account, and create a site with a unique slug like "my-blog".', zh: '開啟控制台，註冊帳號，用唯一的 slug（如 "my-blog"）建立網站。' },
  'how.step3.title': { en: 'Upload and go live', zh: '上傳即上線' },
  'how.step3.desc': { en: 'Upload a ZIP file with your static site. It\'s live instantly at your-slug.yourdomain.com.', zh: '上傳包含靜態網站的 ZIP 檔案，即時上線於 your-slug.yourdomain.com。' },

  // ── Index: Bottom CTA ──
  'cta.ready': { en: 'Ready to host your site?', zh: '準備好託管你的網站了嗎？' },
  'cta.sub': { en: 'Self-hosted. Open source. Zero cost. Just upload and go.', zh: '自託管、開源、零成本，上傳即上線。' },

  // ── Index: Meta ──
  'meta.title': { en: 'Pipee \u2014 Simple Static Site Hosting', zh: 'Pipee \u2014 簡單靜態網站託管' },

  // ── Console: Login ──
  'console.login.title': { en: 'Welcome to Pipee', zh: '歡迎使用 Pipee' },
  'console.login.sub': { en: 'Login to manage your static sites', zh: '登入以管理你的靜態網站' },
  'console.login.btn': { en: 'Login', zh: '登入' },
  'console.register.btn': { en: 'Register', zh: '註冊' },
  'console.login.switchToRegister': { en: 'Need an account? Register', zh: '需要帳號？註冊' },
  'console.login.switchToLogin': { en: 'Have an account? Login', zh: '已有帳號？登入' },
  'console.logout': { en: 'Logout', zh: '登出' },

  // ── Console: Dashboard ──
  'console.mySites': { en: 'My Sites', zh: '我的網站' },
  'console.empty': { en: 'No sites yet. Deploy your first site below.', zh: '尚無網站。在下方部署你的第一個網站。' },
  'console.delete': { en: 'Delete', zh: '刪除' },
  'console.delete.confirm': { en: 'Delete {slug}? This cannot be undone.', zh: '刪除 {slug}？此操作無法復原。' },

  // ── Console: Deploy Form ──
  'console.deploy.title': { en: 'Deploy New Site', zh: '部署新網站' },
  'console.slug.label': { en: 'Slug', zh: '網址名稱' },
  'console.slug.placeholder': { en: 'my-site', zh: 'my-site' },
  'console.upload.label': { en: 'Upload', zh: '上傳' },
  'console.dropzone': { en: '<strong>Drag & drop</strong> a ZIP file here<br>or click to select', zh: '<strong>拖放</strong> ZIP 檔案到此處<br>或點擊選擇' },
  'console.deploy.btn': { en: 'Deploy', zh: '部署' },
  'console.deploy.deploying': { en: 'Deploying...', zh: '部署中...' },

  // ── Console: Deploy Status ──
  'console.deploy.uploading': { en: 'Uploading and deploying...', zh: '正在上傳與部署...' },
  'console.deploy.success': { en: 'Deployed!', zh: '部署成功！' },
  'console.deploy.notLoggedIn': { en: 'Not logged in. Please refresh and login again.', zh: '未登入。請重新整理並再次登入。' },
  'console.deploy.failed': { en: 'Deploy failed', zh: '部署失敗' },
  'console.upload.invalidType': { en: 'Please upload a .zip file', zh: '請上傳 .zip 檔案' },

  // ── Console: Misc ──
  'console.loginFailed': { en: 'Login failed', zh: '登入失敗' },
  'console.registerFailed': { en: 'Registration failed', zh: '註冊失敗' },
  'console.deleteFailed': { en: 'Delete failed', zh: '刪除失敗' },

  // ── Console: Site Meta ──
  'console.updated': { en: 'Updated', zh: '更新於' },

  // ── Time ──
  'time.justNow': { en: 'just now', zh: '剛剛' },
  'time.m': { en: 'm ago', zh: '分鐘前' },
  'time.h': { en: 'h ago', zh: '小時前' },
  'time.d': { en: 'd ago', zh: '天前' },

  // ── Console: Meta ──
  'console.meta.title': { en: 'Pipee Console', zh: 'Pipee 控制台' },

  // ── Theme toggle ──
  'theme.toggle': { en: 'Toggle theme', zh: '切換主題' },
};

// ── Language detection & persistence ──
let currentLang = localStorage.getItem('pipee-lang')
  || (navigator.language.startsWith('zh') ? 'zh' : 'en');

function t(key) {
  return T[key]?.[currentLang] ?? T[key]?.en ?? key;
}

function applyLang() {
  // Static text
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.dataset.i18n);
  });
  // Placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  // Title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    el.title = t(el.dataset.i18nTitle);
  });
  // innerHTML (for elements containing HTML tags)
  document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
    el.innerHTML = t(el.dataset.i18nHtml);
  });

  // Update <html lang>
  document.documentElement.lang = currentLang === 'zh' ? 'zh-Hant' : 'en';

  // Update <title> if key exists
  var titleKey = document.querySelector('title')?.dataset?.i18n;
  if (titleKey) document.title = t(titleKey);

  // Update lang toggle button text
  document.querySelectorAll('.lang-toggle').forEach(function(btn) {
    var enSpan = btn.querySelector('.lang-en');
    var zhSpan = btn.querySelector('.lang-zh');
    if (enSpan && zhSpan) {
      enSpan.style.display = currentLang === 'en' ? 'inline' : 'none';
      zhSpan.style.display = currentLang === 'zh' ? 'inline' : 'none';
    }
  });

  // Persist
  localStorage.setItem('pipee-lang', currentLang);
}

function toggleLang() {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  applyLang();
}

// Auto-apply immediately (script is at bottom of body, DOM elements already exist)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyLang);
} else {
  applyLang();
}
