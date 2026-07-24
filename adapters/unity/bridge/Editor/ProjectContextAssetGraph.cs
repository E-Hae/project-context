using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace ProjectContext.AssetGraph {
  public static class Export {
    [Serializable] private sealed class Edge { public string from; public string to; }
    [Serializable] private sealed class Output { public List<Edge> dependencies = new(); }

    public static void Run() {
      var outputPath = ArgumentValue("-projectContextOutput");
      if (string.IsNullOrEmpty(outputPath)) throw new ArgumentException("-projectContextOutput is required");
      var output = new Output();
      foreach (var assetPath in AssetDatabase.GetAllAssetPaths()) {
        if (!assetPath.StartsWith("Assets/", StringComparison.Ordinal) && !assetPath.StartsWith("Packages/", StringComparison.Ordinal)) continue;
        foreach (var dependency in AssetDatabase.GetDependencies(assetPath, false)) {
          output.dependencies.Add(new Edge { from = assetPath, to = dependency });
        }
      }
      File.WriteAllText(outputPath, JsonUtility.ToJson(output));
    }

    private static string ArgumentValue(string name) {
      var args = Environment.GetCommandLineArgs();
      for (var i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
      return null;
    }
  }
}
