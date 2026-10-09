import { describe, expect, it } from 'vitest';
import { hasControlChars, isControlCode, replaceControlChars } from '../../src/shared/safety';
import { safeFileStem } from '../../src/shared/fileName';
import { cleanName } from '../../src/engine/contacts/text';
import { safeFileName, makeSnippet } from '../../src/engine/messages/bodyUtils';
import { validateFolderName } from '../../src/engine/folders/folderService';
import { findMailtoArg } from '../../src/main/mailto';

describe('control characters', () => {
  it('knows C0 controls and DEL, nothing else', () => {
    expect(isControlCode(0)).toBe(true);
    expect(isControlCode(0x1f)).toBe(true);
    expect(isControlCode(0x7f)).toBe(true);
    expect(isControlCode(0x20)).toBe(false);
    expect(isControlCode(0x7e)).toBe(false);
    expect(isControlCode(0x85)).toBe(false);
  });

  it('finds and replaces them', () => {
    expect(hasControlChars('plain text à 会')).toBe(false);
    expect(hasControlChars('a\nb')).toBe(true);
    expect(hasControlChars('a\u0000b')).toBe(true);
    expect(hasControlChars('a\u007fb')).toBe(true);
    expect(replaceControlChars('a\tb\r\nc\u007f')).toBe('abc');
    expect(replaceControlChars('a\tb\nc', ' ')).toBe('a b c');
    expect(replaceControlChars('')).toBe('');
  });

  it('is used where text becomes a name', () => {
    expect(safeFileStem('Re:\tBudget\n2026', 'x')).toBe('Re_ Budget 2026');
    expect(safeFileStem('a\u0001b', 'x')).toBe('a_b');
    expect(cleanName('Anna\u0000\tRossi', 'anna@x.it')).toBe('Anna Rossi');
    expect(safeFileName('re\u0001port.pdf')).toBe('re_port.pdf');
    expect(() => validateFolderName('bad\u0001name', '/')).toThrow();
    expect(validateFolderName('Good name', '/')).toBe('Good name');
    expect(findMailtoArg(['app.exe', 'mailto:a@b.it\r\nBcc: x@y.it'])).toBeNull();
    expect(findMailtoArg(['app.exe', 'mailto:a@b.it'])).toBe('mailto:a@b.it');
  });

  it('snippets drop invisible padding characters', () => {
    expect(makeSnippet(null, '<p>Hello​‌͏­ world️﻿</p>')).toBe('Hello world');
  });
});
