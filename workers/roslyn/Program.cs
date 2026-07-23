using System.Diagnostics;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const string WorkerVersion = "project-context-roslyn/0.1.0";
    private const int MaxFiles = 100_000;
    private const int MaxFileBytes = 2 * 1024 * 1024;
    private const int MaxMessages = 20;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly HashSet<string> Directions =
        new(StringComparer.Ordinal) { "callers", "callees", "inherits", "implements" };

    private static readonly HashSet<string> UnityMessages = new(StringComparer.Ordinal)
    {
        "Awake", "Start", "OnEnable", "OnDisable", "OnDestroy", "Reset",
        "Update", "LateUpdate", "FixedUpdate", "OnGUI", "OnApplicationFocus",
        "OnApplicationPause", "OnApplicationQuit", "OnValidate", "OnDrawGizmos",
        "OnDrawGizmosSelected", "OnCollisionEnter", "OnCollisionExit",
        "OnCollisionStay", "OnCollisionEnter2D", "OnCollisionExit2D",
        "OnCollisionStay2D", "OnTriggerEnter", "OnTriggerExit", "OnTriggerStay",
        "OnTriggerEnter2D", "OnTriggerExit2D", "OnTriggerStay2D",
    };

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine(WorkerVersion);
            return 0;
        }

        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            var input = await Console.In.ReadToEndAsync();
            var request = JsonSerializer.Deserialize<TraceRequest>(input, JsonOptions)
                ?? throw new WorkerException("invalid_request", "Trace request is empty");
            var response = Analyze(request);
            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return response is TraceFailure ? 1 : 0;
        }
        catch (Exception error)
        {
            var response = new TraceFailure(
                1,
                false,
                new WorkerError("invalid_request", error.Message, []),
                new TraceDiagnostics());
            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return 1;
        }
    }

    private static object Analyze(TraceRequest request)
    {
        var stopwatch = Stopwatch.StartNew();
        var diagnostics = new TraceDiagnostics
        {
            FilesRequested = request.Files?.Length ?? 0,
        };

        try
        {
            ValidateRequest(request);
            var projectRoot = ResolveExistingPath(request.ProjectRoot!);
            if (!Directory.Exists(projectRoot))
            {
                throw new WorkerException("invalid_project", "Project root is not a directory");
            }
            var assemblyDefinitions = LoadAssemblyDefinitions(
                projectRoot,
                request.AssemblyDefinitions!,
                diagnostics);
            var settings = LoadProjectSettings(projectRoot, assemblyDefinitions, diagnostics);
            var sources = LoadSources(
                projectRoot,
                request.Files!,
                assemblyDefinitions,
                settings.ParseOptions,
                diagnostics);
            if (sources.Count == 0)
            {
                throw new WorkerException("no_sources", "No readable C# sources were supplied");
            }

            var compilation = CSharpCompilation.Create(
                "ProjectContext.Analysis",
                sources.Select(source => source.Tree),
                settings.References,
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: true,
                    concurrentBuild: true,
                    metadataImportOptions: MetadataImportOptions.All));
            var analyzer = new TraceAnalyzer(compilation, sources, diagnostics);
            var result = analyzer.Trace(request.Symbol!, request.Direction!, request.MaxResults);

            diagnostics.Partial = diagnostics.FilesSkipped > 0
                || diagnostics.MetadataFailures > 0
                || diagnostics.ReferenceFailures > 0
                || diagnostics.ParseErrors > 0
                || diagnostics.UnresolvedCandidates > 0;
            diagnostics.ElapsedMs = stopwatch.ElapsedMilliseconds;
            return new TraceSuccess(
                1,
                true,
                WorkerVersion,
                request.Symbol!,
                request.Direction!,
                result.MatchedSymbols,
                result.Edges,
                result.Truncated,
                diagnostics);
        }
        catch (WorkerException error)
        {
            diagnostics.Partial = true;
            diagnostics.ElapsedMs = stopwatch.ElapsedMilliseconds;
            return new TraceFailure(
                1,
                false,
                new WorkerError(error.Code, error.Message, error.Candidates),
                diagnostics);
        }
        catch (Exception error)
        {
            diagnostics.Partial = true;
            diagnostics.ElapsedMs = stopwatch.ElapsedMilliseconds;
            AddMessage(diagnostics, error.Message);
            return new TraceFailure(
                1,
                false,
                new WorkerError("analysis_failed", "Roslyn analysis failed", []),
                diagnostics);
        }
    }

    private static void ValidateRequest(TraceRequest request)
    {
        if (request.Version != 1)
        {
            throw new WorkerException("invalid_request", "Trace request version must be 1");
        }
        if (string.IsNullOrWhiteSpace(request.ProjectRoot)
            || request.ProjectRoot.Contains('\0')
            || !Directory.Exists(request.ProjectRoot))
        {
            throw new WorkerException("invalid_project", "Project root is unavailable");
        }
        if (request.Files is null || request.Files.Length == 0 || request.Files.Length > MaxFiles)
        {
            throw new WorkerException("invalid_request", "Trace files are empty or exceed the limit");
        }
        if (request.AssemblyDefinitions is null || request.AssemblyDefinitions.Length > MaxFiles)
        {
            throw new WorkerException("invalid_request", "Assembly definition list is invalid");
        }
        if (string.IsNullOrWhiteSpace(request.Symbol)
            || request.Symbol.Length > 512
            || request.Symbol.Contains('\0'))
        {
            throw new WorkerException("invalid_symbol", "Trace symbol is empty or invalid");
        }
        if (request.Direction is null || !Directions.Contains(request.Direction))
        {
            throw new WorkerException("invalid_direction", "Trace direction is invalid");
        }
        if (request.MaxResults is < 1 or > 200)
        {
            throw new WorkerException("invalid_request", "maxResults must be between 1 and 200");
        }
    }

    private static List<AssemblyDefinition> LoadAssemblyDefinitions(
        string projectRoot,
        IEnumerable<string> paths,
        TraceDiagnostics diagnostics)
    {
        var definitions = new List<AssemblyDefinition>();
        foreach (var relativePath in paths.Order(StringComparer.Ordinal))
        {
            try
            {
                var fullPath = ResolveInputPath(projectRoot, relativePath, ".asmdef");
                using var document = JsonDocument.Parse(File.ReadAllBytes(fullPath));
                if (!document.RootElement.TryGetProperty("name", out var nameValue))
                {
                    diagnostics.MetadataFailures++;
                    AddMessage(diagnostics, $"Skipped assembly definition {relativePath}: name is missing");
                    continue;
                }
                var name = nameValue.GetString()?.Trim();
                if (string.IsNullOrWhiteSpace(name))
                {
                    diagnostics.MetadataFailures++;
                    AddMessage(diagnostics, $"Skipped assembly definition {relativePath}: name is empty");
                    continue;
                }
                definitions.Add(new AssemblyDefinition(Path.GetDirectoryName(fullPath)!, name));
                diagnostics.AssemblyDefinitionsLoaded++;
            }
            catch (Exception error)
            {
                diagnostics.MetadataFailures++;
                AddMessage(diagnostics, $"Skipped assembly definition {relativePath}: {error.Message}");
            }
        }

        return definitions
            .OrderByDescending(definition => definition.Directory.Length)
            .ToList();
    }

    private static ProjectSettings LoadProjectSettings(
        string projectRoot,
        IReadOnlyCollection<AssemblyDefinition> assemblyDefinitions,
        TraceDiagnostics diagnostics)
    {
        var availableProjects = Directory
            .EnumerateFiles(projectRoot, "*.csproj", SearchOption.TopDirectoryOnly)
            .Take(256)
            .ToDictionary(
                project => Path.GetFileNameWithoutExtension(project),
                project => project,
                StringComparer.OrdinalIgnoreCase);
        var requestedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Assembly-CSharp",
            "Assembly-CSharp-Editor",
        };
        foreach (var definition in assemblyDefinitions)
        {
            requestedNames.Add(definition.Name);
        }

        var projectFiles = requestedNames
            .Select(name => availableProjects.GetValueOrDefault(name))
            .Where(path => path is not null)
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (projectFiles.Count == 0 && availableProjects.Count > 0)
        {
            projectFiles.Add(availableProjects.Values.Order(StringComparer.OrdinalIgnoreCase).First());
        }

        var defines = new HashSet<string>(StringComparer.Ordinal);
        var referencePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var languageVersion = LanguageVersion.CSharp9;

        foreach (var projectFile in projectFiles)
        {
            try
            {
                var document = XDocument.Load(projectFile, LoadOptions.None);
                diagnostics.ProjectFilesRead++;
                foreach (var value in document.Descendants()
                    .Where(element => element.Name.LocalName == "DefineConstants")
                    .Select(element => element.Value))
                {
                    foreach (var define in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        if (SyntaxFacts.IsValidIdentifier(define))
                        {
                            defines.Add(define);
                        }
                    }
                }

                foreach (var value in document.Descendants()
                    .Where(element => element.Name.LocalName == "LangVersion")
                    .Select(element => element.Value.Trim()))
                {
                    if (LanguageVersionFacts.TryParse(value, out var parsed) && parsed > languageVersion)
                    {
                        languageVersion = parsed;
                    }
                }

                foreach (var hint in document.Descendants()
                    .Where(element => element.Name.LocalName == "HintPath")
                    .Select(element => element.Value.Trim()))
                {
                    if (string.IsNullOrWhiteSpace(hint) || hint.Contains("$(", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    var candidate = Path.IsPathRooted(hint)
                        ? Path.GetFullPath(hint)
                        : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(projectFile)!, hint));
                    if (Path.GetExtension(candidate).Equals(".dll", StringComparison.OrdinalIgnoreCase)
                        && File.Exists(candidate))
                    {
                        referencePaths.Add(candidate);
                    }
                }
            }
            catch (Exception error)
            {
                diagnostics.MetadataFailures++;
                AddMessage(diagnostics, $"Skipped project settings {Path.GetFileName(projectFile)}: {error.Message}");
            }
        }

        if (!referencePaths.Any(path => Path.GetFileName(path).Equals("mscorlib.dll", StringComparison.OrdinalIgnoreCase)))
        {
            var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
            if (!string.IsNullOrWhiteSpace(trusted))
            {
                foreach (var referencePath in trusted.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
                {
                    referencePaths.Add(referencePath);
                }
            }
        }

        var references = new List<MetadataReference>();
        var identities = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var referencePath in referencePaths.Order(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var identity = AssemblyName.GetAssemblyName(referencePath).FullName ?? referencePath;
                if (!identities.Add(identity))
                {
                    continue;
                }
                references.Add(MetadataReference.CreateFromFile(referencePath));
                diagnostics.ReferencesLoaded++;
            }
            catch (Exception error)
            {
                diagnostics.ReferenceFailures++;
                AddMessage(diagnostics, $"Skipped metadata reference {Path.GetFileName(referencePath)}: {error.Message}");
            }
        }

        return new ProjectSettings(
            new CSharpParseOptions(
                languageVersion,
                DocumentationMode.Parse,
                SourceCodeKind.Regular,
                defines),
            references);
    }

    private static List<SourceUnit> LoadSources(
        string projectRoot,
        IEnumerable<string> paths,
        IReadOnlyList<AssemblyDefinition> assemblyDefinitions,
        CSharpParseOptions parseOptions,
        TraceDiagnostics diagnostics)
    {
        var sources = new List<SourceUnit>();
        foreach (var relativePath in paths.Order(StringComparer.Ordinal))
        {
            try
            {
                var fullPath = ResolveInputPath(projectRoot, relativePath, ".cs");
                var info = new FileInfo(fullPath);
                if (!info.Exists || info.Length > MaxFileBytes)
                {
                    throw new IOException("File is missing or exceeds the size limit");
                }
                var bytes = File.ReadAllBytes(fullPath);
                var text = DecodeText(bytes);
                var normalizedPath = Path.GetRelativePath(projectRoot, fullPath).Replace('\\', '/');
                var tree = CSharpSyntaxTree.ParseText(
                    text,
                    parseOptions,
                    normalizedPath,
                    Encoding.UTF8);
                var parseErrors = tree.GetDiagnostics().Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
                diagnostics.ParseErrors += parseErrors;
                if (parseErrors > 0)
                {
                    AddMessage(diagnostics, $"{normalizedPath} has {parseErrors} parse error(s)");
                }
                sources.Add(new SourceUnit(
                    tree,
                    ResolveAssembly(fullPath, normalizedPath, assemblyDefinitions),
                    Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()));
                diagnostics.FilesLoaded++;
            }
            catch (Exception error)
            {
                diagnostics.FilesSkipped++;
                AddMessage(diagnostics, $"Skipped source {relativePath}: {error.Message}");
            }
        }
        return sources;
    }

    private static string ResolveAssembly(
        string fullPath,
        string relativePath,
        IReadOnlyList<AssemblyDefinition> definitions)
    {
        foreach (var definition in definitions)
        {
            if (IsInside(definition.Directory, fullPath))
            {
                return definition.Name;
            }
        }
        return relativePath.Split('/').Any(segment => segment.Equals("Editor", StringComparison.OrdinalIgnoreCase))
            ? "Assembly-CSharp-Editor"
            : "Assembly-CSharp";
    }

    private static string ResolveInputPath(string projectRoot, string relativePath, string extension)
    {
        if (string.IsNullOrWhiteSpace(relativePath)
            || relativePath.Contains('\0')
            || Path.IsPathRooted(relativePath)
            || !Path.GetExtension(relativePath).Equals(extension, StringComparison.OrdinalIgnoreCase))
        {
            throw new IOException("Input path is invalid");
        }
        var fullPath = Path.GetFullPath(Path.Combine(
            projectRoot,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        if (!IsInside(projectRoot, fullPath))
        {
            throw new IOException("Input path escapes the project root");
        }
        var resolved = ResolveExistingPath(fullPath);
        if (!IsInside(projectRoot, resolved))
        {
            throw new IOException("Input path resolves outside the project root");
        }
        return resolved;
    }

    private static string ResolveExistingPath(string value)
    {
        var absolute = Path.GetFullPath(value);
        if (OperatingSystem.IsWindows())
        {
            using var handle = CreateFileW(
                absolute,
                0,
                FileShare.ReadWrite | FileShare.Delete,
                IntPtr.Zero,
                FileMode.Open,
                0x02000000,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                throw new IOException(
                    new Win32Exception(Marshal.GetLastWin32Error()).Message);
            }
            var output = new StringBuilder(32_768);
            var length = GetFinalPathNameByHandleW(handle, output, (uint)output.Capacity, 0);
            if (length == 0 || length >= output.Capacity)
            {
                throw new IOException(
                    new Win32Exception(Marshal.GetLastWin32Error()).Message);
            }
            var resolved = output.ToString();
            if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            {
                return @"\\" + resolved[8..];
            }
            return resolved.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)
                ? resolved[4..]
                : resolved;
        }

        var root = Path.GetPathRoot(absolute)
            ?? throw new IOException("Path has no filesystem root");
        var current = root;
        var segments = absolute[root.Length..].Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
        foreach (var segment in segments)
        {
            var candidate = Path.Combine(current, segment);
            FileSystemInfo info = Directory.Exists(candidate)
                ? new DirectoryInfo(candidate)
                : new FileInfo(candidate);
            if (!info.Exists)
            {
                throw new IOException("Path does not exist");
            }
            var linkTarget = info.ResolveLinkTarget(returnFinalTarget: true);
            current = Path.GetFullPath(linkTarget?.FullName ?? info.FullName);
        }
        return current;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        FileShare shareMode,
        IntPtr securityAttributes,
        FileMode creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle file,
        StringBuilder filePath,
        uint filePathLength,
        uint flags);

    private static bool IsInside(string root, string candidate)
    {
        var relative = Path.GetRelativePath(root, candidate);
        return relative.Length == 0
            || (!relative.Equals("..", StringComparison.Ordinal)
                && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !Path.IsPathRooted(relative));
    }

    private static string DecodeText(byte[] bytes)
    {
        try
        {
            return new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.GetEncoding(
                949,
                EncoderFallback.ExceptionFallback,
                DecoderFallback.ExceptionFallback).GetString(bytes);
        }
    }

    private static void AddMessage(TraceDiagnostics diagnostics, string message)
    {
        if (diagnostics.Messages.Count < MaxMessages)
        {
            diagnostics.Messages.Add(message);
        }
    }

    private sealed class TraceAnalyzer
    {
        private readonly CSharpCompilation _compilation;
        private readonly IReadOnlyDictionary<SyntaxTree, SourceUnit> _sources;
        private readonly TraceDiagnostics _diagnostics;
        private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();

        public TraceAnalyzer(
            CSharpCompilation compilation,
            IEnumerable<SourceUnit> sources,
            TraceDiagnostics diagnostics)
        {
            _compilation = compilation;
            _sources = sources.ToDictionary(source => source.Tree);
            _diagnostics = diagnostics;
        }

        public TraceResult Trace(string rawSymbol, string direction, int maxResults)
        {
            var symbol = NormalizeQuery(rawSymbol);
            List<SymbolNode> matched;
            List<TraceEdge> edges;
            if (direction is "callers" or "callees")
            {
                var methods = FindMethods(symbol);
                matched = methods.Select(ToNode).ToList();
                edges = direction == "callers" ? FindCallers(methods) : FindCallees(methods);
            }
            else
            {
                var types = FindTypes(symbol);
                matched = types.Select(ToNode).ToList();
                edges = FindTypeRelations(types, direction);
            }

            var ordered = edges
                .GroupBy(edge => $"{edge.Relation}|{edge.From.Signature}|{edge.To.Signature}|{edge.Evidence.Path}|{edge.Evidence.LineStart}")
                .Select(group => group.First())
                .OrderBy(edge => edge.Evidence.Path, StringComparer.Ordinal)
                .ThenBy(edge => edge.Evidence.LineStart)
                .ThenBy(edge => edge.Relation, StringComparer.Ordinal)
                .ThenBy(edge => edge.From.FullName, StringComparer.Ordinal)
                .ThenBy(edge => edge.To.FullName, StringComparer.Ordinal)
                .ToList();
            return new TraceResult(
                matched.OrderBy(node => node.Signature, StringComparer.Ordinal).ToList(),
                ordered.Take(maxResults).ToList(),
                ordered.Count > maxResults);
        }

        private List<IMethodSymbol> FindMethods(string query)
        {
            var namePart = query.Split('(', 2)[0];
            var simpleName = namePart.Split('.').Last();
            var candidates = new List<IMethodSymbol>();
            foreach (var source in _sources.Values)
            {
                var declarations = source.Tree.GetRoot().DescendantNodes()
                    .OfType<MethodDeclarationSyntax>()
                    .Where(declaration => declaration.Identifier.ValueText == simpleName);
                foreach (var declaration in declarations)
                {
                    if (GetModel(source.Tree).GetDeclaredSymbol(declaration) is not IMethodSymbol method)
                    {
                        continue;
                    }
                    var original = method.OriginalDefinition;
                    if (MatchesMethod(query, original)
                        && !candidates.Any(candidate => SymbolEqualityComparer.Default.Equals(candidate, original)))
                    {
                        candidates.Add(original);
                    }
                }
            }
            return RequireSingleName(candidates, MethodSignature, query);
        }

        private List<INamedTypeSymbol> FindTypes(string query)
        {
            var simpleName = query.Split('.').Last();
            var candidates = new List<INamedTypeSymbol>();
            foreach (var source in _sources.Values)
            {
                var declarations = source.Tree.GetRoot().DescendantNodes()
                    .OfType<TypeDeclarationSyntax>()
                    .Where(declaration => declaration.Identifier.ValueText == simpleName);
                foreach (var declaration in declarations)
                {
                    if (GetModel(source.Tree).GetDeclaredSymbol(declaration) is not INamedTypeSymbol type)
                    {
                        continue;
                    }
                    var original = type.OriginalDefinition;
                    if (Matches(query, original.Name, TypeFullName(original))
                        && !candidates.Any(candidate => SymbolEqualityComparer.Default.Equals(candidate, original)))
                    {
                        candidates.Add(original);
                    }
                }
            }
            return RequireSingleName(candidates, TypeFullName, query);
        }

        private static List<T> RequireSingleName<T>(
            List<T> candidates,
            Func<T, string> fullName,
            string query)
        {
            if (candidates.Count == 0)
            {
                throw new WorkerException("symbol_not_found", $"Symbol was not found: {query}");
            }
            var groups = candidates.GroupBy(fullName, StringComparer.Ordinal).ToList();
            if (groups.Count > 1)
            {
                throw new WorkerException(
                    "ambiguous_symbol",
                    $"Symbol is ambiguous: {query}",
                    groups.Select(group => group.Key).Order(StringComparer.Ordinal).ToArray());
            }
            return candidates;
        }

        private List<TraceEdge> FindCallers(IReadOnlyCollection<IMethodSymbol> targets)
        {
            var targetNames = targets.Select(target => target.Name).ToHashSet(StringComparer.Ordinal);
            var edges = new List<TraceEdge>();
            foreach (var source in _sources.Values)
            {
                var invocations = source.Tree.GetRoot().DescendantNodes()
                    .OfType<InvocationExpressionSyntax>()
                    .Where(invocation => targetNames.Contains(InvokedName(invocation) ?? ""));
                SemanticModel? model = null;
                foreach (var invocation in invocations)
                {
                    model ??= GetModel(source.Tree);
                    var info = model.GetSymbolInfo(invocation);
                    if (info.Symbol is not IMethodSymbol called)
                    {
                        _diagnostics.UnresolvedCandidates++;
                        continue;
                    }
                    var normalized = NormalizeMethod(called);
                    if (!targets.Any(target => SymbolEqualityComparer.Default.Equals(target, normalized)))
                    {
                        continue;
                    }
                    var caller = EnclosingMethod(model, invocation.SpanStart);
                    if (caller is null)
                    {
                        continue;
                    }
                    edges.Add(new TraceEdge("calls", ToNode(caller), ToNode(normalized), Evidence(invocation)));
                }
            }

            foreach (var target in targets.Where(IsUnityMessage))
            {
                var declaration = target.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
                if (declaration is null)
                {
                    continue;
                }
                edges.Add(new TraceEdge(
                    "unity_message",
                    new SymbolNode("UnityEngine", "UnityEngine", "UnityEngine", "engine", "UnityEngine", null, null, null, null, false),
                    ToNode(target),
                    Evidence(declaration)));
            }
            return edges;
        }

        private List<TraceEdge> FindCallees(IReadOnlyCollection<IMethodSymbol> targets)
        {
            var edges = new List<TraceEdge>();
            foreach (var target in targets)
            {
                foreach (var syntaxReference in target.DeclaringSyntaxReferences)
                {
                    var declaration = syntaxReference.GetSyntax();
                    var model = GetModel(declaration.SyntaxTree);
                    foreach (var invocation in declaration.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        var info = model.GetSymbolInfo(invocation);
                        if (info.Symbol is not IMethodSymbol called)
                        {
                            _diagnostics.UnresolvedCandidates++;
                            continue;
                        }
                        var normalized = NormalizeMethod(called);
                        if (HasSource(normalized))
                        {
                            edges.Add(new TraceEdge("calls", ToNode(target), ToNode(normalized), Evidence(invocation)));
                        }
                    }
                    foreach (var creation in declaration.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
                    {
                        var info = model.GetSymbolInfo(creation);
                        if (info.Symbol is not IMethodSymbol constructor)
                        {
                            _diagnostics.UnresolvedCandidates++;
                            continue;
                        }
                        var normalized = NormalizeMethod(constructor);
                        if (HasSource(normalized))
                        {
                            edges.Add(new TraceEdge("constructs", ToNode(target), ToNode(normalized), Evidence(creation)));
                        }
                    }
                }
            }
            return edges;
        }

        private List<TraceEdge> FindTypeRelations(
            IReadOnlyCollection<INamedTypeSymbol> targets,
            string direction)
        {
            var edges = new List<TraceEdge>();
            foreach (var target in targets)
            {
                foreach (var syntaxReference in target.DeclaringSyntaxReferences)
                {
                    if (syntaxReference.GetSyntax() is not TypeDeclarationSyntax declaration
                        || declaration.BaseList is null)
                    {
                        continue;
                    }
                    var model = GetModel(declaration.SyntaxTree);
                    foreach (var baseType in declaration.BaseList.Types)
                    {
                        if (model.GetTypeInfo(baseType.Type).Type is not INamedTypeSymbol related)
                        {
                            _diagnostics.UnresolvedCandidates++;
                            continue;
                        }
                        var isInterface = related.TypeKind == TypeKind.Interface;
                        if ((direction == "inherits" && isInterface)
                            || (direction == "implements" && !isInterface))
                        {
                            continue;
                        }
                        edges.Add(new TraceEdge(
                            direction,
                            ToNode(target),
                            ToNode(related.OriginalDefinition),
                            Evidence(baseType)));
                    }
                }
            }
            return edges;
        }

        private SemanticModel GetModel(SyntaxTree tree)
        {
            if (!_models.TryGetValue(tree, out var model))
            {
                model = _compilation.GetSemanticModel(tree, ignoreAccessibility: true);
                _models.Add(tree, model);
            }
            return model;
        }

        private bool HasSource(ISymbol symbol) => symbol.Locations.Any(location =>
            location.IsInSource && location.SourceTree is not null && _sources.ContainsKey(location.SourceTree));

        private SymbolNode ToNode(ISymbol symbol)
        {
            var location = symbol.Locations.FirstOrDefault(candidate =>
                candidate.IsInSource && candidate.SourceTree is not null && _sources.ContainsKey(candidate.SourceTree));
            string? sourcePath = null;
            int? lineStart = null;
            int? lineEnd = null;
            string? fileHash = null;
            string assembly;
            if (location?.SourceTree is not null)
            {
                var span = location.GetLineSpan();
                sourcePath = location.SourceTree.FilePath.Replace('\\', '/');
                lineStart = span.StartLinePosition.Line + 1;
                lineEnd = span.EndLinePosition.Line + 1;
                assembly = _sources[location.SourceTree].Assembly;
                fileHash = _sources[location.SourceTree].Hash;
            }
            else
            {
                assembly = symbol.ContainingAssembly?.Name ?? "unknown";
            }

            return symbol switch
            {
                IMethodSymbol method => new SymbolNode(
                    method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor
                        ? method.ContainingType.Name
                        : method.Name,
                    MethodFullName(method),
                    method.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                    method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor ? "constructor" : "method",
                    assembly,
                    sourcePath,
                    lineStart,
                    lineEnd,
                    fileHash,
                    IsUnityMessage(method)),
                INamedTypeSymbol type => new SymbolNode(
                    type.Name,
                    TypeFullName(type),
                    type.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                    type.TypeKind.ToString().ToLowerInvariant(),
                    assembly,
                    sourcePath,
                    lineStart,
                    lineEnd,
                    fileHash,
                    false),
                _ => new SymbolNode(
                    symbol.Name,
                    symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                    symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
                    symbol.Kind.ToString().ToLowerInvariant(),
                    assembly,
                    sourcePath,
                    lineStart,
                    lineEnd,
                    fileHash,
                    false),
            };
        }

        private SourceEvidence Evidence(SyntaxNode node)
        {
            var source = _sources[node.SyntaxTree];
            var text = node.SyntaxTree.GetText();
            var span = node.GetLocation().GetLineSpan();
            var start = span.StartLinePosition.Line;
            var end = span.EndLinePosition.Line;
            var excerpt = string.Join(
                "\n",
                text.Lines.Skip(start).Take(Math.Min(end - start + 1, 20)).Select(line => line.ToString()))
                .Trim();
            if (excerpt.Length > 2_000)
            {
                excerpt = excerpt[..2_000];
            }
            return new SourceEvidence(
                node.SyntaxTree.FilePath.Replace('\\', '/'),
                start + 1,
                end + 1,
                excerpt,
                source.Hash);
        }

        private static IMethodSymbol? EnclosingMethod(SemanticModel model, int position)
        {
            var current = model.GetEnclosingSymbol(position);
            while (current is not null)
            {
                if (current is IMethodSymbol method && method.MethodKind != MethodKind.AnonymousFunction)
                {
                    return method.OriginalDefinition;
                }
                current = current.ContainingSymbol;
            }
            return null;
        }

        private static string? InvokedName(InvocationExpressionSyntax invocation) => invocation.Expression switch
        {
            IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
            GenericNameSyntax generic => generic.Identifier.ValueText,
            MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
            MemberBindingExpressionSyntax binding => binding.Name.Identifier.ValueText,
            _ => null,
        };

        private static IMethodSymbol NormalizeMethod(IMethodSymbol method) =>
            (method.ReducedFrom ?? method).OriginalDefinition;

        private static bool IsUnityMessage(IMethodSymbol method)
        {
            if (method.IsStatic || !UnityMessages.Contains(method.Name))
            {
                return false;
            }
            for (var type = method.ContainingType; type is not null; type = type.BaseType)
            {
                var fullName = TypeFullName(type);
                if ((fullName is "UnityEngine.MonoBehaviour"
                    or "UnityEngine.ScriptableObject"
                    or "UnityEngine.StateMachineBehaviour")
                    && !type.Locations.Any(location => location.IsInSource)
                    && IsUnityAssembly(type.ContainingAssembly?.Name))
                {
                    return true;
                }
            }
            return false;
        }

        private static bool IsUnityAssembly(string? name) =>
            name is "UnityEngine" or "UnityEngine.CoreModule";

        private static string NormalizeQuery(string value) =>
            value.Trim().Replace("global::", "", StringComparison.Ordinal);

        private static bool MatchesMethod(string query, IMethodSymbol method)
        {
            if (!query.Contains('(', StringComparison.Ordinal))
            {
                return Matches(query, method.Name, MethodFullName(method));
            }
            var signature = MethodSignature(method);
            return signature.Equals(query, StringComparison.Ordinal)
                || signature.EndsWith($".{query}", StringComparison.Ordinal);
        }

        private static bool Matches(string query, string simpleName, string fullName) =>
            query.Contains('.', StringComparison.Ordinal)
                ? fullName.Equals(query, StringComparison.Ordinal)
                    || fullName.EndsWith($".{query}", StringComparison.Ordinal)
                : simpleName.Equals(query, StringComparison.Ordinal);

        private static string MethodFullName(IMethodSymbol method)
        {
            var name = method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor
                ? ".ctor"
                : method.Name;
            return $"{TypeFullName(method.ContainingType)}.{name}";
        }

        private static string MethodSignature(IMethodSymbol method) =>
            method.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);

        private static string TypeFullName(INamedTypeSymbol type) =>
            type.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
    }

    private sealed class WorkerException : Exception
    {
        public WorkerException(string code, string message, string[]? candidates = null)
            : base(message)
        {
            Code = code;
            Candidates = candidates ?? [];
        }

        public string Code { get; }
        public string[] Candidates { get; }
    }

    private sealed class TraceRequest
    {
        public int Version { get; init; }
        public string? ProjectRoot { get; init; }
        public string[]? Files { get; init; }
        public string[]? AssemblyDefinitions { get; init; }
        public string? Symbol { get; init; }
        public string? Direction { get; init; }
        public int MaxResults { get; init; } = 50;
    }

    private sealed class TraceDiagnostics
    {
        public int FilesRequested { get; set; }
        public int FilesLoaded { get; set; }
        public int FilesSkipped { get; set; }
        public int MetadataFailures { get; set; }
        public int ProjectFilesRead { get; set; }
        public int AssemblyDefinitionsLoaded { get; set; }
        public int ReferencesLoaded { get; set; }
        public int ReferenceFailures { get; set; }
        public int ParseErrors { get; set; }
        public int UnresolvedCandidates { get; set; }
        public bool Partial { get; set; }
        public long ElapsedMs { get; set; }
        public List<string> Messages { get; } = [];
    }

    private sealed record ProjectSettings(CSharpParseOptions ParseOptions, IReadOnlyList<MetadataReference> References);
    private sealed record AssemblyDefinition(string Directory, string Name);
    private sealed record SourceUnit(SyntaxTree Tree, string Assembly, string Hash);
    private sealed record TraceResult(List<SymbolNode> MatchedSymbols, List<TraceEdge> Edges, bool Truncated);
    private sealed record SymbolNode(
        string Name,
        string FullName,
        string Signature,
        string Kind,
        string Assembly,
        string? Path,
        int? LineStart,
        int? LineEnd,
        string? FileHash,
        bool UnityMessage);
    private sealed record SourceEvidence(string Path, int LineStart, int LineEnd, string Text, string FileHash);
    private sealed record TraceEdge(string Relation, SymbolNode From, SymbolNode To, SourceEvidence Evidence);
    private sealed record WorkerError(string Code, string Message, string[] Candidates);
    private sealed record TraceSuccess(
        int Version,
        bool Ok,
        string WorkerVersion,
        string Symbol,
        string Direction,
        List<SymbolNode> MatchedSymbols,
        List<TraceEdge> Results,
        bool Truncated,
        TraceDiagnostics Diagnostics);
    private sealed record TraceFailure(int Version, bool Ok, WorkerError Error, TraceDiagnostics Diagnostics);
}
