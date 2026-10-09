(() => {
  const vscode = acquireVsCodeApi();
  const title = document.getElementById('title');
  const hint = document.getElementById('hint');
  const choices = document.getElementById('choices');
  const parameters = document.getElementById('parameters');
  const preview = document.getElementById('preview');
  const error = document.getElementById('error');
  const back = document.getElementById('back');
  const insert = document.getElementById('insert');

  let catalog = null;
  let phase = 'categories';
  let categoryId = '';
  let selected = 0;
  let entry = null;
  let values = {};
  let activeIndex = 0;
  let submitting = false;
  let categoryPending = false;
  let symbols = {};
  const suggestionTitles = {
    materials: 'Material list（常用材料与当前文件）',
    species: '常用掺杂物种'
  };

  function renderSuggestions() {
    if (phase !== 'parameters' || !entry) { return; }
    entry.parameters.forEach((parameter, index) => {
      const box = document.getElementById('suggestions-' + index);
      if (!box) { return; }
      const source = parameter.suggestion_source;
      const observed = source === 'materials' ? (symbols.materials || []) : [];
      const all = [...new Set([...(catalog?.suggestion_lists?.[source] || []), ...observed])];
      box.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = suggestionTitles[source] || '可选名称';
      box.appendChild(heading);
      if (!all.length) {
        const empty = document.createElement('span');
        empty.textContent = '暂无候选项，可手动填写。';
        box.appendChild(empty);
      }
      all.forEach(value => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = value;
        button.title = '填入 ' + value;
        button.addEventListener('click', () => {
          const control = document.getElementById('parameter-' + index);
          control.value = value;
          values[parameter.id] = value;
          control.focus();
          error.textContent = '';
          updatePreview();
        });
        box.appendChild(button);
      });
    });
  }

  function options() {
    if (!catalog) { return []; }
    if (phase === 'categories') { return catalog.categories; }
    if (phase === 'functions') { return catalog.functions.filter(item => item.category === categoryId); }
    return [];
  }

  function renderChoices() {
    const items = options();
    choices.replaceChildren();
    parameters.hidden = true;
    choices.hidden = false;
    insert.hidden = true;
    back.hidden = phase === 'categories';
    const categoryLabel = catalog?.categories.find(item => item.id === categoryId)?.label || '';
    title.textContent = phase === 'categories' ? '选择操作分类' : categoryLabel + ' · 选择 Scheme 函数';
    hint.textContent = phase === 'categories' ? '选择分类后，在代码中创建对应模块。' : '用 ↑ ↓ 选择函数，按 Enter 查看参数。';
    preview.textContent = phase === 'categories' ? '选择分类和函数后显示预览' : '请选择函数';
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.className = 'item' + (index === selected ? ' active' : '');
      button.type = 'button';
      button.textContent = phase === 'categories' ? item.label : item.label + '  ·  ' + item.name;
      button.addEventListener('click', () => { selected = index; accept(); });
      choices.appendChild(button);
    });
    choices.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    error.textContent = items.length ? '' : '这个分类中还没有函数';
  }

  function escapeSchemeString(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function updatePreview() {
    if (!entry) { return; }
    preview.textContent = entry.template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, id) => {
      const parameter = entry.parameters.find(item => item.id === id);
      const value = values[id] ?? parameter?.default ?? '';
      const shown = value ? (parameter?.type === 'scheme_string' ? escapeSchemeString(value) :
        parameter?.type === 'enum' ? (parameter.code_values?.[value] ?? value) : value) : '';
      return id === entry.parameters[activeIndex]?.id ? '[' + shown + '...]' : value ? shown : whole;
    });
  }

  function setActiveParameter(index) {
    activeIndex = index;
    [...parameters.children].forEach((field, fieldIndex) => field.classList.toggle('active', fieldIndex === index));
    updatePreview();
  }

  function renderParameters() {
    phase = 'parameters';
    choices.hidden = true;
    parameters.hidden = false;
    parameters.replaceChildren();
    activeIndex = 0;
    back.hidden = false;
    insert.hidden = false;
    title.textContent = entry.label;
    hint.textContent = entry.description || entry.name;
    error.textContent = '';
    entry.parameters.forEach((parameter, index) => {
      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      label.textContent = (index + 1) + '. ' + parameter.label + (parameter.required ? ' *' : '');
      const control = parameter.type === 'enum' ? document.createElement('select') : document.createElement('input');
      control.id = 'parameter-' + index;
      if (parameter.type === 'enum') {
        (parameter.choices || []).forEach(choice => {
          const option = document.createElement('option');
          option.value = choice;
          option.textContent = choice;
          control.appendChild(option);
        });
      } else {
        control.type = 'text';
      }
      control.value = values[parameter.id] ?? parameter.default ?? '';
      values[parameter.id] = control.value;
      control.addEventListener('input', () => {
        values[parameter.id] = control.value;
        error.textContent = '';
        updatePreview();
      });
      control.addEventListener('change', () => {
        values[parameter.id] = control.value;
        updatePreview();
      });
      control.addEventListener('focus', () => setActiveParameter(index));
      control.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (index + 1 < entry.parameters.length) {
            document.getElementById('parameter-' + (index + 1))?.focus();
          } else { submit(); }
        }
      });
      label.htmlFor = control.id;
      field.append(label, control);
      const help = document.createElement('small');
      const typeHint = parameter.type === 'scheme_expr' ? '可填数字或 Scheme 表达式。' :
        parameter.type === 'scheme_string' ? '填写名称，无需输入双引号。' : '从列表选择。';
      help.textContent = (parameter.description || parameter.label) + ' ' + typeHint +
        (parameter.example ? '示例：' + parameter.example : '');
      field.appendChild(help);
      if (parameter.suggestion_source) {
        const box = document.createElement('div');
        box.id = 'suggestions-' + index;
        box.className = 'suggestions';
        field.appendChild(box);
      }
      parameters.appendChild(field);
    });
    renderSuggestions();
    updatePreview();
    if (entry.parameters.length) { document.getElementById('parameter-0')?.focus(); }
    else { insert.focus(); }
  }

  function accept() {
    const item = options()[selected];
    if (!item) { return; }
    if (phase === 'categories') {
      if (categoryPending) { return; }
      categoryPending = true;
      error.textContent = '';
      vscode.postMessage({ type: 'selectCategory', categoryId: item.id });
    } else if (phase === 'functions') {
      entry = item;
      values = {};
      renderParameters();
    }
  }

  function submit() {
    if (!entry || submitting) { return; }
    submitting = true;
    error.textContent = '';
    vscode.postMessage({ type: 'insert', id: entry.id, values });
  }

  back.addEventListener('click', () => {
    if (phase === 'parameters') {
      phase = 'functions';
      entry = null;
    } else if (phase === 'functions') {
      phase = 'categories';
      selected = 0;
    }
    renderChoices();
  });
  insert.addEventListener('click', submit);
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyQ') {
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: 'toggleFocus' });
      return;
    }
    if (phase === 'parameters') {
      if (event.key === 'Escape') { back.click(); }
      return;
    }
    const items = options();
    if (event.key === 'ArrowDown' && items.length) {
      event.preventDefault();
      selected = (selected + 1) % items.length;
      renderChoices();
    } else if (event.key === 'ArrowUp' && items.length) {
      event.preventDefault();
      selected = (selected - 1 + items.length) % items.length;
      renderChoices();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      accept();
    } else if (event.key === 'Escape' && phase === 'functions') {
      event.preventDefault();
      back.click();
    }
  });
  window.addEventListener('message', event => {
    if (event.data.type === 'catalog') {
      catalog = event.data.catalog;
      phase = 'categories';
      selected = 0;
      renderChoices();
    } else if (event.data.type === 'navigate' || event.data.type === 'categoryReady') {
      const found = catalog?.categories.some(item => item.id === event.data.categoryId);
      categoryPending = false;
      submitting = false;
      phase = found ? 'functions' : 'categories';
      categoryId = found ? event.data.categoryId : '';
      entry = null;
      values = {};
      selected = 0;
      renderChoices();
    } else if (event.data.type === 'symbols') {
      symbols = event.data.symbols || {};
      renderSuggestions();
    } else if (event.data.type === 'reset') {
      submitting = false;
      categoryPending = false;
      phase = 'categories';
      categoryId = '';
      entry = null;
      values = {};
      selected = 0;
      renderChoices();
    } else if (event.data.type === 'error') {
      submitting = false;
      categoryPending = false;
      error.textContent = event.data.message;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
