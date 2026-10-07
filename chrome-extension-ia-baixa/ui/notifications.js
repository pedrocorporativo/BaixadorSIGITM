(function (root) {
  "use strict";
  const NOTICE_STORAGE_KEY = "baixaPersistentNotice";
  const NOTICE_STORAGE_PREFIX = "baixaPersistentNotice:";
  let shownSinceLoad = false;

  function pageNoticeKey() {
    return `${NOTICE_STORAGE_PREFIX}${location.origin}${location.pathname}?${new URLSearchParams(location.search).get("idConsulta") || ""}`;
  }

  function saveNotice(value) {
    try { sessionStorage.setItem(NOTICE_STORAGE_KEY, JSON.stringify(value)); }
    catch { /* armazenamento da sessão pode estar indisponível */ }
    try { chrome.storage.local.set({ [pageNoticeKey()]: value }); }
    catch { /* execução fora da extensão ou armazenamento indisponível */ }
  }

  function clearNotice() {
    try { sessionStorage.removeItem(NOTICE_STORAGE_KEY); }
    catch { /* armazenamento da sessão pode estar indisponível */ }
    try { chrome.storage.local.remove(pageNoticeKey()); }
    catch { /* execução fora da extensão ou armazenamento indisponível */ }
  }

  function show(message, type = "info", expiresAt = Date.now() + 5000) {
    shownSinceLoad = true;
    const hostId = "sigitm-baixa-notice";
    let host = document.getElementById(hostId);
    if (!host) {
      host = document.createElement("div");
      host.id = hostId;
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        :host{all:initial;position:fixed;right:18px;top:18px;z-index:2147483647;font-family:system-ui,sans-serif;color-scheme:dark}
        .box{width:min(520px,calc(100vw - 36px));max-height:88vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:10px;padding:14px;border:1px solid #574b17;border-left:4px solid #ffd52a;border-radius:12px;background:#171819;color:#f7f7f2;box-shadow:0 8px 26px #0007;font-size:14px}
        .box[data-expanded=true]{width:min(760px,calc(100vw - 36px));max-height:94vh}
        .box[data-type=error]{border-color:#793b36;border-left-color:#ff625c}.box[data-type=success]{border-color:#4d622d;border-left-color:#71d68d}
        .heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.title{display:flex;align-items:center;gap:7px;font-weight:800;color:#ffd52a}.brand-icon{width:22px;height:22px;border-radius:50%}.box[data-type=error] .title{color:#ff8b84}
        .message{max-height:70vh;overflow:auto;margin:0;padding:10px;border-radius:8px;background:#101112;color:#fff;font:14px/1.55 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
        .box[data-expanded=true] .message{max-height:82vh}
        button{border:1px solid #4a4b4d;border-radius:7px;padding:6px 9px;background:#242628;color:#fff;font:12px system-ui,sans-serif;cursor:pointer}button:hover{border-color:#ffd52a}
      </style>
      <section class="box" data-expanded="false" role="status" aria-live="polite">
        <div class="heading"><div class="title"><img class="brand-icon" alt="" /> Baixador Automático v2</div></div>
        <pre class="message"></pre>
        <div class="actions"><button class="expand" type="button">Ampliar mensagem</button><button class="copy" type="button">Copiar erro</button></div>
      </section>`;
      const brandIcon = shadow.querySelector(".brand-icon");
      if (brandIcon && typeof chrome !== "undefined" && chrome.runtime?.getURL) brandIcon.src = chrome.runtime.getURL("assets/sigitm-v2.svg");
      const box = shadow.querySelector(".box");
      shadow.querySelector(".expand").addEventListener("click", event => {
        box.dataset.expanded = box.dataset.expanded !== "true";
        event.currentTarget.textContent = box.dataset.expanded === "true" ? "Reduzir mensagem" : "Ampliar mensagem";
      });
      shadow.querySelector(".copy").addEventListener("click", async event => {
        try {
          await navigator.clipboard.writeText(shadow.querySelector(".message").textContent || "");
          event.currentTarget.textContent = "Copiado";
        } catch {
          event.currentTarget.textContent = "Selecione o texto para copiar";
          shadow.querySelector(".message").focus();
        }
      });
      document.documentElement.appendChild(host);
    }
    const box = host.shadowRoot?.querySelector(".box");
    if (box) {
      box.dataset.type = type;
      box.setAttribute("role", type === "error" ? "alert" : "status");
      box.dataset.expanded = "false";
      const expandButton = host.shadowRoot.querySelector(".expand");
      if (expandButton) expandButton.textContent = "Ampliar mensagem";
      const copyButton = host.shadowRoot.querySelector(".copy");
      if (copyButton) copyButton.textContent = type === "error" ? "Copiar erro" : "Copiar mensagem";
      box.querySelector(".message").textContent = String(message || "");
      if (host._noticeTimer) clearTimeout(host._noticeTimer);
      const notice = { message: String(message || ""), type, expiresAt };
      saveNotice(notice);
      const remaining = Math.max(0, expiresAt - Date.now());
      host._noticeTimer = setTimeout(() => {
        clearNotice();
        host.remove();
      }, remaining);
    }
  }

  function restore() {
    if (document.getElementById("sigitm-baixa-notice")) return;
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.get(pageNoticeKey(), stored => {
          if (shownSinceLoad || document.getElementById("sigitm-baixa-notice")) return;
          const saved = stored?.[pageNoticeKey()];
          if (saved && typeof saved.message === "string" && Number(saved.expiresAt) > Date.now()) {
            show(saved.message, saved.type || "info", Number(saved.expiresAt));
          }
        });
      }
    } catch { /* usa sessionStorage como alternativa */ }
    if (shownSinceLoad || document.getElementById("sigitm-baixa-notice")) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(NOTICE_STORAGE_KEY) || "null");
      if (saved && typeof saved.message === "string" && Number(saved.expiresAt) > Date.now()) {
        show(saved.message, saved.type || "info", Number(saved.expiresAt));
      }
    } catch { /* conteúdo antigo/inválido ou armazenamento indisponível */ }
  }

  function celebrate(message = "Todos os BDs foram concluídos.") {
    const existing = document.getElementById("sigitm-baixa-confetti");
    existing?.remove();
    const host = document.createElement("div");
    host.id = "sigitm-baixa-confetti";
    const shadow = host.attachShadow({ mode: "open" });
    const pieces = Array.from({ length: 72 }, (_, index) => `<i style="--x:${(index * 37) % 100};--d:${900 + (index % 9) * 110}ms;--r:${(index * 53) % 360}deg"></i>`).join("");
    shadow.innerHTML = `<style>
      :host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:system-ui,sans-serif}
      .message{position:absolute;top:16%;left:50%;transform:translateX(-50%);padding:12px 18px;border-radius:12px;background:#12653c;color:#fff;font-weight:800;box-shadow:0 8px 26px #0005}
      i{position:absolute;top:-18px;left:calc(var(--x) * 1%);width:9px;height:15px;background:hsl(calc(var(--x) * 3.6),85%,55%);transform:rotate(var(--r));animation:fall var(--d) cubic-bezier(.15,.65,.4,1) forwards}
      @keyframes fall{to{top:105%;transform:translateX(calc((var(--x) - 50) * 3px)) rotate(calc(var(--r) + 720deg));opacity:0}}
      @media (prefers-reduced-motion:reduce){i{display:none}}
    </style><div class="message" role="status" aria-live="polite">🎉 ${String(message)}</div>${pieces}`;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 2600);
  }

  const api = { show, restore, celebrate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaNotifications = api;
  restore();
})(typeof globalThis !== "undefined" ? globalThis : this);
