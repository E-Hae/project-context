import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import * as ts from "typescript";

import {
  TraceAdapterError,
  type TraceAdapter,
  type TraceAdapterRequest,
  type TraceAdapterResponse,
  type TraceAdapterEvidence,
  type TraceDiagnostics,
  type TraceSymbol,
} from "project-context-mcp/trace-adapter";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
const MAX_EVIDENCE_LINES = 20;
const MAX_MESSAGE_COUNT = 20;
const MAX_MESSAGE_LENGTH = 4_096;

interface SourceInfo {
  absolutePath: string;
  relativePath: string;
  hash: string;
  text: string;
  sourceFile: ts.SourceFile;
}

interface DeclarationInfo {
  symbol: ts.Symbol;
  declaration: ts.Declaration;
  source: SourceInfo;
  kind: string;
  key: string;
}

interface AnalyzerResult {
  matchedSymbols: TraceSymbol[];
  results: Array<{
    relation: string;
    from: TraceSymbol;
    to: TraceSymbol;
    evidence: TraceAdapterEvidence;
  }>;
  diagnostics: TraceDiagnostics;
  truncated: boolean;
}

type CallableDeclaration =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

type TypeDeclaration =
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.EnumDeclaration
  | ts.TypeAliasDeclaration;

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isCallableDeclaration(node: ts.Node): node is CallableDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

function isTypeDeclaration(node: ts.Node): node is TypeDeclaration {
  return ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node);
}

function declarationName(node: ts.Declaration): ts.Node | undefined {
  return "name" in node ? (node as ts.Declaration & { name?: ts.Node }).name : undefined;
}

function isHeritageDeclaration(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.InterfaceDeclaration {
  return ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node);
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function symbolForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
): ts.Symbol | undefined {
  const name = declarationName(declaration);
  const symbol = name === undefined
    ? checker.getSymbolAtLocation(declaration)
    : checker.getSymbolAtLocation(name);
  return symbol === undefined ? undefined : canonicalSymbol(checker, symbol);
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").slice(0, MAX_MESSAGE_LENGTH);
}

function addMessage(messages: string[], value: string): void {
  if (messages.length >= MAX_MESSAGE_COUNT || messages.includes(value)) return;
  messages.push(value.slice(0, MAX_MESSAGE_LENGTH));
}

function configPathFor(
  projectRoot: string,
  auxiliaryFiles: readonly string[],
): string | null {
  const candidates = auxiliaryFiles
    .map((relativePath) => ({
      relativePath,
      baseName: path.basename(relativePath).toLocaleLowerCase("en-US"),
    }))
    .filter(({ baseName }) => CONFIG_NAMES.has(baseName));
  const selected = candidates.find(({ baseName }) => baseName === "tsconfig.json") ?? candidates[0];
  if (selected === undefined) return null;
  const absolutePath = path.resolve(projectRoot, selected.relativePath);
  return isInside(projectRoot, absolutePath) ? absolutePath : null;
}

function compilerOptionsFor(
  projectRoot: string,
  configPath: string | null,
  configText: string | null,
  hasJavaScript: boolean,
  messages: string[],
): { options: ts.CompilerOptions; configName: string | null } {
  const defaults: ts.CompilerOptions = {
    allowJs: hasJavaScript,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  if (configPath === null || configText === null) {
    return { options: defaults, configName: null };
  }

  const parsedJson = ts.parseConfigFileTextToJson(configPath, configText);
  if (parsedJson.error !== undefined) {
    addMessage(messages, `Unable to parse ${normalizedPath(path.basename(configPath))}: ${diagnosticText(parsedJson.error)}`);
    return { options: defaults, configName: normalizedPath(path.basename(configPath)) };
  }

  const parsed = ts.parseJsonConfigFileContent(
    parsedJson.config,
    ts.sys,
    projectRoot,
    undefined,
    configPath,
  );
  for (const diagnostic of parsed.errors) {
    addMessage(messages, `${normalizedPath(path.basename(configPath))}: ${diagnosticText(diagnostic)}`);
  }
  return {
    options: {
      ...defaults,
      ...parsed.options,
      allowJs: hasJavaScript || parsed.options.allowJs === true,
      noEmit: true,
      skipLibCheck: true,
    },
    configName: normalizedPath(path.basename(configPath)),
  };
}

async function readTextFile(
  projectRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; relativePath: string; hash: string; text: string }> {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath)
  ) {
    throw new TraceAdapterError(`Invalid source path: ${relativePath}`, "invalid_request");
  }
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!isInside(projectRoot, absolutePath)) {
    throw new TraceAdapterError(`Source path escapes the project root: ${relativePath}`, "invalid_request");
  }
  const bytes = await readFile(absolutePath);
  return {
    absolutePath,
    relativePath: normalizedPath(path.relative(projectRoot, absolutePath)),
    hash: createHash("sha256").update(bytes).digest("hex"),
    text: bytes.toString("utf8"),
  };
}

function sourceInfoForNode(
  node: ts.Node,
  sources: Map<string, SourceInfo>,
): SourceInfo | undefined {
  return sources.get(pathKey(node.getSourceFile().fileName));
}

function lineRange(
  source: SourceInfo,
  node: ts.Node,
): { lineStart: number; lineEnd: number; text: string } {
  const startPosition = Math.max(0, Math.min(node.getStart(source.sourceFile), source.text.length));
  const endPosition = Math.max(startPosition, Math.min(node.getEnd(), source.text.length));
  const start = source.sourceFile.getLineAndCharacterOfPosition(startPosition);
  const lastPosition = Math.max(startPosition, endPosition - 1);
  const end = source.sourceFile.getLineAndCharacterOfPosition(lastPosition);
  const lines = source.text.split(/\r?\n/);
  const excerpt = lines
    .slice(start.line, Math.min(end.line + 1, start.line + MAX_EVIDENCE_LINES))
    .join("\n")
    .trim()
    .slice(0, 2_000);
  return {
    lineStart: start.line + 1,
    lineEnd: Math.max(start.line + 1, end.line + 1),
    text: excerpt,
  };
}

function symbolDisplayName(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  return checker.getFullyQualifiedName(symbol).replaceAll("\\", "/");
}

function symbolKind(info: DeclarationInfo | undefined, symbol: ts.Symbol): string {
  if (info !== undefined) return info.kind;
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return "class";
  if ((symbol.flags & ts.SymbolFlags.Interface) !== 0) return "interface";
  if ((symbol.flags & ts.SymbolFlags.Enum) !== 0) return "enum";
  if ((symbol.flags & ts.SymbolFlags.TypeAlias) !== 0) return "type";
  if ((symbol.flags & ts.SymbolFlags.Function) !== 0) return "function";
  return "symbol";
}

function typeSignature(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declaration: ts.Declaration | undefined,
): string {
  if (declaration !== undefined && isCallableDeclaration(declaration)) {
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (signature !== undefined) {
      return checker.signatureToString(
        signature,
        declaration,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
    }
  }
  const location = declaration ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
  const type = location === undefined
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, location);
  return checker.typeToString(
    type,
    location,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
}

class TypeScriptAnalyzer {
  private readonly sourceByPath: Map<string, SourceInfo>;
  private readonly declarationInfos: DeclarationInfo[] = [];
  private readonly callableInfos: DeclarationInfo[] = [];
  private readonly typeInfos: DeclarationInfo[] = [];
  private readonly infoBySymbol = new Map<ts.Symbol, DeclarationInfo>();
  private readonly infoByNode = new Map<ts.Node, DeclarationInfo>();
  private readonly nodeCache = new Map<string, TraceSymbol>();
  private unresolvedCandidates = 0;
  private parseErrors = 0;

  constructor(
    private readonly projectRoot: string,
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
    sources: SourceInfo[],
    private readonly messages: string[],
    private readonly configName: string | null,
  ) {
    this.sourceByPath = new Map(sources.map((source) => [pathKey(source.absolutePath), source]));
    for (const source of sources) this.collectDeclarations(source.sourceFile, source);
    for (const source of sources) {
      for (const diagnostic of program.getSyntacticDiagnostics(source.sourceFile)) {
        this.parseErrors += 1;
        addMessage(this.messages, `${source.relativePath}: ${diagnosticText(diagnostic)}`);
      }
    }
  }

  trace(request: TraceAdapterRequest, filesRequested: number, filesSkipped: number, startedAt: number): AnalyzerResult {
    const query = request.symbol.trim();
    const targets = request.direction === "callers" || request.direction === "callees"
      ? this.findSymbols(this.callableInfos, query)
      : this.findSymbols(this.typeInfos, query);
    const matchedSymbols = targets.map((target) => this.toTraceSymbol(target.symbol, target));
    const results = request.direction === "callers"
      ? this.findCallers(targets)
      : request.direction === "callees"
        ? this.findCallees(targets)
        : this.findTypeRelations(targets, request.direction);
    const ordered = results
      .filter((edge, index, all) => all.findIndex((candidate) =>
        candidate.relation === edge.relation &&
        candidate.from.fullName === edge.from.fullName &&
        candidate.to.fullName === edge.to.fullName &&
        candidate.evidence.path === edge.evidence.path &&
        candidate.evidence.lineStart === edge.evidence.lineStart,
      ) === index)
      .sort((left, right) =>
        left.evidence.path.localeCompare(right.evidence.path, "en") ||
        left.evidence.lineStart - right.evidence.lineStart ||
        left.relation.localeCompare(right.relation, "en") ||
        left.from.fullName.localeCompare(right.from.fullName, "en") ||
        left.to.fullName.localeCompare(right.to.fullName, "en"),
      );
    const selected = ordered.slice(0, request.maxResults);
    return {
      matchedSymbols,
      results: selected,
      diagnostics: {
        filesRequested,
        filesLoaded: this.sourceByPath.size,
        filesSkipped,
        partial: filesSkipped > 0 || this.parseErrors > 0 || this.unresolvedCandidates > 0,
        elapsedMs: Date.now() - startedAt,
        messages: this.messages,
        metadata: {
          compilerVersion: ts.version,
          config: this.configName,
          parseErrors: this.parseErrors,
          unresolvedCandidates: this.unresolvedCandidates,
          checkJs: this.program.getCompilerOptions().checkJs === true,
          allowJs: this.program.getCompilerOptions().allowJs === true,
        },
      },
      truncated: ordered.length > request.maxResults,
    };
  }

  private collectDeclarations(sourceFile: ts.SourceFile, source: SourceInfo): void {
    const visit = (node: ts.Node): void => {
      if (isCallableDeclaration(node)) {
        this.registerDeclaration(node, source, this.callableKind(node), true);
      } else if (isTypeDeclaration(node) && node.name !== undefined) {
        this.registerDeclaration(node, source, this.typeKind(node), false);
      } else if (ts.isVariableDeclaration(node) && node.name !== undefined) {
        const initializer = node.initializer;
        if (initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          const info = this.registerDeclaration(node, source, "function", true);
          if (info !== undefined) this.infoByNode.set(initializer, info);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private registerDeclaration(
    declaration: ts.Declaration,
    source: SourceInfo,
    kind: string,
    callable: boolean,
  ): DeclarationInfo | undefined {
    const symbol = symbolForDeclaration(this.checker, declaration);
    if (symbol === undefined) return undefined;
    const key = `${pathKey(source.absolutePath)}:${declaration.getStart(source.sourceFile)}:${kind}`;
    const existing = this.declarationInfos.find((candidate) => candidate.key === key);
    if (existing !== undefined) return existing;
    const info: DeclarationInfo = { symbol, declaration, source, kind, key };
    this.declarationInfos.push(info);
    if (callable) this.callableInfos.push(info);
    if (isTypeDeclaration(declaration)) this.typeInfos.push(info);
    this.infoBySymbol.set(symbol, info);
    this.infoByNode.set(declaration, info);
    return info;
  }

  private callableKind(node: CallableDeclaration): string {
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return "method";
    }
    return "function";
  }

  private typeKind(node: TypeDeclaration): string {
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isEnumDeclaration(node)) return "enum";
    return "type";
  }

  private findSymbols(infos: DeclarationInfo[], query: string): DeclarationInfo[] {
    const exact = infos.filter((info) => {
      const display = symbolDisplayName(this.checker, info.symbol);
      const signature = typeSignature(this.checker, info.symbol, info.declaration);
      return query === display || query === signature;
    });
    const candidates = exact.length > 0 ? exact : infos.filter((info) => this.matchesQuery(info, query));
    const unique = [...new Map(candidates.map((info) => [info.key, info])).values()];
    const fullNames = [...new Set(unique.map((info) => symbolDisplayName(this.checker, info.symbol)))];
    if (unique.length === 0) {
      throw new TraceAdapterError(`Symbol was not found: ${query}`, "symbol_not_found");
    }
    if (fullNames.length > 1) {
      throw new TraceAdapterError(
        `Symbol is ambiguous: ${query}`,
        "ambiguous_symbol",
        fullNames.sort((left, right) => left.localeCompare(right, "en")),
      );
    }
    return unique;
  }

  private matchesQuery(info: DeclarationInfo, query: string): boolean {
    const name = info.symbol.getName();
    const display = symbolDisplayName(this.checker, info.symbol);
    const simpleQuery = query.split("(", 1)[0]?.trim() ?? query;
    const queryName = simpleQuery.split(/[.:]/u).at(-1) ?? simpleQuery;
    return query === name ||
      query === display ||
      simpleQuery === name ||
      simpleQuery === display ||
      queryName === name ||
      display.endsWith(`.${simpleQuery}`);
  }

  private findCallers(targets: DeclarationInfo[]): AnalyzerResult["results"] {
    const targetSymbols = new Set(targets.map((target) => target.symbol));
    const results: AnalyzerResult["results"] = [];
    for (const source of this.sourceByPath.values()) {
      this.visitCalls(source.sourceFile, (call, callee) => {
        if (callee === undefined || !targetSymbols.has(callee)) return;
        const caller = this.enclosingCallable(call);
        if (caller === undefined) return;
        results.push({
          relation: "calls",
          from: this.toTraceSymbol(caller.symbol, caller),
          to: this.toTraceSymbol(callee, this.infoBySymbol.get(callee)),
          evidence: this.evidence(call),
        });
      });
    }
    return results;
  }

  private findCallees(targets: DeclarationInfo[]): AnalyzerResult["results"] {
    const results: AnalyzerResult["results"] = [];
    for (const target of targets) {
      this.visitCalls(target.declaration, (call, callee, constructs) => {
        if (callee === undefined) return;
        const targetInfo = this.infoBySymbol.get(callee);
        if (targetInfo === undefined) return;
        results.push({
          relation: constructs ? "constructs" : "calls",
          from: this.toTraceSymbol(target.symbol, target),
          to: this.toTraceSymbol(callee, targetInfo),
          evidence: this.evidence(call),
        });
      });
    }
    return results;
  }

  private findTypeRelations(
    targets: DeclarationInfo[],
    direction: "inherits" | "implements",
  ): AnalyzerResult["results"] {
    const results: AnalyzerResult["results"] = [];
    for (const target of targets) {
      if (!isHeritageDeclaration(target.declaration) || target.declaration.heritageClauses === undefined) continue;
      for (const heritage of target.declaration.heritageClauses) {
        const isImplements = heritage.token === ts.SyntaxKind.ImplementsKeyword;
        if ((direction === "implements") !== isImplements) continue;
        for (const type of heritage.types) {
          const related = this.relatedTypeSymbol(type);
          if (related === undefined) {
            this.unresolvedCandidates += 1;
            continue;
          }
          results.push({
            relation: direction,
            from: this.toTraceSymbol(target.symbol, target),
            to: this.toTraceSymbol(related),
            evidence: this.evidence(type),
          });
        }
      }
    }
    return results;
  }

  private relatedTypeSymbol(type: ts.ExpressionWithTypeArguments): ts.Symbol | undefined {
    const related = this.checker.getTypeAtLocation(type.expression);
    const symbol = related.aliasSymbol ?? related.symbol ?? this.checker.getSymbolAtLocation(type.expression);
    return symbol === undefined ? undefined : canonicalSymbol(this.checker, symbol);
  }

  private visitCalls(
    root: ts.Node,
    callback: (call: ts.CallExpression | ts.NewExpression, callee: ts.Symbol | undefined, constructs?: boolean) => void,
  ): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        callback(node, this.calledSymbol(node), false);
      } else if (ts.isNewExpression(node)) {
        callback(node, this.calledSymbol(node), true);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  private calledSymbol(call: ts.CallExpression | ts.NewExpression): ts.Symbol | undefined {
    if (ts.isNewExpression(call)) {
      const type = this.checker.getTypeAtLocation(call.expression);
      const symbol = type.aliasSymbol ?? type.symbol ?? this.checker.getSymbolAtLocation(call.expression);
      return symbol === undefined ? undefined : canonicalSymbol(this.checker, symbol);
    }
    const signature = this.checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    const symbol = declaration === undefined
      ? this.checker.getSymbolAtLocation(call.expression)
      : symbolForDeclaration(this.checker, declaration);
    return symbol === undefined ? undefined : canonicalSymbol(this.checker, symbol);
  }

  private enclosingCallable(node: ts.Node): DeclarationInfo | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      const info = this.infoByNode.get(current);
      if (info !== undefined && this.callableInfos.includes(info)) return info;
      current = current.parent;
    }
    return undefined;
  }

  private toTraceSymbol(symbol: ts.Symbol, info = this.infoBySymbol.get(symbol)): TraceSymbol {
    const source = info?.source ?? this.sourceForSymbol(symbol);
    const key = `${symbolDisplayName(this.checker, symbol)}|${source?.relativePath ?? ""}|${info?.key ?? ""}`;
    const cached = this.nodeCache.get(key);
    if (cached !== undefined) return cached;
    const declaration = info?.declaration ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
    const range = source === undefined || declaration === undefined
      ? null
      : lineRange(source, declaration);
    const node: TraceSymbol = {
      name: symbol.getName(),
      fullName: symbolDisplayName(this.checker, symbol),
      signature: typeSignature(this.checker, symbol, declaration),
      kind: symbolKind(info, symbol),
      path: source?.relativePath ?? null,
      lineStart: range?.lineStart ?? null,
      lineEnd: range?.lineEnd ?? null,
      fileHash: source?.hash ?? null,
    };
    this.nodeCache.set(key, node);
    return node;
  }

  private sourceForSymbol(symbol: ts.Symbol): SourceInfo | undefined {
    for (const declaration of symbol.declarations ?? []) {
      const source = sourceInfoForNode(declaration, this.sourceByPath);
      if (source !== undefined) return source;
    }
    return undefined;
  }

  private evidence(node: ts.Node): TraceAdapterEvidence {
    const source = sourceInfoForNode(node, this.sourceByPath);
    if (source === undefined) {
      throw new TraceAdapterError("Trace evidence is outside the requested source set", "failed");
    }
    const range = lineRange(source, node);
    return {
      path: source.relativePath,
      lineStart: range.lineStart,
      lineEnd: range.lineEnd,
      text: range.text,
      fileHash: source.hash,
    };
  }
}

async function createAnalyzer(request: TraceAdapterRequest): Promise<{
  analyzer: TypeScriptAnalyzer;
  filesRequested: number;
  filesSkipped: number;
}> {
  const startedAt = Date.now();
  const projectRoot = path.resolve(request.projectRoot);
  const messages: string[] = [];
  const loadedFiles: Array<Awaited<ReturnType<typeof readTextFile>>> = [];
  let filesSkipped = 0;
  for (const relativePath of request.files) {
    const extension = path.extname(relativePath).toLocaleLowerCase("en-US");
    if (!SOURCE_EXTENSIONS.has(extension)) {
      filesSkipped += 1;
      addMessage(messages, `Skipped unsupported source file: ${normalizedPath(relativePath)}`);
      continue;
    }
    try {
      loadedFiles.push(await readTextFile(projectRoot, relativePath));
    } catch (error) {
      if (error instanceof TraceAdapterError) throw error;
      filesSkipped += 1;
      addMessage(messages, `Skipped ${normalizedPath(relativePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (loadedFiles.length === 0) {
    throw new TraceAdapterError("No readable TypeScript or JavaScript source files were provided", "invalid_request");
  }

  const auxiliary = new Map<string, string>();
  for (const relativePath of request.auxiliaryFiles) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (!isInside(projectRoot, absolutePath) || path.extname(relativePath).toLocaleLowerCase("en-US") !== ".json") continue;
    try {
      auxiliary.set(pathKey(absolutePath), (await readFile(absolutePath)).toString("utf8"));
    } catch {
      addMessage(messages, `Unable to read auxiliary file: ${normalizedPath(relativePath)}`);
    }
  }
  const configPath = configPathFor(projectRoot, request.auxiliaryFiles);
  const configText = configPath === null ? null : auxiliary.get(pathKey(configPath)) ?? null;
  const hasJavaScript = loadedFiles.some((file) => [".js", ".jsx", ".mjs", ".cjs"].includes(path.extname(file.relativePath).toLocaleLowerCase("en-US")));
  const compiler = compilerOptionsFor(projectRoot, configPath, configText, hasJavaScript, messages);
  const sourceFileNames = loadedFiles.map((file) => file.absolutePath);
  const compilerHost = ts.createCompilerHost(compiler.options, true);
  const defaultReadFile = compilerHost.readFile.bind(compilerHost);
  compilerHost.readFile = (fileName) =>
    loadedFiles.find((file) => pathKey(file.absolutePath) === pathKey(fileName))?.text ??
    defaultReadFile(fileName);
  const program = ts.createProgram(sourceFileNames, compiler.options, compilerHost);
  const sources: SourceInfo[] = [];
  const sourceByPath = new Map(loadedFiles.map((file) => [pathKey(file.absolutePath), file]));
  for (const sourceFile of program.getSourceFiles()) {
    const loaded = sourceByPath.get(pathKey(sourceFile.fileName));
    if (loaded === undefined) continue;
    sources.push({ ...loaded, sourceFile });
  }
  if (sources.length === 0) {
    throw new TraceAdapterError("TypeScript compiler did not load any requested source files", "failed");
  }
  return {
    analyzer: new TypeScriptAnalyzer(
      projectRoot,
      program,
      program.getTypeChecker(),
      sources,
      messages,
      compiler.configName,
    ),
    filesRequested: request.files.length,
    filesSkipped: filesSkipped + loadedFiles.length - sources.length,
  };
}

export function createTypeScriptTraceAdapter(): TraceAdapter {
  return {
    name: "project-context-mcp-typescript",
    language: "typescript",
    languageAliases: ["javascript", "js"],
    sourceFileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    auxiliaryFileExtensions: [".json"],
    async probe() {
      return {
        available: true,
        detail: `TypeScript compiler ${ts.version} is available`,
        version: ts.version,
        metadata: { javascriptSupport: true },
      };
    },
    async trace(request): Promise<TraceAdapterResponse> {
      const startedAt = Date.now();
      try {
        const created = await createAnalyzer(request);
        const result = created.analyzer.trace(
          request,
          created.filesRequested,
          created.filesSkipped,
          startedAt,
        );
        return {
          workerVersion: `typescript/${ts.version}`,
          symbol: request.symbol,
          direction: request.direction,
          matchedSymbols: result.matchedSymbols,
          diagnostics: result.diagnostics,
          results: result.results,
          truncated: result.truncated,
        };
      } catch (error) {
        if (error instanceof TraceAdapterError) throw error;
        throw new TraceAdapterError(
          error instanceof Error ? error.message : String(error),
          "failed",
        );
      }
    },
  };
}

export const traceAdapter = createTypeScriptTraceAdapter();
