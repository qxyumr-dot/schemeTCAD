(() => {
  const vscode = acquireVsCodeApi();
  const filename = document.getElementById('filename');
  const progress = document.getElementById('progress');
  const modules = document.getElementById('modules');
  const cards = document.getElementById('cards');

  function addCard(title, rows, describe) {
    const card = document.createElement('section');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = title + '（' + rows.length + '）';
    card.appendChild(heading);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '当前文件中尚无记录';
      card.appendChild(empty);
    }
    rows.forEach(row => {
      const item = document.createElement('div');
      item.className = 'item';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = typeof row === 'string' ? row : row.name;
      item.appendChild(name);
      const detailText = describe(row);
      if (detailText) {
        const detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = detailText;
        item.appendChild(detail);
      }
      card.appendChild(item);
    });
    cards.appendChild(card);
  }

  function render(data) {
    const overview = data.overview;
    filename.textContent = data.fileName || '';
    const completed = overview.modules.filter(item => item.hasCode).length;
    progress.textContent = '模块进度 · ' + completed + '/' + overview.modules.length + ' 已有代码';
    modules.replaceChildren();
    overview.modules.forEach(item => {
      const row = document.createElement('div');
      row.className = 'module' + (item.hasCode ? ' done' : '');
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = item.hasCode ? '✓' : '○';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = item.label;
      const state = document.createElement('small');
      state.textContent = item.hasCode ? (item.present ? '已有代码' : '检测到对应语句') : item.present ? '模块已创建，尚无代码' : '尚未创建';
      info.append(name, state);
      row.append(mark, info);
      modules.appendChild(row);
    });
    cards.replaceChildren();
    addCard('定义变量 / 常量', overview.constants, row => row.value);
    addCard('区域名', overview.regions, row => [row.material, row.shape, row.geometry].filter(Boolean).join(' · '));
    addCard('掺杂与浓度', overview.doping, row => [row.kind, row.species, row.concentration ? '浓度 ' + row.concentration : ''].filter(Boolean).join(' · '));
    addCard('Contact', overview.symbols.contacts, () => '');
    addCard('Ref/Eval 窗口', overview.symbols.windows, () => '');
    addCard('网格细化定义', overview.symbols.refinements, () => '');
  }

  window.addEventListener('message', event => {
    if (event.data?.type === 'snapshot') { render(event.data); }
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyQ') {
      event.preventDefault();
      vscode.postMessage({ type: 'focusEditor' });
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
