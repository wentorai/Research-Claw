/**
 * Install before any module scripts. ToDesk + Sogou Pinyin on macOS can leave a
 * fresh Chromium renderer's text input context cold: the candidate window
 * appears, but its committed text never reaches the page. In the reproduced
 * environment, consulting the native textarea state during pointer/focus
 * capture makes the first IME commit succeed. The exact upstream mechanism is
 * not observable from page JavaScript.
 *
 * This hook is read-only. It records nothing and never prevents an event.
 */
(function () {
  var params = new URLSearchParams(window.location.search);

  function warm(event) {
    var target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    void target.value;
    void target.selectionStart;
    void target.selectionEnd;
  }

  window.addEventListener('pointerdown', warm, true);
  window.addEventListener('focus', warm, true);

  if (params.get('ime-probe') !== 'full') return;

  var records = [];
  var types = [
    'keydown',
    'compositionstart',
    'compositionupdate',
    'beforeinput',
    'input',
    'compositionend',
    'keyup',
  ];

  function install(type, capture) {
    document.addEventListener(type, function (event) {
      var target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;

      records.push({
        type: event.type,
        phase: capture ? 'capture' : 'bubble',
        keyCode: typeof event.keyCode === 'number' ? event.keyCode : null,
        isComposing: Boolean(event.isComposing),
        inputType: event.inputType || null,
        dataLength: typeof event.data === 'string' ? event.data.length : null,
        valueLength: target.value.length,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
      });

      if (records.length > 200) records.shift();
    }, capture);
  }

  types.forEach(function (type) {
    install(type, true);
    install(type, false);
  });

  document.documentElement.dataset.rcImeProbe = 'full';
  window.__rcImeProbe = {
    mode: 'full',
    records: records,
  };
})();
