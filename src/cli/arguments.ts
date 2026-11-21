type PublicCommand =
  | { kind: "help" | "server" | "status" | "stop" }
  | { kind: "update"; mode: "upstream" | "local" }
  | { kind: "view"; foreground: boolean; diff: boolean; target?: string };

// The launcher handles private daemon startup and forwards raw argv to an active
// build before interpreting public commands. Parsing here has no side effects.
export function parsePublicCommand(argv: readonly string[]): PublicCommand {
  const [first, second] = argv;
  if (argv.length === 1) {
    switch (first) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "server":
      case "status":
      case "stop":
        return { kind: first };
      case "update":
        return { kind: "update", mode: "upstream" };
    }
  }
  if (argv.length === 2 && first === "update" && second === "--local")
    return { kind: "update", mode: "local" };

  const foreground = first === "--foreground";
  const args = foreground ? argv.slice(1) : argv;
  const literal = args[0] === "--";
  const paths = literal ? args.slice(1) : args;
  if (paths.length > 1 || (literal && paths.length !== 1))
    throw new Error("使い方: miru [path | diff | server | status | stop | update]");
  const diff = !literal && paths[0] === "diff";
  return { kind: "view", foreground, diff, target: diff ? "." : paths[0] || undefined };
}
