export type ModuleLocation = { categoryId: string; endOffset: number };
export type ModuleBlock = ModuleLocation & { startOffset: number; bodyStart: number; bodyEnd: number };

const beginPattern = /^;={5,}[ \t]+schemeTCAD:begin[ \t]+([A-Za-z0-9_-]+)[ \t]*$/;
const endPattern = /^;={5,}[ \t]+schemeTCAD:end[ \t]+([A-Za-z0-9_-]+)[ \t]*$/;

export function createModuleBlock(categoryId: string, label: string, eol: string): { text: string; cursorOffset: number } {
  const heading = `;===== schemeTCAD:begin ${categoryId}${eol}; ${label}${eol}`;
  return {
    text: `${heading}${eol};===== schemeTCAD:end ${categoryId}${eol}`,
    cursorOffset: heading.length
  };
}

export function listModules(text: string): ModuleBlock[] {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  const modules: ModuleBlock[] = [];
  let lineOffset = 0;
  let active: { categoryId: string; startOffset: number; bodyStart: number } | undefined;
  for (const rawLine of lines) {
    if (!rawLine) { continue; }
    const line = rawLine.replace(/\r?\n$|\r$/, '');
    const start = line.match(beginPattern);
    if (start) { active = { categoryId: start[1], startOffset: lineOffset, bodyStart: lineOffset + rawLine.length }; }
    const end = line.match(endPattern);
    if (end && active?.categoryId === end[1]) {
      modules.push({ ...active, bodyEnd: lineOffset, endOffset: lineOffset + rawLine.length });
      active = undefined;
    }
    lineOffset += rawLine.length;
  }
  return modules;
}

export function findModuleAt(text: string, offset: number): ModuleLocation | undefined {
  const found = listModules(text).find(module => offset >= module.startOffset && offset < module.endOffset);
  return found && { categoryId: found.categoryId, endOffset: found.endOffset };
}

export function planModuleInsertion(text: string, offset: number, eol: string): { offset: number; prefix: string } {
  const current = findModuleAt(text, offset);
  if (current) {
    const atEnd = current.endOffset === text.length;
    return { offset: current.endOffset, prefix: atEnd && !text.endsWith(eol) ? eol : '' };
  }
  const previousBreak = offset === 0 ? -1 : text.lastIndexOf('\n', offset - 1);
  const lineStart = previousBreak + 1;
  const nextBreak = text.indexOf('\n', offset);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
  if (!line.trim()) { return { offset: lineStart, prefix: '' }; }
  if (nextBreak >= 0) { return { offset: nextBreak + 1, prefix: '' }; }
  return { offset: text.length, prefix: text.endsWith(eol) ? '' : eol };
}
