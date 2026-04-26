/* ===========================================================
   Tenant Application — Step navigation, validation,
   save-and-resume, signature handling.
   No framework. Vanilla JS.
   =========================================================== */
(function(){
  'use strict';
  var form = document.getElementById('applicationForm');
  if(!form) return;

  var STORAGE_KEY = 'ora_lease_app_draft_v1';
  var TOTAL_STEPS = 4;
  var currentStep = 1;

  var steps        = form.querySelectorAll('.app-step');
  var btnNext      = document.getElementById('btnNext');
  var btnBack      = document.getElementById('btnBack');
  var btnSubmit    = document.getElementById('btnSubmit');
  var btnSaveDraft = document.getElementById('btnSaveDraft');
  var stepLabel    = document.getElementById('stepLabel');
  var progressFill = document.getElementById('progressFill');
  var draftStatus  = document.getElementById('draftStatus');

  /* ---------- Init: dates, hidden context ---------- */
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function todayPretty(){
    var d = new Date();
    return d.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  }
  var sigDate = document.getElementById('signature-date');
  if(sigDate) sigDate.value = todayPretty();
  var sigIp = document.getElementById('signature-ip');
  if(sigIp) sigIp.value = 'Timestamp: ' + new Date().toISOString();
  // submission-timestamp is set in the submit handler (see below) so it captures actual submit time
  var ref = document.getElementById('referrer-url');
  if(ref) ref.value = document.referrer || '(direct)';

  /* ---------- Property dropdown — populate from listings.js if available ---------- */
  (function populateListings(){
    var select = document.querySelector('.js-listing-select');
    if(!select) return;
    var listings = (window.ORA_LISTINGS || window.listings || []);
    if(!Array.isArray(listings) || listings.length === 0) return;
    var frag = document.createDocumentFragment();
    listings.forEach(function(l){
      var label = l.address || l.name || l.title;
      if(!label) return;
      if(l.suite) label += ' — Suite ' + l.suite;
      var opt = document.createElement('option');
      opt.value = label; opt.textContent = label;
      frag.appendChild(opt);
    });
    // Insert before the "Other" option
    var otherOpt = select.querySelector('option[value="Not sure / Other"]');
    if(otherOpt) select.insertBefore(frag, otherOpt);
    else select.appendChild(frag);
  })();

  // Show "specify" field when "Other" is selected
  var buildingSel = document.getElementById('building-unit');
  var otherGroup  = document.getElementById('buildingUnitOtherGroup');
  if(buildingSel && otherGroup){
    buildingSel.addEventListener('change', function(){
      var show = this.value === 'Not sure / Other';
      otherGroup.style.display = show ? '' : 'none';
      var specInput = document.getElementById('building-unit-other');
      if(specInput) specInput.required = show;
    });
  }

  // Show broker info fields when "Yes" is selected
  var brokerRadios = form.querySelectorAll('input[name="working-with-broker"]');
  var brokerGroup  = document.getElementById('brokerInfoGroup');
  brokerRadios.forEach(function(r){
    r.addEventListener('change', function(){
      var show = (form.querySelector('input[name="working-with-broker"]:checked') || {}).value === 'Yes';
      if(brokerGroup) brokerGroup.style.display = show ? '' : 'none';
    });
  });

  // Show personal-email field when "Use a different email" is checked
  var diffEmailCb = document.getElementById('use-different-email');
  var personalEmailGroup = document.getElementById('personalEmailGroup');
  if(diffEmailCb && personalEmailGroup){
    diffEmailCb.addEventListener('change', function(){
      personalEmailGroup.style.display = this.checked ? '' : 'none';
    });
  }

  /* ---------- File-size preflight (Netlify Forms hard cap = 8 MB / file) ---------- */
  var MAX_FILE_BYTES = 8 * 1024 * 1024;
  function fmtMB(bytes){ return (bytes / 1048576).toFixed(1) + ' MB'; }
  form.querySelectorAll('input[type="file"]').forEach(function(input){
    var hint = input.parentElement.querySelector('.file-upload-hint');
    var origHint = hint ? hint.textContent : '';
    input.addEventListener('change', function(){
      if(!this.files || !this.files.length){
        if(hint){ hint.textContent = origHint; hint.style.color = ''; }
        input.classList.remove('invalid');
        return;
      }
      var f = this.files[0];
      if(f.size > MAX_FILE_BYTES){
        if(hint){
          hint.textContent = '✗ ' + f.name + ' is ' + fmtMB(f.size) + ' — too large. Please compress or re-scan (8 MB max).';
          hint.style.color = '#B0432F';
        }
        input.classList.add('invalid');
        input.setCustomValidity('File exceeds 8 MB limit. Please choose a smaller file.');
      } else {
        if(hint){
          hint.textContent = '✓ ' + f.name + ' (' + fmtMB(f.size) + ')';
          hint.style.color = '#3A7D44';
        }
        input.classList.remove('invalid');
        input.setCustomValidity('');
      }
    });
  });

  /* ---------- Phone input mask (cell + landlord refs) ---------- */
  function applyPhoneMask(el){
    el.addEventListener('input', function(e){
      var d = e.target.value.replace(/\D/g,'').slice(0,10);
      if(d.length > 6) e.target.value = '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
      else if(d.length > 3) e.target.value = '(' + d.slice(0,3) + ') ' + d.slice(3);
      else if(d.length > 0) e.target.value = '(' + d;
      else e.target.value = '';
    });
  }
  var phone = document.getElementById('cell-phone');
  if(phone) applyPhoneMask(phone);
  document.querySelectorAll('input[data-mask="phone"]').forEach(applyPhoneMask);

  /* ---------- Step navigation ---------- */
  function showStep(n){
    currentStep = Math.max(1, Math.min(TOTAL_STEPS, n));
    steps.forEach(function(s){
      s.style.display = (parseInt(s.dataset.step,10) === currentStep) ? '' : 'none';
    });
    btnBack.style.display    = currentStep > 1 ? '' : 'none';
    btnNext.style.display    = currentStep < TOTAL_STEPS ? '' : 'none';
    btnSubmit.style.display  = currentStep === TOTAL_STEPS ? '' : 'none';
    stepLabel.textContent    = 'Step ' + currentStep + ' of ' + TOTAL_STEPS;
    progressFill.style.width = (currentStep / TOTAL_STEPS * 100) + '%';
    // Scroll to top of form
    var section = document.querySelector('.app-form-section');
    if(section) window.scrollTo({top: section.offsetTop - 80, behavior:'smooth'});
  }

  function validateStep(n){
    var stepEl = form.querySelector('.app-step[data-step="' + n + '"]');
    if(!stepEl) return true;
    var fields = stepEl.querySelectorAll('input, select, textarea');
    var ok = true; var firstBad = null;
    fields.forEach(function(f){
      f.classList.remove('invalid');
      if(f.type === 'hidden') return;
      if(f.offsetParent === null) return; // skip hidden fields
      if(!f.checkValidity()){
        f.classList.add('invalid');
        if(!firstBad) firstBad = f;
        ok = false;
      }
    });
    if(!ok && firstBad){
      firstBad.focus();
      firstBad.scrollIntoView({behavior:'smooth', block:'center'});
    }
    return ok;
  }

  btnNext.addEventListener('click', function(){
    if(!validateStep(currentStep)) return;
    saveDraft(true);
    showStep(currentStep + 1);
  });
  btnBack.addEventListener('click', function(){
    showStep(currentStep - 1);
  });

  /* ---------- Save & resume (localStorage) ---------- */
  function getDraftPayload(){
    var data = {};
    var fields = form.querySelectorAll('input, select, textarea');
    fields.forEach(function(f){
      if(f.type === 'file' || f.type === 'password') return;
      if(f.name === 'bot-field') return;
      if(f.type === 'checkbox' || f.type === 'radio'){
        if(f.checked) data[f.name] = f.value;
      } else if(f.name) {
        data[f.name] = f.value;
      }
    });
    data.__step = currentStep;
    data.__savedAt = new Date().toISOString();
    return data;
  }

  function saveDraft(silent){
    try{
      var payload = getDraftPayload();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      if(!silent && draftStatus){
        draftStatus.textContent = 'Draft saved at ' + new Date().toLocaleTimeString();
        setTimeout(function(){ if(draftStatus) draftStatus.textContent = ''; }, 4000);
      }
    } catch(e){ /* localStorage unavailable */ }
  }

  function restoreDraft(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return;
      var data = JSON.parse(raw);
      if(!data || typeof data !== 'object') return;
      var ageHours = (Date.now() - new Date(data.__savedAt).getTime()) / 3600000;
      if(ageHours > 168) { localStorage.removeItem(STORAGE_KEY); return; } // 7 days
      var ok = window.confirm('We found a saved draft from ' + new Date(data.__savedAt).toLocaleString() + '. Restore it?');
      if(!ok){ localStorage.removeItem(STORAGE_KEY); return; }
      Object.keys(data).forEach(function(k){
        if(k.indexOf('__') === 0) return;
        var el = form.querySelector('[name="' + CSS.escape(k) + '"]');
        if(!el) return;
        if(el.type === 'checkbox') el.checked = !!data[k];
        else if(el.type === 'radio'){
          var radios = form.querySelectorAll('[name="' + CSS.escape(k) + '"]');
          radios.forEach(function(r){ if(r.value === data[k]) r.checked = true; });
        } else el.value = data[k];
      });
      // Re-trigger conditional fields
      if(buildingSel) buildingSel.dispatchEvent(new Event('change'));
      var brokerChecked = form.querySelector('input[name="working-with-broker"]:checked');
      if(brokerChecked) brokerChecked.dispatchEvent(new Event('change'));
      if(diffEmailCb && diffEmailCb.checked) diffEmailCb.dispatchEvent(new Event('change'));
      if(data.__step) showStep(data.__step);
      // Notify about non-restorable file inputs
      var hasFiles = form.querySelector('input[type="file"]');
      var noticeMsg = 'Draft restored. Note: uploaded documents weren\'t saved with your draft — please re-attach them in Step 4 before submitting.';
      if(draftStatus) draftStatus.textContent = noticeMsg;
      if(hasFiles) window.alert(noticeMsg);
    } catch(e){ /* ignore */ }
  }

  // Auto-save on blur
  form.addEventListener('blur', function(){ saveDraft(true); }, true);
  // Save button
  if(btnSaveDraft){
    btnSaveDraft.addEventListener('click', function(){ saveDraft(false); });
  }

  // Submit handler — final validation + capture actual submit time + clear draft
  form.addEventListener('submit', function(e){
    if(!validateStep(TOTAL_STEPS)){ e.preventDefault(); return; }
    var sig = document.getElementById('typed-signature');
    var name = document.getElementById('full-legal-name');
    if(sig && name && sig.value.trim() && name.value.trim()){
      if(sig.value.trim().toLowerCase() !== name.value.trim().toLowerCase()){
        var ok = window.confirm('Your typed signature does not match the legal name you entered. Submit anyway?');
        if(!ok){ e.preventDefault(); sig.focus(); return; }
      }
    }
    // Capture actual submit time (not page-load time)
    var ts = document.getElementById('submission-timestamp');
    if(ts) ts.value = new Date().toISOString();
    try{ localStorage.removeItem(STORAGE_KEY); } catch(e){}
  });

  /* ---------- Init ---------- */
  showStep(1);
  restoreDraft();
})();
