import { listModules } from './modules';
import { analyzeScheme, type SchemeAnalysis } from './symbols';

export type OverviewSnapshot = SchemeAnalysis & {
  modules: { id: string; label: string; present: boolean; hasCode: boolean }[];
};

export function buildOverview(text: string, categories: { id: string; label: string }[], functions: { name: string; category: string }[]): OverviewSnapshot {
  const blocks = listModules(text);
  const analysis = analyzeScheme(text);
  const modules = categories.map(category => {
    const matching = blocks.filter(block => block.categoryId === category.id);
    const names = new Set(functions.filter(item => item.category === category.id).map(item => item.name));
    const hasTaggedCode = matching.some(block => analyzeScheme(text.slice(block.bodyStart, block.bodyEnd)).formCount > 0);
    return {
      id: category.id,
      label: category.label,
      present: matching.length > 0,
      hasCode: hasTaggedCode || analysis.calls.some(name => names.has(name))
    };
  });
  return { ...analysis, modules };
}
