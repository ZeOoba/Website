/* ===========================================================
   Broker OM upload — two-call flow: mint a Graph upload
   session, PUT the file in chunks directly to SharePoint,
   then finalize. Keeps the large binary off Netlify entirely.
   No framework. Vanilla JS.
   =========================================================== */
(function () {
  'use strict';

  var CHUNK_BYTES = 5 * 1024 * 1024; // 5 MiB — exact multiple of Graph's 320 KiB quantum

  async function requestSession(fields, file) {
    var res = await fetch('/api/broker-upload-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: fields.name, company: fields.company, email: fields.email, phone: fields.phone,
        market: fields.market, message: fields.message, website: fields.website,
        fileName: file.name, fileSize: file.size, contentType: file.type,
        recaptchaToken: fields.recaptchaToken,
      }),
    });
    var json = await readJson(res);
    if (!res.ok || !json.uploadUrl) throw new Error(json.error || 'session_failed');
    return json;
  }

  // Netlify answers a function timeout/crash with a plain-text 502/504 body.
  // res.json() on that throws a SyntaxError whose parser message the form then
  // showed to the broker; read as text and fall back to {} so the clean
  // '<step>_failed' code wins.
  async function readJson(res) {
    var text = '';
    try { text = await res.text(); } catch (e) { return {}; }
    try { return text ? JSON.parse(text) : {}; } catch (e) { return {}; }
  }

  var MAX_CHUNK_ATTEMPTS = 3;
  var RETRY_BASE_MS = 500;

  // Only failures that can clear on their own are retried; a 401/403/404 means
  // the upload session itself is dead and another PUT cannot help.
  function isTransient(status) { return status === 408 || status === 429 || status >= 500; }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  async function uploadInChunks(uploadUrl, file, onProgress) {
    var total = file.size;
    var start = 0;
    while (start < total) {
      var end = Math.min(start + CHUNK_BYTES, total);
      var attempt = 0;
      while (true) {
        attempt++;
        var res = null;
        var networkError = false;
        try {
          res = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': String(end - start), 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + total },
            body: file.slice(start, end),
          });
        } catch (e) { networkError = true; }
        if (res && (res.status === 202 || res.status === 200 || res.status === 201)) break;
        if ((!networkError && !isTransient(res.status)) || attempt >= MAX_CHUNK_ATTEMPTS) {
          throw new Error('chunk_upload_failed:' + (networkError ? 'network' : res.status));
        }
        await sleep(RETRY_BASE_MS * Math.pow(3, attempt - 1));
      }
      start = end;
      if (onProgress) onProgress(start / total);
    }
  }

  async function finalize(intakeToken, fields) {
    var res = await fetch('/api/broker-finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intakeToken: intakeToken, name: fields.name, company: fields.company, email: fields.email, phone: fields.phone, market: fields.market, message: fields.message }),
    });
    var json = await readJson(res);
    if (!res.ok) throw new Error(json.error || 'finalize_failed');
    return json;
  }

  async function submit(formEl) {
    var fields = {
      name: formEl.querySelector('[name="name"]').value,
      company: formEl.querySelector('[name="company"]').value,
      email: formEl.querySelector('[name="email"]').value,
      phone: formEl.querySelector('[name="phone"]').value,
      market: formEl.querySelector('[name="market"]').value,
      message: formEl.querySelector('[name="message"]').value,
      website: formEl.querySelector('[name="website"]').value,
      recaptchaToken: (window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.getResponse && window.ORA_RECAPTCHA_WIDGET_ID !== null) ? window.grecaptcha.enterprise.getResponse(window.ORA_RECAPTCHA_WIDGET_ID) : '',
    };
    var fileInput = formEl.querySelector('input[type="file"]');
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) throw new Error('no_file_selected');
    // Fail fast on an unticked/expired checkbox before spending a network
    // round trip and a rate-limit slot on a request the server will 403 too.
    if (!fields.recaptchaToken) throw new Error('recaptcha_unticked');

    var session = await requestSession(fields, file);
    await uploadInChunks(session.uploadUrl, file);
    return finalize(session.intakeToken, fields);
  }

  async function pollForScore(submissionId, statusToken, onReady, onUnavailable) {
    var MAX_WAIT_MS = 2 * 60 * 1000;
    var POLL_INTERVAL_MS = 3000;
    var start = Date.now();
    function poll() {
      if (Date.now() - start > MAX_WAIT_MS) { onUnavailable(); return; }
      fetch('/api/broker-score-status?submissionId=' + encodeURIComponent(submissionId) + '&statusToken=' + encodeURIComponent(statusToken))
        .then(function (res) { return readJson(res); })
        .then(function (json) {
          if (json.status === 'ready') { onReady(json); }
          else if (json.status === 'unavailable') { onUnavailable(); }
          else { setTimeout(poll, POLL_INTERVAL_MS); }
        })
        .catch(function () { setTimeout(poll, POLL_INTERVAL_MS); });
    }
    poll();
  }

  window.ORA_BROKER_UPLOAD = { submit: submit, pollForScore: pollForScore };
})();
