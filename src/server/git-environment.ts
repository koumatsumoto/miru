// A resident viewer can outlive the shell that started it. Do not let its
// repository-routing overrides change what later, independent views inspect.
const REPOSITORY_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_SHALLOW_FILE",
]);
// Do not inherit a calling repository (e.g. a git hook's index) for MIRU's
// viewer, explicitly linked updater checkout, or isolated build subprocesses.
export function checkoutEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const key = name.toUpperCase();
      return !REPOSITORY_ENV.has(key) && !key.startsWith("GIT_TRACE");
    }),
  );
}
