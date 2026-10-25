async function copyText(value, doc) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; } } catch { /* Older browsers may need the local copy fallback. */ }
  const previous = doc.activeElement, area = doc.createElement('textarea'); area.value = value; area.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'; area.setAttribute('aria-label', '复制代码'); doc.body.append(area);
  area.focus({ preventScroll: true }); area.select(); let copied = false;
  try { copied = Boolean(doc.execCommand?.('copy')); } catch { copied = false; }
  area.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); return copied;
}
export function attachCodeUI(editor, host) {
  const doc = host.ownerDocument, article = host.closest('[data-block]'), overlay = doc.createElement('div'); overlay.className = 'code-tools'; overlay.contentEditable = 'false'; article.append(overlay);
  const buttons = new Map(); let frame = 0, destroyed = false;
  function update() {
    frame = 0; if (destroyed) return;
    const blocks = [...host.querySelectorAll('pre')], base = article.getBoundingClientRect();
    for (const [pre, record] of buttons) if (!blocks.includes(pre)) { clearTimeout(record.timer); record.button.remove(); buttons.delete(pre); }
    for (const pre of blocks) {
      if (!buttons.has(pre)) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'code-copy-button'; button.title = '复制代码'; button.setAttribute('aria-label', '复制代码'); button.innerHTML = '<svg aria-hidden="true"><use href="#i-copy"></use></svg><span class="code-copy-feedback" aria-live="polite"></span>';
        const record = { button, timer: null }; buttons.set(pre, record); overlay.append(button);
        button.addEventListener('pointerdown', event => event.preventDefault());
        button.addEventListener('click', async event => {
          event.preventDefault(); const content = pre.querySelector('code')?.textContent ?? pre.textContent, success = await copyText(content, doc);
          if (!button.isConnected) return;
          button.dataset.copied = String(success); button.title = success ? '已复制代码' : '复制未成功，请手动选择代码'; button.setAttribute('aria-label', button.title); button.querySelector('span').textContent = success ? '已复制' : '复制未成功';
          clearTimeout(record.timer); record.timer = setTimeout(() => { button.removeAttribute('data-copied'); button.title = '复制代码'; button.setAttribute('aria-label', '复制代码'); button.querySelector('span').textContent = ''; }, 1800);
        });
      }
      const box = pre.getBoundingClientRect(), button = buttons.get(pre).button;
      button.style.left = `${Math.max(0, box.right - base.left - 36)}px`; button.style.top = `${Math.max(0, box.top - base.top + 7)}px`;
    }
  }
  function schedule() { if (!destroyed && !frame) frame = requestAnimationFrame(update); }
  editor.on('transaction', schedule); window.addEventListener('resize', schedule); update();
  return () => { destroyed = true; cancelAnimationFrame(frame); editor.off('transaction', schedule); window.removeEventListener('resize', schedule); for (const record of buttons.values()) clearTimeout(record.timer); buttons.clear(); overlay.remove(); };
}
