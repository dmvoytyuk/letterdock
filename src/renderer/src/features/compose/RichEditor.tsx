import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import DOMPurify from 'dompurify';
import { Icon, type IconName } from '../../components/Icon';
import { escapeHtml } from '../../lib/format';

// Only plain formatting survives a paste or a draft reload (no scripts, no foreign styles).
const purify = DOMPurify(window);
const PASTE_TAGS = ['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'br', 'div', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'pre', 'code', 'span'];

function cleanPaste(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_TAGS: PASTE_TAGS,
    ALLOWED_ATTR: ['href'],
    ALLOW_DATA_ATTR: false,
  });
}

/** Draft content from the engine or an earlier save: keep classes and quote styles, drop anything unsafe. */
function cleanDraft(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_TAGS: PASTE_TAGS.concat(['hr', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'font', 'sub', 'sup']),
    ALLOWED_ATTR: ['href', 'class', 'style', 'type', 'dir', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}

export interface RichEditorHandle {
  getHtml: () => string;
  /** Text the user wrote: without the quoted original and the signature. */
  getOwnText: () => string;
  getText: () => string;
  focusStart: () => void;
  focus: () => void;
  /** Replace the signature block when the From account changes. Returns true if swapped. */
  swapSignature: (oldHtml: string, newHtml: string) => boolean;
  exec: (cmd: 'bold' | 'italic' | 'underline' | 'strike' | 'ul' | 'ol' | 'indent' | 'outdent' | 'quote' | 'clear') => void;
  /** Remember the selection (before a dialog steals focus). */
  saveSelection: () => void;
  selectedText: () => string;
  insertLink: (url: string, text?: string) => void;
}

interface Props {
  initialHtml: string;
  onChange: () => void;
  onFiles: (files: File[]) => void;
  onToolbarState: (s: ToolbarState) => void;
  label: string;
}

export type ToolbarState = Partial<Record<'bold' | 'italic' | 'underline' | 'strike' | 'ul' | 'ol' | 'quote', boolean>>;

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  { initialHtml, onChange, onFiles, onToolbarState, label },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const plainNext = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    el.current.innerHTML = cleanDraft(initialHtml);
    document.execCommand('styleWithCSS', false, 'false');
    // Run once per draft: the editor owns its content after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inEditor = (n: Node | null) => !!n && !!el.current && el.current.contains(n);

  const reportState = useCallback(() => {
    const sel = document.getSelection();
    if (!sel || !inEditor(sel.anchorNode)) return;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    onToolbarState({
      bold: q('bold'),
      italic: q('italic'),
      underline: q('underline'),
      strike: q('strikeThrough'),
      ul: q('insertUnorderedList'),
      ol: q('insertOrderedList'),
      quote: !!node?.closest('blockquote'),
    });
  }, [onToolbarState]);

  useEffect(() => {
    document.addEventListener('selectionchange', reportState);
    return () => document.removeEventListener('selectionchange', reportState);
  }, [reportState]);

  useImperativeHandle(
    ref,
    () => ({
      getHtml: () => el.current?.innerHTML ?? '',
      getText: () => el.current?.innerText ?? '',
      getOwnText: () => {
        if (!el.current) return '';
        const clone = el.current.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('blockquote, .letterdock-signature, .letterdock-quote-intro, .mailroom-signature, .mailroom-quote-intro').forEach((n) => n.remove());
        return clone.textContent ?? '';
      },
      focusStart: () => {
        const e = el.current;
        if (!e) return;
        e.focus();
        const r = document.createRange();
        r.setStart(e, 0);
        r.collapse(true);
        const s = document.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
      },
      focus: () => el.current?.focus(),
      swapSignature: (oldHtml, newHtml) => {
        const e = el.current;
        const block = e?.querySelector<HTMLElement>('.letterdock-signature, .mailroom-signature');
        if (!e) return false;
        const norm = (h: string) => {
          const d = document.createElement('div');
          d.innerHTML = cleanDraft(h);
          return (d.textContent ?? '').replace(/\s+/g, ' ').trim();
        };
        if (!block) return false;
        // Only replace a signature the user has not edited.
        if (norm(block.outerHTML) !== norm(oldHtml)) return false;
        if (newHtml) {
          const d = document.createElement('div');
          d.innerHTML = cleanDraft(newHtml);
          block.replaceWith(...Array.from(d.childNodes));
        } else {
          block.remove();
        }
        onChange();
        return true;
      },
      exec: (cmd) => {
        el.current?.focus();
        switch (cmd) {
          case 'bold':
            document.execCommand('bold');
            break;
          case 'italic':
            document.execCommand('italic');
            break;
          case 'underline':
            document.execCommand('underline');
            break;
          case 'strike':
            document.execCommand('strikeThrough');
            break;
          case 'ul':
            document.execCommand('insertUnorderedList');
            break;
          case 'ol':
            document.execCommand('insertOrderedList');
            break;
          case 'indent':
            document.execCommand('indent');
            break;
          case 'outdent':
            document.execCommand('outdent');
            break;
          case 'quote': {
            const sel = document.getSelection();
            const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
            document.execCommand('formatBlock', false, node?.closest('blockquote') ? 'div' : 'blockquote');
            break;
          }
          case 'clear':
            document.execCommand('removeFormat');
            document.execCommand('unlink');
            break;
        }
        onChange();
        reportState();
      },
      saveSelection: () => {
        const s = document.getSelection();
        saved.current = s && s.rangeCount > 0 && inEditor(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
      },
      selectedText: () => saved.current?.toString() ?? '',
      insertLink: (url, text) => {
        const e = el.current;
        if (!e) return;
        e.focus();
        const s = document.getSelection();
        if (saved.current) {
          s?.removeAllRanges();
          s?.addRange(saved.current);
        }
        const collapsed = !s || s.isCollapsed;
        if (collapsed) {
          const label = escapeHtml(text?.trim() || url);
          document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}">${label}</a>`);
        } else {
          document.execCommand('createLink', false, url);
        }
        onChange();
      },
    }),
    [onChange, reportState],
  );

  return (
    <div
      ref={el}
      className="editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      spellCheck
      onInput={onChange}
      onKeyDown={(e) => {
        plainNext.current = e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v';
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
          // Tab inside a list indents; elsewhere it moves on to the next control.
          const sel = document.getSelection();
          const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
          if (node?.closest('li')) {
            e.preventDefault();
            document.execCommand('indent');
          }
        }
      }}
      onPaste={(e) => {
        const cd = e.clipboardData;
        const plain = plainNext.current;
        plainNext.current = false;
        const files = Array.from(cd.files);
        const html = cd.getData('text/html');
        const text = cd.getData('text/plain');
        if (files.length > 0 && !html && !text) {
          e.preventDefault();
          onFiles(files);
          return;
        }
        if (plain && text) {
          e.preventDefault();
          document.execCommand('insertText', false, text);
          return;
        }
        if (html) {
          e.preventDefault();
          const clean = cleanPaste(html);
          if (clean.trim()) document.execCommand('insertHTML', false, clean);
          else if (text) document.execCommand('insertText', false, text);
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          onFiles(Array.from(e.dataTransfer.files));
        }
      }}
    />
  );
});

const FMT: { cmd: Parameters<RichEditorHandle['exec']>[0]; icon?: IconName; text?: string; label: string; key?: keyof ToolbarState; keys?: string }[] = [
  { cmd: 'bold', text: 'B', label: 'Bold', key: 'bold', keys: 'Ctrl+B' },
  { cmd: 'italic', text: 'I', label: 'Italic', key: 'italic', keys: 'Ctrl+I' },
  { cmd: 'underline', text: 'U', label: 'Underline', key: 'underline', keys: 'Ctrl+U' },
  { cmd: 'strike', text: 'S', label: 'Strikethrough', key: 'strike' },
];

/** The formatting bar under the subject. */
export function FormatBar({
  state,
  onExec,
  onLink,
}: {
  state: ToolbarState;
  onExec: (cmd: Parameters<RichEditorHandle['exec']>[0]) => void;
  onLink: () => void;
}) {
  // Buttons must not steal focus from the editor, or the selection is lost.
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="fbar" role="toolbar" aria-label="Formatting">
      {FMT.map((f) => (
        <button
          key={f.cmd}
          type="button"
          className={`ibtn sm fmt-${f.cmd} ${f.key && state[f.key] ? 'on' : ''}`}
          aria-label={f.label}
          aria-pressed={f.key ? !!state[f.key] : undefined}
          title={f.keys ? `${f.label} (${f.keys})` : f.label}
          onMouseDown={keep}
          onClick={() => onExec(f.cmd)}
        >
          {f.text}
        </button>
      ))}
      <span className="tsep" />
      <button type="button" className={`ibtn sm ${state.ul ? 'on' : ''}`} aria-label="Bulleted list" aria-pressed={!!state.ul} title="Bulleted list" onMouseDown={keep} onClick={() => onExec('ul')}>
        <Icon name="list" />
      </button>
      <button type="button" className={`ibtn sm ${state.ol ? 'on' : ''}`} aria-label="Numbered list" aria-pressed={!!state.ol} title="Numbered list" onMouseDown={keep} onClick={() => onExec('ol')}>
        <span className="fmt-ol">1.</span>
      </button>
      <button type="button" className="ibtn sm" aria-label="Increase indent" title="Increase indent" onMouseDown={keep} onClick={() => onExec('indent')}>
        <span className="fmt-ol">&rarr;</span>
      </button>
      <button type="button" className="ibtn sm" aria-label="Decrease indent" title="Decrease indent" onMouseDown={keep} onClick={() => onExec('outdent')}>
        <span className="fmt-ol">&larr;</span>
      </button>
      <span className="tsep" />
      <button type="button" className={`ibtn sm ${state.quote ? 'on' : ''}`} aria-label="Quote" aria-pressed={!!state.quote} title="Quote" onMouseDown={keep} onClick={() => onExec('quote')}>
        <span className="fmt-ol">&ldquo;</span>
      </button>
      <button type="button" className="ibtn sm" aria-label="Insert link (Ctrl+K)" title="Insert link (Ctrl+K)" onMouseDown={keep} onClick={onLink}>
        <Icon name="link" />
      </button>
      <span className="tsep" />
      <button type="button" className="ibtn sm" aria-label="Clear formatting" title="Clear formatting" onMouseDown={keep} onClick={() => onExec('clear')}>
        <span className="fmt-ol">Tx</span>
      </button>
    </div>
  );
}
