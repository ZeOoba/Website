/**
 * Ask ORA — chat widget client
 * Vanilla JS. Mounts into #ora-chat (auto-inserted if missing).
 * Streams from /api/chat as SSE; submits leads to /api/chat-lead.
 */

(function () {
  'use strict';

  if (window.__oraChatLoaded) return;
  window.__oraChatLoaded = true;

  // ---- State ----
  var SESSION_KEY = 'ora_chat_session_v1';
  var sessionId =
    sessionStorage.getItem(SESSION_KEY) ||
    (Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
  sessionStorage.setItem(SESSION_KEY, sessionId);

  var HISTORY_KEY = 'ora_chat_history_v1';
  /** @type {{role:'user'|'assistant',content:string}[]} */
  var history = [];
  try {
    var raw = sessionStorage.getItem(HISTORY_KEY);
    if (raw) history = JSON.parse(raw);
  } catch (e) { history = []; }

  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-20))); } catch (e) {}
  }

  // ---- Lead-capture trigger phrases ----
  var TRIGGER_PHRASES = [
    'reach out', 'contact gabriel', 'contact us', 'speak with someone',
    'schedule a call', 'email us', 'get in touch', 'ggoldberg@oxfordra.net',
  ];
  var USER_INTENT_PHRASES = [
    "i'd like to speak with", 'can you connect me', 'introduce me',
    'i have a deal', 'i have space requirements', 'i want to lease',
    'i represent', "i'm a broker", 'capital partner',
  ];

  // ---- Markdown (small, sanitizing) ----
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function renderMarkdown(text) {
    var safe = escapeHtml(text);
    // links: [label](url) — only http(s) and mailto
    safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    // bare oxfordra.net URLs and emails
    safe = safe.replace(/(?<![">/])(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
    safe = safe.replace(/\b(oxfordra\.net\/[^\s<]+)/g, function (u) {
      return '<a href="https://' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
    safe = safe.replace(/\b([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g, function (e) {
      return '<a href="mailto:' + e + '">' + e + '</a>';
    });
    // bold + italic
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/(^|\W)\*([^*\n]+)\*(\W|$)/g, '$1<em>$2</em>$3');
    // unordered lists
    safe = safe.replace(/(?:^|\n)((?:[ \t]*[-*][ \t]+[^\n]+\n?)+)/g, function (_, block) {
      var items = block.trim().split(/\n/).map(function (l) {
        return '<li>' + l.replace(/^[ \t]*[-*][ \t]+/, '') + '</li>';
      }).join('');
      return '\n<ul>' + items + '</ul>\n';
    });
    // paragraphs
    var paras = safe.split(/\n{2,}/).map(function (p) {
      if (/^<(ul|ol)>/.test(p.trim())) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return paras;
  }

  // ---- DOM scaffold ----
  function createTrigger() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ora-chat-trigger';
    btn.id = 'ora-chat-trigger';
    btn.setAttribute('aria-label', 'Open Ask ORA chat assistant');
    btn.innerHTML =
      '<span class="ora-chat-trigger__icon" aria-hidden="true">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none">' +
          '<path d="M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 0 1-3.51-.64L3 21l1.7-4.84A7.5 7.5 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
        '</svg>' +
      '</span>' +
      '<span>Ask ORA</span>';
    document.body.appendChild(btn);
    return btn;
  }

  function createPanel() {
    var p = document.createElement('div');
    p.id = 'ora-chat-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', 'true');
    p.setAttribute('aria-labelledby', 'ora-chat-title');
    p.innerHTML = [
      '<div class="ora-chat-header">',
        '<div>',
          '<h2 class="ora-chat-header__title" id="ora-chat-title">Ask ORA</h2>',
          '<p class="ora-chat-header__sub">Trained on our public materials. For confidential matters, <a href="mailto:ggoldberg@oxfordra.net">contact us</a>.</p>',
        '</div>',
        '<div class="ora-chat-header__actions">',
          '<button type="button" class="ora-chat-header__btn" id="ora-chat-clear" aria-label="Clear conversation">Clear</button>',
          '<button type="button" class="ora-chat-header__btn ora-chat-header__close" id="ora-chat-close" aria-label="Close chat">',
            '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
          '</button>',
        '</div>',
      '</div>',
      '<div class="ora-chat-messages" id="ora-chat-messages" role="log" aria-live="polite" aria-relevant="additions"></div>',
      '<div class="ora-chat-composer">',
        '<div class="ora-chat-composer__row">',
          '<textarea id="ora-chat-input" rows="1" placeholder="Ask about target markets, available space, how to engage…" aria-label="Type your message"></textarea>',
          '<button type="button" class="ora-chat-composer__send" id="ora-chat-send" aria-label="Send message">',
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 21l18-9L3 3v7l13 2-13 2v7z" fill="currentColor"/></svg>',
          '</button>',
        '</div>',
        '<p class="ora-chat-composer__hint">This is an automated assistant. For authoritative answers, contact us directly.</p>',
      '</div>',
    ].join('');
    document.body.appendChild(p);
    return p;
  }

  // ---- Render helpers ----
  function appendUserMessage(text) {
    var el = document.createElement('div');
    el.className = 'ora-chat-msg ora-chat-msg--user';
    el.textContent = text;
    messagesEl.appendChild(el);
    autoscroll();
  }

  function appendAssistantPlaceholder() {
    var el = document.createElement('div');
    el.className = 'ora-chat-msg ora-chat-msg--assistant';
    el.innerHTML = '<div class="ora-chat-typing"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(el);
    autoscroll();
    return el;
  }

  function finalizeAssistantMessage(el, text) {
    el.innerHTML = renderMarkdown(text);
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ora-chat-msg__copy';
    copy.setAttribute('aria-label', 'Copy message');
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () {
        copy.textContent = 'Copied';
        copy.dataset.copied = 'true';
        setTimeout(function () { copy.textContent = 'Copy'; copy.dataset.copied = 'false'; }, 1500);
      });
    });
    el.appendChild(copy);
  }

  function autoscroll() {
    var threshold = 80;
    var nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- Lead capture ----
  function shouldOfferLead(userText, assistantText) {
    var u = (userText || '').toLowerCase();
    var a = (assistantText || '').toLowerCase();
    for (var i = 0; i < USER_INTENT_PHRASES.length; i++) if (u.indexOf(USER_INTENT_PHRASES[i]) !== -1) return true;
    for (var j = 0; j < TRIGGER_PHRASES.length; j++) if (a.indexOf(TRIGGER_PHRASES[j]) !== -1) return true;
    return false;
  }

  function appendLeadForm() {
    if (messagesEl.querySelector('.ora-chat-lead')) return;
    var card = document.createElement('div');
    card.className = 'ora-chat-lead';
    card.innerHTML = [
      '<h3 class="ora-chat-lead__heading">Have us reach out</h3>',
      '<label class="ora-chat-lead__field"><label>Name</label><input type="text" name="name" required></label>',
      '<label class="ora-chat-lead__field"><label>Email</label><input type="email" name="email" required></label>',
      '<label class="ora-chat-lead__field"><label>Phone (optional)</label><input type="tel" name="phone"></label>',
      '<label class="ora-chat-lead__field"><label>You are</label>',
        '<select name="role" required>',
          '<option value="">Select…</option>',
          '<option value="Broker">Broker</option>',
          '<option value="Prospective Tenant">Prospective Tenant</option>',
          '<option value="Capital Partner">Capital Partner</option>',
          '<option value="Vendor">Vendor</option>',
          '<option value="Other">Other</option>',
        '</select>',
      '</label>',
      '<label class="ora-chat-lead__field"><label>Message</label><textarea name="message" required minlength="10" maxlength="2000"></textarea></label>',
      '<input class="ora-chat-lead__honeypot" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">',
      '<div class="ora-chat-lead__error" role="alert" hidden></div>',
      '<div class="ora-chat-lead__actions">',
        '<button type="button" class="ora-chat-lead__btn ora-chat-lead__btn--primary" data-action="submit">Send</button>',
        '<button type="button" class="ora-chat-lead__btn ora-chat-lead__btn--secondary" data-action="dismiss">Not now</button>',
      '</div>',
    ].join('');
    messagesEl.appendChild(card);
    autoscroll();

    var errBox = card.querySelector('.ora-chat-lead__error');
    function showErr(msg) { errBox.hidden = false; errBox.textContent = msg; }
    function hideErr() { errBox.hidden = true; errBox.textContent = ''; }

    card.querySelector('[data-action="dismiss"]').addEventListener('click', function () {
      card.remove();
    });
    card.querySelector('[data-action="submit"]').addEventListener('click', function () {
      hideErr();
      var name = card.querySelector('[name="name"]').value.trim();
      var email = card.querySelector('[name="email"]').value.trim();
      var phone = card.querySelector('[name="phone"]').value.trim();
      var role = card.querySelector('[name="role"]').value.trim();
      var message = card.querySelector('[name="message"]').value.trim();
      var website = card.querySelector('[name="website"]').value.trim();
      if (!name) return showErr('Please enter your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showErr('Please enter a valid email.');
      if (!role) return showErr('Please select your role.');
      if (message.length < 10) return showErr('Please add a bit more detail (10+ characters).');

      var btn = card.querySelector('[data-action="submit"]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      fetch('/.netlify/functions/chat-lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name, email: email, phone: phone, role: role, message: message,
          website: website, sessionId: sessionId,
          transcript: history.slice(-10),
        }),
      })
        .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
        .then(function (j) {
          if (j && j.ok) {
            card.innerHTML = '<div class="ora-chat-lead__success">Thanks. We will be in touch within one business day.</div>';
          } else {
            btn.disabled = false; btn.textContent = 'Send';
            showErr('Could not submit. Please email ggoldberg@oxfordra.net directly.');
          }
        })
        .catch(function () {
          btn.disabled = false; btn.textContent = 'Send';
          showErr('Could not submit. Please email ggoldberg@oxfordra.net directly.');
        });
    });
  }

  // ---- SSE streaming ----
  function streamChat(userText) {
    history.push({ role: 'user', content: userText });
    saveHistory();
    appendUserMessage(userText);
    var assistantEl = appendAssistantPlaceholder();
    var assistantText = '';
    var firstToken = false;

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-20), sessionId: sessionId }),
    }).then(function (r) {
      if (!r.ok || !r.body) {
        finalizeAssistantMessage(assistantEl, "Something went wrong reaching the assistant. Please email ggoldberg@oxfordra.net.");
        return;
      }
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            finishStream();
            return;
          }
          buf += decoder.decode(res.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          lines.forEach(function (line) {
            if (!line.startsWith('data:')) return;
            var payload = line.slice(5).trim();
            if (!payload) return;
            try {
              var evt = JSON.parse(payload);
              if (evt.type === 'text') {
                if (!firstToken) {
                  firstToken = true;
                  assistantEl.innerHTML = '';
                }
                assistantText += evt.text;
                assistantEl.innerHTML = renderMarkdown(assistantText);
                autoscroll();
              } else if (evt.type === 'error') {
                assistantText = "I had trouble responding. Please email ggoldberg@oxfordra.net.";
                finalizeAssistantMessage(assistantEl, assistantText);
              }
            } catch (e) {}
          });
          return pump();
        });
      }
      function finishStream() {
        if (!assistantText) assistantText = "I did not receive a reply. Please try again or email ggoldberg@oxfordra.net.";
        finalizeAssistantMessage(assistantEl, assistantText);
        history.push({ role: 'assistant', content: assistantText });
        saveHistory();
        if (shouldOfferLead(userText, assistantText)) appendLeadForm();
      }
      return pump();
    }).catch(function () {
      finalizeAssistantMessage(assistantEl, "Something went wrong. Please email ggoldberg@oxfordra.net.");
    });
  }

  // ---- Init UI ----
  var trigger, panel, messagesEl, inputEl, sendBtn, closeBtn, clearBtn;
  var lastFocusedBeforeOpen = null;
  var keydownHandler = null;

  function open() {
    if (panel.dataset.open === 'true') return;
    lastFocusedBeforeOpen = document.activeElement;
    panel.dataset.open = 'true';
    trigger.hidden = true;
    setTimeout(function () { inputEl.focus(); }, 60);
    document.addEventListener('keydown', keydownHandler);
    if (history.length === 0 && messagesEl.childElementCount === 0) {
      var welcome = document.createElement('div');
      welcome.className = 'ora-chat-msg ora-chat-msg--assistant';
      welcome.innerHTML = renderMarkdown(
        "I'm an assistant for Oxford Realty Advisors. I can answer questions about our investment philosophy, target markets, available space, and how to work with us. What can I help you with?"
      );
      messagesEl.appendChild(welcome);
    }
  }
  function close() {
    panel.dataset.open = 'false';
    setTimeout(function () { trigger.hidden = false; if (lastFocusedBeforeOpen) try { lastFocusedBeforeOpen.focus(); } catch (e) {} }, 160);
    document.removeEventListener('keydown', keydownHandler);
  }
  function clearConversation() {
    history = [];
    saveHistory();
    messagesEl.innerHTML = '';
    var w = document.createElement('div');
    w.className = 'ora-chat-msg ora-chat-msg--assistant';
    w.innerHTML = renderMarkdown("Cleared. What can I help you with next?");
    messagesEl.appendChild(w);
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || text.length > 4000) return;
    inputEl.value = '';
    inputEl.style.height = '';
    streamChat(text);
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  function init() {
    trigger = document.getElementById('ora-chat-trigger') || createTrigger();
    panel = createPanel();
    messagesEl = document.getElementById('ora-chat-messages');
    inputEl = document.getElementById('ora-chat-input');
    sendBtn = document.getElementById('ora-chat-send');
    closeBtn = document.getElementById('ora-chat-close');
    clearBtn = document.getElementById('ora-chat-clear');

    keydownHandler = function (e) {
      if (e.key === 'Escape') close();
    };

    trigger.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    clearBtn.addEventListener('click', clearConversation);
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('input', autoGrow);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // Restore prior history on open if present
    if (history.length) {
      history.forEach(function (m) {
        if (m.role === 'user') appendUserMessage(m.content);
        else {
          var el = document.createElement('div');
          el.className = 'ora-chat-msg ora-chat-msg--assistant';
          el.innerHTML = renderMarkdown(m.content);
          messagesEl.appendChild(el);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
