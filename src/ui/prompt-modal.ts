// 通用自定义弹窗 —— 替代原生 window.prompt / window.confirm。
//
// 视觉与动画复刻 score-preview-modal(.pm-overlay > .pm-card,.open/.closing 类
// 切换 + 160ms 过渡)。返回 Promise,调用方 await 即可:
//   const v = await modal.promptText({ title:'重命名', initial:'foo' }); // null=取消
//   const ok = await modal.confirm({ title:'删除?', message:'不可撤销', danger:true });

import './prompt-modal.css';

export interface PromptTextOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  cancelText?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptModalHandle {
  /** 文本输入弹窗。resolve(用户输入的 trim 值,可能为空串);取消 resolve(null)。 */
  promptText: (opts: PromptTextOptions) => Promise<string | null>;
  /** 确认弹窗。确认 resolve(true),取消 resolve(false)。 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** 当前是否有弹窗打开。 */
  isOpen: () => boolean;
}

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export function buildPromptModal(): PromptModalHandle {
  let overlay: HTMLElement | null = null;
  let resolver: ((v: string | null | boolean) => void) | null = null;
  /** IME 合成态:为 true 时忽略回车提交(避免中文输入法选词回车误提交)。 */
  let composing = false;

  /** 关闭并 resolve。v: 传值(null/false/true/string);nully 表示取消类。 */
  const close = (v: string | null | boolean): void => {
    if (!overlay) return;
    const el = overlay;
    const res = resolver;
    overlay = null;
    resolver = null;
    composing = false;
    el.classList.remove('open');
    el.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => el.remove(), 160);
    if (res) res(v);
  };

  function onKey(e: KeyboardEvent): void {
    if (!overlay) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      const input = overlay.querySelector('.pm-input') as HTMLInputElement | null;
      if (input) close(null);
      else close(false);
    } else if (e.key === 'Enter' && !composing) {
      e.preventDefault();
      const input = overlay.querySelector('.pm-input') as HTMLInputElement | null;
      if (input) {
        const val = (input.value || '').trim();
        close(val);
      } else {
        close(true);
      }
    }
  }

  /** 通用构建:isInput 决定是否有输入框。 */
  const open = (
    opts: { title: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean },
    isInput: boolean,
    initial: string,
    placeholder: string,
  ): Promise<string | null | boolean> => {
    // 已有弹窗打开:先关掉(放弃),再开新的。
    if (overlay) close(null);
    return new Promise(resolve => {
      resolver = resolve;
      overlay = document.createElement('div');
      overlay.className = 'pm-overlay';

      const card = document.createElement('div');
      card.className = 'pm-card';

      // 头部
      const head = document.createElement('div');
      head.className = 'pm-head';
      const title = document.createElement('span');
      title.className = 'pm-title';
      title.textContent = opts.title;
      head.appendChild(title);
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'pm-close';
      closeBtn.innerHTML = CLOSE_ICON;
      closeBtn.title = '取消';
      closeBtn.onclick = (e) => { e.stopPropagation(); close(isInput ? null : false); };
      head.appendChild(closeBtn);
      card.appendChild(head);

      // 消息
      if (opts.message) {
        const msg = document.createElement('p');
        msg.className = 'pm-message';
        msg.textContent = opts.message;
        card.appendChild(msg);
      }

      // 输入框(仅 promptText)
      let input: HTMLInputElement | null = null;
      if (isInput) {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'pm-input';
        input.value = initial;
        input.placeholder = placeholder || '';
        // IME 守卫
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; });
        card.appendChild(input);
      }

      // 操作按钮
      const actions = document.createElement('div');
      actions.className = 'pm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pm-btn cancel';
      cancel.textContent = opts.cancelText || '取消';
      cancel.onclick = (e) => { e.stopPropagation(); close(isInput ? null : false); };
      actions.appendChild(cancel);
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'pm-btn confirm' + (opts.danger ? ' danger' : '');
      ok.textContent = opts.confirmText || (isInput ? '确定' : '确认');
      ok.onclick = (e) => {
        e.stopPropagation();
        if (isInput && input) close((input.value || '').trim());
        else close(true);
      };
      actions.appendChild(ok);
      card.appendChild(actions);

      overlay.appendChild(card);
      // 点遮罩空白取消;点卡片不取消。
      overlay.onclick = (e) => { if (e.target === overlay) close(isInput ? null : false); };
      document.body.appendChild(overlay);

      document.addEventListener('keydown', onKey);
      // 入场动画
      requestAnimationFrame(() => overlay?.classList.add('open'));
      // 聚焦:有输入框聚焦并全选;否则聚焦确认按钮(便于直接回车)。
      requestAnimationFrame(() => {
        if (input) {
          input.focus();
          input.select();
        } else {
          ok.focus();
        }
      });
    });
  };

  return {
    promptText: (opts) =>
      open(opts, true, opts.initial ?? '', opts.placeholder ?? '') as Promise<string | null>,
    confirm: (opts) =>
      open(opts, false, '', '') as Promise<boolean>,
    isOpen: () => overlay !== null,
  };
}
