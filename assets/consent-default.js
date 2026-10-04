/* Google Consent Mode v2 defaults for GA4.
 *
 * Loaded as text/partytown (Partytown web worker) BEFORE gtag.js, so the first
 * hit is already consent-aware: with analytics_storage denied, GA4 sends
 * cookieless aggregate pings and sets no _ga cookies. Advertising signals stay
 * denied permanently; this site runs no advertising.
 *
 * The visitor's choice is stored by script.js (cookie banner) in localStorage.
 * A returning visitor who accepted starts granted; everyone else, including
 * anyone who declined, starts denied. script.js also sends a consent update on
 * Accept (and for returning accepters, as a safeguard). Decline never grants. Same-origin and external on purpose: an inline snippet
 * would change the CSP script hash on every page.
 */
window.dataLayer = window.dataLayer || [];
// Assign to window, not `function gtag(){}`: Partytown runs each worker script in
// its own function scope, so a bare declaration stays private to that script and
// the main-thread stub's forwarded window.gtag(...) calls (this file's consent
// update, and the broker / contact / checklist conversion events) would throw
// "Cannot read properties of undefined (reading 'apply')" in the worker.
window.gtag = function () { dataLayer.push(arguments); };
var oxfordConsentGranted = false;
try { oxfordConsentGranted = localStorage.getItem('oxford-cookies-accepted') === 'true'; } catch (e) {}
gtag('consent', 'default', {
  analytics_storage: oxfordConsentGranted ? 'granted' : 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied'
});
