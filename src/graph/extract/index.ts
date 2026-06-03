/**
 * Per-file extractor dispatch by extension (B6+).
 *
 * TypeScript/JavaScript (.ts/.tsx/.js/.jsx/.mjs/.cjs) → the tree-sitter TS
 * pipeline; Python (.py/.pyi) → the tree-sitter Python pipeline. Both produce
 * the same FileExtraction shape, so the snapshot builder and cross-file passes
 * are language-agnostic downstream.
 */

import { extractTypeScript } from "./typescript.js";
import { extractPython } from "./python.js";
import type { FileExtraction } from "../types.js";

/** True for Python source extensions. */
export function isPythonPath(relativePath: string): boolean {
  return /\.pyi?$/.test(relativePath);
}

/** Extract one file, routing to the language-appropriate extractor. */
export function extractFile(sourceCode: string, relativePath: string): FileExtraction {
  if (isPythonPath(relativePath)) return extractPython(sourceCode, relativePath);
  return extractTypeScript(sourceCode, relativePath);
}
