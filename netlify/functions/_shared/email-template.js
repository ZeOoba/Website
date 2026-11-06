'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LABELS = {
  'applicant-email': 'Applicant Email', 'building-unit': 'Property / Unit', 'building-unit-other': 'Property (specified)',
  'required-sf': 'Required SF', 'monthly-rent': 'Monthly Rent', 'security-deposit': 'Security Deposit',
  'length-of-lease': 'Length of Lease', 'desired-start-date': 'Desired Start Date', 'intended-use': 'Intended Use',
  'working-with-broker': 'Working With a Broker', 'broker-name': 'Broker Name', 'brokerage-name': 'Brokerage',
  'broker-contact': 'Broker Contact', 'referral-source': 'Referral Source', 'full-legal-name': 'Full Legal Name',
  'personal-email': 'Personal Email', 'cell-phone': 'Cell Phone', 'home-address': 'Home Address',
  'business-name': 'Business Name', 'business-address': 'Business Address', 'business-requirements': 'Business Requirements',
  'landlord-1-name': 'Landlord 1', 'landlord-1-address': 'Landlord 1 Address', 'landlord-1-phone': 'Landlord 1 Phone',
  'landlord-2-name': 'Landlord 2', 'landlord-2-address': 'Landlord 2 Address', 'landlord-2-phone': 'Landlord 2 Phone',
  'landlord-3-name': 'Landlord 3', 'landlord-3-address': 'Landlord 3 Address', 'landlord-3-phone': 'Landlord 3 Phone',
  'typed-signature': 'Signed By', 'signature-date': 'Signature Date',
  name: 'Name', company: 'Company', email: 'Email', phone: 'Phone', market: 'Market', message: 'Message',
  'submission-score': 'Score', 'scorecard-coverage': 'Scorecard Coverage', 'gate-property-type': 'Property Type Gate', 'gate-market': 'Market Gate',
  'submission-id': 'Submission ID', 'scorecard-version': 'Scorecard Version',
  'lead-landing': 'Landing Page', 'lead-referrer': 'Referred From',
};

const DOC_LABELS = {
  'upload-credit-report': 'Credit Report', 'upload-drivers-license': "Driver's License",
  'upload-articles': 'Articles of Organization', document: 'Uploaded Document',
};

function renderRows(fields) {
  return Object.keys(fields)
    .filter((k) => fields[k] !== '' && fields[k] != null)
    .map((k) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#596B7D;white-space:nowrap;">${escapeHtml(LABELS[k] || k)}</td><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#2D2D2D;">${escapeHtml(fields[k])}</td></tr>`)
    .join('');
}

function renderLinks(links) {
  const items = Object.keys(links)
    .filter((k) => links[k])
    .map((k) => `<li style="margin-bottom:6px;"><a href="${escapeHtml(links[k])}" style="color:#C9A96E;">${escapeHtml(DOC_LABELS[k] || k)}</a></li>`)
    .join('');
  if (!items) return '';
  return `<div style="margin-top:20px;padding:16px;background:#F5F3EF;border-left:3px solid #C9A96E;"><p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#C9A96E;">Documents (stored in OneDrive)</p><ul style="margin:0;padding-left:18px;">${items}</ul></div>`;
}

function renderShell({ heading, rows, links }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F5F3EF;">
<div style="max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;">
  <div style="background:#1B2A4A;padding:24px 32px;">
    <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:400;">${escapeHtml(heading)}</h1>
  </div>
  <div style="background:#ffffff;padding:24px 32px;">
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    ${links}
  </div>
  <div style="padding:16px 32px;font-family:Arial,sans-serif;font-size:11px;color:#596B7D;">Oxford Realty Advisors — automated submission notice.</div>
</div></body></html>`;
}

function renderTenantEmail({ fields, links }) {
  const applicant = (fields && fields['full-legal-name']) || (fields && fields['applicant-email']) || 'Unknown Applicant';
  const property = (fields && (fields['building-unit'] || fields['building-unit-other'])) || 'Unspecified Property';
  return {
    subject: `New Tenant Lease Application — ${applicant} · ${property}`,
    html: renderShell({ heading: `Tenant Lease Application — ${applicant}`, rows: renderRows(fields || {}), links: renderLinks(links || {}) }),
  };
}

function renderBrokerEmail({ fields, links }) {
  const company = (fields && fields.company) || 'Unknown Company';
  const market = (fields && fields.market) || 'Unspecified Market';
  return {
    subject: `New Broker Submission — ${company} · ${market}`,
    html: renderShell({ heading: `Broker OM Submission — ${company}`, rows: renderRows(fields || {}), links: renderLinks(links || {}) }),
  };
}

function renderScoreFollowupEmail({ fields, score, submissionId }) {
  const company = (fields && fields.company) || 'Unknown Company';
  const gateNote = score.gateFailed ? ' (capped — outside core criteria)' : '';
  const coverage = score.coveragePct == null ? null : `${score.coveragePct}%`;
  const withheld = !!score.insufficientData;
  const needsReview = !!score.needsReview;
  const headerRows = renderRows({
    company,
    'submission-score': needsReview
      ? `Needs review — extracted figures failed validation (${(score.reviewReasons || []).join('; ')})`
      : withheld ? `Withheld — insufficient data (only ${coverage} of the scorecard could be read)` : `${score.finalScore}/100${gateNote}`,
    ...(coverage ? { 'scorecard-coverage': coverage } : {}),
    'gate-property-type': score.gates.propertyType,
    'gate-market': score.gates.market,
    ...(submissionId ? { 'submission-id': submissionId } : {}),
    ...(score.scorecardVersion ? { 'scorecard-version': score.scorecardVersion } : {}),
  });
  const breakdownRows = (score.categories || []).map((c) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#596B7D;">${escapeHtml(c.label)}</td><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:13px;color:#2D2D2D;">${c.excluded ? 'N/A' : `${c.earned}/${c.possible}`}</td><td style="padding:6px 12px;border-bottom:1px solid #E8E4DE;font-family:Arial,sans-serif;font-size:12px;color:#596B7D;">${escapeHtml(c.internalNote || c.note)}</td></tr>`).join('');
  return {
    subject: needsReview
      ? `Deal Score Needs Review — ${company}`
      : withheld
      ? `Deal Score Withheld — ${company} · ${coverage} coverage`
      : `Deal Score Ready — ${company} · ${score.finalScore}/100`,
    html: renderShell({ heading: `Automated Score — ${company}`, rows: headerRows + breakdownRows, links: '' }),
  };
}

module.exports = { renderTenantEmail, renderBrokerEmail, renderScoreFollowupEmail };
