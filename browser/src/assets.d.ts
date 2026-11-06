declare module '*.css' { const css: string; export default css; }
interface Highlight { add(range: Range): void; }
declare var Highlight: { new (...ranges: Range[]): Highlight };
interface CSS { highlights: Map<string, Highlight>; }
declare namespace CSS { const highlights: Map<string, Highlight>; }
