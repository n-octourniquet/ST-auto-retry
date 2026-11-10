// Auto Retry - SillyTavern extension
// Keeps regenerating until a response "succeeds" or you press Stop.
// Success = last message is from the AI, has at least `minChars` characters,
// and doesn't match the optional "reject" regex (e.g. refusals).

const MODULE = 'auto_retry';

const DEFAULTS = {
    enabled: false,
    maxAttempts: 0,      // 0 = unlimited
    delayMs: 1500,       // pause between attempts
    timeoutSec: 180,     // give up on a single attempt after this long
    minChars: 1,         // shorter than this = failure
    rejectRegex: '',     // e.g. I can't|I cannot|As an AI
    useSwipes: true,     // retry by swiping (keeps every attempt) instead of regenerate
};

const state = {
    active: false,       // a retry loop is running
    generating: false,   // an attempt is in flight
    attempts: 0,
    retryTimer: null,
    watchdog: null,
    poller: null,
    idlePolls: 0,
    selfStopping: false,
};

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extensionSettings[MODULE][k] === undefined) extensionSettings[MODULE][k] = v;
    }
    return extensionSettings[MODULE];
}

function save() {
    ctx().saveSettingsDebounced();
}

function setStatus(text) {
    $('#auto_retry_status').text(text);
    $('#auto_retry_float_label').text(text);
}

function showFloat(show) {
    $('#auto_retry_float').toggleClass('ar-hidden', !show);
}

// ---------- success check ----------

function lastMessageOk() {
    const s = settings();
    const { chat } = ctx();
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) return false;

    const text = String(last.mes ?? '').trim();
    if (text.length < Math.max(1, Number(s.minChars) || 1)) return false;

    if (s.rejectRegex) {
        try {
            if (new RegExp(s.rejectRegex, 'i').test(text)) return false;
        } catch (e) {
            console.warn('[AutoRetry] Invalid reject regex, ignoring it:', e);
        }
    }
    return true;
}

// ---------- loop control ----------

function clearTimers() {
    clearTimeout(state.retryTimer);
    clearTimeout(state.watchdog);
    clearInterval(state.poller);
    state.retryTimer = state.watchdog = state.poller = null;
}

function stopLoop(reason, level = 'info') {
    const wasActive = state.active;
    state.active = false;
    state.generating = false;
    state.attempts = 0;
    clearTimers();
    showFloat(false);
    setStatus(reason ? `Idle (${reason})` : 'Idle');
    if (wasActive && reason) toastr[level](reason, 'Auto Retry');
}

function startPolling() {
    clearInterval(state.poller);
    state.idlePolls = 0;
    // Some errors never emit GENERATION_ENDED. If the stop button disappears
    // while we think we're generating, treat the attempt as finished.
    state.poller = setInterval(() => {
        if (!state.active || !state.generating) return;
        if ($('#mes_stop').is(':visible')) {
            state.idlePolls = 0;
        } else if (++state.idlePolls >= 4) {
            onAttemptFinished();
        }
    }, 500);
}

function beginAttempt() {
    const s = settings();
    state.generating = true;
    state.idlePolls = 0;
    clearTimeout(state.watchdog);
    state.watchdog = setTimeout(() => {
        if (!state.active || !state.generating) return;
        console.warn('[AutoRetry] Attempt timed out');
        state.selfStopping = true;
        try { ctx().stopGeneration(); } catch (e) { /* ignore */ }
        setTimeout(() => { state.selfStopping = false; }, 1000);
        onAttemptFinished();
    }, Math.max(5, Number(s.timeoutSec) || 180) * 1000);
    startPolling();
    setStatus(`Attempt ${state.attempts}${s.maxAttempts > 0 ? ` / ${s.maxAttempts}` : ''}...`);
    showFloat(true);
}

function onAttemptFinished() {
    if (!state.active || !state.generating) return;
    state.generating = false;
    clearTimeout(state.watchdog);
    clearInterval(state.poller);

    // Give ST a moment to render/save the message before inspecting it.
    setTimeout(() => {
        if (!state.active) return;
        if (lastMessageOk()) {
            const n = state.attempts;
            stopLoop(`Success after ${n} attempt${n === 1 ? '' : 's'}`, 'success');
        } else {
            scheduleRetry();
        }
    }, 300);
}

function scheduleRetry() {
    const s = settings();
    if (s.maxAttempts > 0 && state.attempts >= s.maxAttempts) {
        stopLoop(`Gave up after ${state.attempts} attempts`, 'warning');
        return;
    }
    setStatus(`Attempt ${state.attempts} failed, retrying...`);
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => {
        if (!state.active) return;
        state.attempts++;
        triggerRegenerate();
    }, Math.max(0, Number(s.delayMs) || 0));
}

function lastIsAiMessage() {
    const { chat } = ctx();
    const last = chat[chat.length - 1];
    return !!last && !last.is_user && !last.is_system;
}

async function triggerRegenerate() {
    beginAttempt();
    try {
        // Swipe: pressing "next swipe" on the last swipe generates a new one and
        // keeps the earlier attempts. Needs an AI message to swipe on; if the last
        // message is the user's (e.g. the API errored before any reply), fall back
        // to a normal regenerate.
        if (settings().useSwipes && lastIsAiMessage()) {
            const btn = $('#chat .last_mes .swipe_right').last();
            if (btn.length) {
                btn.trigger('click');
                return;
            }
        }
        const c = ctx();
        if (typeof c.generate === 'function') {
            await c.generate('regenerate');
        } else {
            $('#option_regenerate').trigger('click');
        }
    } catch (e) {
        console.error('[AutoRetry] Retry threw:', e);
        onAttemptFinished();
    }
}

// ---------- event wiring ----------

function onGenerationStarted(type, _params, dryRun) {
    const s = settings();
    if (!s.enabled || dryRun) return;
    if (type === 'quiet' || type === 'impersonate') return;

    if (!state.active) {
        state.active = true;
        state.attempts = 1;
    }
    beginAttempt();
}

function onGenerationStopped() {
    if (!state.active || state.selfStopping) return;
    stopLoop('Stopped by you');
}

function onGenerationEnded() {
    onAttemptFinished();
}

jQuery(async () => {
    const { eventSource, event_types } = ctx();
    const s = settings();

    const html = `
    <div class="auto-retry-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Auto Retry</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="auto_retry_enabled" type="checkbox" />
                    <span>Enable (retry until a response succeeds)</span>
                </label>

                <label class="checkbox_label">
                    <input id="auto_retry_swipes" type="checkbox" />
                    <span>Retry as swipes (keep every attempt)</span>
                </label>

                <label for="auto_retry_max">Max attempts (0 = unlimited)</label>
                <input id="auto_retry_max" class="text_pole" type="number" min="0" step="1" />

                <label for="auto_retry_delay">Delay between attempts (ms)</label>
                <input id="auto_retry_delay" class="text_pole" type="number" min="0" step="100" />

                <label for="auto_retry_timeout">Per-attempt timeout (seconds)</label>
                <input id="auto_retry_timeout" class="text_pole" type="number" min="5" step="5" />

                <label for="auto_retry_minchars">Minimum response length (characters)</label>
                <input id="auto_retry_minchars" class="text_pole" type="number" min="1" step="1" />

                <label for="auto_retry_regex">Reject if response matches regex (optional, case-insensitive)</label>
                <input id="auto_retry_regex" class="text_pole" type="text"
                       placeholder="I can't|I cannot|as an AI" />

                <div class="ar-row">
                    <input id="auto_retry_stop" class="menu_button" type="button" value="Stop retrying" />
                    <span id="auto_retry_status">Idle</span>
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('body').append(`
        <div id="auto_retry_float" class="ar-hidden">
            <span id="auto_retry_float_label">Retrying...</span>
            <button id="auto_retry_float_stop" class="menu_button">Stop</button>
        </div>`);

    $('#auto_retry_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = $(this).prop('checked');
        if (!s.enabled && state.active) stopLoop('Disabled');
        save();
    });
    $('#auto_retry_swipes').prop('checked', s.useSwipes).on('change', function () {
        s.useSwipes = $(this).prop('checked');
        save();
    });
    const bindNum = (sel, key, min) => $(sel).val(s[key]).on('input', function () {
        const v = Number($(this).val());
        s[key] = Number.isFinite(v) ? Math.max(min, v) : DEFAULTS[key];
        save();
    });
    bindNum('#auto_retry_max', 'maxAttempts', 0);
    bindNum('#auto_retry_delay', 'delayMs', 0);
    bindNum('#auto_retry_timeout', 'timeoutSec', 5);
    bindNum('#auto_retry_minchars', 'minChars', 1);
    $('#auto_retry_regex').val(s.rejectRegex).on('input', function () {
        s.rejectRegex = String($(this).val());
        save();
    });

    const manualStop = () => {
        if (!state.active) return;
        state.selfStopping = true;
        try { ctx().stopGeneration(); } catch (e) { /* ignore */ }
        setTimeout(() => { state.selfStopping = false; }, 1000);
        stopLoop('Stopped by you');
    };
    $('#auto_retry_stop, #auto_retry_float_stop').on('click', manualStop);

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    // Switching chats aborts any running loop.
    eventSource.on(event_types.CHAT_CHANGED, () => { if (state.active) stopLoop('Chat changed'); });

    console.log('[AutoRetry] loaded');
});
