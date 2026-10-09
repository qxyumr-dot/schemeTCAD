export type SymbolLists = Record<'materials' | 'regions' | 'contacts' | 'windows' | 'refinements' | 'profiles', string[]>;
export type NamedValue = { name: string; value: string };
export type RegionInfo = { name: string; material: string; shape: string; geometry: string };
export type DopingInfo = { name: string; species: string; kind: string; concentration: string };
export type SchemeAnalysis = {
  symbols: SymbolLists;
  constants: NamedValue[];
  regions: RegionInfo[];
  doping: DopingInfo[];
  calls: string[];
  formCount: number;
};

type Node = ({ kind: 'atom' | 'string'; value: string } | { kind: 'list'; items: Node[] }) &
  { start: number; end: number; complete: boolean };

const definitionKinds: Record<string, keyof SymbolLists> = {
  'sdedr:define-refeval-window': 'windows',
  'sdedr:define-refinement-size': 'refinements',
  'sdedr:define-multibox-size': 'refinements',
  'sdedr:define-constant-profile': 'profiles',
  'sdedr:define-gaussian-profile': 'profiles',
  'sdedr:define-1d-external-profile': 'profiles',
  'sdedr:define-submesh': 'profiles',
  'sdegeo:define-contact-set': 'contacts'
};

function parseScheme(text: string): Node[] {
  let index = 0;
  function skipSpace(): void {
    while (index < text.length) {
      if (/\s/.test(text[index])) { index++; continue; }
      if (text[index] === ';') {
        while (index < text.length && text[index] !== '\n') { index++; }
        continue;
      }
      if (text.startsWith('#|', index)) {
        const end = text.indexOf('|#', index + 2);
        index = end < 0 ? text.length : end + 2;
        continue;
      }
      break;
    }
  }
  function readNode(): Node | undefined {
    skipSpace();
    if (index >= text.length) { return undefined; }
    if (text[index] === ')') { index++; return undefined; }
    const start = index;
    if (text[index] === '(') {
      index++;
      const items: Node[] = [];
      let complete = false;
      while (index < text.length) {
        skipSpace();
        if (text[index] === ')') { index++; complete = true; break; }
        if (index >= text.length) { break; }
        const before = index;
        const child = readNode();
        if (child) { items.push(child); }
        if (index === before) { index++; }
      }
      return { kind: 'list', items, start, end: index, complete };
    }
    if (text[index] === '"') {
      index++;
      let value = '';
      while (index < text.length) {
        const char = text[index++];
        if (char === '"') { return { kind: 'string', value, start, end: index, complete: true }; }
        if (char === '\\' && index < text.length) { value += text[index++]; }
        else { value += char; }
      }
      return { kind: 'string', value, start, end: index, complete: false };
    }
    while (index < text.length && !/[\s();]/.test(text[index])) { index++; }
    return index > start ? { kind: 'atom', value: text.slice(start, index), start, end: index, complete: true } : undefined;
  }
  const nodes: Node[] = [];
  while (index < text.length) {
    const before = index;
    const node = readNode();
    if (node) { nodes.push(node); }
    if (index === before) { index++; }
  }
  return nodes;
}

export function analyzeScheme(text: string): SchemeAnalysis {
  const found: Record<keyof SymbolLists, Set<string>> = {
    materials: new Set(), regions: new Set(), contacts: new Set(),
    windows: new Set(), refinements: new Set(), profiles: new Set()
  };
  const constants = new Map<string, NamedValue>();
  const regions = new Map<string, RegionInfo>();
  const doping = new Map<string, DopingInfo>();
  const calls: string[] = [];
  let formCount = 0;
  const value = (node: Node | undefined): string => node ? text.slice(node.start, node.end).replace(/\s+/g, ' ').trim() : '';
  const stringArg = (items: Node[], position: number): string | undefined => {
    const item = items[position];
    return item?.kind === 'string' && item.complete && item.value.trim() ? item.value : undefined;
  };
  const atomArg = (items: Node[], position: number): string | undefined => {
    const item = items[position];
    return item?.kind === 'atom' ? item.value : undefined;
  };
  const positionText = (node: Node | undefined, twoDimensional: boolean): string => {
    if (node?.kind !== 'list' || atomArg(node.items, 0) !== 'position') { return ''; }
    const coords = node.items.slice(1, twoDimensional ? 3 : 4).map(value);
    return `(${coords.join(', ')})`;
  };

  function visit(node: Node): void {
    if (node.kind !== 'list' || !node.complete) { return; }
    const { items } = node;
    const head = atomArg(items, 0) ?? '';
    if (head) { formCount++; calls.push(head); }
    if (head === 'sde:clear') {
      Object.values(found).forEach(names => names.clear());
      constants.clear(); regions.clear(); doping.clear();
    }
    const defined = definitionKinds[head];
    if (defined) {
      const name = stringArg(items, 1);
      if (name) { found[defined].add(name); }
    }
    if (head === 'define' && atomArg(items, 1) && items[2]) {
      const definition = items[2];
      const isProcedure = definition.kind === 'list' && atomArg(definition.items, 0) === 'lambda';
      if (!isProcedure) {
        const name = atomArg(items, 1)!;
        constants.set(name, { name, value: value(definition) });
      }
    }
    if (head === 'sde:define-parameter') {
      const name = stringArg(items, 1);
      if (name) { constants.set(name, { name, value: value(items[2]) }); }
    }
    if (['sdegeo:create-rectangle', 'sdegeo:create-cuboid', 'sdegeo:create-polygon'].includes(head)) {
      const material = stringArg(items, items.length - 2);
      const name = stringArg(items, items.length - 1);
      if (material) { found.materials.add(material); }
      if (name) { found.regions.add(name); }
      if (material && name) {
        const shape = head === 'sdegeo:create-rectangle' ? '矩形' : head === 'sdegeo:create-cuboid' ? '长方体' : '多边形';
        let geometry = '';
        if (head === 'sdegeo:create-polygon' && items[1]?.kind === 'list') {
          geometry = `${items[1].items.filter(item => item.kind === 'list' && atomArg(item.items, 0) === 'position').length} 个顶点`;
        } else {
          const twoDimensional = head === 'sdegeo:create-rectangle';
          geometry = `${positionText(items[1], twoDimensional)} → ${positionText(items[2], twoDimensional)}`;
        }
        regions.set(name, { name, material, shape, geometry });
      }
    }
    if (head === 'sdegeo:set-contact') {
      const name = stringArg(items, 2);
      if (name) { found.contacts.add(name); }
    }
    if (['sdedr:define-constant-profile', 'sdedr:define-gaussian-profile', 'sdedr:define-1d-external-profile', 'sdedr:define-submesh'].includes(head)) {
      const name = stringArg(items, 1);
      if (name) {
        const species = head === 'sdedr:define-submesh' || head === 'sdedr:define-1d-external-profile' ? '' : (stringArg(items, 2) ?? '');
        const kind = head === 'sdedr:define-constant-profile' ? '恒定' : head === 'sdedr:define-gaussian-profile' ? '高斯' : '外部';
        let concentration = head === 'sdedr:define-constant-profile' ? value(items[3]) : '';
        if (head === 'sdedr:define-gaussian-profile') {
          const peakAt = items.findIndex(item => item.kind === 'string' && item.value === 'PeakVal');
          if (peakAt >= 0) { concentration = value(items[peakAt + 1]); }
        }
        doping.set(name, { name, species, kind, concentration });
      }
    }
    items.forEach(visit);
  }

  parseScheme(text).forEach(visit);
  return {
    symbols: Object.fromEntries(Object.entries(found).map(([key, values]) => [key, [...values]])) as SymbolLists,
    constants: [...constants.values()], regions: [...regions.values()], doping: [...doping.values()], calls, formCount
  };
}

export function scanSymbols(text: string): SymbolLists {
  return analyzeScheme(text).symbols;
}
