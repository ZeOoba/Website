'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTenantEmail, renderBrokerEmail } = require('../../../netlify/functions/_shared/email-template.js');

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
