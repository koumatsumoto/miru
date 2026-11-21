import { expect, it } from "vite-plus/test";
import { parsePublicCommand } from "../src/cli/arguments";

it("recognizes commands only as complete invocations", () => {
  for (const kind of ["server", "status", "stop"]) {
    expect(parsePublicCommand([kind])).toEqual({ kind });
  }
  for (const alias of ["-h", "--help"]) {
    expect(parsePublicCommand([alias])).toEqual({ kind: "help" });
  }
  expect(parsePublicCommand(["update"])).toEqual({ kind: "update", mode: "upstream" });
  expect(parsePublicCommand(["update", "--local"])).toEqual({ kind: "update", mode: "local" });
});

it("keeps HOME, relative paths and diff distinct in both view modes", () => {
  for (const foreground of [false, true]) {
    const prefix = foreground ? ["--foreground"] : [];
    for (const [args, target, diff] of [
      [[], undefined, false],
      [[""], undefined, false],
      [["資料/report #1.md"], "資料/report #1.md", false],
      [["--local"], "--local", false],
      [["diff"], ".", true],
    ] as const) {
      expect(parsePublicCommand([...prefix, ...args])).toEqual({
        kind: "view",
        target,
        diff,
        foreground,
      });
    }
  }
});

it("treats literal command or flag names as paths, never resident operations", () => {
  for (const target of [
    "diff",
    "update",
    "server",
    "status",
    "stop",
    "--help",
    "--foreground",
    "--",
  ]) {
    for (const foreground of [false, true]) {
      const prefix = foreground ? ["--foreground", "--"] : ["--"];
      expect(parsePublicCommand([...prefix, target])).toEqual({
        kind: "view",
        target,
        diff: false,
        foreground,
      });
    }
  }
  expect(parsePublicCommand(["--foreground", "update"])).toEqual({
    kind: "view",
    target: "update",
    diff: false,
    foreground: true,
  });
});

it("rejects missing literal paths and extra arguments instead of running a partial command", () => {
  for (const args of [
    ["--"],
    ["--foreground", "--"],
    ["a", "b"],
    ["stop", "file"],
    ["--help", "file"],
    ["update", "--other"],
    ["update", "--local", "file"],
    ["--", "update", "--local"],
    ["--foreground", "update", "--local"],
  ]) {
    expect(() => parsePublicCommand(args)).toThrow("使い方: miru");
  }
});
