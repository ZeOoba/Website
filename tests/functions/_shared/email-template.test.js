'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTenantEmail, renderBrokerEmail, renderScoreFollowupEmail } = require('../../../netlify/functions/_shared/email-template.js');

test('renderTenantEmail produces a distinct subject and includes key fields + document links', () => {
  const { subject, html } = renderTenantEmail({
    fields: { 'full-legal-name': 'Jane Doe', 'building-unit': '1100 Rarig Avenue, Columbus, OH', 'applicant-email': 'jane@example.com' },
    links: { 'upload-credit-report': 'https://contoso.sharepoint.com/x/credit.pdf', 'upload-drivers-license': 'https://contoso.sharepoint.com/x/dl.pdf', 'upload-articles': 'https://contoso.sharepoint.com/x/articles.pdf' },
  });
  assert.match(subject, /^New Tenant Lease Application — Jane Doe/);
  assert.match(html, /1B2A4A/); // navy brand color present
  assert.match(html, /Jane Doe/);
  assert.match(html, /1100 Rarig Avenue, Columbus, OH/);
  assert.match(html, /https:\/\/contoso\.sharepoint\.com\/x\/credit\.pdf/);
  assert.doesNotMatch(html, /<script/i);
});

test('renderBrokerEmail produces a distinct subject and includes the OM link', () => {
  const { subject, html } = renderBrokerEmail({
    fields: { name: 'Bob Broker', company: 'Acme Realty', market: 'Columbus' },
    links: { document: 'https://contoso.sharepoint.com/x/om.pdf' },
  });
  assert.match(subject, /^New Broker Submission — Acme Realty/);
  assert.match(html, /Bob Broker/);
  assert.match(html, /https:\/\/contoso\.sharepoint\.com\/x\/om\.pdf/);
});

test('email templates HTML-escape field values to prevent markup injection', () => {
  const { html } = renderTenantEmail({ fields: { 'full-legal-name': '<img src=x onerror=alert(1)>' }, links: {} });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('renderScoreFollowupEmail includes the company, total score, and every category note', () => {
  const score = {
    finalScore: 82,
    gates: { propertyType: 'PASS', market: 'PASS' },
    gateFailed: false,
    categories: [
      { key: 'dealSize', label: 'Deal Size', earned: 25, possible: 25, excluded: false, note: 'Within target.' },
      { key: 'basis', label: 'Acquisition Basis vs. Replacement Cost', earned: null, possible: 25, excluded: true, note: 'Not stated in OM.' },
    ],
  };
  const { subject, html } = renderScoreFollowupEmail({ fields: { company: 'Acme Co' }, score });
  assert.match(subject, /Acme Co/);
  assert.match(subject, /82\/100/);
  assert.match(html, /Deal Size/);
  assert.match(html, /25\/25/);
  assert.match(html, /Not stated in OM/);
});

test('renderScoreFollowupEmail notes when a gate failure capped the score', () => {
  const score = { finalScore: 30, gates: { propertyType: 'FAIL', market: 'PASS' }, gateFailed: true, categories: [] };
  const { subject } = renderScoreFollowupEmail({ fields: { company: 'Off-Box LLC' }, score });
  assert.match(subject, /30\/100/);
});
