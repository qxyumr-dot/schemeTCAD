import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { scanSymbols } from './symbols';
import { createModuleBlock, findModuleAt, planModuleInsertion } from './modules';
import { buildOverview } from './overview';

type Parameter = {
  id: string;
  label: string;
  description: string;
  type: 'scheme_expr' | 'scheme_string' | 'enum';
  required: boolean;
  default?: string;
  example?: string;
  choices?: string[];
  code_values?: Record<string, string>;
  suggestion_source?: string;
};

type FunctionEntry = {
  id: string;
  category: string;
  name: string;
  label: string;
  description: string;
  template: string;
  parameters: Parameter[];
  requires?: string[];
};

type Category = { id: string; label: string; order: number };
type Catalog = { categories: Category[]; functions: FunctionEntry[]; suggestion_lists: Record<string, string[]> };

function loadCatalog(extensionPath: string): Catalog {
  const folder = path.join(extensionPath, 'function-library');
  const files = fs.readdirSync(folder).filter(name => name.toLowerCase().endsWith('.txt')).sort();
  if (files.length === 0) { throw new Error('function-library 文件夹中没有 TXT 函数库'); }
  const categoryMap = new Map<string, Category>();
  const functionMap = new Map<string, FunctionEntry>();
  const suggestionLists: Record<string, string[]> = {};

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as Record<string, unknown>;
    if (raw.format !== 'sde-function-catalog' || raw.schema_version !== 1 ||
      !Array.isArray(raw.categories) || !Array.isArray(raw.functions)) {
      throw new Error(`${file}: 函数库格式或版本不正确`);
    }
    if (raw.suggestion_lists && typeof raw.suggestion_lists === 'object') {
      for (const [key, value] of Object.entries(raw.suggestion_lists)) {
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
          suggestionLists[key] = [...new Set([...(suggestionLists[key] ?? []), ...value])];
        }
      }
    }
    for (const item of raw.categories) {
      const category = item as Category;
      if (typeof category.id !== 'string' || typeof category.label !== 'string' ||
        typeof category.order !== 'number') { throw new Error(`${file}: 分类信息不完整`); }
      const previous = categoryMap.get(category.id);
      if (previous && previous.label !== category.label) { throw new Error(`${file}: 分类 ${category.id} 重复且名称不同`); }
      categoryMap.set(category.id, category);
    }
    for (const item of raw.functions) {
      const entry = item as FunctionEntry;
      if (typeof entry.id !== 'string' || typeof entry.category !== 'string' ||
        typeof entry.name !== 'string' || typeof entry.label !== 'string' ||
        typeof entry.template !== 'string' || !Array.isArray(entry.parameters)) {
        throw new Error(`${file}: 函数信息不完整`);
      }
      if (functionMap.has(entry.id)) { throw new Error(`${file}: 函数 ID ${entry.id} 重复`); }
      const ids = new Set<string>();
      for (const parameter of entry.parameters) {
        if (!parameter || typeof parameter.id !== 'string' || typeof parameter.label !== 'string' ||
          !['scheme_expr', 'scheme_string', 'enum'].includes(parameter.type)) {
          throw new Error(`${file}: ${entry.id} 的参数定义有误`);
        }
        if (ids.has(parameter.id)) { throw new Error(`${file}: ${entry.id} 有重复参数 ${parameter.id}`); }
        if (parameter.type === 'enum' && (!Array.isArray(parameter.choices) || !parameter.choices.length ||
          !parameter.choices.every(choice => typeof choice === 'string') ||
          (parameter.code_values && Object.keys(parameter.code_values).some(choice => !parameter.choices?.includes(choice))))) {
          throw new Error(`${file}: ${entry.id} 的选项定义有误`);
        }
        ids.add(parameter.id);
      }
      const placeholders = [...entry.template.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map(match => match[1]);
      if (placeholders.some(id => !ids.has(id)) || [...ids].some(id => !placeholders.includes(id))) {
        throw new Error(`${file}: ${entry.id} 的模板占位符与参数不一致`);
      }
      functionMap.set(entry.id, entry);
    }
  }

  const categories = [...categoryMap.values()].sort((a, b) => a.order - b.order);
  const functions = [...functionMap.values()];
  for (const entry of functions) {
    if (!categoryMap.has(entry.category)) { throw new Error(`${entry.id}: 找不到分类 ${entry.category}`); }
  }
  return { categories, functions, suggestion_lists: suggestionLists };
}

function renderCode(entry: FunctionEntry, values: Record<string, unknown>): string {
  const rendered = new Map<string, string>();
  for (const parameter of entry.parameters) {
    const raw = values[parameter.id] ?? parameter.default ?? '';
    if (typeof raw !== 'string') { throw new Error(`${parameter.label} 必须是文本`); }
    const value = raw.trim();
    if (parameter.required && !value) { throw new Error(`请填写：${parameter.label}`); }
    if (parameter.type === 'enum') {
      if (!parameter.choices?.includes(value)) { throw new Error(`${parameter.label} 不在可选项中`); }
      rendered.set(parameter.id, parameter.code_values?.[value] ?? value);
    } else if (parameter.type === 'scheme_string') {
      if (/[\r\n]/.test(value)) { throw new Error(`${parameter.label} 不能包含换行`); }
      rendered.set(parameter.id, value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    } else {
      if (!/^[A-Za-z0-9_@+*().\s\x2f-]+$/.test(value)) {
        throw new Error(`${parameter.label} 包含不支持的 Scheme 表达式字符`);
      }
      let depth = 0;
      for (const char of value) {
        if (char === '(') { depth++; }
        if (char === ')') { depth--; }
        if (depth < 0) { throw new Error(`${parameter.label} 的括号不匹配`); }
      }
      if (depth !== 0) { throw new Error(`${parameter.label} 的括号不匹配`); }
      rendered.set(parameter.id, value);
    }
  }
  return entry.template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, id: string) => rendered.get(id) ?? '');
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px;display:flex;flex-direction:column;height:100vh;box-sizing:border-box;overflow:hidden}
[hidden]{display:none!important}
h2{margin:0 0 8px}#hint{margin:0 0 8px;color:var(--vscode-descriptionForeground)}
#choices{overflow:auto;flex:1;min-height:0}button.item{display:block;width:100%;text-align:left;padding:9px 12px;margin:3px 0;background:transparent;color:var(--vscode-foreground);border:1px solid transparent;cursor:pointer}
button.item.active,button.item:hover{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
#parameters{overflow-y:auto;flex:1 1 auto;min-height:110px}.field{margin-bottom:12px}.field label{display:block;margin-bottom:4px}.field small{display:block;color:var(--vscode-descriptionForeground);margin-top:5px;line-height:1.35}
.field.active{border-left:3px solid var(--vscode-focusBorder);padding-left:9px}
.field input,.field select{width:100%;box-sizing:border-box;padding:7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
.suggestions{border:1px solid var(--vscode-panel-border);margin-top:6px;padding:6px;max-height:105px;overflow:auto}.suggestions strong{display:block;font-size:12px;margin-bottom:4px;color:var(--vscode-descriptionForeground)}
.suggestions button{display:inline-block;margin:2px;padding:3px 6px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;cursor:pointer}.suggestions button:hover{outline:1px solid var(--vscode-focusBorder)}
#actions{display:flex;gap:8px;margin:7px 0;flex:none}#actions button{padding:7px 13px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}
#previewBox{border-top:1px solid var(--vscode-panel-border);padding-top:8px;flex:none}
#preview{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);padding:8px;min-height:28px;max-height:85px;overflow:auto;margin:6px 0}
#error{min-height:20px;color:var(--vscode-errorForeground)}
#error:empty{display:none}
</style></head><body>
<h2 id="title">Scheme 辅助</h2><p id="hint"></p>
<div id="choices"></div><div id="parameters" hidden></div>
<div id="actions"><button id="back" hidden>返回</button><button id="insert" hidden>插入代码 (Enter)</button></div>
<div id="previewBox"><strong>当前生成的语句</strong><pre id="preview">选择分类和函数后显示预览</pre><div id="error" role="alert"></div></div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

function overviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'overview.js'));
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:14px;box-sizing:border-box;margin:0}
h2{margin:0 0 4px;font-size:17px}#filename{color:var(--vscode-descriptionForeground);font-size:12px;overflow-wrap:anywhere;margin-bottom:14px}
.section-title{font-weight:600;margin:12px 0 7px}.module-list{border:1px solid var(--vscode-panel-border);padding:10px;display:grid;gap:7px}
.module{border:1px solid var(--vscode-panel-border);padding:9px;display:flex;align-items:center;gap:9px;min-height:22px}
.module .mark{font-size:17px;width:21px;text-align:center}.module.done .mark{color:var(--vscode-testing-iconPassed)}
.module small{display:block;color:var(--vscode-descriptionForeground);margin-top:2px}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:15px}
.card{border:1px solid var(--vscode-panel-border);min-height:115px;padding:9px;overflow-wrap:anywhere}
.card h3{font-size:13px;margin:0 0 7px}.card .item{padding:5px 0;border-top:1px solid var(--vscode-panel-border)}
.card .item:first-of-type{border-top:0}.card .name{font-weight:600}.card .detail{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:2px}
.empty{color:var(--vscode-descriptionForeground);font-size:12px}
@media(max-width:460px){.cards{grid-template-columns:1fr}}
</style></head><body>
<h2>SDE 文件概览</h2><div id="filename"></div>
<div class="section-title" id="progress">模块进度</div><div class="module-list" id="modules"></div>
<div class="cards" id="cards"></div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let overviewPanel: vscode.WebviewPanel | undefined;
  let overviewUri: vscode.Uri | undefined;
  const overviewOpenedFiles = new Set<string>();
  let catalog: Catalog | undefined;
  let target: { uri: vscode.Uri; position: vscode.Position; offset: number; column: vscode.ViewColumn } | undefined;
  let lastCodeEditor: vscode.TextEditor | undefined;
  let inserting = false;
  let programmaticEditorFocus = 0;
  let lastNavigationKey: string | undefined;
  let navigationSerial = 0;

  function navigationKey(document: vscode.TextDocument, offset: number): string {
    return `${document.uri.toString()}|${document.version}|${offset}`;
  }

  async function sendOverview(): Promise<void> {
    if (!overviewPanel || !overviewUri || !catalog) { return; }
    const uri = overviewUri;
    const document = await vscode.workspace.openTextDocument(uri);
    if (overviewUri.toString() !== uri.toString()) { return; }
    await overviewPanel.webview.postMessage({
      type: 'snapshot',
      fileName: path.basename(uri.path) || document.fileName,
      overview: buildOverview(document.getText(), catalog.categories, catalog.functions)
    });
  }

  function ensureOverview(force = false): void {
    if (!target) { return; }
    overviewUri = target.uri;
    const fileKey = target.uri.toString();
    if (!force && !overviewPanel && overviewOpenedFiles.has(fileKey)) { return; }
    overviewOpenedFiles.add(fileKey);
    if (overviewPanel) { void sendOverview(); return; }
    overviewPanel = vscode.window.createWebviewPanel('schemetcad.overview', 'SDE 文件概览',
      { viewColumn: vscode.ViewColumn.Three, preserveFocus: true }, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    const current = overviewPanel;
    current.onDidDispose(() => { if (overviewPanel === current) { overviewPanel = undefined; } });
    current.onDidChangeViewState(event => {
      if (event.webviewPanel.visible) { void sendOverview(); }
    });
    current.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') { void sendOverview(); }
      if (message?.type === 'focusEditor') { void returnToEditor(); }
    });
    current.webview.html = overviewHtml(current.webview, context.extensionUri);
  }

  async function navigateAssistant(force = false): Promise<void> {
    if (!panel || !target || !catalog) { return; }
    const currentPanel = panel;
    const currentTarget = target;
    const serial = ++navigationSerial;
    const document = await vscode.workspace.openTextDocument(currentTarget.uri);
    if (serial !== navigationSerial || panel !== currentPanel || target !== currentTarget || inserting) { return; }
    const key = navigationKey(document, currentTarget.offset);
    if (!force && key === lastNavigationKey) { return; }
    const module = findModuleAt(document.getText(), currentTarget.offset);
    const categoryId = catalog.categories.some(item => item.id === module?.categoryId) ? module?.categoryId : undefined;
    if (!await currentPanel.webview.postMessage({ type: 'navigate', categoryId })) { return; }
    lastNavigationKey = key;
    await sendSymbols();
  }

  async function sendSymbols(): Promise<void> {
    if (!panel || !target) { return; }
    const document = await vscode.workspace.openTextDocument(target.uri);
    const cutoff = Math.min(target.offset, document.getText().length);
    await panel.webview.postMessage({ type: 'symbols', symbols: scanSymbols(document.getText().slice(0, cutoff)) });
  }

  function rememberEditor(): boolean {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.isClosed) { return false; }
    trackEditor(editor);
    return true;
  }

  function trackEditor(editor: vscode.TextEditor): boolean {
    if (editor.document.isClosed) { return false; }
    lastCodeEditor = editor;
    const next = {
      uri: editor.document.uri,
      position: editor.selection.active,
      offset: editor.document.offsetAt(editor.selection.active),
      column: editor.viewColumn ?? vscode.ViewColumn.One
    };
    if (target?.uri.toString() === next.uri.toString() && target.offset === next.offset && target.column === next.column) {
      return false;
    }
    target = next;
    navigationSerial++;
    return true;
  }

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (!inserting && !programmaticEditorFocus && trackEditor(event.textEditor) && panel?.visible && !panel.active) {
      void navigateAssistant(true);
    }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && !inserting && !programmaticEditorFocus && trackEditor(editor) && panel?.visible && !panel.active) {
      void navigateAssistant(true);
    }
  }));

  async function returnToEditor(): Promise<void> {
    if (!target) { return; }
    const destination = target;
    programmaticEditorFocus++;
    try {
      const document = await vscode.workspace.openTextDocument(destination.uri);
      const editor = await vscode.window.showTextDocument(document, { viewColumn: destination.column, preview: false });
      lastCodeEditor = editor;
      const position = document.positionAt(Math.min(destination.offset, document.getText().length));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
      target = { ...destination, position, offset: document.offsetAt(position) };
    } catch (error) {
      void vscode.window.showErrorMessage(`无法返回代码编辑器：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      programmaticEditorFocus--;
    }
  }

  function focusAssistant(): void {
    if (panel?.active || overviewPanel?.active) {
      void returnToEditor();
      return;
    }
    if (!rememberEditor()) {
      void vscode.window.showWarningMessage('请先把光标放在要编辑的文件中');
      return;
    }
    if (panel) { panel.reveal(vscode.ViewColumn.Two, false); ensureOverview(); }
    else { void vscode.commands.executeCommand('schemetcad.openAssistant'); }
  }

  context.subscriptions.push(vscode.commands.registerCommand('schemetcad.focusAssistant', focusAssistant));
  context.subscriptions.push(vscode.commands.registerCommand('schemetcad.showOverview', () => {
    if (vscode.window.activeTextEditor) { rememberEditor(); }
    if (!target) {
      void vscode.window.showWarningMessage('请先打开一个 SDE Scheme 文件');
      return;
    }
    if (!catalog) {
      try { catalog = loadCatalog(context.extensionPath); }
      catch (error) {
        void vscode.window.showErrorMessage(`函数库读取失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    ensureOverview(true);
    overviewPanel?.reveal(vscode.ViewColumn.Three, false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('schemetcad.openAssistant', () => {
    if (!rememberEditor()) {
      void vscode.window.showWarningMessage('请先打开一个可编辑文件并放置光标');
      return;
    }
    if (panel) {
      panel.reveal(vscode.ViewColumn.Two, false);
      ensureOverview();
      return;
    }
    try { catalog = loadCatalog(context.extensionPath); }
    catch (error) {
      void vscode.window.showErrorMessage(`函数库读取失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    panel = vscode.window.createWebviewPanel('schemetcad.assistant', 'Scheme 辅助', vscode.ViewColumn.Two, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    const currentPanel = panel;
    let assistantFocused = currentPanel.active;
    currentPanel.onDidDispose(() => {
      if (panel === currentPanel) { panel = undefined; lastNavigationKey = undefined; navigationSerial++; }
    });
    currentPanel.onDidChangeViewState(event => {
      const becameFocused = event.webviewPanel.active && !assistantFocused;
      assistantFocused = event.webviewPanel.active;
      if (becameFocused && !inserting) {
        if (lastCodeEditor) { trackEditor(lastCodeEditor); }
        void navigateAssistant(true);
      }
    });
    currentPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) { return; }
      if (message.type === 'ready') {
        await currentPanel.webview.postMessage({ type: 'catalog', catalog });
        await navigateAssistant(true);
        return;
      }
      if (message.type === 'toggleFocus') {
        await returnToEditor();
        return;
      }
      if (message.type === 'selectCategory' && 'categoryId' in message && typeof message.categoryId === 'string') {
        if (inserting) { return; }
        inserting = true;
        navigationSerial++;
        try {
          const category = catalog?.categories.find(item => item.id === message.categoryId);
          if (!category || !target) { throw new Error('分类或插入位置已失效'); }
          const document = await vscode.workspace.openTextDocument(target.uri);
          const existingModule = findModuleAt(document.getText(), target.offset);
          if (existingModule) {
            await currentPanel.webview.postMessage({ type: 'categoryReady', categoryId: existingModule.categoryId });
            lastNavigationKey = navigationKey(document, target.offset);
            return;
          }
          const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
          const { offset: insertionOffset, prefix } = planModuleInsertion(document.getText(), target.offset, eol);
          const block = createModuleBlock(category.id, category.label, eol);
          const edit = new vscode.WorkspaceEdit();
          edit.insert(target.uri, document.positionAt(insertionOffset), prefix + block.text);
          if (!await vscode.workspace.applyEdit(edit)) { throw new Error('无法创建模块注释区块'); }
          const updated = await vscode.workspace.openTextDocument(target.uri);
          const cursorOffset = insertionOffset + prefix.length + block.cursorOffset;
          const cursor = updated.positionAt(cursorOffset);
          const editor = vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === target?.uri.toString() && item.viewColumn === target.column) ??
            await vscode.window.showTextDocument(updated, { viewColumn: target.column, preview: false });
          editor.selection = new vscode.Selection(cursor, cursor);
          editor.revealRange(new vscode.Range(cursor, cursor));
          target = { ...target, position: cursor, offset: cursorOffset };
          currentPanel.reveal(vscode.ViewColumn.Two, false);
          await currentPanel.webview.postMessage({ type: 'categoryReady', categoryId: category.id });
          lastNavigationKey = navigationKey(updated, cursorOffset);
          await sendSymbols();
        } catch (error) {
          void currentPanel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        } finally {
          inserting = false;
        }
        return;
      }
      if (message.type !== 'insert' || inserting || !('id' in message) || typeof message.id !== 'string' ||
        !('values' in message) || typeof message.values !== 'object' || message.values === null) { return; }
      inserting = true;
      navigationSerial++;
      let inserted = false;
      try {
        const entry = catalog?.functions.find(item => item.id === message.id);
        if (!entry || !target) { throw new Error('函数或插入位置已失效'); }
        const originalDocument = await vscode.workspace.openTextDocument(target.uri);
        const actualCategory = findModuleAt(originalDocument.getText(), target.offset)?.categoryId;
        if (actualCategory !== entry.category) {
          await currentPanel.webview.postMessage({ type: 'navigate', categoryId: actualCategory });
          lastNavigationKey = navigationKey(originalDocument, target.offset);
          throw new Error('光标已离开该函数所属模块，请在当前模块重新选择函数');
        }
        const code = renderCode(entry, message.values as Record<string, unknown>);
        const eol = originalDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const insertion = code + eol;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(target.uri, target.position, insertion);
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('无法在原文件中插入代码'); }
        const updatedDocument = await vscode.workspace.openTextDocument(target.uri);
        await currentPanel.webview.postMessage({ type: 'reset' });
        const restored = await vscode.window.showTextDocument(updatedDocument, { viewColumn: target.column, preview: false });
        const end = updatedDocument.positionAt(target.offset + insertion.length);
        restored.selection = new vscode.Selection(end, end);
        restored.revealRange(new vscode.Range(end, end));
        target = { ...target, position: end, offset: target.offset + insertion.length };
        await sendSymbols();
        inserted = true;
      } catch (error) {
        void currentPanel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        inserting = false;
        if (inserted) { void navigateAssistant(true); }
      }
    });
    currentPanel.webview.html = webviewHtml(currentPanel.webview, context.extensionUri);
    ensureOverview();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (panel && target && event.document.uri.toString() === target.uri.toString()) {
      void sendSymbols();
    }
    if (overviewPanel && overviewUri && event.document.uri.toString() === overviewUri.toString()) {
      void sendOverview();
    }
  }));
}

export function deactivate(): void {}
