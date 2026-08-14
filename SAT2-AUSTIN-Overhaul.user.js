// ==UserScript==
// @name         SAT2 AUSTIN overhaul
// @namespace    http://tampermonkey.net/
// @version      01.0.36
// @description  Shift codes, FCLM links, clock status, FLEX schedules, labor tracking, case details, analytics, RBI/ARC tracker, PIN mode, SIMBA tracker
// @author       Ian Chang (changiao)
// @match        https://*.austin.a2z.com/*
// @match        https://*.ehs-amazon.com/*
// @match        https://scorecard.workingwell.whs.amazon.dev/*
// @match        https://fclm-portal.amazon.com/employee/timeDetails*
// @match        https://prod.na.rtw.whs.amazon.dev/*
// @match        https://fcmenu-iad-regionalized.corp.amazon.com/*/laborTrackingKiosk*
// @match        https://durable.corp.amazon.com/*
// @require https://drive-render.corp.amazon.com/view/changiao@/MaintainScript/Shared%20Library%20WHS%202.js
// @require      https://drive-render.corp.amazon.com/view/smabrade@/Current/WHS_DarkOverlay.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      fclm-portal.amazon.com
// @connect      fclm-portal-iad.iad.proxy.amazon.com
// @connect      scheduling.amazon.com
// @connect      fcmenu-iad-regionalized.corp.amazon.com
// @connect      appsync-api.us-east-1.amazonaws.com
// @connect      drive-render.corp.amazon.com
// @connect      prod.na.rtw.whs.amazon.dev
// @connect      prod.na.rtw-api.whs.amazon.dev
// @connect      durable.corp.amazon.com
// @connect      scorecard.workingwell.whs.amazon.dev
// @connect      slack.com
// @connect      rno-tools.corp.amazon.com
// @run-at       document-idle
// @updateURL     https://tamarin.aces.amazon.dev/scripts/SAT2 AUSTIN overhaul/install.user.js
// @downloadURL   https://tamarin.aces.amazon.dev/scripts/SAT2 AUSTIN overhaul/install.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Auth harvest: scorecard tab opened by Huddle Monitor Auth button.
    // Instead of blindly closing after 1.5s, show progress UI and poll for
    // actual auth success (session cookies + page render). Closes only
    // when authenticated, or after 90s if user abandons.
    if (window.location.hostname.indexOf('scorecard.workingwell.whs.amazon.dev') !== -1 &&
        window.location.search.indexOf('whs_harvest=1') !== -1) {
        (function () {
            function paint() {
                if (document.getElementById('whs-auth-banner')) return;
                var b = document.createElement('div');
                b.id = 'whs-auth-banner';
                b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:linear-gradient(135deg,#1565c0,#0d47a1);color:#fff;padding:14px 20px;font-family:"Segoe UI",Arial,sans-serif;font-size:14px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,.4);text-align:center;';
                b.innerHTML = '<div style="font-weight:bold;margin-bottom:4px;">\uD83D\uDD11 WHS Huddle Monitor \u2014 Authenticating</div><div id="whs-auth-status" style="font-size:12px;color:#bbdefb;">Waiting for login... If you\'re prompted, please sign in. This window will close automatically.</div>';
                if (document.body) document.body.appendChild(b);
            }
            function setStatus(msg) {
                var el = document.getElementById('whs-auth-status');
                if (el) el.textContent = msg;
            }
            // Inject banner as soon as body is available
            if (document.body) paint();
            else document.addEventListener('DOMContentLoaded', paint);

            var elapsed = 0;
            var INTERVAL = 750;
            var MAX = 90000; // 90s
            var poll = setInterval(function () {
                elapsed += INTERVAL;
                paint();
                // Heuristic: page is authenticated when scorecard cookies are set
                // and the body is no longer on a generic Cognito/Midway sign-in page.
                var bodyText = (document.body && document.body.textContent || '').toLowerCase();
                var stillSigningIn = bodyText.indexOf('sign in') !== -1 && bodyText.length < 2000;
                var hasCookies = document.cookie && document.cookie.length > 0;
                if (hasCookies && !stillSigningIn && elapsed > 1500) {
                    setStatus('\u2713 Authenticated! Closing window...');
                    clearInterval(poll);
                    setTimeout(function () { try { window.close(); } catch (e) {} }, 800);
                    return;
                }
                if (elapsed >= MAX) {
                    setStatus('\u23F1 Timed out. Please log in manually, then close this tab and click Auth again.');
                    clearInterval(poll);
                }
            }, INTERVAL);
        })();
        return;
    }

    // ================================================================
    // WAIT FOR LIBRARY
    // ================================================================

    var lib = window.WHSLib;
    if (!lib) {
        console.error('WHS Incident Tools: Shared library (WHSLib) not loaded. Aborting.');
        return;
    }
if (lib && lib.VERSION !== '19.49') {
    console.warn('WHS: Library version mismatch! Expected 19.49, got ' + lib.VERSION + '. Clear Tampermonkey external cache.');
}

    // ================================================================
    // GRACEFUL DEGRADATION CHECK
    // ================================================================

    var _missingModules = [];
    if (!lib.auth) _missingModules.push('auth');
    if (!lib.bulk) _missingModules.push('bulk');
    if (!lib.fclm) _missingModules.push('fclm');
    if (!lib.ui) _missingModules.push('ui');
    if (!lib.styles) _missingModules.push('styles');
    if (!lib.settings) _missingModules.push('settings');
    if (!lib.dom) _missingModules.push('dom');

    if (_missingModules.length > 0) {
        console.error('WHS: Missing modules: ' + _missingModules.join(', ') + '. Running in degraded mode.');
    }

    var _degraded = _missingModules.length > 0;

    // ================================================================
    // ALIASES
    // ================================================================

    var C         = lib.constants;
    var state     = lib.state;
    var utils     = lib.utils;
    var settings  = lib.settings;
    var auth      = lib.auth;
    var dom       = lib.dom;
    var urls      = lib.urls;
    var bulk      = lib.bulk;
    var fclm      = lib.fclm;
    var flex      = lib.flex;
    var ui        = lib.ui;
    var styles    = lib.styles;
    var panel     = lib.settingsPanel;
    var pb        = lib.progressBar;
    var perf      = lib.perf;
    var rtwLib    = lib.rtw;

    // Concurrency-limited queue for per-card enrichment fan-out. Browser
    // caps concurrent connections/host at ~6; without this, 40 visible
    // cards fire 40 parallel GM_xmlhttpRequests and spinners resolve in
    // an unpredictable long tail. Cap at 6 keeps the queue predictable.
    var FCLM_ENRICH_CONCURRENCY = 6;
    var _fclmQueueActive = 0;
    var _fclmQueue = [];
    function _fclmQueuedRun(task) {
        return new Promise(function (resolve, reject) {
            function tryStart() {
                if (_fclmQueueActive >= FCLM_ENRICH_CONCURRENCY) {
                    _fclmQueue.push(tryStart);
                    return;
                }
                _fclmQueueActive++;
                task().then(function (v) {
                    _fclmQueueActive--;
                    var next = _fclmQueue.shift();
                    if (next) next();
                    resolve(v);
                }, function (e) {
                    _fclmQueueActive--;
                    var next = _fclmQueue.shift();
                    if (next) next();
                    reject(e);
                });
            }
            tryStart();
        });
    }

    // ================================================================
    // CROSS-PAGE ROUTING \u2014 Early return for non-Austin pages
    // ================================================================

    if (window.location.hostname.includes('fcmenu-iad-regionalized.corp.amazon.com')) {
        handleLaborKiosk();
        return;
    }

    if (window.location.hostname.includes('rtw.whs.amazon.dev')) {
        if (lib.rtw) lib.rtw.harvestToken();
        return;
    }

    if (window.location.hostname.includes('fclm-portal.amazon.com') &&
        window.location.href.includes('timeDetails')) {
        handleFCLMPage();
        return;
    }

    // RBI Setup Wizard \u2014 boot into wizard mode when one of these signals fires:
    //   1) URL has ?whsRbiSetup=1   (may be stripped by Austin's React router)
    //   2) window.name === 'whs-rbi-setup'   (survives URL changes; set by opener)
    //   3) sessionStorage flag we set on first detection (survives auth redirects)
    // Persist via sessionStorage so the flag survives Austin's SPA route changes.
    if (window.location.hostname.includes('na.ehs-amazon.com')) {
        var _wizardActive = false;
        try {
            var urlHasFlag = window.location.search.indexOf('whsRbiSetup=1') !== -1;
            var nameMatch = window.name === 'whs-rbi-setup';
            var sessionFlag = sessionStorage.getItem('whsRbiSetupActive') === '1';
            if (urlHasFlag || nameMatch || sessionFlag) {
                _wizardActive = true;
                sessionStorage.setItem('whsRbiSetupActive', '1');
            }
        } catch (e) {}
        if (_wizardActive) {
            console.log('[WHS RBI Setup] Wizard mode active. lib.rbiSetup =', !!lib.rbiSetup);
            if (lib.rbiSetup && lib.rbiSetup.bootWizardMode) {
                lib.rbiSetup.bootWizardMode();
            } else {
                // Library doesn't expose rbiSetup \u2014 likely a stale @require cache.
                // Show a visible error so the user knows what to do.
                console.error('[WHS RBI Setup] Wizard mode flag detected but lib.rbiSetup is not loaded. The Tampermonkey @require cache may be stale.');
                var paint = function () {
                    if (document.getElementById('whs-rbi-loaderr')) return;
                    var d = document.createElement('div');
                    d.id = 'whs-rbi-loaderr';
                    d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c62828;color:#fff;padding:20px;font-family:"Segoe UI",Arial,sans-serif;font-size:14px;font-weight:bold;z-index:2147483647;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.4)';
                    d.innerHTML = '\u26A0\uFE0F WHS RBI Setup wizard module not loaded.<br><span style="font-size:11px;font-weight:normal;color:#ffcdd2;">Clear Tampermonkey\'s external resource cache (Settings \u2192 Externals \u2192 trash icon next to Shared Library WHS 2.js), reload your original Austin tab, then try the setup button again.</span>';
                    if (document.body) document.body.appendChild(d);
                };
                if (document.body) paint();
                else document.addEventListener('DOMContentLoaded', paint);
            }
            return;
        }
    }


    // ================================================================
    // CROSS-PAGE: LABOR KIOSK AUTO-FILL
    // ================================================================

    function handleLaborKiosk() {
        var hash = window.location.hash.substring(1);
        var params = {};

        if (hash) {
            hash.split('&').forEach(function (p) {
                var pc = p.split('=');
                if (pc[0] && pc[1]) params[pc[0]] = decodeURIComponent(pc[1]);
            });
        }

        if (params.code) localStorage.setItem('laborTrackingCode', params.code);
        if (params.badge) localStorage.setItem('laborTrackingBadge', params.badge);

        var code = localStorage.getItem('laborTrackingCode');
        var badge = localStorage.getItem('laborTrackingBadge');
        var codeInput = document.querySelector('#calmCode');
        var badgeInput = document.querySelector('#trackingBadgeId');

        function submitNearest(el) {
            var form = el.closest('form') || document.querySelector('form');
            if (form) {
                if (typeof form.requestSubmit === 'function') form.requestSubmit();
                else form.submit();
            }
        }

        function fillAndSubmit(input, value, clearKey, delay) {
            setTimeout(function () {
                input.focus();
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                localStorage.removeItem(clearKey);
                setTimeout(function () { submitNearest(input); }, 500);
            }, delay);
        }

        if (codeInput && code) {
            fillAndSubmit(codeInput, code, 'laborTrackingCode', 1000);
        } else if (badgeInput && badge) {
            fillAndSubmit(badgeInput, badge, 'laborTrackingBadge', 500);
        }
    }

    // ================================================================
    // CROSS-PAGE: FCLM PAGE LABOR BUTTON
    // ================================================================

    function handleFCLMPage() {
        function getBadgeNumber() {
            var dts = document.querySelectorAll('dt');
            for (var i = 0; i < dts.length; i++) {
                if (dts[i].textContent.trim() === 'Badge') {
                    var dd = dts[i].nextElementSibling;
                    if (dd && dd.tagName === 'DD') return dd.textContent.trim();
                }
            }
            return null;
        }

        function getSiteCodeLocal() {
            try {
                var s = localStorage.getItem(C.STORAGE_KEY);
                if (s) return JSON.parse(s).siteCode || '';
            } catch (e) {}
            return '';
        }

        var existing = document.getElementById('fclm-labor-container');
        if (existing) existing.remove();

        var siteCode = getSiteCodeLocal();
        if (!siteCode) return;

        var container = document.createElement('div');
        container.id = 'fclm-labor-container';
        container.style.cssText =
            'position:fixed;top:10px;left:50%;transform:translateX(-50%);' +
            'z-index:10000;font-family:Arial,sans-serif;';

        var toggleBtn = document.createElement('button');
        toggleBtn.innerHTML = '\u26A1 Auto Labor Track \u25BC';
        toggleBtn.style.cssText =
            'background:linear-gradient(135deg,#2e7d32,#1b5e20);' +
            'color:white;border:none;padding:10px 15px;border-radius:8px;' +
            'cursor:pointer;font-size:14px;font-weight:bold;' +
            'box-shadow:0 2px 10px rgba(0,0,0,0.2);';
        container.appendChild(toggleBtn);

        var contentBox = document.createElement('div');
        contentBox.style.cssText =
            'background:#fff;border-radius:8px;' +
            'box-shadow:0 2px 10px rgba(0,0,0,0.2);' +
            'margin-top:5px;display:none;overflow:hidden;';

        var badge = getBadgeNumber();

        var bd = document.createElement('div');
        bd.style.cssText = 'font-size:12px;color:#666;padding:12px 15px;border-bottom:1px solid #eee;';
        bd.innerHTML = '<strong>Badge:</strong> ' + (badge || 'Not found') + ' | <strong>Site:</strong> ' + siteCode;
        contentBox.appendChild(bd);

        C.LABOR_CODES.forEach(function (item) {
            var btn = document.createElement('button');
            btn.textContent = item.label + ' - ' + item.desc;
            btn.style.cssText =
                'display:block;width:100%;padding:12px 15px;' +
                'background-color:' + item.color + ';color:white;' +
                'border:none;cursor:pointer;font-size:13px;text-align:left;';
            btn.addEventListener('click', function () {
                var b = getBadgeNumber();
                if (!b) b = prompt('Badge not found. Enter badge:');
                if (b) {
                    window.open(
                        'https://fcmenu-iad-regionalized.corp.amazon.com/' +
                        siteCode + '/laborTrackingKiosk#code=' + item.code + '&badge=' + b,
                        '_blank'
                    );
                }
            });
            contentBox.appendChild(btn);
        });

        container.appendChild(contentBox);

        var isOpen = false;
        toggleBtn.addEventListener('click', function () {
            isOpen = !isOpen;
            contentBox.style.display = isOpen ? 'block' : 'none';
            toggleBtn.innerHTML = '\u26A1 Auto Labor Track ' + (isOpen ? '\u25B2' : '\u25BC');
        });

        document.body.appendChild(container);
    }

    // ================================================================
    // CROSS-PAGE: SIMBA API INTERCEPTOR
    // ================================================================

    function handleSimbaPage() {
        // Use unsafeWindow so overrides affect the page JS context, not just the sandbox
        var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        // Capture ANY non-asset XHR/fetch \u2014 broad net since we don't know the URL yet
        function looksLikeData(url) {
            var u = (url || '').toLowerCase();
            return u.indexOf('.js') === -1 && u.indexOf('.css') === -1 &&
                   u.indexOf('.png') === -1 && u.indexOf('.ico') === -1 &&
                   u.indexOf('.woff') === -1 && u.indexOf('.svg') === -1;
        }

        function saveCapture(url, method, headers, body, responseText) {
            if (!responseText || responseText.length < 10) return;
            try {
                var parsed = JSON.parse(responseText);
                // Must be a non-trivial JSON response
                if (JSON.stringify(parsed).length < 30) return;
                GM_setValue('whs_simba_api_capture', JSON.stringify({
                    url: url, method: method || 'GET',
                    headers: headers || {}, body: body || null,
                    capturedAt: Date.now()
                }));
                showBanner('\u2705 API captured! Go back to the WHS tool and click Refresh in the SIMBA panel.');
                console.log('[WHS SIMBA] Captured:', method, url);
            } catch (e) { /* not JSON, skip */ }
        }

        function showBanner(msg) {
            var ex = document.getElementById('whs-simba-banner');
            if (ex) { ex.textContent = '[WHS] ' + msg; return; }
            var b = document.createElement('div');
            b.id = 'whs-simba-banner';
            b.style.cssText =
                'position:fixed;top:0;left:0;right:0;z-index:999999;' +
                'background:linear-gradient(135deg,#1565c0,#0d47a1);' +
                'color:#fff;padding:10px 20px;font-size:13px;font-weight:600;' +
                'font-family:Arial,sans-serif;text-align:center;' +
                'box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;';
            b.textContent = '[WHS] ' + msg;
            b.addEventListener('click', function () { b.remove(); });
            document.body.appendChild(b);
        }

        // -- Intercept fetch --
        var _origFetch = win.fetch;
        if (_origFetch) {
            win.fetch = function (input, init) {
                var url = (typeof input === 'string') ? input : (input && input.url) || '';
                var method = (init && init.method) || 'GET';
                var body = (init && init.body) ? String(init.body) : null;
                var headers = {};
                try {
                    if (init && init.headers) {
                        if (typeof init.headers.forEach === 'function') {
                            init.headers.forEach(function (v, k) { headers[k] = v; });
                        } else { headers = init.headers; }
                    }
                } catch (e) {}
                var p = _origFetch.apply(this, arguments);
                if (looksLikeData(url)) {
                    p.then(function (resp) {
                        resp.clone().text().then(function (text) {
                            saveCapture(url, method, headers, body, text);
                        });
                    }).catch(function () {});
                }
                return p;
            };
        }

        // -- Intercept XHR --
        var _origOpen   = win.XMLHttpRequest.prototype.open;
        var _origSend   = win.XMLHttpRequest.prototype.send;
        var _origSetHdr = win.XMLHttpRequest.prototype.setRequestHeader;

        win.XMLHttpRequest.prototype.open = function (method, url) {
            this._whs_url = url; this._whs_method = method; this._whs_headers = {};
            return _origOpen.apply(this, arguments);
        };
        win.XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
            if (this._whs_headers) this._whs_headers[k] = v;
            return _origSetHdr.apply(this, arguments);
        };
        win.XMLHttpRequest.prototype.send = function (body) {
            var self = this;
            if (looksLikeData(self._whs_url)) {
                self.addEventListener('load', function () {
                    saveCapture(self._whs_url, self._whs_method, self._whs_headers,
                        body ? String(body) : null, self.responseText);
                });
            }
            return _origSend.apply(this, arguments);
        };

        // Show status banner once DOM is ready
        function onReady() {
            try {
                var existing = GM_getValue('whs_simba_api_capture', null);
                if (existing) {
                    var c = JSON.parse(existing);
                    var ageMin = Math.round((Date.now() - (c.capturedAt || 0)) / 60000);
                    showBanner('Previous capture (' + ageMin + 'm ago) \u2014 browsing will re-capture. Click to dismiss.');
                } else {
                    showBanner('WHS interceptor active \u2014 browse or filter SIMBAs to capture the API. Click to dismiss.');
                }
            } catch (e) {}
        }
        if (document.body) { onReady(); }
        else { document.addEventListener('DOMContentLoaded', onReady); }
    }

    // ================================================================
    // INITIALIZE SETTINGS & LOCAL STATE
    // ================================================================

    var cfg = settings.init();

    // If degraded, disable features that require missing modules
    if (_degraded) {
        if (_missingModules.indexOf('bulk') !== -1) {
            cfg.showFollowUps = false;
            cfg.showICare = false;
            cfg.showRegulatory = false;
            cfg.showBodyParts = false;
            cfg.showLocation = false;
            cfg.showDiagnosis = false;
            cfg.showProcessPath = false;
            cfg.showImpactType = false;
        }
        if (_missingModules.indexOf('fclm') !== -1) {
            cfg.showClockStatus = false;
            cfg.showLaborTracking = false;
        }
    }

    var lastCardHash = 0;
    var lastCardCount = 0;
    var isFullProcessing = false;
    var mutationDebounceTimer = null;
    var lastProcessTimestamp = 0;
    var _cachedCards = null;
    var _cachedCardsHash = 0;

    var detectedSite = auth ? auth.detectSiteCode() : null;
    if (detectedSite && !cfg.siteCode) {
        cfg.siteCode = detectedSite;
        settings.save(cfg);
    }

    // Check for team config URL import
    if (lib.teamConfig) {
        lib.teamConfig.checkUrlConfig();
    }

    // ================================================================
    // BULK DATA PROGRESS CALLBACKS
    // ================================================================

    function getBulkCallbacks() {
        return pb.createCallbacks(function () {
            applyBulkDataToAllCards();
        });
    }

    // ================================================================
    // SHIFT LABEL ON TITLE
    // ================================================================

    function addShiftToTitle(titleEl, shiftCode) {
        if (!cfg.showIncidentShiftCodes) return;
        var ex = titleEl.querySelector('.shift-label');
        if (ex) ex.remove();

        var colors = dom.getShiftColors();
        var sp = document.createElement('span');
        sp.className = 'shift-label';
        sp.textContent = '[' + shiftCode + '] ';
        sp.style.cssText = 'color:' + (colors[shiftCode] || '#666') + '!important;font-weight:bold;';
        titleEl.insertBefore(sp, titleEl.firstChild);
    }

    function processCard(titleEl) {
        if (!cfg.showIncidentShiftCodes) return;
        if (titleEl.querySelector('.shift-label')) return;

        var link = titleEl.closest('a[href*="incident/"]');
        if (link) {
            var cn = dom.extractCaseNumber(link.getAttribute('href'));
            if (cn) {
                var d = bulk.getBulkCaseDataForCard(cn, getBulkCallbacks());
                if (d && d.shiftCode) {
                    addShiftToTitle(titleEl, d.shiftCode);
                    return;
                }
            }
        }

        var sp = document.createElement('span');
        sp.className = 'shift-label';
        sp.textContent = '[...] ';
        sp.style.cssText = 'color:#999!important;font-weight:bold;';
        titleEl.insertBefore(sp, titleEl.firstChild);
    }

    // ================================================================
    // CASE DETAILS FOR CARD
    // ================================================================

    function processCaseDetailsForCard(card) {
        var href = card.getAttribute('href');
        if (!href) return;

        var caseNumber = dom.extractCaseNumber(href);
        if (!caseNumber) return;

        var cardContent = card.closest('.MuiCardContent-root');
        if (!cardContent) {
            var cr = card.closest('[data-testid="IncidentCard-root"]');
            if (cr) cardContent = cr;
        }
        if (!cardContent) return;

        var data = bulk.getBulkCaseDataForCard(caseNumber, getBulkCallbacks());
        if (!data) return;

        if (card.classList.contains('casedata-processed')) return;
        card.classList.add('casedata-processed');

        ui.displayCaseData(cardContent, data);

        // Auto-pin/unpin by status: 'open' -> pin; 'closed' / 'claim-filed' /
        // 'pending-outside-medical' -> unpin (auto-pins only; manual pins are
        // always preserved). Runs live as each card is processed. Idempotent,
        // so it also coexists with the library-side safety-net hook.
        if (lib.pin && lib.pin.autoSyncByStatus) {
            lib.pin.autoSyncByStatus(data);
        }

        // Inject PIN button if pin module loaded
        if (lib.pin && lib.pin.injectPinButton) {
            lib.pin.injectPinButton(cardContent, caseNumber);
        }

        // Inject RTW dropdown if case has rtwCaseId
        if (lib.rtw && lib.rtw.injectDropdown && data.rtwCaseId) {
            lib.rtw.injectDropdown(cardContent, data.rtwCaseId);
        }

        if (data.shiftCode && cfg.showIncidentShiftCodes) {
            var titleEl = cardContent.querySelector('[data-testid="IncidentCard-title"]');
            if (!titleEl) {
                var r2 = cardContent.closest('[data-testid="IncidentCard-root"]');
                if (r2) titleEl = r2.querySelector('[data-testid="IncidentCard-title"]');
            }
            if (titleEl) {
                var es = titleEl.querySelector('.shift-label');
                var colors = dom.getShiftColors();
                if (es) {
                    es.textContent = '[' + data.shiftCode + '] ';
                    es.style.color = colors[data.shiftCode] || '#666';
                } else {
                    addShiftToTitle(titleEl, data.shiftCode);
                }
            }
        }
    }

    function applyBulkDataToAllCards() {
        if (!settings.anyCaseDetailsEnabled() || state.bulkCaseData.size === 0) return;

        document.querySelectorAll('[data-testid="IncidentCard-title"]').forEach(function (titleEl) {
            var link = titleEl.closest('a[href*="incident/"]');
            if (!link) {
                var root = titleEl.closest('[data-testid="IncidentCard-root"]');
                if (root) link = root.querySelector('a[href*="incident/"]');
            }
            if (link) processCaseDetailsForCard(link);
        });

        // Update freshness badge
        var fb = document.getElementById('whs-freshness-badge');
        if (fb && fb._update) fb._update();
    }

    // ================================================================
    // FCLM BUTTONS & ASSOCIATE INFO
    // ================================================================

    function addFCLMButtons() {
        if (state._processingLock) return;
        state._processingLock = true;

        try {
            document.querySelectorAll(
                '[data-testid="IncidentCard-userAliasInvolved-root"]'
            ).forEach(function (container) {
                if (container.classList.contains('austin-processed')) return;

                var aliasEl = container.querySelector('[data-testid="UserDisplay-alias"]');
                if (!aliasEl) return;

                var alias = aliasEl.textContent.trim().toLowerCase();
                if (!alias || alias.length < 2) return;

                if (container.querySelector('.clock-indicator') ||
                    container.querySelector('.fclm-button')) {
                    container.classList.add('austin-processed');
                    return;
                }

                var cardContainer = dom.getCardContainer(container);
                container.classList.add('austin-processed');

                // FCLM button
                if (cfg.showFCLMButtons) {
                    var btn = document.createElement('a');
                    btn.className = 'fclm-button';
                    btn.href = urls.buildFCLMUrl(alias);
                    btn.target = '_blank';
                    btn.textContent = '\uD83D\uDC64 FCLM';
                    aliasEl.after(btn);
                }

                // iCare auto-fill button (v19.47)
                // Small button next to FCLM. On click, walks up to the card
                // root to grab the case number, then hands the modal a
                // caseNumber/alias/groupId payload so the confirm UI is
                // populated end-to-end without any extra clicks.
                if (cfg.showIcareButton && lib.icareFiller) {
                    var ic = document.createElement('button');
                    ic.className = 'fclm-button whs-icare-btn';
                    ic.type = 'button';
                    ic.textContent = '\uD83E\uDE7A iCare';
                    ic.title = 'Auto-fill iCare (Not Scheduled / Absent)';
                    ic.style.cursor = 'pointer';
                    (function (aliasCaptured, containerCaptured) {
                        ic.addEventListener('click', function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            var cardRoot = containerCaptured.closest('[data-testid="IncidentCard-root"]')
                                || dom.getCardContainer(containerCaptured);
                            var caseLink = cardRoot && cardRoot.querySelector('a[href*="incident/"]');
                            var caseId = caseLink ? dom.extractCaseNumber(caseLink.getAttribute('href')) : null;
                            if (!caseId) {
                                console.warn('[WHS iCare] Could not extract case id from card');
                                return;
                            }
                            var data = null;
                            try { data = bulk.getBulkCaseDataForCard(caseId, getBulkCallbacks()); } catch (err) {}
                            lib.icareFiller.showQuickSubmitModal(caseId, {
                                caseNumber: data && data.caseNumber,
                                alias:      aliasCaptured,
                                groupId:    data && data.groupCaseNumber,
                                onSuccess:  function (res) {
                                    console.log('[WHS iCare] Submitted', res && res.status, 'for', aliasCaptured);
                                }
                            });
                        });
                    })(alias, container);
                    var afterFclm = container.querySelector('.fclm-button') || aliasEl;
                    afterFclm.after(ic);
                }

                // Loading indicator \u2014 inserted after the LAST fclm-button so
                // the spinner lands to the right of both FCLM and iCare.
                var loading = document.createElement('span');
                loading.className = 'clock-indicator';
                loading.textContent = '\u23F3';
                loading.style.cssText = 'display:inline-block;margin-left:6px;vertical-align:middle;';
                var allFclmBtns = container.querySelectorAll('.fclm-button');
                var insertAfter = allFclmBtns.length ? allFclmBtns[allFclmBtns.length - 1] : aliasEl;
                insertAfter.after(loading);

                _fclmQueuedRun(function () {
                    return Promise.all([
                        fclm.checkClockStatus(alias),
                        flex.fetchFlexSchedule(alias)
                    ]);
                }).then(function (results) {
                    var cr = results[0];
                    var sched = results[1];
                    loading.remove();

                    if (!document.contains(container)) return;
                    if (container.querySelector('.clock-indicator:not([style*="\u23F3"])') ||
                        container.querySelector('.shift-code-badge') ||
                        container.querySelector('.terminated-badge') ||
                        container.querySelector('.inactive-badge') ||
                        container.querySelector('.flex-badge-container')) return;

                    var fclmBtns1 = container.querySelectorAll('.fclm-button');
                    var lastEl = fclmBtns1.length ? fclmBtns1[fclmBtns1.length - 1] : aliasEl;

                    if (cfg.showClockStatus) {
                        var ci = ui.createClockIndicator(cr.isClockedIn, cr.path);
                        lastEl.after(ci);
                        lastEl = ci;
                    }

                    if (cr.badge && cfg.showLaborTracking) {
                        var lb = ui.createLaborTrackButton(cr.badge);
                        if (lb) { lastEl.after(lb); lastEl = lb; }
                    }

                    if (!cr.shiftCode) {
                        if (cfg.showTerminatedBadge) {
                            // Three-way branch driven by the FCLM result's `kind`:
                            //   \u2022 notFound    \u2192 real terminated/resigned (positive proof)
                            //   \u2022 ok          \u2192 inactive (in FCLM but no shift)
                            //   \u2022 unavailable \u2192 pending (transient; auto-retry loop
                            //                   below in checkPendingFclmBadges())
                            var pendingBadge;
                            if (cr.kind === 'notFound')          pendingBadge = ui.createTerminatedBadge();
                            else if (cr.kind === 'ok')           pendingBadge = ui.createInactiveBadge();
                            else /* unavailable or legacy */     pendingBadge = ui.createPendingBadge(alias);
                            lastEl.after(pendingBadge);
                        }
                    } else if (cr.shiftCode.toUpperCase().indexOf('FLEX') !== -1) {
                        var fb = ui.createFlexBadge(alias, cardContainer, sched);
                        if (fb) lastEl.after(fb);
                    } else {
                        if (cfg.showShiftCodeBadges) lastEl.after(ui.createShiftCodeBadge(cr.shiftCode));
                    }

                    var refreshBtn = ui.createRefreshButton(function () {
                        container.querySelectorAll(
                            '.clock-indicator,.shift-code-badge,.terminated-badge,' +
                            '.inactive-badge,.fclm-pending-badge,.flex-badge-container,' +
                            '.labor-track-container,.fclm-refresh-button,.fclm-button'
                        ).forEach(function (el) {
                            if (el.classList.contains('labor-track-container')) {
                                document.querySelectorAll('.labor-track-dropdown').forEach(function (dd) {
                                    if (dd._parentContainer === el) dd.remove();
                                });
                            }
                            if (el.classList.contains('flex-badge-container')) {
                                document.querySelectorAll('.flex-schedule-dropdown').forEach(function (dd) {
                                    if (dd._parentContainer === el) dd.remove();
                                });
                            }
                            el.remove();
                        });
                        if (cardContainer) {
                            var banner = cardContainer.querySelector('.flex-today-banner');
                            if (banner) banner.remove();
                        }
                        fclm.invalidateClockCache(alias);
                        flex.invalidateFlexCache(alias);
                        container.classList.remove('austin-processed');
                        addFCLMButtons();
                    });
                    container.appendChild(refreshBtn);
                }).catch(function (err) {
                    loading.remove();
                    if (!document.contains(container)) return;
                    if (container.querySelector('.shift-code-badge') ||
                        container.querySelector('.terminated-badge')) return;

                    var fclmBtns2 = container.querySelectorAll('.fclm-button');
                    var lastEl = fclmBtns2.length ? fclmBtns2[fclmBtns2.length - 1] : aliasEl;
                    var eb = document.createElement('span');
                    eb.className = 'clock-indicator';
                    eb.textContent = '\u26A0\uFE0F Error';
                    eb.title = 'Failed: ' + err.message;
                    eb.style.cssText =
                        'display:inline-block;background:#fff3e0;color:#e65100!important;' +
                        'padding:2px 6px;border-radius:4px;font-size:10px;font-weight:bold;' +
                        'margin-left:6px;border:1px solid #ffcc80;vertical-align:middle;cursor:pointer;';
                    eb.addEventListener('click', function () {
                        eb.remove();
                        container.classList.remove('austin-processed');
                        fclm.invalidateClockCache(alias);
                        flex.invalidateFlexCache(alias);
                        addFCLMButtons();
                    });
                    lastEl.after(eb);
                });
            });
        } finally {
            setTimeout(function () { state._processingLock = false; }, C.PROCESS_COOLDOWN);
        }
    }

    // ================================================================
    // PROCESS ALL CARDS
    // ================================================================

    function processAllCards() {
        if (!utils.isAustinPage()) return;
        if (state._processingLock) return;

        perf.start('processAllCards');

        var cards = _cachedCards || dom.findIncidentCards();
        cards.forEach(function (card) { processCard(card); });
        addFCLMButtons();

        if (settings.anyCaseDetailsEnabled()) {
            bulk.fetchBulkCaseData(false, getBulkCallbacks()).then(function () {
                // Single render pass \u2014 bulk fetch's onApply callback
                // (wired in getBulkCallbacks) already streams updates
                // as each page arrives. The old 500ms follow-up call
                // re-processed already-decorated cards and cost 300-600ms
                // of redundant DOM work per bulk refresh.
                applyBulkDataToAllCards();
                if (lib.medicalAlert) {
                    setTimeout(function () { lib.medicalAlert.checkAndShowMedicalAlert(); }, 1000);
                }
            }).catch(function (err) {
                console.error('WHS: Bulk fetch failed:', err);
            });
        }

        perf.end('processAllCards');
        // Schedule a retry sweep for any FCLM lookups that came back
        // "unavailable" this round (auth-cookie races, timeouts, cold-
        // start settings). Idempotent \u2014 no-ops when no pending badges
        // exist. Attempts are per-badge, capped at 5 tries each.
        schedulePendingFclmRetry();
    }

    // Retry loop for `.fclm-pending-badge` elements. Fires every 3s,
    // tops out after 6 sweeps (18s wall time). Each pending badge is
    // re-checked at most 5 times before giving up (badge stays put so
    // the user still sees "FCLM \u2026" instead of a false Terminated). A
    // per-badge attempt counter lives on `dataset.fclmAttempts`.
    var _fclmRetryTimer = null;
    var _fclmRetrySweepCount = 0;
    var FCLM_RETRY_MAX_SWEEPS = 6;
    var FCLM_RETRY_INTERVAL_MS = 3000;
    var FCLM_RETRY_PER_BADGE_CAP = 5;

    function schedulePendingFclmRetry() {
        if (_fclmRetryTimer) return;               // already scheduled
        _fclmRetrySweepCount = 0;
        _fclmRetryTimer = setTimeout(runPendingFclmRetrySweep, FCLM_RETRY_INTERVAL_MS);
    }

    function runPendingFclmRetrySweep() {
        _fclmRetryTimer = null;
        var pending = document.querySelectorAll('.fclm-pending-badge');
        if (!pending.length) { _fclmRetrySweepCount = 0; return; }
        _fclmRetrySweepCount++;
        pending.forEach(function (badge) {
            var alias = badge.getAttribute('data-alias');
            if (!alias) return;
            var attempts = parseInt(badge.dataset.fclmAttempts || '0', 10);
            if (attempts >= FCLM_RETRY_PER_BADGE_CAP) return;
            badge.dataset.fclmAttempts = String(attempts + 1);
            lib.fclm.checkClockStatus(alias).then(function (cr) {
                // Element may have been detached during re-render \u2014 check
                // before mutating.
                if (!badge.isConnected) return;
                if (cr.kind === 'ok') {
                    badge.replaceWith(ui.createInactiveBadge());
                } else if (cr.kind === 'notFound') {
                    badge.replaceWith(ui.createTerminatedBadge());
                }
                // 'unavailable' \u2192 leave the pending badge; next sweep tries again.
            }).catch(function () { /* keep pending badge */ });
        });
        if (_fclmRetrySweepCount < FCLM_RETRY_MAX_SWEEPS) {
            _fclmRetryTimer = setTimeout(runPendingFclmRetrySweep, FCLM_RETRY_INTERVAL_MS);
        }
    }

    // ================================================================
    // RESET ALL
    // ================================================================

    function resetAllAndReprocess() {
        bulk.resetAllCaches();
        pb.remove();
        dom.clearAllAddedElements();
        dom.cleanupOrphanedElements();
        lastCardHash = 0;
        lastCardCount = 0;
        lastProcessTimestamp = 0;
        isFullProcessing = false;
        _cachedCards = null;
        processAllCards();
    }

    function clearAndReprocess() {
        dom.clearAllAddedElements();
        lastCardCount = 0;
        lastCardHash = 0;
        _cachedCards = null;
        processAllCards();
    }
        // ================================================================
    // CHANGE DETECTION (hash-based)
    // ================================================================

    function checkForChanges() {
        // Try to create settings UI on every check
        if (panel) {
            panel.createSettingsUI({
                onRefresh: resetAllAndReprocess,
                onToggle: clearAndReprocess,
                onPanelToggle: handlePanelToggle,
                onColorChange: function () {
                    styles.addStyles();
                    clearAndReprocess();
                }
            });
        }

        if (!utils.isAustinPage()) return;
        if (isFullProcessing) return;

        var cards = dom.findIncidentCards();
        var count = cards.length;
        var hash = utils.quickHash(cards);

        // Update card cache
        _cachedCards = cards;
        _cachedCardsHash = hash;

        var contentChanged = hash !== lastCardHash;
        lastCardHash = hash;

        if (count !== lastCardCount || contentChanged) {
            lastCardCount = count;

            if (contentChanged) {
                if (Date.now() - lastProcessTimestamp < C.PROCESS_COOLDOWN) return;

                isFullProcessing = true;
                lastProcessTimestamp = Date.now();

                dom.clearAllAddedElements();
                dom.cleanupOrphanedElements();
                _cachedCards = null;

                // Invalidate bulk cache for fresh card set
                state.bulkDataTimestamp = 0;
                state.bulkDataLoading = false;
                state.bulkDataPromise = null;
                state.pendingBatchKeys.delete('bulk-all');

                processAllCards();

                setTimeout(function () {
                    isFullProcessing = false;
                    setTimeout(checkForChanges, 200);
                }, C.PROCESS_COOLDOWN);
                return;
            }

            processAllCards();
            return;
        }

        // Check if any cards still need processing
        var needsProcessing = false;

        if (cfg.showIncidentShiftCodes) {
            for (var i = 0; i < cards.length; i++) {
                if (!cards[i].querySelector('.shift-label')) {
                    needsProcessing = true;
                    break;
                }
            }
        }

        if (!needsProcessing) {
            var up = document.querySelectorAll(
                '[data-testid="IncidentCard-userAliasInvolved-root"]:not(.austin-processed)'
            );
            if (up.length > 0) needsProcessing = true;
        }

        if (!needsProcessing && settings.anyCaseDetailsEnabled() &&
            state.bulkCaseData.size > 0) {
            var uc = document.querySelectorAll('a[href*="incident/"]:not(.casedata-processed)');
            if (uc.length > 0) needsProcessing = true;

            if (!needsProcessing) {
                var processedCards = document.querySelectorAll('a[href*="incident/"].casedata-processed');
                for (var j = 0; j < processedCards.length; j++) {
                    var cc = processedCards[j].closest('.MuiCardContent-root');
                    if (cc && !cc.querySelector('.case-details-wrapper') &&
                        !cc.querySelector('.case-details-section')) {
                        processedCards[j].classList.remove('casedata-processed');
                        needsProcessing = true;
                    }
                }
            }
        }

        if (needsProcessing) {
            if (Date.now() - lastProcessTimestamp < C.PROCESS_COOLDOWN) return;
            lastProcessTimestamp = Date.now();
            processAllCards();
        }
    }

    // ================================================================
    // PANEL TOGGLE HANDLER
    // ================================================================

    function handlePanelToggle() {
        var settings = state.settings;

        // Analytics panel
        var analyticsToggle = document.getElementById('whs-analytics-toggle');
        var analyticsPanel = document.getElementById('whs-analytics-panel');

        if (settings.showAnalyticsPanel === false) {
            if (analyticsToggle) analyticsToggle.style.display = 'none';
            if (analyticsPanel) {
                analyticsPanel.classList.remove('open');
                analyticsPanel.style.display = 'none';
            }
        } else {
            // If turning back on but panel doesn't exist, need reload
            if (!analyticsPanel && !analyticsToggle) {
                if (confirm('Analytics panel requires a page refresh to re-enable. Refresh now?')) {
                    location.reload();
                }
                return;
            }
            if (analyticsToggle) analyticsToggle.style.display = '';
            if (analyticsPanel) analyticsPanel.style.display = '';
        }

        // RBI panel
        var rbiToggle = document.getElementById('rt-toggle');
        var rbiPanel = document.getElementById('rt-panel');

        if (settings.showRBITracker === false) {
            if (rbiToggle) rbiToggle.style.display = 'none';
            if (rbiPanel) {
                rbiPanel.classList.remove('open');
                rbiPanel.style.display = 'none';
            }
        } else {
            if (!rbiPanel && !rbiToggle) {
                if (confirm('RBI/ARC Tracker requires a page refresh to re-enable. Refresh now?')) {
                    location.reload();
                }
                return;
            }
            if (rbiToggle) rbiToggle.style.display = '';
            if (rbiPanel) rbiPanel.style.display = '';
        }

        // SIMBA panel
        var simbaToggle = document.getElementById('whs-toolbar-simba-btn');
        var simbaPanel  = document.getElementById('whs-simba-panel');

        if (settings.showSIMBATracker === false) {
            if (simbaToggle) simbaToggle.style.display = 'none';
            if (simbaPanel) {
                simbaPanel.classList.remove('open');
                simbaPanel.style.display = 'none';
            }
        } else {
            if (!simbaPanel && !simbaToggle) {
                if (confirm('SIMBA Tracker requires a page refresh to re-enable. Refresh now?')) {
                    location.reload();
                }
                return;
            }
            if (simbaToggle) simbaToggle.style.display = '';
            if (simbaPanel) simbaPanel.style.display = '';
        }

        // PIN panel
        var pinToolbarBtn = document.getElementById('whs-toolbar-pin-btn');
        var pinPanel = document.getElementById('whs-pin-panel');

        if (settings.showPinPanel === false) {
            if (pinToolbarBtn) pinToolbarBtn.style.display = 'none';
            if (pinPanel) {
                pinPanel.classList.remove('open');
                pinPanel.style.display = 'none';
            }
        } else {
            if (!pinPanel) {
                if (confirm('PIN Cases panel requires a page refresh to re-enable. Refresh now?')) {
                    location.reload();
                }
                return;
            }
            if (pinToolbarBtn) pinToolbarBtn.style.display = '';
            if (pinPanel) pinPanel.style.display = '';
        }

        // Huddle Monitor panel
        var huddleToggle = document.getElementById('whm-tb');
        var huddlePanel  = document.getElementById('whm-panel');

        if (settings.showHuddleMonitor === false) {
            if (huddleToggle) huddleToggle.style.display = 'none';
            if (huddlePanel) {
                huddlePanel.classList.remove('open');
                huddlePanel.style.display = 'none';
            }
        } else {
            if (!huddlePanel && !huddleToggle) {
                if (confirm('Huddle Monitor requires a page refresh to re-enable. Refresh now?')) {
                    location.reload();
                }
                return;
            }
            if (huddleToggle) huddleToggle.style.display = '';
            if (huddlePanel)  huddlePanel.style.display  = '';
        }
    }

    // ================================================================
    // URL CHANGE HANDLER
    // ================================================================

    function handleUrlChange() {
        lastCardCount = 0;
        lastCardHash = 0;
        dom.cleanupOrphanedElements();
        if (auth) auth.getScopeId();

        var detected = auth ? auth.detectSiteCode() : null;
        if (detected && detected !== cfg.siteCode) {
            console.log('WHS: Detected site change to ' + detected);
        }

        setTimeout(checkForChanges, 500);
    }

    // ================================================================
    // GLOBAL CLICK DISMISSER
    // ================================================================

    function initGlobalClickDismisser() {
        document.addEventListener('click', function (e) {
            // Labor tracking dropdowns
            document.querySelectorAll('.labor-track-dropdown.open').forEach(function (dd) {
                var pc = dd._parentContainer;
                if (pc && !pc.contains(e.target) && !dd.contains(e.target)) {
                    dd.classList.remove('open');
                }
            });

            // Flex schedule dropdowns
            document.querySelectorAll('.flex-schedule-dropdown').forEach(function (dd) {
                if (dd.style.display === 'block') {
                    var pc = dd._parentContainer;
                    if (pc && !pc.contains(e.target) && !dd.contains(e.target)) {
                        dd.style.display = 'none';
                        var b = pc.querySelector('button');
                        if (b && b.textContent.indexOf('FLEX') !== -1) {
                            b.textContent = 'FLEX \u25BC';
                        }
                    }
                }
            });
        });
    }

    // ================================================================
    // KEYBOARD SHORTCUTS
    // ================================================================

    function initKeyboardShortcuts() {
        document.addEventListener('keydown', function (e) {
            // Escape \u2014 close panels/dropdowns
            if (e.key === 'Escape') {
                var sd = document.getElementById('austin-settings-dropdown');
                if (sd && sd.classList.contains('open')) {
                    sd.classList.remove('open');
                    e.preventDefault();
                    return;
                }
                var ol = document.querySelector('.labor-track-dropdown.open');
                if (ol) { ol.classList.remove('open'); e.preventDefault(); return; }
                var of2 = document.querySelector('.flex-schedule-dropdown[style*="display: block"]');
                if (of2) { of2.style.display = 'none'; e.preventDefault(); return; }
            }

            // Ctrl+Shift+R \u2014 Refresh all
            if (e.ctrlKey && e.shiftKey && e.key === 'R' &&
                e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                resetAllAndReprocess();
                settings.showToast('\uD83D\uDD03 Refreshed all data');
            }

            // Ctrl+Shift+P \u2014 Performance dump
            if (e.ctrlKey && e.shiftKey && e.key === 'P' &&
                e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (perf) {
                    perf.dump();
                    settings.showToast('\uD83D\uDCCA Perf report in console (F12)');
                }
            }
        });
    }

    // ================================================================
    // MUTATION OBSERVER & MONITORING
    // ================================================================

    function startMonitoring() {
        initGlobalClickDismisser();
        initKeyboardShortcuts();

        var observer = new MutationObserver(function (mutations) {
            // Filter out mutations caused by our own DOM changes
            var dominated = true;
            for (var i = 0; i < mutations.length; i++) {
                var t = mutations[i].target;
                if (!t.classList) { dominated = false; break; }
                if (!t.classList.contains('austin-processed') &&
                    !t.classList.contains('casedata-processed') &&
                    !t.classList.contains('case-details-section') &&
                    !t.classList.contains('case-details-wrapper') &&
                    !t.classList.contains('case-details-content') &&
                    !t.classList.contains('case-details-toggle') &&
                    !t.classList.contains('shift-label')) {
                    dominated = false;
                    break;
                }
            }
            if (dominated) return;

            clearTimeout(mutationDebounceTimer);
            mutationDebounceTimer = setTimeout(function () {
                checkForChanges();
            }, 500);
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // URL change detection
        window.addEventListener('popstate', handleUrlChange);
        window.addEventListener('hashchange', handleUrlChange);

        var _lastHref = location.href;
        setInterval(function () {
            if (location.href !== _lastHref) {
                _lastHref = location.href;
                handleUrlChange();
            }
        }, 2000);

        // Initial check \u2014 the MutationObserver above will catch any
        // late-mounted Austin content, and the URL poller catches SPA
        // navigation. The old 1500ms/3000ms follow-up timers were
        // redundant hash passes that never found new work.
        setTimeout(checkForChanges, 500);

        console.log('WHS Incident Tools v' + lib.VERSION + ' ready \u2014 Site: ' + (cfg.siteCode || '(not set)'));
    }

    // ================================================================
    // INITIALIZE
    // ================================================================

    function initialize() {
        if (!utils.checkBrowserCompatibility()) {
            console.error('WHS Incident Tools: Browser not compatible');
            return;
        }

        console.log('WHS Incident Tools v' + lib.VERSION + ' by SMABRADE');

        if (styles) {
            styles.addStyles();
            styles.applyWebsiteTheme();
        }

        // Warm the auth token cache before any request needs it. First
        // call scans localStorage (5-30ms depending on how many keys);
        // doing it here means the first GraphQL request in every batch
        // doesn't pay that on the head of its waterfall.
        try { auth.getAuthToken(); } catch (e) {}

        function onDomReady() {
            startMonitoring();

            // Initialize analytics panel (if enabled)
            if (lib.analytics && cfg.showAnalyticsPanel !== false) {
                lib.analytics.injectStyles();
                lib.analytics.createPanel();
            }

            // Initialize RBI/ARC tracker (if enabled)
            if (lib.rbi && cfg.showRBITracker !== false) {
                lib.rbi.injectStyles();
                lib.rbi.createPanel();
            }

            // Initialize SIMBA tracker (if enabled)
            if (lib.simba && cfg.showSIMBATracker !== false) {
                lib.simba.injectStyles();
                lib.simba.createPanel();
            }

            // Initialize Huddle Monitor (if enabled)
            if (lib.huddle && cfg.showHuddleMonitor !== false) {
                lib.huddle.init();
            }

            // Initialize Austin Slack Reminders
            if (lib.asr) {
                lib.asr.init();
            }

            // Initialize Site Personnel panel
            if (lib.personnelPanel) {
                lib.personnelPanel.init();
            }

// Initialize Command Dashboard (WORK IN PROGRESS \u2014 off by default)
            if (lib.commandDashboard && cfg.showCommandDashboard === true) {
                lib.commandDashboard.init();
            }

            // Show onboarding wizard OR what's new \u2014 skip on SIMBA durable site (we don't
            // want the popup on durable.corp.amazon.com; it's a side data source, not the
            // main Austin UI)
            var isDurable = window.location.hostname.indexOf('durable.corp.amazon.com') !== -1;
            if (lib.onboarding && !isDurable) {
                var showedOnboarding = lib.onboarding.showOnboardingWizard(function () {
                    // Onboarding complete callback \u2014 refresh everything
                    resetAllAndReprocess();

                    // Update the settings button label
                    var btn = document.getElementById('austin-settings-btn');
                    if (btn) {
                        var siteLabel = cfg.siteCode || 'No Site';
                        // Find the text node and update it
                        var firstText = btn.childNodes[0];
                        if (firstText && firstText.nodeType === 3) {
                            firstText.textContent = '\u2699\uFE0F WHS Incident Tools (' + siteLabel + ') ';
                        }
                    }
                });

                // If onboarding didn't show, check for what's new
                if (!showedOnboarding) {
                    lib.onboarding.showWhatsNew(false);
                }
            }

            // Fetch Drive-based hours data for RIR/FAIR
            if (lib.rir && lib.rir.fetchHoursFromDrive) {
                lib.rir.fetchHoursFromDrive();
            }

            // Initialize PIN mode panel (if enabled)
            if (lib.pin && cfg.showPinPanel !== false) {
                lib.pin.createPanel();
            }

            if (lib.rtw && lib.rtw.createPanel && cfg.showRTWPanel !== false) {
                lib.rtw.createPanel();
            }

            // RTW token harvest is now user-initiated only \u2014 click the \uD83D\uDD11 Get RTW Token
            // button inside the RTW panel when authentication is needed. The previous
            // automatic warm-up + 50-minute refresh interval was opening RTW portal tabs
            // unexpectedly while users were working, which was annoying and broke focus.
            // The panel surfaces a clear "Token Required" prompt when the token is stale,
            // so users always have an obvious manual path without random popups.

            // Apply panel visibility based on settings \u2014 must run AFTER all createPanel() calls
            handlePanelToggle();

            // Medical alert check if data is already cached
            if (lib.medicalAlert && state.bulkCaseData.size > 0 &&
                state.bulkDataTimestamp && (Date.now() - state.bulkDataTimestamp) < C.BULK_CACHE_DURATION) {
                setTimeout(function () {
                    lib.medicalAlert.checkAndShowMedicalAlert();
                }, 2000);
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDomReady);
        } else {
            onDomReady();
        }
    }

    initialize();

})();
