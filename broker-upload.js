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
    var json = await res.json();
    if (!res.ok || !json.uploadUrl) throw new Error(json.error || 'session_failed');
    return json;
  }

  async function uploadInChunks(uploadUrl, file, onProgress) {
    var total = file.size;
    var start = 0;
    while (start < total) {
      var end = Math.min(start + CHUNK_BYTES, total);
      var chunk = file.slice(start, end);
      var res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(end - start), 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + total },
        body: chunk,
      });
      if (!(res.status === 202 || res.status === 200 || res.status === 201)) {
        throw new Error('chunk_upload_failed:' + res.status);
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
    var json = await res.json();
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
      recaptchaToken: (window.grecaptcha && window.grecaptcha.getResponse) ? window.grecaptcha.getResponse() : '',
    };
    var fileInput = formEl.querySelector('input[type="file"]');
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) throw new Error('no_file_selected');

    var session = await requestSession(fields, file);
    await uploadInChunks(session.uploadUrl, file);
    return finalize(session.intakeToken, fields);
  }

  async function pollForScore(submissionId, onReady, onUnavailable) {
    var MAX_WAIT_MS = 2 * 60 * 1000;
    var POLL_INTERVAL_MS = 3000;
    var start = Date.now();
    function poll() {
      if (Date.now() - start > MAX_WAIT_MS) { onUnavailable(); return; }
      fetch('/api/broker-score-status?submissionId=' + encodeURIComponent(submissionId))
        .then(function (res) { return res.json(); })
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
